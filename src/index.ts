/**
 * inetGeek MCP server.
 *
 * Deliberately thin: every tool here reads data inetGeek already publishes at
 * https://inetgeek.com — the static `.md` mirror of every page, the site's
 * own search index, its JSON feeds, and the already-live, already-rate-limited
 * DNS/SPF/propagation APIs. No fact is sourced here; this is a distribution
 * surface for content that is already verified and dated, not a new place for
 * a claim to originate. The one computation is estimate_monthly_cost, which is
 * arithmetic over published per-volume rates, labelled as ours in every answer
 * and never presented as a vendor quote.
 *
 * Stateless on purpose: one McpServer + one transport per request, no
 * Durable Object, no session store. Nothing here needs to remember a caller
 * between calls, and stateless is the smaller, easier-to-reason-about thing
 * to keep correct.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { expandQuery, matchCriteria, normaliseForSearch, rankSearchDocs } from './search-rank';

const SITE = 'https://inetgeek.com';

/**
 * This worker's own origin, used for the icon URLs so a connector loads the
 * mark from the same host it speaks MCP to. Hard-coded rather than derived
 * from the request because serverInfo is built once per server instance, not
 * per request, and a wrong guess here is an icon that silently fails to load.
 */
const SELF = 'https://inetgeek-mcp.palashbagchi.workers.dev';


// TOOL LIST IS MIRRORED BY HAND in src/data/mcp-tools.ts (the /mcp/ page's
// documentation). The site cannot import this worker at build time and this
// worker cannot import the site, so src/lib/mcp-tools.test.ts greps every
// `registerTool('...'` below and fails `npm test` when the two differ. Add,
// rename or remove a tool here → update src/data/mcp-tools.ts.

interface SearchDoc {
  path: string;
  title: string;
  description: string;
  kind: string;
  keywords?: string;
}
interface SearchIndex {
  count: number;
  docs: SearchDoc[];
}

// One fetch of each published JSON file serves every call in this isolate
// for 5 minutes — each is a few hundred small records, cheap to hold, and
// refetching per tool call would be a full round trip for data that changes
// at deploy cadence, not per-request cadence.
const jsonCache = new Map<string, { at: number; data: unknown }>();
async function loadJson<T>(path: string): Promise<T> {
  const hit = jsonCache.get(path);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.data as T;
  // The map above only helps an isolate that has already answered a call.
  // cacheEverything is what a COLD isolate gets, and a cold isolate is the
  // common case for an MCP server that is called in bursts and then idle —
  // the same flag the icon and server-card fetches at the bottom of this file
  // have always used. Without it a cold start paid a full origin round trip
  // for /providers/core.json, which is 226 KB on the wire.
  const res = await fetch(`${SITE}${path}`, { cf: { cacheEverything: true } });
  if (!res.ok) throw new Error(`${path} fetch failed: HTTP ${res.status}`);
  const data = (await res.json()) as T;
  jsonCache.set(path, { at: Date.now(), data });
  return data;
}
const loadSearchIndex = () => loadJson<SearchIndex>('/search-index.json');

/**
 * Shape of the provider feed — see src/lib/providers-feed.ts in the site repo.
 *
 * This reads the `core` view, not `/providers.json`. The full feed carries the
 * verbatim excerpt behind every figure, which is the right default for an
 * agent reading the file directly and the wrong one here: it is 2.05 MB
 * against core's 1.07 MB, and these tools want the values, not the evidence.
 * A caller who wants an excerpt gets it from get_provider, which fetches the
 * provider's own page.
 *
 * `display` is OPTIONAL in core, present only where it differs from `value` —
 * for 2,364 of 3,055 facts the two were the same string. Read it through
 * shown() below, never directly.
 */
interface PublishedFact {
  value: unknown;
  display?: string;
  source_url: string;
  verified_at: string;
}
/** The rendered value: `display` where the feed carries one, else `value`. */
const shown = (fact: PublishedFact): string => fact.display ?? String(fact.value);
interface PublishedProvider {
  id: string;
  name: string;
  category: string;
  also_in: string[];
  path: string;
  homepage: string;
  best_for: string | null;
  facts: Record<string, PublishedFact>;
}
interface ProvidersFile {
  count: number;
  fact_labels: Record<string, string>;
  providers: PublishedProvider[];
}
const loadProviders = () => loadJson<ProvidersFile>('/providers/core.json');

/** Shape of /plan.json — see src/pages/plan.json.ts and src/lib/plan.ts in the site repo. */
interface PlanLayerResult {
  key: string;
  label: string;
  /** Layers this one does nothing without — see Layer.requires in the site. */
  requires?: string[];
  href: string;
  providerId: string | null;
  providerName: string | null;
  providerHref: string | null;
  bestFor: string | null;
  priceLabel: string;
  priceUsd: number | null;
  /** 'price' when genuinely cheaper than the layer, 'tie' when only the alphabet separated it from coEqual. */
  pickBasis: 'price' | 'tie' | 'none';
  coEqual: string[];
}
interface PlanSecurityCandidate {
  id: string;
  name: string;
  href: string;
  priceUsd: number | null;
  priceLabel: string;
  // NO bestFor. It was removed from the payload on 2026-09-16: the planner was
  // shipping 143 editorial paragraphs into a JSON island so a picker could show
  // one, and the reasoning lives on the provider page the href points at. This
  // type declared it for a few hours after it stopped existing, which would
  // have printed "undefined" as a provider's reason.
  [requirement: string]: unknown;
}
/** One ranked provider in a layer, from /plan.json `candidates`. */
interface PlanCandidate {
  id: string;
  name: string;
  /** Registrable-domain label of the homepage ("cloudflare", "amazon"): what `platform` matches on. */
  vendor: string;
  priceUsd: number | null;
  priceLabel: string;
  href: string;
  primary: boolean;
}
interface PlanFile {
  layers: { key: string; label: string }[];
  securityRequirementKeys: string[];
  results: PlanLayerResult[];
  stages: { key: string; label: string; layerKeys: string[]; requirements?: string[] }[];
  keywordLayers: Record<string, string[]>;
  securityCandidates: Record<string, PlanSecurityCandidate[]>;
  /** Every ranked provider per layer; absent on a feed older than 2026-10-25. */
  candidates?: Record<string, PlanCandidate[]>;
}
const loadPlan = () => loadJson<PlanFile>('/plan.json');

/** Shape of /scores.json — see src/pages/scores.json.ts and src/lib/score.ts in the site repo. */
interface ScoreCriterion {
  key: string;
  pillar: string;
  score: number;
  weight: number;
  basis: string;
}
interface ScorePillar {
  pillar: string;
  score: number;
  raw: number;
  low: number;
  high: number;
  coverage: number;
  scored: number;
  applicable: number;
  criteria: ScoreCriterion[];
  /** Decidable criteria peers document that this provider does not. */
  missing: string[];
}
interface ProviderScore {
  id: string;
  name: string;
  category: string;
  overall: number;
  low: number;
  high: number;
  rank: number;
  of: number;
  coverage: number;
  pillars: Partial<Record<string, ScorePillar>>;
  weights: Partial<Record<string, number>>;
  distinct: boolean;
  caveat: string;
  /** Why this record's number needs extra care — thin pillars, documented-but-unscored facts. Absent on an older feed. */
  readingNotes?: string[];
}
interface ScoresFile {
  method: string;
  generated_at: string;
  pillars: Record<string, string>;
  categories: Record<string, ProviderScore[]>;
}
const loadScores = () => loadJson<ScoresFile>('/scores.json');

/** Shape of /usage-pricing.json — see src/pages/usage-pricing.json.ts in the site repo. */
interface UsagePlanRow {
  provider: string;
  name: string;
  category: string;
  path: string;
  plan: string;
  unit: 'pageviews' | 'events' | 'emails' | 'mau';
  currency?: string;
  /** Absent on a quote-only row. */
  monthly_usd?: number;
  /** A purchase price, beside or instead of a monthly fee. */
  one_time_usd?: number | null;
  /** Units a month covered; null when `uncapped` says why there is no number. */
  included?: number | null;
  uncapped?: 'unlimited' | 'fair-use' | null;
  /** A quote-only row: above this volume the vendor sells by quote and prints no price. */
  quote_above?: number;
  overage_usd_per_unit?: number | null;
  /** Overage billed in blocks; `granularity` is what the page says about whole blocks versus prorating. */
  overage_block?: { size: number; usd: number; granularity: 'unstated' | 'whole' | 'prorated' } | null;
  /** Marginal rates that change with volume; `from` is the first unit billed at each. */
  overage_tiers?: { from: number; per_unit: number }[] | null;
  /** The volume through which the overage rate holds; null when it holds without limit. */
  max_units?: number | null;
  sites: number | null;
  /** The vendor says "unlimited websites" for this plan. */
  sites_unlimited?: boolean;
  term: string | null;
  source_url: string;
  verified_at: string;
  note: string | null;
}
interface UsagePricingFile {
  count: number;
  plans: UsagePlanRow[];
}
const loadUsagePricing = () => loadJson<UsagePricingFile>('/usage-pricing.json');

/**
 * A plan's [lowest, highest] monthly cost at `needed` units, or null when the
 * plan prices nothing at that volume. Mirrors costRangeAt in the site's
 * src/lib/price-tables.ts; the two ends differ only for a block overage whose
 * billing the page leaves open.
 */
function priceRange(row: UsagePlanRow, needed: number): [number, number] | null {
  const monthly = row.monthly_usd ?? 0;
  const included = row.included ?? Infinity;
  if (needed <= included) return [monthly, monthly];
  if (row.overage_block) {
    const { size, usd, granularity } = row.overage_block;
    const excess = needed - included;
    const prorated = monthly + (excess / size) * usd;
    const whole = monthly + Math.ceil(excess / size) * usd;
    return granularity === 'prorated' ? [prorated, prorated] : granularity === 'whole' ? [whole, whole] : [prorated, whole];
  }
  if (row.overage_tiers && row.overage_tiers.length) {
    let cost = monthly;
    row.overage_tiers.forEach((tier, i) => {
      const last = i + 1 < row.overage_tiers!.length ? row.overage_tiers![i + 1].from - 1 : Infinity;
      const inTier = Math.min(needed, last) - tier.from + 1;
      if (inTier > 0) cost += inTier * tier.per_unit;
    });
    return [cost, cost];
  }
  if (row.overage_usd_per_unit == null) return null;
  if (row.max_units != null && needed > row.max_units) return null;
  const c = monthly + (needed - included) * row.overage_usd_per_unit;
  return [c, c];
}

/** One provider's score in one category, by id or by name, case-insensitively. */
function findScore(scores: ScoresFile, category: string, idOrName: string): ProviderScore | undefined {
  const rows = scores.categories[category] ?? [];
  const q = idOrName.trim().toLowerCase();
  return rows.find((r) => r.id === q || r.name.toLowerCase() === q);
}

const fmtScore = (r: ProviderScore) =>
  `${Math.round(r.overall)}/100 (80% interval ${Math.round(r.low)}–${Math.round(r.high)}), rank ${r.rank} of ${r.of}${r.distinct ? '' : ' (interval overlaps the next rank — an ordering, not a finding)'}`;

