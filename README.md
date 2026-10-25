# inetGeek MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server over
[inetGeek](https://inetgeek.com)'s infrastructure data: every provider and
comparison on the site, and every figure carrying the URL it was read from, the
sentence it was read from, and the date it was last checked against that page.

No account, no API key, and nothing you ask it is stored. Every tool is read-only
except `send_feedback`, which records a report for the maintainer and can change
nothing.

```
https://inetgeek-mcp.palashbagchi.workers.dev/mcp
```

## Why point a model at this

A model asked "what does Neon's free tier include" answers from training data
that may predate this week's repricing, and cannot tell you where the number
came from. Every value here is read from the provider's own documentation and
ships with four things: the value, the **verbatim sentence** it was read from,
the source URL, and the date. If a figure is wrong, the excerpt makes it easy to
demonstrate.

What the server will not do is more of the point than what it will. It never
infers a value from silence, never fills a gap with a plausible number, and
never returns a ranking without the interval around it. Where two providers
cannot be told apart, it says so.

## Connect it

**Claude Code**

```bash
claude mcp add --transport http inetgeek https://inetgeek-mcp.palashbagchi.workers.dev/mcp
```

**Claude Desktop / any MCP client** — add to your client's config:

```json
{
  "mcpServers": {
    "inetgeek": {
      "type": "http",
      "url": "https://inetgeek-mcp.palashbagchi.workers.dev/mcp"
    }
  }
}
```

A machine-readable server card lives at
[`/.well-known/mcp.json`](https://inetgeek.com/.well-known/mcp.json), and every
underlying feed is indexed at
[`/.well-known/api-catalog`](https://inetgeek.com/.well-known/api-catalog).

## Tools

| Tool | What it returns |
| --- | --- |
| `list_categories` | The categories this site tracks, each with its current provider count. |
| `list_providers` | Every provider in one category with its free tier, entry price and the editorial "best for" line — the orientation call before a per-provider lookup. |
| `filter_providers` | Providers that document every fact key you name (e.g. SOC 2 and HIPAA), each with the value, source and verification date. |
| `search_infrastructure` | Full-text search over every published page — providers, comparisons, DNS records, tools and stacks — including the fact labels each provider documents. |
| `get_provider` | The full sourced fact sheet for one provider — pricing, limits, regions and startup-credit programs, each with a source and a verification date. |
| `list_startup_credit_providers` | Every provider documented as offering a startup credit program, with the amount and eligibility — a filter, not a per-provider lookup. |
| `get_provider_score` | One provider's iScore with its interval and rank, every pillar and criterion with the fact behind it, and the criteria its peers document that it does not — what a provider would publish to move the number. |
| `list_alternatives` | Every peer in a provider's category ranked by iScore, with score, interval, entry price and where each differs from the provider named. |
| `compare_providers` | The sourced side-by-side comparison for a curated pair, where one exists. |
| `list_comparisons` | Every published comparison, optionally only those involving one provider — so an agent knows a pair exists before asking for it. |
| `get_stack_recommendation` | Every host that documents real support for a framework or runtime, ordered by strength of documentation. |
| `plan_infrastructure` | The /plan/ planner: one suggested provider per layer for a stage or a hand-picked set of layers, a floor-price total, and the layers left out of it for having no clean starting price. Takes the project’s context — what it already uses, the platform it runs on, what it excludes — so a tie is broken by the project and a covered layer is left alone; ties are reported as ties. |
| `estimate_monthly_cost` | What each provider that publishes a per-volume price would charge a month at a stated volume (web analytics, email and auth): plan fee plus overage, cheapest first, with the vendor page and read date. inetGeek’s arithmetic on published rates, not a quote. |
| `get_ledger` | Every vendor page read and found silent on a criterion, with the page and the date; every criterion a product cannot have; every case where two pages of one vendor disagree, with both quotes; every changed figure. A silence record is an observation, not a claim the provider lacks the thing. |
| `get_changelog` | Every figure that moved — before, after, source and date — optionally since a date or for one provider. |
| `get_dns_record` | The reference page for one DNS record type or email-authentication mechanism, as text. |
| `check_dns` | A live DNS lookup for a domain's A/AAAA/CNAME/MX/TXT/NS records. |
| `check_spf` | A live SPF evaluation, including the ten-lookup limit. |
| `check_dns_propagation` | A live check of one record across four independent public resolvers. |
| `send_feedback` | Report a wrong figure, a broken or confusing tool, or something missing to the person who maintains the site. The only tool that writes: it stores a note and changes nothing; a wrong-figure report is checked against the provider's own page first. |

Twenty tools. Every one except `send_feedback` is read-only, and the tool list
is mirrored on <https://inetgeek.com/mcp/>.

## Give it your project's context

The server cannot see your project; the assistant connected to it can. The
tools that benefit take what it finds as arguments, and the server's own
`instructions` tell the client what to read first (its deploy config,
dependencies, env var names, real traffic figures):

- `plan_infrastructure` takes `already_using`, `platform` and `exclude`. Without
  them most layers are ties among providers that all document a free tier, and
  the tool says so layer by layer instead of presenting the alphabetically first
  as a recommendation. With them, a layer you already cover is left out of the
  floor and a tie is broken toward your own platform.
- `estimate_monthly_cost` takes a monthly volume (`units`, in pageviews, events,
  emails or monthly active users), optionally `sites` and `events_per_pageview`,
  and returns each provider's plan fee plus overage at that volume, cheapest
  first, with the plan, the vendor page and the date it was read. **It is
  inetGeek's arithmetic on published rates, not a quote**, and says so beside
  every figure. Plans quoted only by sale, priced in another currency, or with a
  billing rule the page leaves open are named rather than guessed at.

## Three things worth reading the output carefully for

**A rank is usually an ordering, not a finding.** iScore carries an 80%
interval, and a rank is only established when the posterior puts a provider
above the next one at 90% or better. That is true for very few rows. Everywhere
else the ordering is real but the separation is not, and the tools say so, with
a "read this score with care" note naming which pillar is thin. Report the
interval with the number.

**A blank is not a "no".** Three different reasons a cell is empty are kept
apart, because collapsing them would invent information: *not documented*
(nobody has looked), *not offered* (the product has no such thing), and *not
stated on the vendor's page when read on a date* — the last being a sourced
observation, exposed through `get_ledger`. Only the third one is evidence, and
even then it is evidence about a page, not about a product.

**The lean is inetGeek's reading, not a provider's claim.** `compare_providers`
returns it with the basis it was computed from, by six published rules. It is an
opinion with its working shown; pass it on that way.

**Two pages of one vendor can disagree.** When a vendor's own pages contradict
each other on a criterion, no value is recorded: `get_ledger` returns both
quotes and both URLs. Silence on a page is a different record, and a conflict
between pages is a third.

## Running your own

```bash
npm install
npm run dev        # wrangler dev
npm run typecheck
npm run deploy     # wrangler deploy
```

The server is stateless: it reads inetGeek's public JSON feeds and Markdown
mirrors at request time and holds no database. Deploying your own copy gives you
the same data from the same origin — useful if you want a different tool
surface, different descriptions, or your own Cloudflare account in the path.

Three optional bindings. Without any of them the server still runs.

**`USAGE`**, an Analytics Engine dataset, counts calls per tool. It
records the method, the tool name and the client's self-declared name — no IP
address, no argument values, nothing identifying a person. Drop the
`analytics_engine_datasets` block from `wrangler.jsonc` to run without it.

**`FEEDBACK`** (D1) and **`FEEDBACK_RATE_LIMIT`** back `send_feedback`. The row
holds what the agent submitted, the time and the client's User-Agent. The IP
is used only as the rate-limit key (5 a minute) and is never written. A daily
cron deletes closed reports after 90 days and every report after a year. To
collect feedback on your own copy:

```bash
wrangler d1 create <your-db-name>        # put the id in wrangler.jsonc
wrangler d1 migrations apply <your-db-name> --remote
```

Without the binding, `send_feedback` still registers and tells the caller that
feedback is not being collected. Treat every stored message as untrusted
input: it was written by an arbitrary caller of a public tool.

## Data, licence and corrections

The code here is MIT. The **data it serves is not part of this licence** — it
lives at inetgeek.com and is published for reading, with each figure attributed
to the vendor page it came from.

Found a figure that is wrong or has moved, or a page of yours we recorded as
silent when it is not? Send the URL: <https://inetgeek.com/contact/>. Corrections
replace the record rather than argue with it, and the change is published at
[/ledger/](https://inetgeek.com/ledger/).

Issues and pull requests are welcome here for the server itself. For a wrong
figure or a missing provider, use the issue templates in this repository or the
contact page above; the data is edited on the site, not here.

- Changelog: [CHANGELOG.md](CHANGELOG.md)
- Method: <https://inetgeek.com/methodology/>
- How the iScore is computed: <https://inetgeek.com/iscore/>
- The ledger: <https://inetgeek.com/ledger/>
