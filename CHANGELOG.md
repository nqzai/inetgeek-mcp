# Changelog

Tool and behaviour changes of the MCP server. Data corrections are published
separately at <https://inetgeek.com/ledger/> and <https://inetgeek.com/changelog.json>.

## 1.9.0 — 2026-10-25
- `estimate_monthly_cost` prices plans that are unlimited or fair-use, one-time
  licences, block-billed overage the page leaves open (returned as a range), and
  a row backed by two pages of the vendor. A volume above a vendor's top printed
  band says the vendor sells it by quote, naming each plan, instead of "no price
  on file".
- A provider without a per-volume schedule is listed with what its own page says
  about price.

## 1.8.0 — 2026-10-25
- New category: developer documentation platforms (`docs-platforms`), with eight
  criteria — docs as code, OpenAPI reference, API playground, SDK generation,
  llms.txt, MCP server, AI assistant, versioning — usable with `filter_providers`.
- `plan_infrastructure` gains the `docs` layer.

## 1.7.0 — 2026-10-25
- `estimate_monthly_cost` (new): plan fee plus overage at a stated monthly
  volume for web analytics, email and auth, with the source page and read date.
  Arithmetic on published rates, not a quote.
- `plan_infrastructure` takes `already_using`, `platform` and `exclude`, reports
  ties as ties (the pick is only alphabetical), leaves covered layers out of the
  floor and prefers providers on your platform.
- `search_infrastructure` adds the words the criteria use for everyday terms
  (crawler, bot, revenue) and names the matching `filter_providers` key.
- Server `instructions` tell the connected client which project facts to read
  and pass.
- `get_provider_score` and provider pages carry "read this score with care"
  notes. `get_ledger` also returns places where two pages of one vendor
  disagree.
- New criteria for web analytics: revenue attribution, payment providers
  connected, AI and search crawler tracking.

## 1.6.1 and earlier
See the git history. 1.6.0 added `send_feedback`; 1.6.1 declared `readOnlyHint`
on every read tool.
