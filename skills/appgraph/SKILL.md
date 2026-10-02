---
name: appgraph
description: Query a static map of a web app's screens, routes, render trees, navigation, API calls, stores, feature flags and test-id selectors with the appgraph CLI. Use it before changing, testing or browsing UI code. It answers "which screen is /invoices/42", "what renders on this page", "which screens use this component", "what endpoints does this screen call", "what test ids can I select on this screen", "which links are dead" and "where is this menu entry routed", without reading the source by hand. Triggers include appgraph, screen map, route map, component tree, which page uses, which screens call this API, test ids for a page, dead links, orphan screens, and writing an e2e or Playwright test for a screen.
---

# appgraph

`appgraph` parses a React, Vue, Angular, Next.js, Nuxt, TanStack, Expo or AdminJS app and writes a graph of its screens. Query commands read that graph from a cache (`<out>/appgraph.graph.json`, default `docs/appgraph/`) in about 0.2 s, even on an 800-screen app. Run them from the project root, or pass `--root <dir>`. Use `npx appgraph` when the package is not installed.

## Quick start

```bash
appgraph stats                         # app name, screen/component/endpoint/dead-link counts, cache state
appgraph screens --search invoice      # find screens by url, title, id, flag, route name or entry file
appgraph screen /invoices/42           # one screen: tree, navigation, endpoints, stores, test ids, …
appgraph links /invoices               # navigation neighbours in and out, with weights
appgraph usages src/components/InvoiceTable.tsx   # screens and components that use a file/endpoint/test id/store/query key/i18n ns
appgraph findings                      # limitations, dead links, orphans, confidence, diagnostics
```

Other commands: `search <query>` (screens, components and menu at once), `components`, `menu`, `glossary [term]`, `schema [command]`, `doctor` (detection trace, writes nothing) and `analyze` (the default command, which writes the artifacts).

## Recipes

| Task | Command |
| --- | --- |
| Find the screen for a URL | `appgraph screen /invoices/42` resolves by id, then url, then route match. If nothing matches it exits 2 and the hint lists the nearest ids |
| Which screens use component X | `appgraph usages src/components/X.tsx`, or `appgraph usages X` (a component name aliases to its files) |
| What API calls a screen makes | `appgraph screen <id> --sections endpoints` |
| Which screens call an endpoint | `appgraph usages 'GET /api/invoices'` (a bare url matches every method) |
| Test ids for a screen | `appgraph screen <id> --sections test-ids --json` |
| Which screen owns a test id | `appgraph usages <test-id> --type testid` |
| Dead links / missing menu paths | `appgraph findings --section dead-links`, `appgraph menu --missing` |
| What a screen renders | `appgraph screen <id> --sections tree --tree-depth 2` |
| Auth- or flag-gated screens | `appgraph screens --auth protected`, `appgraph screens --flag` or `--flag <name>` |
| Components of a kind | `appgraph components --kind <kind> --sort file` (kinds come from your project; an unknown kind lists the valid ones) |
| Errors in the analysis | `appgraph findings --section diagnostics --severity error` |
| Meaning of a term in the output | `appgraph glossary shell` |

## JSON output

Add `--json` to get exactly one object on stdout. All prose goes to stderr. Every query object carries `schemaVersion: 2`, `command` and `cache: {status: fresh|refreshed|built, path, fingerprint}`.

- **List commands** (`screens`, `links`, `search`, `components`, `menu`, `findings`, `usages`, and `glossary` with no term) return `{total, offset, limit, truncated, nextOffset?, items}`. `links` and `usages` also carry an `item` that describes the target.
- **Item commands** (`screen`, `stats`, and `glossary <term>`) return `{item}`.
- **`schema [command]`** prints the JSON Schema (2020-12 subset) of a command's `--json` output. `appgraph schema error` gives the failure shape.

**Paging.** `--limit <n>` defaults to 50 and `--offset <n>` to 0. When `truncated` is true, fetch the next page with `--offset <nextOffset>`. In text mode the footer prints the next command, for example `1-50 of 824 — next: appgraph screens --limit 50 --offset 50`.