/** Shape of /changelog.json — see src/pages/changelog.json.ts in the site repo. */
interface ChangelogEntry {
  kind: string;
  cause?: string;
  id: string;
  name: string;
  field?: string;
  from?: string;
  to?: string;
  source?: string;
  verified_at?: string;
  date: string;
  commit: string;
}
interface ChangelogFile {
  generated_at: string;
  counts: Record<string, number>;
  entries: ChangelogEntry[];
}

/** The URL section a provider publishes under — the first path segment. */
function sectionOf(p: { path: string }): string {
  return p.path.split('/')[1] ?? 'unknown';
}

/**
 * Fact keys a caller may name in filter_providers, grouped as the site's
 * CRITERIA table groups them (src/lib/difference.ts). Kept succinct and by
 * hand; /providers.json carries the authoritative `fact_labels` map at
 * runtime, and an unknown key is reported back with the valid list.
 */
const CRITERION_KEYS_BY_GROUP =
  'Pricing: free_tier, minimum_paid_price, pricing_model, egress_overage_price, overage_behaviour, startup_credit_program. ' +
  'Limits: entry_plan_storage, entry_plan_memory, sites_included, monthly_visits_cap, bandwidth_included, file_count_limit, build_minutes, concurrent_builds, max_request_duration. ' +
  'Execution: cpu_time_limit, edge_function_timeout, streaming_response_limit, connection_pooling. ' +
  'Deployment: git_deploy, docker_deploy, containers, scheduled_jobs. ' +
  'Infrastructure: persistent_processes, persistent_storage, managed_databases, edge_network, scale_to_zero, autoscaling, regions. ' +
  'Data: engine, max_connections, idle_behaviour, branching, pitr_window, read_replicas, backup_retention, backtrack. ' +
  'Storage: storage_price, operations_price, min_storage_duration, s3_compatible. ' +
  'Observability: events_included, retention_window, session_replay, self_hostable, ingest_price_per_gb, query_price, revenue_attribution, payment_integrations, ai_crawler_tracking. ' +
  'Inference: flagship_input_price, flagship_output_price, budget_input_price, context_window, max_output_tokens, prompt_caching, batch_discount, rate_limits. ' +
  'Email: emails_included, overage_price_per_1000, log_retention, dedicated_ip, inbound_email. ' +
  'Auth: mau_included, sso_connection_price, sso_saml, scim_provisioning, mfa, audit_logs. ' +
  'Queues: work_included, max_message_size, queue_retention, max_delay, concurrency_limit, dead_letter_queue. ' +
  'GPU: gpu_hourly_price, cheapest_gpu_price, max_vram, billing_granularity, reserved_discount. ' +
  'Caching: ops_included, max_dataset_size, persistence, multi_region_replication. ' +
  'Vector: max_dimensions, similarity_metrics, hybrid_search, metadata_filtering. ' +
  'CI/CD: max_job_duration, self_hosted_runners, parallelism_pricing. ' +
  'Secrets: secrets_included, secret_versioning, dynamic_secrets. ' +
  'CDN: pop_count, image_optimization. ' +
  'Documentation: docs_as_code, openapi_support, api_playground, sdk_generation, llms_txt, docs_mcp_server, docs_ai_assistant, docs_versioning. ' +
  'Compliance: cookieless, soc2, iso27001, hipaa_eligible, gdpr_data_residency, pci_dss, encryption_at_rest, customer_managed_keys, rbac, private_networking, dedicated_infrastructure.';

/**
 * Every URL section a provider can publish under, in the order
 * src/data/categories.json declares them. The five hosting sub-types
 * (frontend-serverless, paas, vps-cloud, managed-hosting, mass-market) all
 * publish under /hosting/, so there are fewer sections than category ids.
 *
 * HAND-MAINTAINED, AND IT DRIFTED. This worker is a separate deploy and
 * cannot import the site's categories.json, so this string is a copy — and on
 * 2026-09-16 it still listed the fourteen sections that existed when it was
 * written, against thirty-one on the site. Nothing broke loudly: the string
 * only seeds tool DESCRIPTIONS, and get_provider happily served
 * "sms"/"twilio" while telling agents that sms was not one of the sections
 * they could ask for. A tool that works and documents itself as not working
 * is worse than one that fails, because the agent never tries.
 *
 * src/lib/mcp-tools.test.ts now asserts this string against categories.json,
 * the same way it already asserts the tool names against registerTool.
 * list_categories still derives the live list with counts from
 * /providers.json and is unaffected by this constant.
 */
const SECTIONS_HINT =
  '"hosting", "gpu", "databases", "storage", "caching", "vector-db", "data-api", "federation", "auth", "email", "queues", "payments", "cdn", "observability", "ci-cd", "secrets-mgmt", "analytics", "llm-apis", "search", "dns-hosting", "kubernetes", "iac", "backup", "api-gateway", "load-balancing", "realtime", "waf", "data-warehouse", "etl", "media", "sms", "streaming", "feature-flags", "incident-management", "finops", "docs-platforms", "ztna", "model-hosting"';

/**
 * The planner's stage names and layer keys, in the order plan-layers.ts
 * declares them.
 *
 * HAND-KEPT LIKE SECTIONS_HINT, AND THEY DRIFTED THE SAME WAY. Until
 * 2026-09-16 plan_infrastructure's schema told agents the stages were "mvp",
 * "traction" or "scale". There has never been a traction stage; the five are
 * idea, mvp, growth, scale and enterprise. Asking for "traction" returned a
 * one-line answer and asking for "enterprise" — a real stage the schema did not
 * mention — returned seventy-seven. The layer list named fourteen of
 * thirty-one, and `waf` worked perfectly while being absent from it.
 *
 * Same failure as SECTIONS_HINT and the same cost: the tool worked and its
 * schema said otherwise, so an agent either asked for something that does not
 * exist or never asked for what does. src/lib/mcp-tools.test.ts asserts both
 * against src/lib/plan-layers.ts.
 */
const STAGES_HINT = '"idea", "mvp", "growth", "scale", "enterprise"';
const LAYERS_HINT =
  'hosting, database, storage, auth, email, observability, queues, cdn, caching, vector-db, secrets, ci-cd, llm, gpu, data-api, federation, analytics, payments, search, dns-hosting, kubernetes, iac, backup, api-gateway, load-balancing, realtime, waf, data-warehouse, etl, media, sms, streaming, feature-flags, incident-management, finops, docs, ztna, model-hosting';

const DNS_SLUGS = [
  'a-record', 'aaaa-record', 'cname-record', 'mx-record', 'txt-record', 'ns-record', 'soa-record', 'caa-record', 'ptr-record', 'srv-record',
  'alias-record', 'wildcard-record', 'glue-records', 'spf', 'dkim', 'dmarc', 'dnssec', 'ttl', 'mta-sts', 'bimi', 'email-authentication',
];

