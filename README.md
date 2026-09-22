# inetGeek MCP server

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server over
[inetGeek](https://inetgeek.com)'s infrastructure data: 211 providers, 493
comparisons, and every figure carrying the URL it was read from, the sentence it
was read from, and the date it was last checked against that page.

No account, no API key, nothing stored about the caller.

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
| `list_categories` | The categories tracked, with their URL sections |
| `list_providers` | Every provider in a category with its free tier and entry price |
| `filter_providers` | Providers documenting every fact key you name |
| `search_infrastructure` | Full-text search across every published page |
| `get_provider` | One provider's full sourced fact sheet, plus its iScore |
| `get_provider_score` | The iScore with per-criterion basis and what would move it |
| `list_alternatives` | Category peers ranked, with why each ranks there |
| `compare_providers` | A sourced side-by-side, including the lean and its basis |
| `list_comparisons` | Every published comparison |
| `list_startup_credit_providers` | Providers documenting a startup credit programme |
| `get_stack_recommendation` | Hosts documenting real support for a stack |
| `plan_infrastructure` | A layer-by-layer plan with a price floor |
| `get_ledger` | Every page read and found silent, and every changed figure |
| `get_changelog` | Figures that moved, before and after, with the source |
| `get_dns_record` | Reference for one DNS record type |
| `check_dns` · `check_spf` · `check_dns_propagation` | Live lookups |

## Three things worth reading the output carefully for

**A rank is usually an ordering, not a finding.** iScore carries an 80%
interval, and a rank is only established when the posterior puts a provider
above the next one at 90% or better. That is true for 4 of 222 rows. Everywhere
else the ordering is real but the separation is not, and the tools say so.
Report the interval with the number.

**A blank is not a "no".** Three different reasons a cell is empty are kept
apart, because collapsing them would invent information: *not documented*
(nobody has looked), *not offered* (the product has no such thing), and *not
stated on the vendor's page when read on a date* — the last being a sourced
observation, exposed through `get_ledger`. Only the third one is evidence, and
even then it is evidence about a page, not about a product.

**The lean is inetGeek's reading, not a provider's claim.** `compare_providers`
returns it with the basis it was computed from, by six published rules. It is an
opinion with its working shown; pass it on that way.

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

One optional binding, an Analytics Engine dataset, counts calls per tool. It
records the method, the tool name and the client's self-declared name — no IP
address, no argument values, nothing identifying a person. Drop the
`analytics_engine_datasets` block from `wrangler.jsonc` to run without it.

## Data, licence and corrections

The code here is MIT. The **data it serves is not part of this licence** — it
lives at inetgeek.com and is published for reading, with each figure attributed
to the vendor page it came from.

Found a figure that is wrong or has moved, or a page of yours we recorded as
silent when it is not? Send the URL: <https://inetgeek.com/contact/>. Corrections
replace the record rather than argue with it, and the change is published at
[/ledger/](https://inetgeek.com/ledger/).

- Method: <https://inetgeek.com/methodology/>
- How the iScore is computed: <https://inetgeek.com/iscore/>
- The ledger: <https://inetgeek.com/ledger/>