**Fields.** `--fields id,url` keeps only those item keys. An unknown field exits 2, and the hint lists the valid ones (`appgraph schema <command>` lists them too).

**Errors.** With `--json`, every failure still prints one object: `{command, exitCode, error: {code, message, hint}, diagnostics}`. Common codes are `cli/usage`, `usage/unknown-field`, `emit/unknown-screen`, `cache/missing`, `cache/stale`, `cache/incompatible`, `cache/corrupt`, `analysis/refused` and `analysis/no-screens`. The `hint` names the next step, so follow it.

## Cache semantics

- **Queries refresh the cache automatically.** When the graph cache is missing, stale (source files, config, tsconfig or dependencies changed), incompatible or corrupt, a query re-analyses first and then answers. It prints `appgraph: analysing … (cache stale)` on stderr unless `--quiet` or `--json` is set. A refresh rewrites only `appgraph.graph.json` and the `graph` half of `.appgraph-fingerprint`. The YAML and HTML artifacts are not touched, and the next `appgraph --if-stale` still sees them as out of date.
- **`--cached`** never analyses. It answers from the existing cache or exits **6** with `cache/missing|stale|incompatible|corrupt`. Use it when a fast and possibly unavailable answer is better than waiting for an analysis.
- **Graph flags are sticky.** `--source`, `--all-sources` and `--depth` are recorded in the sidecar. A later query that does not pass them reuses the recorded values. Pass them again to change them.
- **The cache is deterministic.** It contains no timestamp and no fingerprint, so identical input gives a byte-identical `appgraph.graph.json`. Two agents that query at once are safe: writes are staged and atomically renamed, and the last writer wins.
- `--out <dir>` selects which cache to read. It must match the `--out` that the analysis used.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success: a clean run, or the query was answered |
| 1 | At least one `error` diagnostic, or a refusal to choose between live screen sources |
| 2 | Usage error (unknown command or flag, bad value, unknown screen) |
| 3 | No screens found. The full detection trace is printed |
| 4 | `--strict` and at least one `warning` diagnostic (analyze only) |
| 5 | The run itself failed (unsupported compiler, config load, unwritable output dir) |
| 6 | `--cached` and the graph cache is missing, stale, incompatible or corrupt |

When several codes apply, the precedence is `2 > 6 > 5 > 3 > 1 > 4`.

## Pitfalls

- **Refusal (exit 1, `analysis/refused`).** The repo has several live screen sources, and appgraph will not guess between them. Run `appgraph doctor` to see the candidates. Then pass `--source <name>` (it is sticky) or `--all-sources`, which namespaces screen ids by source.
- **Zero screens is exit 3, not an empty success.** No query can answer in that state. `appgraph doctor` prints why. The usual fixes are `--root` pointing at the app package or a `--source` override.
- **Empty fact sections are not proof of absence.** Check `appgraph findings --section confidence`. A `low` or `suspect` level means that section may be incomplete.
- **Conditions are text, never evaluated.** A tree node with `conditions` or `alwaysRendered: false` can render, not must render.
- `screen` takes a concrete path (`/invoices/42`) as well as the route pattern (`/invoices/:id`). `links` takes an id or url. Null-url and API screens have no map links, and they are reported in `item.excluded`.
- `--limit` and `--offset` apply per group in `search`.
- Query output is English only. `--locale` is an `analyze` flag that affects only the HTML report; query commands reject it.
- **Write query output outside the source roots.** The graph fingerprint stamps every file under them, so `appgraph screens --json > screens.json` in the project root makes the next query re-analyse (and `--cached` exit 6). Pipe it, or write to a temp dir.
- Shared options may come before the command (`appgraph --root frontend screens --json`) or after it.
- **`--cached` fails on a fresh checkout or in CI.** Freshness uses file modification times, so a committed or copied `appgraph.graph.json` reads as stale. Keep the cache out of git and let the first query build it, or run `appgraph` first in the job.
- For the full reference, see `docs/agents.md` in the appgraph repository (https://github.com/doryski/appgraph/blob/main/docs/agents.md). For per-command help, run `appgraph <command> --help`.