function factLine(key: string, fact: PublishedFact, labels: Record<string, string>): string {
  return `  ${labels[key] ?? key}: ${shown(fact)} [verified ${fact.verified_at}, ${fact.source_url}]`;
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

async function fetchPublic(path: string): Promise<{ ok: true; body: string } | { ok: false; status: number; body: string }> {
  // Markdown mirrors, held in no map — they are per-page and there are 1,061
  // of them, so caching them in the isolate would be a memory leak shaped
  // like a cache. The edge is the right place for them instead.
  const res = await fetch(`${SITE}${path}`, { cf: { cacheEverything: true } });
  const body = await res.text();
  return res.ok ? { ok: true, body } : { ok: false, status: res.status, body };
}

/**
 * Tool annotations, declared on every tool rather than left to the client.
 *
 * ChatGPT's developer-mode guide: "We respect the readOnlyHint tool
 * annotation. Tools without this hint are treated as write actions." Until
 * 2026-09-23 no tool here declared it, so every read-only lookup was presented
 * to ChatGPT as a write — and a client reported seeing eight or nine of the
 * nineteen tools, a different number each time. Annotations are hints, not
 * enforcement; they are here so a client can make the right call.
 *
 * openWorldHint is true only where a tool reaches outside inetGeek: the three
 * live DNS tools query third-party public resolvers. Everything else reads
 * this site's own published feeds.
 */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const LIVE_LOOKUP = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/** What a tool handler may need from the request that is being served. */
interface CallContext {
  env: Env;
  request: Request;
}

function buildServer(ctx: CallContext): McpServer {
  const server = new McpServer({
    name: 'inetgeek',
    // `name` is the wire identifier and stays the lowercase slug; `title` is
    // what a client puts in front of a person, and without it the connector
    // rendered as "inetgeek" rather than the brand.
    title: 'inetGeek',
    version: '1.9.0',
    websiteUrl: 'https://inetgeek.com',
    description:
      "Sourced infrastructure comparisons: provider pricing, limits and compliance read from each vendor's own documentation and dated, plus iScore, live DNS/SPF checks and a stack planner.",
    // THE BRAND MARK, declared rather than guessed. A client that shows an
    // icon for a connector either reads it from here or falls back to
    // fetching the server origin's /favicon.ico — and this worker answered
    // that path with a text/plain 404, so neither route found anything and
    // the connector showed a generic placeholder. Both are fixed: these
    // absolute URLs point at the same marks the site serves, and the fetch
    // handler below now answers the conventional icon paths.
    //
    // No `theme` on any entry: the mark is a single orange knot on
    // transparency and reads on light and dark alike, so claiming a
    // light-only or dark-only variant would be a lie about an asset that
    // does not exist.
    //
    // ORDER AND ORIGIN, BOTH CHANGED ON 2026-09-16 AFTER A CONNECTED CLIENT
    // SHOWED A BROKEN-IMAGE GLYPH RATHER THAN A PLACEHOLDER. A placeholder
    // means the icon was never found; a broken image means one was found and
    // would not render, which is a different bug and ours to fix. Every
    // declared URL returned 200 with valid image data and the correct type,
    // the array shape matches the SDK's schema, so neither the assets nor the
    // declaration were wrong. That leaves how a client resolves the list:
    //
    //   PNG FIRST, .ico LAST. A client that picks the best size for its slot
    //   is unaffected by order. A client that takes icons[0] and hands it to
    //   an image pipeline gets a Windows ICO, which browsers render in an
    //   <img> but many image libraries and proxies do not decode at all.
    //   There is no cost to putting the widely-decodable format first.
    //
    //   SAME ORIGIN AS THE MCP ENDPOINT. These used to point at inetgeek.com
    //   while the server answers on workers.dev. A client that declines to
    //   load a connector's icon from a different origin than the connector
    //   itself is being reasonable, and we cannot see that decision from here.
    //   The fetch handler already proxies every one of these paths from the
    //   site, so same-origin URLs serve identical bytes and there is still one
    //   copy of the mark to keep correct.
    //
    // Neither is a proven cause — the client's behaviour is not observable
    // from this repo. Both are strictly safer than what they replace.
    icons: [
      { src: `${SELF}/favicon-192.png`, mimeType: 'image/png', sizes: ['192x192'] },
      { src: `${SELF}/apple-touch-icon.png`, mimeType: 'image/png', sizes: ['180x180'] },
      { src: `${SELF}/favicon-32.png`, mimeType: 'image/png', sizes: ['32x32'] },
      // Served as image/vnd.microsoft.icon, which is what this now claims.
      // image/x-icon is the older alias and a strict client comparing the
      // declared type against the response would see a mismatch.
      { src: `${SELF}/favicon.ico`, mimeType: 'image/vnd.microsoft.icon', sizes: ['16x16', '32x32', '48x48'] },
    ],
  }, {
    // READ BY THE CALLING MODEL AT HANDSHAKE. This server cannot see a project;
    // the AI tool connected to it can. Most weak answers came from a caller
    // asking in the abstract ("best analytics") when the repository it sits in
    // would have settled half the question.
    instructions: [
      'inetGeek is a reference of sourced, dated provider facts. It does not know your user\'s project; you do. Before planning, estimating or comparing, read the project and pass what you find:',
      '- the platform and runtime it deploys on (wrangler.jsonc, vercel.json, netlify.toml, Dockerfile, package.json scripts and dependencies, framework config) -> `platform` and `framework`;',
      '- providers it already runs (dependencies, env var names such as STRIPE_, DATABASE_URL hosts, DNS and deploy config) -> `already_using`, and anything ruled out -> `exclude`;',
      '- real volumes (monthly pageviews or events, users, emails, requests — from its analytics, logs or dashboards if you can reach them; ask the user if not) -> `units` for estimate_monthly_cost;',
      '- hard requirements (data residency, SOC 2, SSO, cookie-free, self-hosting, which payment providers it takes) -> `security` and filter_providers.',
      'Then: plan_infrastructure reports ties as ties (the pick is only alphabetical) — never present a tie as a recommendation; choose among the equals with what you read in the project. estimate_monthly_cost is inetGeek\'s arithmetic on published rates, not a quote. An empty cell means undocumented on the vendor\'s page at the date shown, not a confirmed no. When two of a vendor\'s own pages disagree, get_ledger shows both quotes and no value is recorded.',
    ].join('\n'),
  });

  server.registerTool(
    'list_categories',
    {
      title: 'List inetGeek categories',
      annotations: READ_ONLY,
      description:
        `The infrastructure categories inetGeek tracks — one line per URL section (${SECTIONS_HINT}), each with its current provider count and the category ids that publish under it (hosting groups frontend-serverless, paas, vps-cloud, managed-hosting and mass-market). The section name is the \`category\` argument every other tool takes. Call this first if you don't already know which section a provider falls under. Derived from the published provider list, so it can't lag the site.`,
    },
    async () => {
      const { providers } = await loadProviders();
      const bySection = new Map<string, { count: number; ids: Set<string> }>();
      for (const p of providers) {
        const section = sectionOf(p);
        const row = bySection.get(section) ?? { count: 0, ids: new Set<string>() };
        row.count += 1;
        row.ids.add(p.category);
        bySection.set(section, row);
      }
      const lines = [...bySection.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([section, row]) => `- ${section}: ${row.count} providers (category ids: ${[...row.ids].sort().join(', ')})`);
      return textResult(lines.join('\n'));
    },
  );

  server.registerTool(
    'list_providers',
    {
      title: 'List providers in a category',
      annotations: READ_ONLY,
      description:
        `Every published provider in one category, with its free tier, entry paid price and inetGeek's editorial "best for" line — the orientation call before get_provider. Every figure is the same sourced, dated fact the provider's own page shows; "Not documented" means undocumented as of the page's verification dates, not a confirmed no. \`category\` is a URL section (${SECTIONS_HINT}) or a category id (e.g. "paas", "vps-cloud", "object-storage"); providers also_in a category are listed there too, marked as such.`,
      inputSchema: {
        category: z.string().describe(`URL section such as "databases" or "hosting", or a category id such as "vps-cloud"; see list_categories`),
      },
    },
    async ({ category }) => {
      const wanted = category.trim().toLowerCase();
      const { providers, fact_labels } = await loadProviders();
      const matches = providers.filter(
        (p) => sectionOf(p) === wanted || p.category === wanted || p.also_in.includes(wanted),
      );
      if (matches.length === 0) {
        return textResult(`inetGeek has no published provider in "${category}". Call list_categories for the sections and category ids that exist.`);
      }
      const lines = matches.map((p) => {
        const alsoIn = sectionOf(p) !== wanted && p.category !== wanted ? ` (also_in — canonical category ${p.category})` : '';
        const free = p.facts.free_tier ? shown(p.facts.free_tier) : 'Not documented';
        const entry = p.facts.minimum_paid_price ? shown(p.facts.minimum_paid_price) : 'Not documented';
        return [
          `${p.name}${alsoIn} — ${SITE}${p.path}`,
          `  free tier: ${free}`,
          `  entry price: ${entry}`,
          ...(p.best_for ? [`  best for: ${p.best_for}`] : []),
          `  documented facts: ${Object.keys(p.facts).map((k) => fact_labels[k] ?? k).join(', ')}`,
        ].join('\n');
      });
      return textResult(`${matches.length} providers in ${category}:\n\n${lines.join('\n\n')}`);
    },
  );

  server.registerTool(
    'filter_providers',
    {
      title: 'Filter providers by documented facts',
      annotations: READ_ONLY,
      description:
        `Providers that document ALL of the given fact keys, each with that fact's value, source URL and verification date — the way to answer "which databases are HIPAA eligible" without reading every fact sheet. A provider documenting a key does not mean the answer is yes: read the value (a compliance fact can read "not ISO 27001 certified"; a support fact can be "Limited" or "Not supported"). Absence means undocumented as of the check, not a confirmed no. Valid keys, grouped as the site groups them — ${CRITERION_KEYS_BY_GROUP}`,
      inputSchema: {
        criteria: z.array(z.string()).min(1).describe('Fact keys every returned provider must document, e.g. ["soc2", "hipaa_eligible"]'),
        category: z.string().optional().describe('Restrict to one URL section or category id, e.g. "databases" — see list_categories'),
      },
    },
    async ({ criteria, category }) => {
      const { providers, fact_labels } = await loadProviders();
      const keys = criteria.map((c) => c.trim().toLowerCase());
      const unknown = keys.filter((k) => !(k in fact_labels));
      if (unknown.length > 0) {
        return textResult(`Unknown fact key(s): ${unknown.join(', ')}. Valid keys — ${CRITERION_KEYS_BY_GROUP}`);
      }
      const wanted = category?.trim().toLowerCase();
      const matches = providers.filter(
        (p) =>
          (!wanted || sectionOf(p) === wanted || p.category === wanted || p.also_in.includes(wanted)) &&
          keys.every((k) => k in p.facts),
      );
      if (matches.length === 0) {
        return textResult(
          `No published provider${wanted ? ` in ${category}` : ''} documents every one of: ${keys.map((k) => fact_labels[k]).join(', ')}. That means undocumented on inetGeek as of its checks, not that none exists — try fewer keys.`,
        );
      }
      const lines = matches.map((p) =>
        [`${p.name} (${sectionOf(p)}, ${SITE}${p.path})`, ...keys.map((k) => factLine(k, p.facts[k], fact_labels))].join('\n'),
      );
      return textResult(`${matches.length} providers document ${keys.map((k) => fact_labels[k]).join(' + ')}:\n\n${lines.join('\n\n')}`);
    },
  );

  server.registerTool(
    'list_startup_credit_providers',
    {
      title: 'List providers with a startup credit program',
      annotations: READ_ONLY,
      description:
        'Every inetGeek provider documented as offering a startup credit program, with the amount/eligibility as published, a source, and the date it was checked. Use this to filter for an MVP-stage pick before calling get_provider or get_stack_recommendation for the rest of the decision. Absence from this list means undocumented as of the check, not a confirmed "no program".',
    },
    async () => {
      const result = await fetchPublic('/startup-credits.json');
      if (!result.ok) return textResult(`Could not load the startup-credit list (HTTP ${result.status}).`);
      const data = JSON.parse(result.body) as {
        providers: { id: string; name: string; category: string; path: string; program: string; source_url: string; verified_at: string }[];
      };
      if (data.providers.length === 0) return textResult('No provider currently documents a startup credit program.');
      return textResult(
        data.providers
          .map((p) => `${p.name} (${p.category}, ${SITE}${p.path}) — ${p.program} [verified ${p.verified_at}, ${p.source_url}]`)
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'search_infrastructure',
    {
      title: 'Search inetGeek',
      annotations: READ_ONLY,
      description:
        'Full-text search over every page inetGeek has published — providers, comparisons, DNS records, tools and stacks. Provider entries also match on the human label of every fact their page documents ("SOC 2", "point-in-time recovery", "startup credits"), so a fact name finds the providers that carry it — use filter_providers to get the values. Returns matching page paths, titles and descriptions. Use get_provider or compare_providers afterward to fetch the full sourced content for a result.',
      inputSchema: {
        query: z.string().describe('Free-text search, e.g. "postgres" or "object storage egress"'),
      },
    },
    async ({ query }) => {
      const index = await loadSearchIndex();
      // Everyday words for a capability, widened to the words the fact labels use.
      const asTyped = rankSearchDocs(index.docs, query);
      const added = expandQuery(query, asTyped.tokens);
      const { matches, kept, tokens, absent, bestHits } = added.length ? rankSearchDocs(index.docs, `${query} ${added.join(' ')}`) : asTyped;
      // A concept that is a documented CRITERION is best answered by
      // filter_providers, not by a list of pages that mention the word.
      const { fact_labels } = await loadProviders();
      const criteria = matchCriteria(tokens, fact_labels);
      const criteriaLine = criteria.length
        ? `Documented criteria that match your terms — filter_providers with these keys lists who documents them and the value: ${criteria.map((c) => `${c.label} (${c.key})`).join('; ')}.`
        : '';

      if (matches.length === 0) return textResult(`No inetGeek page matches "${query}".${criteriaLine ? ` ${criteriaLine}` : ''}`);

      // `doc.path` already carries its trailing slash on this endpoint (see
      // search-index.json.ts) — unlike search-index.ts's in-repo builder,
      // which deliberately leaves it off for the sitemap to add.
      const lines = matches.map((m) => `${m.doc.title} (${m.doc.kind}) — ${SITE}${m.doc.path} — ${m.doc.description}`);

      const notes: string[] = [];
      if (tokens.length > 1 && bestHits < tokens.length) {
        notes.push(
          `No page carries all ${tokens.length} of your terms; these match ${bestHits} of them, best first. ` +
            `Narrower single-concept queries work better here than keyword lists.`,
        );
      }
      if (kept > matches.length) notes.push(`${kept} pages matched closely; showing the top ${matches.length}.`);
      // Terms we hold nothing for are worth saying out loud: it is the
      // difference between "inetGeek ranked these badly" and "inetGeek does
      // not cover peering", and only the second is a gap in the data.
      if (absent.length) {
        notes.push(`No page mentions ${absent.map((t) => `"${t}"`).join(', ')}; ranked on the remaining terms.`);
      }
      if (added.length) notes.push(`Also searched for ${added.map((t) => `"${t}"`).join(', ')}, the words the criteria use for what you described.`);
      if (criteriaLine) notes.push(criteriaLine);
      return textResult(notes.length ? `${notes.join(' ')}\n\n${lines.join('\n')}` : lines.join('\n'));
    },
  );

  server.registerTool(
    'get_provider',
    {
      title: 'Get a provider fact sheet',
      annotations: READ_ONLY,
      description:
        "The full sourced fact sheet for one infrastructure provider — pricing, limits and regions, each with a source URL and the date it was last verified against that source — plus its iScore with interval, rank and per-pillar breakdown (see get_provider_score for the criterion-level basis). Use search_infrastructure first if you don't know the exact category/slug.",
      inputSchema: {
        category: z
          .string()
          .describe(`The URL section the provider publishes under — one of ${SECTIONS_HINT}. Note the five hosting sub-types (paas, vps-cloud, …) all publish under "hosting"; list_categories shows which.`),
        slug: z.string().describe('e.g. "neon", "vercel", "cloudflare-r2"'),
      },
    },
    async ({ category, slug }) => {
      const result = await fetchPublic(`/${category}/${slug}.md`);
      if (!result.ok) {
        return textResult(
          `No inetGeek page at ${category}/${slug} (HTTP ${result.status}). Try search_infrastructure to find the right category/slug.`,
        );
      }
      return textResult(result.body);
    },
  );

  server.registerTool(
    'get_provider_score',
    {
      title: "Get a provider's iScore and what moves it",
      annotations: READ_ONLY,
      description:
        "inetGeek's iScore for one provider: 0–100 against its category peers with an 80% interval and rank, the six pillars (price, capacity, capability, trust, evidence, adoption) each with its interval, weight and coverage, every scored criterion with the fact it was read from and the peer median it was measured against, and — for a provider asking how to score higher — the criteria its peers document that it does not. Computed at build from sourced facts by rules published at /iscore/; not a provider claim, not a benchmark, and not comparable across categories. Always report the interval with the number: a thin record is pulled toward the category middle with a wide band, and that band is the finding. `category` here is a CATEGORY ID (\"database\", \"paas\", \"llm-api\"), not a URL section — list_categories shows both.",
      inputSchema: {
        category: z.string().describe('Category id such as "database", "paas", "object-storage" — the canonical category, or one the provider is also_in'),
        provider: z.string().describe('Provider id or name, e.g. "neon" or "Neon"'),
      },
    },
    async ({ category, provider }) => {
      const scores = await loadScores();
      const cat = category.trim().toLowerCase();
      if (!scores.categories[cat]) {
        return textResult(`No scored category "${category}". Category ids with scores: ${Object.keys(scores.categories).sort().join(', ')}.`);
      }
      const r = findScore(scores, cat, provider);
      if (!r) {
        return textResult(`No provider "${provider}" in ${cat}. Providers scored there: ${scores.categories[cat].map((x) => x.id).join(', ')}.`);
      }
      const lines = [
        `${r.name} — iScore ${fmtScore(r)} in ${cat}, computed ${scores.generated_at}.`,
        r.caveat,
        ...(r.readingNotes?.length ? ['', 'Read this score with care:', ...r.readingNotes.map((n) => `- ${n}`)] : []),
        `Method: ${scores.method}`,
        '',
        `Coverage: scored on ${Math.round(r.coverage * 100)}% of the decidable criteria peers document.`,
        '',
        'Pillars:',
      ];
      for (const [key, label] of Object.entries(scores.pillars)) {
        const ps = r.pillars[key];
        if (!ps) {
          lines.push(`- ${label}: not applicable in this category (no peer documents a decidable criterion here)`);
          continue;
        }
        const w = r.weights[key];
        lines.push(
          `- ${label}: ${Math.round(ps.score)} (${Math.round(ps.low)}–${Math.round(ps.high)}), weight ${w !== undefined ? Math.round(w * 100) : 0}%, ${ps.scored}/${ps.applicable} criteria scored`,
        );
        for (const c of ps.criteria) lines.push(`    ${c.key}: ${Math.round(c.score)} (weight ${c.weight.toFixed(2)}) — ${c.basis}`);
        if (ps.missing.length) lines.push(`    scored for peers, not for ${r.name} — either undocumented or stated without a number, a yes/limited/no, or a boolean: ${ps.missing.join(', ')}`);
      }
      lines.push(
        '',
        'To move the number: publish the criteria above as facts a page states plainly — a number with a unit for a limit or a price, yes/limited/no for a capability, a named certification on a trust page — on a URL a plain fetch can read. The score follows the facts; it is never edited directly. Corrections to any existing figure: https://inetgeek.com/contact/',
      );
      return textResult(lines.join('\n'));
    },
  );

  server.registerTool(
    'list_alternatives',
    {
      title: 'Alternatives to a provider, ranked by iScore',
      annotations: READ_ONLY,
      description:
        "Every peer in a provider's category ranked by iScore — the same list as the site's /{section}/{slug}/alternatives/ page — each with its score and interval, free tier, entry price, editorial best-for line, and up to two sourced facts where it differs from the provider named. For an architect choosing a substitute; use get_provider_score on any row for the breakdown, compare_providers where a curated pair exists. Ranks whose intervals overlap are an ordering, not a finding, and are marked. `category` is a CATEGORY ID (\"database\", \"paas\"), not a URL section.",
      inputSchema: {
        category: z.string().describe('Category id such as "database" or "object-storage" — see list_categories'),
        provider: z.string().describe('Provider id or name to find alternatives to, e.g. "neon"'),
      },
    },
    async ({ category, provider }) => {
      const [scores, { providers, fact_labels }] = await Promise.all([loadScores(), loadProviders()]);
      const cat = category.trim().toLowerCase();
      const rows = scores.categories[cat];
      if (!rows) {
        return textResult(`No scored category "${category}". Category ids with scores: ${Object.keys(scores.categories).sort().join(', ')}.`);
      }
      const subject = findScore(scores, cat, provider);
      if (!subject) {
        return textResult(`No provider "${provider}" in ${cat}. Providers there: ${rows.map((x) => x.id).join(', ')}.`);
      }
      const byId = new Map(providers.map((p) => [p.id, p]));
      const subj = byId.get(subject.id);
      const SHORT = 36;
      const lines = rows
        .filter((r) => r.id !== subject.id)
        .map((r) => {
          const p = byId.get(r.id);
          const diffs: string[] = [];
          if (p && subj) {
            for (const [k, f] of Object.entries(p.facts)) {
              const mine = subj.facts[k];
              if (!mine || shown(mine) === shown(f)) continue;
              const theirs = shown(f);
              const ours = shown(mine);
              if (theirs.length <= SHORT && ours.length <= SHORT) diffs.push(`${fact_labels[k] ?? k}: ${theirs} vs ${ours}`);
              if (diffs.length === 2) break;
            }
          }
          return [
            `${r.rank}. ${r.name} — iScore ${fmtScore(r)}${p ? ` — ${SITE}${p.path}` : ''}`,
            ...(p
              ? [
                  `   free tier: ${p.facts.free_tier ? shown(p.facts.free_tier) : 'Not documented'}; entry price: ${p.facts.minimum_paid_price ? shown(p.facts.minimum_paid_price) : 'Not documented'}`,
                ]
              : []),
            ...(p?.best_for ? [`   best for: ${p.best_for}`] : []),
            ...(diffs.length ? [`   differs from ${subject.name} on: ${diffs.join(' · ')}`] : []),
          ].join('\n');
        });
      const path = subj ? `${SITE}${subj.path}alternatives/` : '';
      return textResult(
        `${lines.length} alternatives to ${subject.name} in ${cat}, ranked by iScore (${subject.name} itself: ${fmtScore(subject)}). Computed ${scores.generated_at}; method ${scores.method}.${path ? ` Page: ${path}` : ''}\n\n${lines.join('\n\n')}`,
      );
    },
  );

  server.registerTool(
    'compare_providers',
    {
      title: 'Compare two providers',
      annotations: READ_ONLY,
      description:
        "inetGeek's sourced side-by-side comparison of two providers, where one exists — real differences computed from each provider's own published facts, never templated prose. Pair order doesn't matter; both orderings are tried.",
      inputSchema: {
        a: z.string().describe('First provider slug, e.g. "neon"'),
        b: z.string().describe('Second provider slug, e.g. "supabase"'),
      },
    },
    async ({ a, b }) => {
      for (const [x, y] of [
        [a, b],
        [b, a],
      ]) {
        const result = await fetchPublic(`/compare/${x}-vs-${y}.md`);
        if (result.ok) return textResult(result.body);
      }
      return textResult(
        `inetGeek has no published comparison for ${a} vs ${b} yet — either the pair isn't curated, or it doesn't clear inetGeek's sourcing quality gate. Try get_provider on each individually.`,
      );
    },
  );

  server.registerTool(
    'list_comparisons',
    {
      title: 'List published comparisons',
      annotations: READ_ONLY,
      description:
        "Every side-by-side comparison inetGeek has published, optionally only those involving one provider — so an agent learns which pairs exist before calling compare_providers, instead of discovering a pair is unpublished by trying it. Only pairs that clear the site's sourcing quality gate appear.",
      inputSchema: {
        provider: z.string().optional().describe('Provider slug to restrict to, e.g. "neon"'),
      },
    },
    async ({ provider }) => {
      const index = await loadSearchIndex();
      const slug = provider?.trim().toLowerCase();
      const comparisons = index.docs.filter((doc) => {
        if (doc.kind !== 'comparison') return false;
        if (!slug) return true;
        const pair = doc.path.replace(/^\/compare\//, '').replace(/\/$/, '').split('-vs-');
        return pair.includes(slug);
      });
      if (comparisons.length === 0) {
        return textResult(
          slug
            ? `No published comparison involves "${provider}". Try search_infrastructure to check the slug, or get_provider for its fact sheet alone.`
            : 'No comparisons are published.',
        );
      }
      return textResult(
        `${comparisons.length} published comparisons${slug ? ` involving ${slug}` : ''}:\n` +
          comparisons.map((c) => `- ${c.title} — ${SITE}${c.path}`).join('\n'),
      );
    },
  );

  server.registerTool(
    'get_stack_recommendation',
    {
      title: 'Get hosting recommendations for a framework',
      annotations: READ_ONLY,
      description:
        "Every host that publishes real support for a given framework or runtime, ordered by strength of documentation (a dedicated deployment guide first, a generic one second — there is no numeric score). Each row carries the entry paid plan price. This is the tool for 'what should I deploy X on' — cross-check a candidate's free tier and startup-credit-program facts with get_provider before deciding an MVP-stage pick.",
      inputSchema: {
        framework: z
          .string()
          .describe('e.g. "nextjs", "astro", "django", "wordpress", "laravel", "nodejs", "nuxt", "sveltekit", "ghost", "n8n"'),
      },
    },
    async ({ framework }) => {
      const result = await fetchPublic(`/stacks/${framework}.md`);
      if (!result.ok) {
        return textResult(
          `No inetGeek recommendation page for "${framework}" (HTTP ${result.status}). Try search_infrastructure to find the right slug — note some stacks (e.g. metabase, plausible, strapi) don't have a generic recommendation page yet and only appear paired with a specific host, findable the same way.`,
        );
      }
      return textResult(result.body);
    },
  );

  server.registerTool(
    'plan_infrastructure',
    {
      title: 'Plan an infrastructure stack',
      annotations: READ_ONLY,
      description:
        "inetGeek's /plan/ planner: one suggested starting provider per layer — the cheapest with a documented free tier or a clean USD starting price, ranked by the provider's own facts, never a quality score — with its editorial reason and a floor total. THE TOTAL IS A FLOOR, NOT A PROJECTION: it sums documented entry points ($0 for a real free tier), and a layer whose pricing is usage-based with no flat minimum is listed as excluded, never counted as free; traffic, storage and usage move every number upward (use estimate_monthly_cost for a volume). Pick a stage or name layers explicitly; each stage is a superset of the one before it, and `scale` is most layers rather than all of them. Security requirements re-pick every layer whose providers document those criteria, and say so when no candidate satisfies every requirement rather than picking one anyway. PASS THE PROJECT'S CONTEXT: read its config and dependencies first (wrangler.jsonc, vercel.json, package.json, env var names, Dockerfile) and give `already_using` (providers it runs today), `platform` (the vendor it deploys on) and `exclude`. Without them most layers are TIES — every provider documents a free tier and the pick is only the alphabetically first — and the tool says so layer by layer rather than presenting it as a recommendation. With them, a layer you already cover is left alone, and a tie is broken toward providers on your own platform.",
      inputSchema: {
        stage: z
          .string()
          .optional()
          .describe(
            `One of ${STAGES_HINT}. Each stage is a superset of the one before it; enterprise selects the same layers as scale and differs by requirement, not by layer. Ignored when \`layers\` is given.`,
          ),
        layers: z
          .array(z.string())
          .optional()
          .describe(`Layer keys to plan: ${LAYERS_HINT}`),
        security: z
          .array(z.string())
          .optional()
          .describe('Requirements every pick must document as satisfied: ssoSaml, scimProvisioning, mfa, auditLogs, soc2, iso27001, hipaaEligible, gdprDataResidency, pciDss'),
        framework: z
          .string()
          .optional()
          .describe(
            'Optional application or runtime — "nextjs", "astro", "django", "laravel", "wordpress", "nodejs", "nuxt", "sveltekit", "ghost", "n8n". Appends the hosts that document real support for it, so one call answers "what does a Next.js project at MVP stage need, and who runs it".',
          ),
        already_using: z
          .array(z.string())
          .optional()
          .describe('Providers the project ALREADY uses, by id or name — "cloudflare-pages", "stripe", "Neon". A layer one of them covers is reported as covered and left out of the floor; the rest of the plan is built around them. Find the id with search_infrastructure or list_providers.'),
        platform: z
          .string()
          .optional()
          .describe('The platform the project runs on, as a vendor name: "cloudflare", "aws", "google", "microsoft", "vercel", "digitalocean". Where that vendor sells a provider in a layer it is preferred, because one platform is one bill, one login and one network. Matched on the registrable domain of each provider\'s homepage.'),
        exclude: z
          .array(z.string())
          .optional()
          .describe('Providers the project cannot or will not use (ids or names), e.g. for a licensing, residency or vendor-lock-in reason. Never picked.'),
      },
    },
    async ({ stage, layers, security, framework, already_using, platform, exclude }) => {
      const plan = await loadPlan();
      const validLayers = new Set(plan.results.map((r) => r.key));
      const candidates = plan.candidates ?? {};

      let layerKeys: string[];
      let stageRequirements: string[] = [];
      if (layers && layers.length > 0) {
        const unknown = layers.filter((l) => !validLayers.has(l));
        if (unknown.length > 0) return textResult(`Unknown layer(s): ${unknown.join(', ')}. Valid: ${[...validLayers].join(', ')}.`);
        layerKeys = [...new Set(layers)];
      } else {
        const preset = plan.stages.find((s) => s.key === (stage ?? 'mvp').trim().toLowerCase());
        if (!preset) return textResult(`Unknown stage "${stage}". Valid: ${plan.stages.map((s) => `${s.key} (${s.label})`).join(', ')}.`);
        layerKeys = preset.layerKeys;
        stageRequirements = preset.requirements ?? [];
      }

      // A stage may switch requirements on — today only `enterprise`, which
      // selects Scale's layers and differs from it by requirement alone. An
      // explicit `security` argument wins: the caller said what they need.
      const reqs = (security && security.length > 0 ? security : stageRequirements).map((r) => r.trim());
      const badReqs = reqs.filter((r) => !plan.securityRequirementKeys.includes(r));
      if (badReqs.length > 0) return textResult(`Unknown security requirement(s): ${badReqs.join(', ')}. Valid: ${plan.securityRequirementKeys.join(', ')}.`);

      // PROJECT CONTEXT. The caller's own AI tool can see the repository; this
      // server cannot. Everything below turns what it passes into a decision the
      // alphabet used to make: which layers are already covered, which provider
      // wins a tie, which are off the table. Names that match nothing are
      // reported back, never silently ignored — a typo in `already_using` would
      // otherwise plan and price a layer the project already has.
      const byKey = new Map<string, PlanCandidate>();
      const layersOf = new Map<string, string[]>();
      for (const [layerKey, list] of Object.entries(candidates)) {
        for (const c of list) {
          byKey.set(c.id, c);
          byKey.set(c.name.toLowerCase(), c);
          layersOf.set(c.id, [...(layersOf.get(c.id) ?? []), layerKey]);
        }
      }
      const resolve = (raw: string) => byKey.get(raw.trim().toLowerCase()) ?? byKey.get(raw.trim().toLowerCase().replace(/\s+/g, '-'));
      const used = new Map<string, PlanCandidate>();
      const unrecognised: string[] = [];
      for (const raw of already_using ?? []) {
        const c = resolve(raw);
        if (c) used.set(c.id, c);
        else unrecognised.push(raw);
      }
      const excluded = new Set<string>();
      for (const raw of exclude ?? []) {
        const c = resolve(raw);
        if (c) excluded.add(c.id);
        else unrecognised.push(raw);
      }
      const PLATFORM_ALIASES: Record<string, string> = { aws: 'amazon', gcp: 'google', 'google cloud': 'google', azure: 'microsoft', gh: 'github' };
      const platformRaw = platform?.trim().toLowerCase();
      const platformKey = platformRaw ? PLATFORM_ALIASES[platformRaw] ?? platformRaw.replace(/\s+/g, '') : undefined;

      const lines: string[] = [];
      const covered: string[] = [];
      let total = 0;
      let hasPriced = false;
      const excludedFromTotal: string[] = [];
      let ties = 0;

      for (const key of layerKeys) {
        const base = plan.results.find((r) => r.key === key)!;
        const ranked = (candidates[key] ?? []).filter((c) => !excluded.has(c.id));

        // Already covered by something the project runs: leave the layer alone.
        const have = ranked.filter((c) => used.has(c.id));
        if (have.length > 0) {
          covered.push(base.label);
          lines.push(`${base.label}: already covered by ${have.map((c) => c.name).join(', ')} — kept, not added to the floor — ${SITE}${have[0].href}`);
          continue;
        }

        let pick: { name: string | null; href: string; bestFor: string | null; priceLabel: string; priceUsd: number | null };
        let basis: 'price' | 'tie' | 'platform' | 'security' | 'none' = base.pickBasis;
        let tieNames: { name: string; href: string }[] = [];

        const pool = plan.securityCandidates[key];
        if (pool && reqs.length > 0) {
          // Same rule as the page's client script: with any requirement set,
          // the layer re-picks the cheapest candidate satisfying ALL of them
          // ('yes' only — 'limited' is not an answer to a hard requirement).
          const filtered = pool.filter((c) => reqs.every((r) => c[r] === true) && !excluded.has(String(c.id)));
          const preferred = platformKey ? filtered.find((c) => byKey.get(String(c.id))?.vendor === platformKey) : undefined;
          const chosen = preferred ?? filtered[0];
          pick = chosen
            ? { name: chosen.name, href: chosen.href, bestFor: null, priceLabel: chosen.priceLabel, priceUsd: chosen.priceUsd }
            : { name: null, href: base.href, bestFor: null, priceLabel: 'No provider documents this combination — see category page', priceUsd: null };
          basis = chosen ? (preferred ? 'platform' : 'security') : 'none';
        } else if (ranked.length === 0) {
          pick = { name: null, href: base.href, bestFor: null, priceLabel: 'No provider left in this layer after exclusions', priceUsd: null };
          basis = 'none';
        } else {
          const onPlatform = platformKey ? ranked.find((c) => c.vendor === platformKey && c.primary === ranked[0].primary) ?? ranked.find((c) => c.vendor === platformKey) : undefined;
          const top = onPlatform ?? ranked[0];
          const stillBase = top.id === base.providerId;
          pick = { name: top.name, href: top.href, bestFor: stillBase ? base.bestFor : null, priceLabel: top.priceLabel, priceUsd: top.priceUsd };
          if (onPlatform) {
            basis = 'platform';
          } else {
            // Recomputed here because an exclusion can change who the tie is between.
            const equals = ranked.slice(1).filter((c) => c.primary === top.primary && c.priceUsd === top.priceUsd);
            basis = equals.length > 0 ? 'tie' : 'price';
            tieNames = equals.map((c) => ({ name: c.name, href: c.href }));
          }
        }

        if (pick.priceUsd !== null) {
          total += pick.priceUsd;
          hasPriced = true;
        } else {
          excludedFromTotal.push(base.label);
        }

        const head = pick.name
          ? `${base.label}: ${pick.name} — ${pick.priceLabel} — ${SITE}${pick.href}${pick.bestFor ? `\n  why: ${pick.bestFor}` : ''}`
          : `${base.label}: ${pick.priceLabel} — ${SITE}${base.href}`;
        const extra: string[] = [];
        if (basis === 'platform') extra.push(`  basis: on your platform (${platform}) — chosen over the cheapest provider in this layer`);
        if (basis === 'tie') {
          ties += 1;
          extra.push(
            `  TIE, NOT A RECOMMENDATION: ${tieNames.length + 1} providers document the same starting price here, and ${pick.name} is only the first alphabetically. Others: ${tieNames.slice(0, 10).map((t) => t.name).join(', ')}${tieNames.length > 10 ? `, and ${tieNames.length - 10} more` : ''}. Choose on what the project needs (compare_providers, filter_providers), or pass already_using / platform / exclude.`,
          );
        }
        if (pick.name) extra.push(`  every ${base.label.toLowerCase()} provider: ${SITE}${base.href}`);
        lines.push([head, ...extra].join('\n'));
      }

      const totalLine = hasPriced ? `Starting floor for these layers: $${total}/mo` : 'No priceable layers picked';
      const excludedLine =
        excludedFromTotal.length > 0 ? `\nNot counted above (no clean starting price documented, usage-based): ${excludedFromTotal.join(', ')}.` : '';
      const coveredLine = covered.length > 0 ? `\nAlready covered by what you use (not counted): ${covered.join(', ')}.` : '';
      const tieLine =
        ties > 0 ? `\n${ties} of ${layerKeys.length} layers above are ties decided alphabetically. Without project context this is a list of equals, not a plan.` : '';

      // A provider the caller says it uses that covers no chosen layer: say where it belongs.
      const strays = [...used.values()].filter((c) => !(layersOf.get(c.id) ?? []).some((l) => layerKeys.includes(l)));
      const strayLine =
        strays.length > 0
          ? `\nYou said you use ${strays.map((c) => `${c.name} (a ${(layersOf.get(c.id) ?? []).join('/')} provider)`).join(', ')}; none of the planned layers is theirs, so they changed nothing above. Add the layer to plan around it.`
          : '';
      const unrecognisedLine =
        unrecognised.length > 0
          ? `\nNot recognised, so ignored: ${unrecognised.join(', ')}. Use a provider id or name as list_providers shows it.`
          : '';

      // A layer that does nothing on its own, picked without the layer it needs.
      // Reported rather than silently added: the caller asked for a specific
      // set and inetGeek's reading of a dependency is not a reason to override
      // it. Same status as a stage preset — visible, and yours to ignore.
      const chosen = new Set(layerKeys);
      const unmet: string[] = [];
      for (const key of layerKeys) {
        const layer = plan.results.find((r) => r.key === key);
        for (const req of layer?.requires ?? []) {
          if (!chosen.has(req)) {
            const reqLabel = plan.results.find((r) => r.key === req)?.label ?? req;
            unmet.push(`${layer!.label} needs ${reqLabel}`);
          }
        }
      }
      const dependencyLine =
        unmet.length > 0
          ? `\n\nLayers picked without something they depend on: ${unmet.join('; ')}. Not added for you — add the layer or ignore this.`
          : '';

      // The application, when one was named. A stack is a set of layers AND the
      // thing running on it, and answering both in one call is the difference
      // between a plan and a list.
      let frameworkBlock = '';
      if (framework) {
        const slug = framework.trim().toLowerCase();
        const doc = await fetchPublic(`/stacks/${slug}.md`);
        frameworkBlock = doc.ok
          ? `\n\n--- Hosts documenting support for ${slug} ---\n${doc.body.trim()}`
          : `\n\nNo inetGeek recommendation page for "${slug}" (HTTP ${doc.status}); the layers above are unaffected. Try search_infrastructure for the right slug.`;
      }

      return textResult(
        `${lines.join('\n\n')}\n\n${totalLine}${excludedLine}${coveredLine}${tieLine}${strayLine}${unrecognisedLine}${dependencyLine}\n\nThis is not what you will pay — it is the sum of each layer's cheapest documented starting point. See ${SITE}/plan/ to change any pick.${frameworkBlock}`,
      );
    },
  );

  server.registerTool(
    'estimate_monthly_cost',
    {
      title: 'Estimate monthly cost at a stated volume',
      annotations: READ_ONLY,
      description:
        "What each provider that publishes a per-volume price would charge a month at the volume you state — plan fee plus any overage, cheapest first, each with the plan, the formula, the vendor page it came from and the date it was read. This is INETGEEK'S ARITHMETIC ON PUBLISHED RATES, not a quote and not a projection: taxes, currency, annual discounts and a vendor's own definition of its unit are outside it, and it says so beside every figure. Covers web analytics (pageviews or events), email (emails sent a month) and auth (monthly active users) — see the `unit` argument; a provider absent from the list has no readable per-volume price on file, which says nothing about its price — use get_provider. Get the volume from the project (its analytics, logs or dashboards) rather than guessing, and say which unit it is: a vendor that counts events is not counting pageviews (Umami counts each saved event property as another event; Traks's own page counts a pageview as about two events — pass `events_per_pageview` for those plans).",
      inputSchema: {
        category: z.string().optional().describe('URL section or category id to price, e.g. "analytics". Omit for every category with per-volume prices on file.'),
        units: z.number().positive().describe('The monthly volume, in the unit named by `unit`.'),
        unit: z.enum(['pageviews', 'events', 'emails', 'mau']).default('pageviews').describe('What `units` counts: pageviews or events (web analytics), emails sent a month (email), or monthly active users (auth). Only pageviews and events are ever converted into each other, with `events_per_pageview`, and the output says so.'),
        events_per_pageview: z.number().positive().default(1).describe('Events recorded per pageview, used only to compare a pageviews figure against plans that bill in events (or the reverse). 1 means a bare pageview and no custom events.'),
        sites: z.number().int().positive().optional().describe('How many websites the plan must cover. Plans with a stated lower cap are skipped; plans that state no site cap are kept and flagged.'),
      },
    },
    async ({ category, units, unit, events_per_pageview, sites }) => {
      const [{ plans }, { providers }] = await Promise.all([loadUsagePricing(), loadProviders()]);
      const wanted = category?.trim().toLowerCase();
      const comparable = (u: UsagePlanRow['unit']) => u === unit || (['pageviews', 'events'].includes(u) && ['pageviews', 'events'].includes(unit));
      // No currency conversion, here or anywhere on the site: a plan priced in
      // another currency is named and left out of the comparison.
      const foreign = [...new Set(plans.filter((p) => p.currency && p.currency !== 'USD').map((p) => `${p.name} (${p.currency})`))];
      const inScope = plans.filter((p) => (!p.currency || p.currency === 'USD') && (!wanted || p.category === wanted || p.path.split('/')[1] === wanted) && comparable(p.unit));
      if (inScope.length === 0) {
        const have = [...new Set(plans.map((p) => `${p.path.split('/')[1]} (${p.unit === 'events' ? 'pageviews/events' : p.unit})`))].sort();
        return textResult(`No per-volume prices on file for ${unit}${category ? ` in "${category}"` : ''}. Covered: ${have.join(', ') || 'none yet'}. For any other provider, get_provider has its entry price and pricing model as published.`);
      }

      const convert = (row: UsagePlanRow): { needed: number; note: string | null } =>
        row.unit === unit
          ? { needed: units, note: null }
          : unit === 'pageviews'
            ? { needed: units * events_per_pageview, note: `converted at ${events_per_pageview} event(s) per pageview` }
            : { needed: units / events_per_pageview, note: `converted at ${events_per_pageview} event(s) per pageview` };

      const byProvider = new Map<string, UsagePlanRow[]>();
      for (const p of inScope) byProvider.set(p.provider, [...(byProvider.get(p.provider) ?? []), p]);

      const n = (x: number) => x.toLocaleString('en-US');
      const money = (x: number) => `$${x.toFixed(x < 100 ? 2 : 0)}`;
      const priced: { cost: number; line: string }[] = [];
      const cannot: string[] = [];
      for (const [, allRows] of byProvider) {
        const rows = allRows.filter((r) => r.quote_above === undefined);
        const quotes = allRows.filter((r) => r.quote_above !== undefined);
        let best: { range: [number, number]; row: UsagePlanRow; needed: number; note: string | null; siteNote: string | null } | undefined;
        let volumeFits = false;
        let highest = 0;
        for (const row of rows) {
          const { needed, note } = convert(row);
          highest = Math.max(highest, row.overage_usd_per_unit == null && !row.overage_tiers && !row.overage_block ? row.included ?? Infinity : row.max_units ?? Infinity);
          const range = priceRange(row, needed);
          if (range === null) continue;
          volumeFits = true;
          if (sites !== undefined && !row.sites_unlimited && row.sites != null && row.sites < sites) continue;
          if (!best || range[0] < best.range[0]) best = { range, row, needed, note, siteNote: sites !== undefined && row.sites == null && !row.sites_unlimited ? `the page states no site cap, so ${sites} site(s) is unchecked` : null };
        }
        const name = allRows[0].name;
        if (!best) {
          // Above the top printed band the vendor may say outright that it sells by quote.
          const quoted = quotes.filter((q) => convert(q).needed >= (q.quote_above as number));
          cannot.push(
            volumeFits
              ? `${name}: a plan on file covers this volume, but none that states a site cap covers ${sites} sites.`
              : quoted.length
                ? `${name}: no price is printed at this volume, and its pricing page sells it by quote ("contact" or "custom"): ${quoted.map((q) => `${q.plan} (quote-only above ${n(q.quote_above as number)})`).join('; ')}.`
                : `${name}: ${n(units)} ${unit} is above the largest band on file (${n(highest)} ${rows[0].unit}); the vendor sells it, but no price for it is on file.`,
          );
          continue;
        }
        const { range, row, needed, note, siteNote } = best;
        const monthly = row.monthly_usd ?? 0;
        const included = row.included ?? Infinity;
        const over = needed - included;
        const volume = row.uncapped === 'unlimited' ? 'unlimited use' : row.uncapped === 'fair-use' ? 'fair use, no number stated' : `covers up to ${n(included)} ${row.unit}`;
        const formula =
          needed <= included
            ? `${row.plan}: $${monthly}/mo, ${volume}`
            : row.overage_block
              ? `${row.plan}: $${monthly}/mo + $${row.overage_block.usd} per additional ${n(row.overage_block.size)} ${row.unit} for ${n(over)} extra${row.overage_block.granularity === 'unstated' ? ' (the page does not say whether a part block is prorated or billed whole, so this is a range)' : ''}`
              : row.overage_tiers
                ? `${row.plan}: $${monthly}/mo + ${n(over)} extra ${row.unit} at the printed marginal rates ($${row.overage_tiers.map((x) => x.per_unit).join(' → $')})`
                : `${row.plan}: $${monthly}/mo + ${n(over)} extra ${row.unit} x $${row.overage_usd_per_unit}`;
        // The table's own caption says how the vendor counts its unit, which is
        // exactly what a converted figure depends on: shown whenever units were
        // converted, so "events" is never silently read as "pageviews".
        const unitNote = note && row.note ? `how the vendor counts: ${row.note.slice(0, 280)}${row.note.length > 280 ? '…' : ''}` : null;
        // When the figure includes an overage, the table's caption carries the
        // conditions on that rate (a ceiling, a first band, a rate that falls at
        // volume), and those decide how far the number can be trusted.
        const overageNote = needed > included && row.note ? `about the rate: ${row.note.slice(0, 300)}${row.note.length > 300 ? '…' : ''}` : null;
        const flags = [note, unitNote, overageNote && !unitNote ? overageNote : null, siteNote, row.term].filter(Boolean).join('; ');
        const cost = range[0] === range[1] ? money(range[0]) : `${money(range[0])}–${money(range[1])}`;
        const once = row.one_time_usd ? ` + $${row.one_time_usd} one time` : '';
        priced.push({
          cost: range[0],
          line: `${cost}/mo${once} — ${row.name} — ${formula}${flags ? ` (${flags})` : ''} — ${SITE}${row.path} — read ${row.verified_at}, ${row.source_url}`,
        });
      }
      priced.sort((a, b) => a.cost - b.cost);

      // Providers in the same section with nothing on file: named WITH what
      // their own page says the entry price is, so an absent row reads as "no
      // per-volume schedule" (a one-time licence, a free service, a price the
      // page never paints) rather than "not an option".
      const sections = new Set(inScope.map((p) => p.path.split('/')[1]));
      const trim = (t: string) => (t.length > 170 ? `${t.slice(0, 167)}…` : t);
      const missing = providers
        .filter((p) => sections.has(sectionOf(p)) && !byProvider.has(p.id))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => {
          const entry = p.facts.minimum_paid_price ?? p.facts.pricing_model;
          const free = p.facts.free_tier?.value === true ? 'has a free tier' : null;
          const said = entry ? `its page says: ${trim(shown(entry))} [read ${entry.verified_at}]` : free ?? 'no entry price documented';
          return `${p.name} — ${said} (${SITE}${p.path})`;
        });

      return textResult(
        [
          `At ${units.toLocaleString('en-US')} ${unit} a month${sites ? `, ${sites} site(s)` : ''}. inetGeek's arithmetic on each vendor's published rates — not a quote; taxes, currency and the vendor's own definition of its unit are outside it.`,
          '',
          ...(priced.length ? priced.map((x) => x.line) : ['No provider on file can be priced at this volume.']),
          ...(cannot.length ? ['', 'Not priced here:', ...cannot.map((c) => `- ${c}`)] : []),
          ...(foreign.length ? ['', `Priced in another currency, which this tool does not convert: ${foreign.join(', ')}.`] : []),
          ...(missing.length ? ['', 'No per-volume schedule on file, so not compared here (see get_provider for the full record):', ...missing.map((m) => `- ${m}`)] : []),
        ].join('\n'),
      );
    },
  );

  server.registerTool(
    'get_changelog',
    {
      title: 'What changed on inetGeek',
      annotations: READ_ONLY,
      description:
        'Every provider fact that moved — a price or limit that changed (before, after, source, date), a fact newly sourced, or a provider newly published — derived from the git history of the site data, so it cannot disagree with the pages. Value changes are listed first: a price that moved is the news, a fact newly sourced is inventory. Ask "what changed since I last planned" with `since`; narrow to one provider with `provider`. Returns the most recent entries (the feed carries the last 100).',
      inputSchema: {
        since: z.string().optional().describe('ISO date (YYYY-MM-DD); only entries on or after it'),
        provider: z.string().optional().describe('Provider slug, e.g. "neon"'),
      },
    },
    async ({ since, provider }) => {
      const result = await fetchPublic('/changelog.json');
      if (!result.ok) return textResult(`Could not load the changelog (HTTP ${result.status}).`);
      const data = JSON.parse(result.body) as ChangelogFile;
      if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) return textResult('`since` must be an ISO date, YYYY-MM-DD.');
      const slug = provider?.trim().toLowerCase();
      const entries = data.entries.filter((e) => (!since || e.date >= since) && (!slug || e.id === slug)).slice(0, 50);
      if (entries.length === 0) {
        return textResult(`No recorded change${slug ? ` for ${provider}` : ''}${since ? ` since ${since}` : ''} in the last 100 entries (feed generated ${data.generated_at}).`);
      }
      const lines = entries.map((e) => {
        const head = `${e.date} ${e.kind}${e.cause ? `:${e.cause}` : ''} — ${e.name}${e.field ? ` / ${e.field}` : ''}`;
        const body =
          e.kind === 'value-changed'
            ? `\n  from: ${e.from}\n  to: ${e.to}`
            : e.kind === 'fact-added'
              ? `\n  now: ${e.to}`
              : '';
        return `${head}${body}${e.source ? `\n  source: ${e.source}` : ''}`;
      });
      return textResult(`Changelog generated ${data.generated_at}; ${entries.length} entries${since ? ` since ${since}` : ''}${slug ? ` for ${slug}` : ''}:\n\n${lines.join('\n\n')}`);
    },
  );

  server.registerTool(
    'get_dns_record',
    {
      title: 'DNS record reference',
      annotations: READ_ONLY,
      description:
        `inetGeek's reference page for one DNS record type or email-authentication mechanism, as text — what it does, how it behaves, and the common mistakes. Reference text, not a live lookup; use check_dns for a domain's actual records. Types: ${DNS_SLUGS.join(', ')}.`,
      inputSchema: { type: z.string().describe('e.g. "cname", "mx-record", "spf", "dmarc", "ttl"') },
    },
    async ({ type }) => {
      const base = type.trim().toLowerCase().replace(/\s+/g, '-').replace(/-records?$/, '');
      const candidates = [...new Set([base, `${base}-record`, `${base}-records`])].filter((c) => DNS_SLUGS.includes(c));
      for (const slug of candidates) {
        const result = await fetchPublic(`/dns/${slug}.md`);
        if (result.ok) return textResult(result.body);
      }
      return textResult(`No inetGeek DNS reference page for "${type}". Types: ${DNS_SLUGS.join(', ')}.`);
    },
  );

  server.registerTool(
    'check_dns',
    {
      title: 'Live DNS lookup',
      annotations: LIVE_LOOKUP,
      description:
        "Queries public DNS-over-HTTPS resolvers for a domain's A/AAAA/CNAME/MX/TXT/NS records right now, via inetGeek's own rate-limited lookup endpoint. Nothing queried is stored.",
      inputSchema: { domain: z.string().describe('e.g. "example.com"') },
    },
    async ({ domain }) => {
      const result = await fetchPublic(`/api/dns?domain=${encodeURIComponent(domain)}`);
      return textResult(result.ok ? result.body : `DNS lookup failed (HTTP ${result.status}): ${result.body}`);
    },
  );

  server.registerTool(
    'check_spf',
    {
      title: 'Live SPF check',
      annotations: LIVE_LOOKUP,
      description:
        "Evaluates a domain's SPF record right now, including the RFC 7208 ten-DNS-lookup limit, via inetGeek's own checker. Nothing queried is stored.",
      inputSchema: { domain: z.string().describe('e.g. "example.com"') },
    },
    async ({ domain }) => {
      const result = await fetchPublic(`/api/spf?domain=${encodeURIComponent(domain)}`);
      return textResult(result.ok ? result.body : `SPF check failed (HTTP ${result.status}): ${result.body}`);
    },
  );

  server.registerTool(
    'check_dns_propagation',
    {
      title: 'Check DNS propagation',
      annotations: LIVE_LOOKUP,
      description:
        'Queries four independent public DNS resolvers for one record and compares their answers, to check whether a change has propagated. Nothing queried is stored.',
      inputSchema: {
        domain: z.string().describe('e.g. "example.com"'),
        type: z.string().optional().describe('Record type, defaults to "A" — e.g. "A", "AAAA", "CNAME", "MX", "TXT"'),
      },
    },
    async ({ domain, type }) => {
      const params = new URLSearchParams({ domain });
      if (type) params.set('type', type);
      const result = await fetchPublic(`/api/propagation?${params.toString()}`);
      return textResult(result.ok ? result.body : `Propagation check failed (HTTP ${result.status}): ${result.body}`);
    },
  );

  server.registerTool(
    'get_ledger',
    {
      title: 'What inetGeek says it could not find, and what it changed',
      annotations: READ_ONLY,
      description:
        "inetGeek's public ledger. Four records an agent cannot get anywhere else: every vendor page that was READ on a stated date and found silent on a criterion, every criterion classed as one a product structurally cannot have, every case where two pages of the SAME vendor contradict each other on a criterion (both quotes and both URLs, with no value recorded — a vendor whose docs say crawlers are dropped while its homepage says they are counted is one), and every change to a published figure with whether the vendor moved it or inetGeek corrected its own reading. A silence record is an observation about one page on one date — it is NOT a statement that the provider lacks the thing, and it must not be reported as one. It exists because comparisons lean on it: a documented criterion outranks a page that was read and does not mention it, and that lean is only fair if the evidence behind it is checkable. A provider whose page says more than was found can send the URL to https://inetgeek.com/contact/ and the row is replaced. Filter to one provider with `provider`, or omit it for the whole ledger.",
      inputSchema: {
        provider: z
          .string()
          .optional()
          .describe('Provider id, e.g. "sentry" or "auth0". Omit for every provider.'),
      },
    },
    async ({ provider }) => {
      const result = await fetchPublic('/ledger.json');
      if (!result.ok) return textResult(`Ledger unavailable (HTTP ${result.status}).`);
      if (!provider) return textResult(result.body);
      let parsed: {
        not_stated?: { id: string }[];
        source_disagreements?: { id: string }[];
        not_offered?: { id: string }[];
        recent_changes?: { id: string }[];
        corrections?: string;
      };
      try {
        parsed = JSON.parse(result.body);
      } catch {
        return textResult(result.body);
      }
      const id = provider.toLowerCase();
      const pick = <T extends { id: string }>(rows: T[] | undefined) =>
        (rows ?? []).filter((r) => r.id.toLowerCase() === id);
      const scoped = {
        provider: id,
        corrections: parsed.corrections,
        not_stated: pick(parsed.not_stated),
        not_offered: pick(parsed.not_offered),
        source_disagreements: pick(parsed.source_disagreements),
        changes: pick(parsed.recent_changes),
      };
      if (!scoped.not_stated.length && !scoped.not_offered.length && !scoped.changes.length && !scoped.source_disagreements.length) {
        return textResult(
          `Nothing in the ledger for "${provider}": no criterion recorded as unstated on its pages, none classed as not offered, and no published figure changed in the recent window. That is the ordinary case.`,
        );
      }
      return textResult(JSON.stringify(scoped, null, 2));
    },
  );

  // ------------------------------------------------------------ feedback
  //
  // THE ONE TOOL THAT WRITES. Everything above reads inetGeek's published
  // data; this records a note for the maintainer and nothing else. It cannot
  // change a figure, a page or a score — a correction is read by a person,
  // checked against the vendor's own page with scripts/triage-correction.mjs,
  // and applied by the same import every other fact goes through.
  //
  // What is stored is what the agent submits, its User-Agent and the time —
  // see migrations/0001_feedback.sql. The IP is the rate-limit key and is
  // never written. Every free-text field is untrusted input to whoever reads
  // it later, and scripts/mcp-feedback.mjs treats it that way.
  server.registerTool(
    'send_feedback',
    {
      title: 'Send feedback about the inetGeek MCP server',
      description:
        "Tell inetGeek's maintainer something is wrong, missing or confusing in this MCP server's data or tools — a figure that disagrees with the vendor's own page, a tool that errored or returned something unusable, a provider or criterion you needed and could not get, or a tool whose output misled you. Read by a person; nothing is applied automatically, and a data correction is only made after it is checked against the provider's own published page. " +
        'For wrong_data, include `provider` and `criterion` (the ids the other tools use) and `evidence_url`: the provider\'s OWN page that states the correct value — a third-party page cannot be used. For tool problems, name the `tool` and put the arguments you passed and what came back in `observed`. ' +
        "Do NOT include personal data, credentials, API keys, your user's code, or anything from your conversation that your user has not agreed to share: this is stored. This is the only tool on this server that writes anything.",
      inputSchema: {
        kind: z
          .enum(['wrong_data', 'missing_data', 'tool_error', 'tool_confusing', 'feature_request', 'other'])
          .describe(
            'wrong_data: a figure disagrees with the vendor\'s page. missing_data: a provider, criterion or figure you needed is absent. tool_error: a tool failed. tool_confusing: a tool worked but its output misled you. feature_request: a tool or field that does not exist. other: anything else.',
          ),
        message: z
          .string()
          .min(10)
          .max(2000)
          .describe('What is wrong or missing, in plain language. Specific beats long.'),
        tool: z.string().max(64).optional().describe('The tool concerned, e.g. "get_provider".'),
        provider: z
          .string()
          .regex(/^[a-z0-9-]{1,64}$/)
          .optional()
          .describe('Provider id as the other tools return it, e.g. "neon".'),
        criterion: z
          .string()
          .regex(/^[a-z0-9_]{1,64}$/)
          .optional()
          .describe('Fact key as the other tools return it, e.g. "free_tier".'),
        evidence_url: z
          .string()
          .url()
          .max(500)
          .optional()
          .describe("For wrong_data: the provider's own page that states the correct value."),
        observed: z
          .string()
          .max(1000)
          .optional()
          .describe('What you passed and what came back, or what the page currently shows.'),
        expected: z.string().max(1000).optional().describe('What you expected instead.'),
        client: z
          .string()
          .max(64)
          .optional()
          .describe('The agent or client product sending this, e.g. "Claude Code". Not a person\'s name.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const db = ctx.env.FEEDBACK;
      if (!db) {
        return textResult(
          'Feedback is not being collected on this deployment of the server (no FEEDBACK database is bound). Report it at https://inetgeek.com/contact/ instead.',
        );
      }
      if (ctx.env.FEEDBACK_RATE_LIMIT) {
        // Keyed on the connecting IP, used only to count; never stored.
        const key = ctx.request.headers.get('cf-connecting-ip') ?? 'unknown';
        const { success } = await ctx.env.FEEDBACK_RATE_LIMIT.limit({ key });
        if (!success) {
          return {
            content: [{ type: 'text' as const, text: 'Too many feedback calls from this client in the last minute. Send one combined report, or try again shortly.' }],
            isError: true,
          };
        }
      }
      const id = `fb_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const userAgent = (ctx.request.headers.get('user-agent') ?? '').slice(0, 160) || null;
      await db
        .prepare(
          `INSERT INTO feedback (id, received_at, kind, tool, provider, criterion, evidence_url, message, observed, expected, client, user_agent)
           VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          args.kind,
          args.tool ?? null,
          args.provider ?? null,
          args.criterion ?? null,
          args.evidence_url ?? null,
          args.message,
          args.observed ?? null,
          args.expected ?? null,
          args.client ?? null,
          userAgent,
        )
        .run();
      const next =
        args.kind === 'wrong_data'
          ? args.evidence_url
            ? " It will be checked against the page you cited; if that page is the provider's own and states a different value, the figure is corrected and the change appears at https://inetgeek.com/ledger/."
            : " No evidence_url was given, so it can only be checked against inetGeek's existing source. Sending the provider's own page that states the correct value makes it actionable."
          : '';
      return textResult(`Recorded as ${id}. A person reads every report; nothing is applied automatically.${next}`);
    },
  );

  return server;
}

interface Env {
  /**
   * Usage counting. Optional on the type so the worker still runs where the
   * binding is absent (a bare `wrangler dev`, a preview without it) rather
   * than throwing on a line that exists only to count.
   */
  USAGE?: AnalyticsEngineDataset;
  /** Feedback from send_feedback. Optional so a copy without it still runs. */
  FEEDBACK?: D1Database;
  /** Per-IP limit on send_feedback; the key is never stored. */
  FEEDBACK_RATE_LIMIT?: RateLimit;
}

/**
 * What a call was, in two words, for the usage counter.
 *
 * WHAT IS RECORDED AND WHAT IS NOT. The JSON-RPC method, and one companion
 * that depends on it: for `initialize`, the client's own self-declared name
 * ("claude-ai", "Claude Desktop", "cursor") — which is the only thing here
 * that says anything about who is calling, and it is a product name the
 * client volunteers about itself, not about its user. For `tools/call`, the
 * tool name, which is the number actually worth having: whether
 * get_provider_score and list_alternatives get used at all was unknown
 * before this. Everything else records the method alone.
 *
 * ALSO RECORDED, from 1.5.0: the User-Agent, which names the client software
 * and version. It is here because `clientInfo` arrives ONLY on the handshake,
 * and this server is stateless — so a client that handshook once then calls
 * tools forever after is, on every one of those calls, anonymous. Two clients
 * were demonstrably connected and driving traffic while the handshake table
 * read 1, which is a counter reporting its own blind spot rather than the
 * world. The User-Agent is on every request and names software rather than a
 * person, so it closes that gap at the smallest cost.
 *
 * DELIBERATELY ABSENT: the IP address, every other header, and every argument
 * value. A domain someone checks with check_dns, a provider they look up —
 * none of it is written anywhere, which is what /mcp/ and the privacy policy
 * say, so it has to stay true here. A counter that grew to hold arguments
 * would make both pages wrong.
 *
 * THIS IS NOT A COUNT OF INSTALLS, and no arrangement of this data can be.
 * The server is stateless — no session, no account, no cookie — so a client
 * that reconnects is indistinguishable from a new one. `initialize` counts
 * handshakes, which rise when someone adds the connector AND every time a
 * client restarts. Read it as activity, never as users.
 */
function usageOf(body: unknown): { event: string; who: string }[] {
  const one = (msg: unknown): { event: string; who: string } | null => {
    if (typeof msg !== 'object' || msg === null) return null;
    const m = msg as { method?: unknown; params?: Record<string, unknown> };
    if (typeof m.method !== 'string') return null;
    if (m.method === 'initialize') {
      const info = m.params?.clientInfo as { name?: unknown } | undefined;
      return { event: 'initialize', who: typeof info?.name === 'string' ? info.name : 'unnamed' };
    }
    if (m.method === 'tools/call') {
      const name = m.params?.name;
      return { event: 'tools/call', who: typeof name === 'string' ? name : 'unnamed' };
    }
    return { event: m.method, who: '' };
  };
  // A JSON-RPC payload may be one message or a batch of them.
  const list = Array.isArray(body) ? body : [body];
  return list.map(one).filter((x): x is { event: string; who: string } => x !== null);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Icon paths, proxied from the site so there is one copy of the mark.
    // A client that does not read `icons` off the initialize result falls
    // back to the server origin's favicon, and every one of these used to be
    // a text/plain 404 here — which is why the connector showed a generic
    // placeholder. Proxied rather than redirected because a favicon fetcher
    // that declines to follow a cross-origin redirect is a failure mode with
    // no symptom, and a subrequest to our own zone is cheap.
    const ICON_PATHS: Record<string, string> = {
      '/favicon.ico': '/favicon.ico',
      '/favicon.png': '/favicon-32.png',
      '/favicon-32.png': '/favicon-32.png',
      '/favicon-192.png': '/favicon-192.png',
      '/apple-touch-icon.png': '/apple-touch-icon.png',
      '/icon.png': '/favicon-192.png',
    };
    const icon = ICON_PATHS[url.pathname];
    if (icon) {
      const upstream = await fetch(`${SITE}${icon}`, { cf: { cacheEverything: true } });
      if (!upstream.ok) return new Response('Icon unavailable.', { status: 502 });
      const headers = new Headers(upstream.headers);
      headers.set('cache-control', 'public, max-age=86400');
      // An <img> needs no CORS, but a client that fetch()es the mark to cache
      // or re-host it does, and a connector UI is as likely to do the second.
      // Failing that fetch looks identical to having no icon at all.
      headers.set('access-control-allow-origin', '*');
      return new Response(upstream.body, { status: 200, headers });
    }

    // The server card, served from the origin a client actually connected to.
    // It also lives at inetgeek.com/.well-known/mcp.json, but a client handed
    // only this worker's URL has no reason to know the site exists — and
    // looking for discovery metadata where you connected is the whole point of
    // a well-known path. Proxied so there is one copy to keep correct.
    if (url.pathname === '/.well-known/mcp.json') {
      const upstream = await fetch(`${SITE}/.well-known/mcp.json`, { cf: { cacheEverything: true } });
      if (!upstream.ok) return new Response('Server card unavailable.', { status: 502 });
      return new Response(upstream.body, {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=3600',
          'access-control-allow-origin': '*',
        },
      });
    }

    if (url.pathname !== '/mcp') {
      return new Response(
        'inetGeek MCP server — sourced infrastructure comparisons, read-only apart from send_feedback.\n' +
          'POST MCP requests to /mcp. See https://inetgeek.com for the human-facing site.',
        { status: url.pathname === '/' ? 200 : 404, headers: { 'content-type': 'text/plain; charset=utf-8' } },
      );
    }

    const server = buildServer({ env, request });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // Plain JSON responses, not an SSE stream — nothing here streams or
      // pushes a second message, so there's no reason to ask every client to
      // hold a chunked connection open to read one reply.
      enableJsonResponse: true,
    });
    await server.connect(transport);

    // The SDK hard-rejects (406) any POST whose Accept header doesn't list
    // BOTH application/json and text/event-stream, per the letter of the MCP
    // Streamable HTTP spec — unconditionally, regardless of enableJsonResponse
    // above. A real client that connects fine (its `initialize` call happens
    // to send the right Accept) can still fail silently on the very next
    // `tools/list`, because that call came from different code with a
    // different Accept header. This was caught exactly that way: a client
    // reported inetGeek as "connected" but with no invokable tools, and every
    // Accept header this server was actually sent during diagnosis —
    // "application/json" alone, no header at all — got a 406 the client
    // never surfaced as an error, just an empty tool list. Rewriting the
    // header before the SDK ever sees it makes every request satisfy a check
    // this server has no reason to enforce on a caller's behalf: every reply
    // is small, immediate, and never needs the client to have asked for
    // streaming in the first place.
    //
    // POST only. A GET opens the *optional* standalone SSE stream for
    // server-initiated pushes — forcing "accept: text/event-stream" onto one
    // of those makes the transport hold it open forever, since nothing here
    // ever pushes a message on it. That hung request, not a 406, is worse:
    // the first version of this fix did exactly that and had to be narrowed.
    let normalized = request;
    if (request.method === 'POST') {
      const headers = new Headers(request.headers);
      headers.set('accept', 'application/json, text/event-stream');
      // The body is read here rather than streamed through, because the
      // usage counter has to see which method was called and a body can only
      // be consumed once. It is re-attached verbatim — the transport parses
      // the same bytes the client sent, and a payload this counter cannot
      // parse is still passed on untouched for the SDK to reject properly.
      const body = await request.text();
      normalized = new Request(request.url, { method: 'POST', headers, body });

      if (env.USAGE) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = null;
        }
        // Truncated because a blob has a size budget and no honest client
        // needs 200 characters to name itself; a UA longer than this is
        // padding or an attempt to fill the dataset.
        const agent = (request.headers.get('user-agent') ?? '').slice(0, 96) || 'none';
        for (const { event, who } of usageOf(parsed)) {
          // blob1 event, blob2 the client or tool name, blob3 the client
          // software, double1 a count of one so SUM() reads as calls.
          // Indexed on the event because that is what every query groups by
          // first.
          env.USAGE.writeDataPoint({ indexes: [event], blobs: [event, who, agent], doubles: [1] });
        }
      }
    }

    return transport.handleRequest(normalized);
  },

  /**
   * Daily retention sweep for send_feedback rows (cron in wrangler.jsonc).
   *
   * Closed feedback goes 90 days after it was closed; anything at all goes
   * after 365 days, handled or not. /privacy/ states both periods, so they are
   * enforced here rather than left to someone remembering to run a script.
   * Timestamps are written by SQLite's datetime('now') on insert and on close,
   * so these comparisons are like-for-like strings.
   */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    if (!env.FEEDBACK) return;
    await env.FEEDBACK.batch([
      env.FEEDBACK.prepare("DELETE FROM feedback WHERE closed_at IS NOT NULL AND closed_at < datetime('now', '-90 days')"),
      env.FEEDBACK.prepare("DELETE FROM feedback WHERE received_at < datetime('now', '-365 days')"),
    ]);
  },
};
