/**
 * Ranking for search_infrastructure, kept in its own file with no Cloudflare
 * or SDK imports so it can be tested as a plain function.
 *
 * WHY IT EXISTS. Until 2026-09-17 this tool matched the WHOLE QUERY as one
 * substring: `haystack.includes(query)`. So "zero-trust access" found the ZTNA
 * pages and "mesh VPN zero-trust" found nothing at all — even though "Mesh VPN
 * and zero-trust access tools" is the literal description of the ZTNA hub. The
 * word "and" sitting between two of the caller's terms was enough to return
 * zero results.
 *
 * That is a bad failure for a human and a much worse one for an agent. A person
 * sees an empty dropdown and deletes a word. An agent gets one shot, reads
 * "No inetGeek page matches", and reports the category as missing. A connected
 * client reviewing coverage on 2026-09-17 concluded inetGeek had no private
 * networking, no KMS story, no compliance story and no model-hosting story.
 * All four existed. The taxonomy was never the problem; the search was.
 *
 * The site's own SearchDialog had tokenised and ranked correctly the whole
 * time. Two implementations of one feature, and the agent-facing one was the
 * broken one — which is the general hazard worth remembering here.
 *
 * WHAT IT DOES NOW, AND WHY EACH PIECE IS THERE. Every rule below was added in
 * response to a query that returned the wrong thing, not in anticipation:
 *
 *   TOKENS, NOT A PHRASE — "mesh VPN zero-trust" returned nothing.
 *   STOPWORDS DROPPED — so a query does not hinge on "and" or "with".
 *   TOKENS DEDUPLICATED — "model ... model ..." must not pay twice.
 *   IDF WEIGHTING — "model hosting inference" ranked Hostinger first, because
 *     "hosting" matched 257 pages and "inference" matched a dozen, and both
 *     counted the same. A term that narrows the corpus is worth more.
 *   GENTLE PLACEMENT WEIGHTS — at x10, a COMMON word in a title still beat a
 *     RARE word in a description, and Hostinger stayed on top. Placement
 *     breaks ties between comparable terms; it does not overturn rarity.
 *   A RELATIVE FLOOR — otherwise two good answers are followed by eighteen
 *     pages whose only crime is containing "data", and an agent reading
 *     top-to-bottom treats the tail as signal.
 *
 * Deliberately MORE FORGIVING than the site's dialog, which requires every
 * token to land. An agent asking one keyword-stuffed question is better served
 * by the best partial match plus a note saying it is partial, than by nothing.
 */

export interface RankableDoc {
  title: string;
  description: string;
  path: string;
  kind: string;
  keywords?: string;
}

export interface RankedDoc<T extends RankableDoc> {
  doc: T;
  score: number;
  hits: number;
}

export interface RankResult<T extends RankableDoc> {
  matches: RankedDoc<T>[];
  /** Everything above the relative floor, before the display limit. */
  kept: number;
  /** Query terms after stopword removal and deduplication. */
  tokens: string[];
  /** Terms no document contains at all — a data gap, not a ranking failure. */
  absent: string[];
  /** Terms the best match actually carries. */
  bestHits: number;
}

/**
 * Hyphens flatten to spaces because the index stores keywords that way
 * ("point in time recovery"), so "point-in-time" and "ci-cd" still find them.
 */
export function normaliseForSearch(s: string): string {
  return s.toLowerCase().replace(/-/g, ' ');
}

/** Dropped before scoring so they neither gate a result nor inflate it. */
export const SEARCH_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'to', 'vs', 'with',
]);

const TITLE_WEIGHT = 3;
const KEYWORD_WEIGHT = 2;
/** A result scoring under this share of the best is tail, not answer. */
const RELATIVE_FLOOR = 0.25;

export function rankSearchDocs<T extends RankableDoc>(docs: T[], query: string, limit = 20): RankResult<T> {
  const phrase = normaliseForSearch(query);
  const tokens = [...new Set(phrase.split(/\s+/).filter((t) => t && !SEARCH_STOPWORDS.has(t)))];
  // A query that is nothing but stopwords still deserves an answer.
  if (tokens.length === 0 && phrase.trim()) tokens.push(phrase.trim());

  const fields = docs.map((doc) => {
    const title = normaliseForSearch(doc.title ?? '');
    const keywords = normaliseForSearch(doc.keywords ?? '');
    return {
      doc,
      title,
      keywords,
      haystack: `${title} ${keywords} ${normaliseForSearch(`${doc.description ?? ''} ${doc.path ?? ''}`)}`,
    };
  });

  const N = fields.length;
  const weights = new Map<string, number>();
  for (const token of tokens) {
    const df = fields.reduce((n, f) => (f.haystack.includes(token) ? n + 1 : n), 0);
    // A term in no document scores zero and stops contributing — the honest
    // outcome when the corpus genuinely does not cover "peering".
    weights.set(token, df === 0 ? 0 : Math.log(N / df) + 0.1);
  }

  const scored = fields
    .map(({ doc, title, keywords, haystack }) => {
      let score = 0;
      let hits = 0;
      for (const token of tokens) {
        if (!haystack.includes(token)) continue;
        hits += 1;
        const w = weights.get(token) ?? 0;
        if (title.includes(token)) score += w * TITLE_WEIGHT;
        else if (keywords.includes(token)) score += w * KEYWORD_WEIGHT;
        else score += w;
      }
      if (hits === 0) return null;
      // The whole query appearing contiguously is the old behaviour, kept as
      // the strongest single signal rather than as the only one.
      if (haystack.includes(phrase)) score += 100;
      return { doc, score, hits };
    })
    .filter((m): m is RankedDoc<T> => m !== null)
    .sort((a, b) => b.score - a.score || a.doc.title.localeCompare(b.doc.title));

  const ceiling = scored.length ? scored[0].score : 0;
  const kept = scored.filter((m) => m.score >= ceiling * RELATIVE_FLOOR);

  return {
    matches: kept.slice(0, limit),
    kept: kept.length,
    tokens,
    absent: tokens.filter((t) => (weights.get(t) ?? 0) === 0),
    bestHits: kept.length ? kept[0].hits : 0,
  };
}
