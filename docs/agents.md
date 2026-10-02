# appgraph for AI agents: CLI reference

This is the complete reference for agents that drive `appgraph` through a shell. The short, task-first version is the Claude Code skill in [`skills/appgraph/SKILL.md`](../skills/appgraph/SKILL.md). The command sections below are generated from the command registry (`src/cli/commands.ts`), so they match `appgraph <command> --help` and `appgraph schema <command>`.

- [How it works](#how-it-works)
- [Shared options](#shared-options)
- [Output contract](#output-contract)
- [Exit codes](#exit-codes)
- [Commands](#commands)
- [HTML report to CLI parity](#html-report-to-cli-parity)
- [Full YAML v2 shape](#full-yaml-v2-shape)
- [Graph cache and sidecar](#graph-cache-and-sidecar)

## How it works

1. `appgraph` (the `analyze` command) parses the project and writes the requested artifacts into `--out` (default `docs/appgraph/`). It always writes the graph cache `appgraph.graph.json` and the sidecar `.appgraph-fingerprint` as well.
2. Query commands (`screens`, `screen`, `links`, `search`, `components`, `menu`, `findings`, `stats` and `usages`) load the cache and answer in about 0.2 s, even on an 824-screen app.
3. A query first checks the cache against a **graph fingerprint**. That fingerprint covers the appgraph version, the resolved config, the tsconfig chain, every source root (paths and mtimes), the dependency manifests and the template-compiler peers. Output-only options (`--format`, `--locale`, `--screen`, the timestamp) are not part of it.
   - On a mismatch, the query re-analyses with formats `["graph"]` and rewrites only the cache and the `graph` half of the sidecar. Then it answers.
   - With `--cached`, a query never analyses. It exits `6` instead.
4. `glossary` and `schema` read no graph. They never analyse and never touch the cache.

The fingerprint path does not load TypeScript, so a fresh query works even where `typescript` cannot be resolved.

The graph fingerprint stamps every file under the source roots, not only source files, because analysis also reads imported JSON and manifests. Writing query output into a source root (`appgraph screens --json > screens.json` at the project root) therefore makes the next query re-analyse, and `--cached` exit `6`. Pipe the output, or write it outside the source roots.

## Shared options

Each command takes the option groups listed in its section.

| Group | Option | Meaning |
| --- | --- | --- |
| project | `--root <dir>` | Project root. Default: the nearest ancestor with `package.json` + `tsconfig.json`. |
| project | `--config <file>` | Config file. Default: `<root>/appgraph.config.{ts,mts,js,mjs}` if present. |
| project | `--out <dir>` | Output directory, where the graph cache lives too. Default: `docs/appgraph`. |
| graph | `--source <name>` | Force one screen source, bypassing detection. Sticky for queries. |
| graph | `--all-sources` | Run every detected screen source; screens are namespaced by source. Sticky for queries. |
| graph | `--depth <n>` | Render tree depth. Default: `3`. Sticky for queries. |
| emit | `--format <format>` | Repeatable: `index` \| `detail` \| `full` \| `html` \| `graph` \| `all`. Default: `index` + `html`. The graph cache is always written. |
| emit | `--screen <id>` | Restrict output to one screen. It requires `--format detail` and is rejected with any other format. |
| emit | `--locale <locale>` | HTML report locale: `en` \| `pl`. |
| emit | `--no-timestamp` | Omit the HTML generation timestamp. |
| run | `--allow-empty` | On zero screens, still exit non-zero, but write a marked `screens: []` artifact. |
| run | `--if-stale` | Skip the run when the run fingerprint matches the previous clean run. |
| run | `--strict` | Exit non-zero on any warning diagnostic. |
| query | `--cached` | Answer from the existing graph cache only and never analyse. Exits 6 when the cache is missing or stale. |
| query | `--limit <n>` | Maximum number of items to print. Default: `50`. |
| query | `--offset <n>` | Number of items to skip before the first one printed. Default: `0`. |
| query | `--fields <list>` | Comma-separated item fields to keep (see `appgraph schema <command>`). |
| output | `--quiet` | Print errors only. |
| output | `--json` | Emit one machine-readable object on stdout; all prose goes to stderr. |
| output | `--timing` | Print per-phase durations (ms) to stderr. `analyze` and `doctor` also add a `timing` object to `--json` output. |

**Sticky graph flags.** The sidecar records `--source`, `--all-sources` and `--depth` (`graph.options`). A query that omits them reuses the recorded values, so it answers for the same graph that the last analysis built. Pass a flag explicitly to change it. The cache then becomes stale and is rebuilt.

## Output contract

**Text output** (the default) is plain English with no colour, aligned columns, and integers without separators, so `grep` and `awk` work on it. A truncated list ends with a footer naming the next command, for example `1-50 of 824 — next: appgraph screens --limit 50 --offset 50`. When the cache had to be built, a progress line goes to stderr unless `--quiet` or `--json` is set.

**`--json`** prints exactly one compact object on stdout. Every query object carries:

| Key | Meaning |
| --- | --- |
| `schemaVersion` | `2`, the version of the query output contract |
| `command` | The command that produced the output |
| `cache` | `{status, path, fingerprint}`. `status` is `fresh` (read as is), `refreshed` (rebuilt because it was stale or incompatible) or `built` (built because it was missing or corrupt). Absent for `glossary` and `schema` |
| `emptyResult`, `emptyReason` | Present only when the graph has no screens |

The rest depends on the envelope:

- **List** (`screens`, `links`, `search`, `components`, `menu`, `findings`, `usages`, and `glossary` without a term): `{total, offset, limit, truncated, nextOffset?, items}`. `nextOffset` appears only when `truncated` is true. Every declared item key is present in each item, unless `--fields` keeps only the named ones.
- **Item** (`screen`, `stats`, and `glossary <term>`): `{item}`.
- **Document** (`schema`): a JSON Schema document.

`appgraph schema` prints one document whose `$defs` holds every command's schema and `error`. `appgraph schema <command>` prints one command's schema, and `appgraph schema error` prints the failure shape.

**Errors.** With `--json`, every failure, including usage errors, prints one object on stdout:

```json
{"command":"screen","exitCode":2,"error":{"code":"emit/unknown-screen","message":"unknown screen 'nope'","hint":"run appgraph screens to list them"},"diagnostics":[]}
```

| `error.code` | Exit | When |
| --- | --- | --- |
| `cli/usage` | 2 | Unknown command or flag, bad value |
| `usage/unknown-field` | 2 | `--fields` names a key the command does not have. The hint lists the valid keys |
| `emit/unknown-screen` | 2 | `screen`/`links` target matches nothing. The hint lists up to 5 nearest ids or urls |
| `cache/missing`, `cache/stale`, `cache/incompatible`, `cache/corrupt` | 6 | `--cached` and the cache cannot be used |
| `analysis/refused` | 1 | Several live screen sources. Hint: pass `--source <name>` or `--all-sources` |
| `analysis/no-screens` | 3 | The analysis found no screens. Hint: run `appgraph doctor` |
| `cache/not-emitted` | 5 | The analysis produced no readable graph cache |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success: a clean run, or the query was answered |
| `1` | At least one `error` diagnostic, or a refusal to choose between live screen sources |
| `2` | Usage error (unknown command or flag, bad value, unknown screen) |
| `3` | No screens found. The full detection trace is printed |
| `4` | `--strict` and at least one `warning` diagnostic |
| `5` | The run itself failed (unsupported compiler, config load, unwritable output dir) |
| `6` | `--cached` and the graph cache is missing, stale, incompatible or corrupt |

When several codes apply, the precedence is `2` > `6` > `5` > `3` > `1` > `4`. Each command section lists the codes that command can return.

## Commands

### `analyze`

Analyse the project and write the artifacts (default command). A bare `appgraph [flags]` runs it.

Detect the screen sources, walk every screen's component tree and write the requested artifacts plus the graph cache (appgraph.graph.json) to --out.

```
appgraph analyze [options]
```

Shared options: project (`--root`, `--config`, `--out`); graph (`--source`, `--all-sources`, `--depth`); emit (`--format`, `--screen`, `--locale`, `--no-timestamp`); run (`--allow-empty`, `--if-stale`, `--strict`); output (`--quiet`, `--json`, `--timing`).

**Output.** A summary, the diagnostics and the written files. With --json: one object with the counts, the written files, the diagnostics and the exit code.

**JSON fields:**

| Field | Type | Meaning |
| --- | --- | --- |
| `command` | string | Always analyze (one of `analyze`) |
| `appgraphVersion` | string | Version of appgraph that ran |
| `root` | string | Absolute project root |
| `out` | string | Output directory, relative to the root |
| `formats` | string[] | Formats written, including graph |
| `skipped` | boolean | True when --if-stale found nothing to do |
| `fingerprint` | string | Run fingerprint |
| `emptyResult` | boolean | True when no screens were found |
| `refused` | boolean | True when appgraph refused to choose between live screen sources |
| `counts` | object | Entity counts of the graph |
| `wrote` | object[] | Written files |
| `wrote.path` | string | Path relative to --out |
| `wrote.bytes` | integer | Size in bytes |
| `diagnostics` | object[] | Diagnostics of the run |
| `diagnostics.severity` | string | Diagnostic severity (one of `error`, `warning`, `info`) |
| `diagnostics.code` | string | Stable diagnostic code |
| `diagnostics.message` | string | What happened |
| `diagnostics.plugin` | string \| null | Plugin that raised it |
| `diagnostics.file` | string | Project-relative file (optional) |
| `diagnostics.line` | integer | Line in the file (optional) |
| `diagnostics.screenId` | string | Screen the diagnostic is about (optional) |
| `exitCode` | integer | The process exit code |
| `trace` | string | Analysis trace; present when the analysis produced one (optional) |
| `timing` | object | Per-phase durations in ms; present with --timing (optional) |

**Examples:**

```bash
appgraph
appgraph --root ./frontend --out docs/appgraph --format index --format html
appgraph --format detail --screen /invoices/:id
appgraph --if-stale --quiet
appgraph --json > appgraph-run.json
```

**Exit codes:** `0`, `1`, `2`, `3`, `4`, `5`.

### `doctor`

Print the full detection trace and write nothing.

Explain every guess: root and config resolution, the tsconfig chain, per-source detection scores with evidence, globs, exclusions, counts, confidence and the staleness fingerprint. Writes nothing.

```
appgraph doctor [options]
```

Shared options: project (`--root`, `--config`, `--out`); graph (`--source`, `--all-sources`, `--depth`); `--json`; `--timing`.

**Output.** The detection report as text sections. With --json: the same report as one object. Always exits 0 once the flags parsed.

**JSON fields:**

| Field | Type | Meaning |
| --- | --- | --- |
| `command` | string | Always doctor (one of `doctor`) |
| `appgraphVersion` | string | Version of appgraph that ran |
| `root` | string | Absolute project root |
| `rootReason` | string | Why this root was chosen |
| `cwd` | string | Working directory appgraph ran in |
| `configFile` | string \| null | Absolute config file path |
| `sourceRoots` | string[] | Source roots the analysis walked |
| `tsconfig` | object \| null | Resolved tsconfig chain: files, baseUrl, paths, include, moduleResolution, jsx |
| `templateCompilers` | object[] | Template compilers and whether they are installed |
| `screenSources` | string[] | Screen sources that produced screens |
| `sourcesRun` | string[] | Every screen source that ran |
| `counts` | object | Entity counts of the graph |
| `confidence` | object[] | Per-section confidence |
| `navGroups` | object[] | Detected navigation groups |
| `detections` | object[] | Per-source detection scores with evidence |
| `globs` | object[] | Glob attempts |
| `nearMisses` | object[] | Files that almost matched a screen source |
| `exclusions` | object[] | Excluded files and why |
| `nestedPackages` | object[] | Nested packages under the root |
| `testIdAttributes` | object[] | Test id attributes and how often each was seen |
| `limitations` | string[] | Known limitations of the analysis |
| `diagnostics` | object[] | Diagnostics of the analysis |
| `diagnostics.severity` | string | Diagnostic severity (one of `error`, `warning`, `info`) |
| `diagnostics.code` | string | Stable diagnostic code |
| `diagnostics.message` | string | What happened |
| `diagnostics.plugin` | string \| null | Plugin that raised it |
| `diagnostics.file` | string | Project-relative file (optional) |
| `diagnostics.line` | integer | Line in the file (optional) |
| `diagnostics.screenId` | string | Screen the diagnostic is about (optional) |
| `trace` | string | Analysis trace |
| `fingerprint` | string \| null | Graph fingerprint |
| `fingerprintParts` | string[] | Inputs the fingerprint hashes |
| `failure` | string \| null | Why the analysis failed |
| `notes` | string[] | Notes on reading the report |
| `exitCode` | integer | Always 0 |
| `timing` | object | Per-phase durations in ms; present with --timing (optional) |

**Examples:**

```bash
appgraph doctor
appgraph doctor --root ./frontend --json
```

**Exit codes:** `0`, `2`, `5`.

### `screens`

List screens, filtered and searched like the report's screen list.

List the screens in report order (pages first, API routes last) with their labels and badges.

```
appgraph screens [options]
```

Shared options: project (`--root`, `--config`, `--out`); graph (`--source`, `--all-sources`, `--depth`); query (`--cached`, `--limit`, `--offset`, `--fields`); output (`--quiet`, `--json`, `--timing`).

| Option | Meaning |
| --- | --- |
| `--search <query>` | Keep screens whose search text (url, title, id, flag, route name, route activations, entries) contains the query (case-insensitive substring). |
| `--auth <state>` | Keep screens with this auth state. |
| `--api` | Keep only API routes. |
| `--no-api` | Drop API routes. |
| `--flag [name]` | Keep screens gated by a feature flag, or by this flag. |
| `--kind <kind>` | Keep screens with this kind tag. |
| `--from <source>` | Keep screens produced by this screen source. |

**Output.** One aligned row per screen and a footer with the next page. With --json: { total, offset, limit, truncated, items }.

**Item fields** (`--fields` selects from these):

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Stable screen id; pass it to appgraph screen <id> |
| `url` | string \| null | Route URL pattern; null for an unaddressable screen |
| `title` | string \| null | Static title, when one was found |
| `primaryLabel` | string | The label the report lists the screen under |
| `source` | string | Screen source that produced the screen |
| `kindTag` | string \| null | Screen kind tag |
| `auth` | string | Auth state (one of `protected`, `public`, `unknown`) |
| `featureFlag` | string \| null | Feature flag gating the screen |
| `devOnly` | boolean | Only reachable in development builds |
| `addressable` | boolean | Has a URL a user can navigate to |
| `redirectTo` | string \| null | Redirect target URL for a redirect screen |
| `shell` | string \| null | Id of the shell (layout chain) the screen renders inside |
| `isApi` | boolean | An API route rather than a page; listed after the pages |
| `badges` | string[] | Badges the report shows next to the screen, as id or id:value |

**Examples:**

```bash
appgraph screens
appgraph screens --search invoice --auth protected
appgraph screens --no-api --json --fields id,url
```

**Exit codes:** `0`, `1`, `2`, `3`, `5`, `6`.

### `screen`

Show one screen's detail: tree, navigation, endpoints, stores and more.

Resolve a screen by id, then by url, then by route match, and print its detail document. Empty sections are omitted.

```
appgraph screen <id|url> [options]
```

- `id|url`: Screen id, url or a concrete path the route matches

Shared options: project (`--root`, `--config`, `--out`); graph (`--source`, `--all-sources`, `--depth`); query (`--cached`, `--limit`, `--offset`, `--fields`); output (`--quiet`, `--json`, `--timing`).

| Option | Meaning |
| --- | --- |
| `--sections <list>` | Comma-separated sections to print: activations, entries, ancestors, tree, navigation, shell, endpoints, stores, query-keys, mutations, i18n, feature-gates, forms, test-ids, messages, extra, params, reachable. |
| `--tree-depth <n>` | Cut the printed render tree at this depth. |

**Output.** The screen's detail as YAML-like text. With --json: { item } holding the screen row, redirect target, HTML deep link and the non-empty sections.

**Item fields** (`--fields` selects from these):

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Stable screen id; pass it to appgraph screen <id> |
| `url` | string \| null | Route URL pattern; null for an unaddressable screen |
| `title` | string \| null | Static title, when one was found |
| `primaryLabel` | string | The label the report lists the screen under |
| `source` | string | Screen source that produced the screen |
| `kindTag` | string \| null | Screen kind tag |
| `auth` | string | Auth state (one of `protected`, `public`, `unknown`) |
| `featureFlag` | string \| null | Feature flag gating the screen |
| `devOnly` | boolean | Only reachable in development builds |
| `addressable` | boolean | Has a URL a user can navigate to |
| `redirectTo` | string \| null | Redirect target URL for a redirect screen |
| `shell` | string \| object \| null | Shell id, or the shell section object when the shell section is selected |
| `isApi` | boolean | An API route rather than a page; listed after the pages |
| `badges` | string[] | Badges the report shows next to the screen, as id or id:value |
| `redirectTarget` | string \| null | Id of the screen a redirect lands on |
| `htmlLink` | string | Deep link into appgraph.html (relative to --out) that opens this screen |
| `activations` | object[] | How the screen is reached: route, state or event activations; omitted when empty (optional) |
| `entries` | object[] | Entry files and wrappers the screen starts from; omitted when empty (optional) |
| `ancestors` | object[] | Layouts, guards and providers above the screen; omitted when empty (optional) |
| `tree` | object[] | Render tree, cut at --tree-depth; omitted when empty (optional) |
| `navigation` | object[] | Outgoing navigation chips: to, matchedRoute, trigger, dynamic, sources; omitted when empty (optional) |
| `endpoints` | object | Endpoints keyed by transport; omitted when empty (optional) |
| `stores` | string[] | Stores the screen reads; omitted when empty (optional) |
| `query-keys` | array | Query keys; long keys are truncated objects; omitted when empty (optional) |
| `mutations` | integer | Number of mutations the screen triggers; omitted when empty (optional) |
| `i18n` | string[] | i18n namespaces; omitted when empty (optional) |
| `feature-gates` | string[] | Feature gates checked inside the screen; omitted when empty (optional) |
| `forms` | object | Form schemas and fields; omitted when empty (optional) |
| `test-ids` | string[] | Test ids; omitted when empty (optional) |
| `messages` | string[] | User-facing messages; omitted when empty (optional) |
| `extra` | object | Plugin fact channels, keyed by channel; omitted when empty (optional) |
| `params` | string[] | Route params; omitted when empty (optional) |
| `reachable` | string[] | Component files reachable from the screen; omitted when empty (optional) |

**Examples:**

```bash
appgraph screen /invoices/:id
appgraph screen /invoices/42 --sections endpoints,navigation
appgraph screen app:/settings --json
```

**Exit codes:** `0`, `1`, `2`, `3`, `5`, `6`.

### `links`

List a screen's navigation neighbours, as on the report's map.

List the collapsed navigation edges into and out of one screen, with weights and in/out degree. Null-url and API screens are excluded, as on the map.

```
appgraph links <id|url> [options]
```

- `id|url`: Screen id or url

Shared options: project (`--root`, `--config`, `--out`); graph (`--source`, `--all-sources`, `--depth`); query (`--cached`, `--limit`, `--offset`, `--fields`); output (`--quiet`, `--json`, `--timing`).

| Option | Meaning |
| --- | --- |
| `--incoming` | Only edges into the screen. |
| `--outgoing` | Only edges out of the screen. |

**Output.** A summary line and one row per neighbour with direction, weight, dynamic marker and triggers. With --json: { item: { id, url, degree, inDegree, outDegree, excluded }, total, offset, limit, truncated, items }.

**Item fields** (`--fields` selects from these):

| Field | Type | Meaning |
| --- | --- | --- |
| `direction` | string | Edge direction relative to the screen (one of `out`, `in`) |
| `id` | string | Neighbour screen id |
| `url` | string | Neighbour url |
| `weight` | integer | Number of navigation edges collapsed into this link |
| `dynamic` | boolean | At least one edge has a computed target |
| `triggers` | string[] | Distinct triggers of the collapsed edges |

**Envelope extras:**

| Field | Type | Meaning |
| --- | --- | --- |
| `item` | object | The screen the links belong to |
| `item.id` | string | Screen id |
| `item.url` | string \| null | Screen url |
| `item.degree` | integer | Number of map edges touching the screen |
| `item.inDegree` | integer | Neighbours linking in |
| `item.outDegree` | integer | Neighbours linked to |
| `item.excluded` | string \| null | Why the screen is not on the map (one of `no-url`, `api-route`) |

**Examples:**

```bash
appgraph links /invoices
appgraph links /invoices --incoming --json
```

**Exit codes:** `0`, `1`, `2`, `3`, `5`, `6`.

### `search`

Search screens, components and menu entries at once.

The report's command palette: every word of the query must match. Results are grouped screens, components, menu; --limit and --offset apply per group.

```
appgraph search <query> [options]
```

- `query`: Words to match

Shared options: project (`--root`, `--config`, `--out`); graph (`--source`, `--all-sources`, `--depth`); query (`--cached`, `--limit`, `--offset`, `--fields`); output (`--quiet`, `--json`, `--timing`).

**Output.** One row per hit with its kind and label, plus a '… N more' line per truncated group. With --json: { query, groups[{kind,total,shown,truncated}], total, offset, limit, truncated, items }; --limit/--offset apply per group.

**Item fields** (`--fields` selects from these):

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | string | Hit kind (one of `screen`, `component`, `menu`) |
| `id` | string | Screen id, component file or menu path |
| `label` | string | What the report shows for the hit |
| `detail` | string \| null | Secondary text: screen title, component route or file, menu group |

**Envelope extras:**

| Field | Type | Meaning |
| --- | --- | --- |
| `query` | string | The query as given |
| `groups` | object[] | Per-kind totals, in result order |
| `groups.kind` | string | Hit kind (one of `screen`, `component`, `menu`) |
| `groups.total` | integer | Hits of this kind |
| `groups.shown` | integer | Hits of this kind in items |
| `groups.truncated` | boolean | More hits of this kind exist past this page |

**Examples:**

```bash
appgraph search invoice
appgraph search 'user settings' --json
```

**Exit codes:** `0`, `1`, `2`, `3`, `5`, `6`.

### `components`

List components with their route, renders, endpoints and stores.

The report's components table: every analysed component file, sorted by render count by default.

```
appgraph components [options]
```

Shared options: project (`--root`, `--config`, `--out`); graph (`--source`, `--all-sources`, `--depth`); query (`--cached`, `--limit`, `--offset`, `--fields`); output (`--quiet`, `--json`, `--timing`).

| Option | Meaning |
| --- | --- |
| `--kind <kind>` | Keep components of this kind. |
| `--sort <key>` | Sort order: renders \| file. Default: `renders`. |
| `--search <query>` | Keep components whose file, name, kind or route matches every word. |

**Output.** One aligned row per component. With --json: { total, offset, limit, truncated, items }.

**Item fields** (`--fields` selects from these):

| Field | Type | Meaning |
| --- | --- | --- |
| `file` | string | Project-relative file |
| `component` | string | Component name |
| `kind` | string | Component kind |
| `route` | string \| null | Route the component most likely belongs to |
| `renders` | integer | Number of components it renders |
| `endpoints` | integer | Number of endpoints it calls |
| `mutations` | integer | Number of mutations it triggers |
| `stores` | string[] | Stores it reads |

**Examples:**

```bash
appgraph components
appgraph components --sort file --limit 20
appgraph components --search Invoice --json
```

**Exit codes:** `0`, `1`, `2`, `3`, `5`, `6`.

### `menu`

List navigation menu entries and whether the router knows their path.

The report's menu table: every entry of every detected navigation group.

```
appgraph menu [options]
```

Shared options: project (`--root`, `--config`, `--out`); graph (`--source`, `--all-sources`, `--depth`); query (`--cached`, `--limit`, `--offset`, `--fields`); output (`--quiet`, `--json`, `--timing`).

| Option | Meaning |
| --- | --- |
| `--group <name>` | Keep entries of this navigation group. |
| `--missing` | Keep only entries whose path no screen matches. |
| `--search <query>` | Keep entries whose label, key or path matches every word. |

**Output.** One aligned row per entry. With --json: { total, offset, limit, truncated, items }.

**Item fields** (`--fields` selects from these):

| Field | Type | Meaning |
| --- | --- | --- |
| `group` | string | Navigation group name |
| `label` | string \| null | Entry label |
| `labelKey` | string \| null | i18n key of the label |
| `path` | string | Target path |
| `featureFlag` | string \| null | Feature flag gating the entry |
| `parentPath` | string \| null | Path of the parent entry |
| `linkedScreen` | string \| null | Id of the screen the path resolves to |
| `missing` | boolean | No screen matches the path |
| `source` | string | Navigation source that found the entry |
| `file` | string | Project-relative file declaring the entry |
| `line` | integer | Line in the file |

**Examples:**

```bash
appgraph menu
appgraph menu --missing
appgraph menu --group sidebar --json
```

**Exit codes:** `0`, `1`, `2`, `3`, `5`, `6`.

### `findings`

List limitations, dead links, orphan screens, confidence and diagnostics.

The report's findings tab, section by section in report order. --severity and --code imply the diagnostics section.

```
appgraph findings [options]
```

Shared options: project (`--root`, `--config`, `--out`); graph (`--source`, `--all-sources`, `--depth`); query (`--cached`, `--limit`, `--offset`, `--fields`); output (`--quiet`, `--json`, `--timing`).

| Option | Meaning |
| --- | --- |
| `--section <name>` | Only this section: limitations \| dead-links \| orphans \| confidence \| diagnostics. |
| `--severity <level>` | Only diagnostics of this severity: error \| warning \| info; implies the diagnostics section. |
| `--code <code>` | Only diagnostics with this code; implies the diagnostics section. |

**Output.** Each section with its count and rows. With --json: { sections, severityCounts, total, offset, limit, truncated, items } where every item carries its section; --severity/--code imply the diagnostics section.

**Item fields** (`--fields` selects from these):

| Field | Type | Meaning |
| --- | --- | --- |
| `section` | string | Section the row belongs to (one of `limitations`, `dead-links`, `orphans`, `confidence`, `diagnostics`) |
| `severity` | string | Diagnostic severity (optional; one of `error`, `warning`, `info`) |
| `code` | string | Diagnostic code (optional) |
| `message` | string | Limitation or diagnostic text (optional) |
| `plugin` | string \| null | Plugin that raised the diagnostic (optional) |
| `screenId` | string \| null | Screen the diagnostic is about (optional) |
| `path` | string | Dead link path (optional) |
| `label` | string \| null | Dead link or orphan label (optional) |
| `source` | string | Navigation source of a dead link (optional) |
| `id` | string | Orphan screen id, or confidence area (optional) |
| `count` | integer | Facts found in the confidence area (optional) |
| `enablingDependency` | string \| null | Dependency the confidence area relies on (optional) |
| `dependencyInstalled` | boolean | The enabling dependency is installed (optional) |
| `level` | string | Confidence level (optional; one of `high`, `low`, `suspect`) |
| `status` | string | Confidence status (optional; one of `ok`, `partial`, `empty-unexpected`, `empty-expected`) |
| `file` | string \| null | Project-relative file (optional) |
| `line` | integer \| null | Line in the file (optional) |

**Envelope extras:**

| Field | Type | Meaning |
| --- | --- | --- |
| `sections` | object | Row count per selected section, before paging |
| `sections.limitations` | integer | Rows in limitations (optional) |
| `sections.dead-links` | integer | Rows in dead-links (optional) |
| `sections.orphans` | integer | Rows in orphans (optional) |
| `sections.confidence` | integer | Rows in confidence (optional) |
| `sections.diagnostics` | integer | Rows in diagnostics (optional) |
| `severityCounts` | object | Diagnostics per severity across the whole graph, unfiltered |
| `severityCounts.all` | integer | All diagnostics |
| `severityCounts.error` | integer | error diagnostics |
| `severityCounts.warning` | integer | warning diagnostics |
| `severityCounts.info` | integer | info diagnostics |

**Examples:**

```bash
appgraph findings
appgraph findings --section dead-links
appgraph findings --section diagnostics --severity error --json
```

**Exit codes:** `0`, `1`, `2`, `3`, `5`, `6`.

### `stats`

Print the report header counts and the cache state.

Screens, components, endpoints, dead links and the secondary counts, plus app name, versions and the empty-result reason.

```
appgraph stats [options]
```

Shared options: project (`--root`, `--config`, `--out`); graph (`--source`, `--all-sources`, `--depth`); query (`--cached`, `--limit`, `--offset`, `--fields`); output (`--quiet`, `--json`, `--timing`).

**Output.** key: value lines ending with a 'cache: <status> <path>' line; apiRoutes is hidden when 0. With --json: { item } with every count, apiRoutes included.

**Item fields** (`--fields` selects from these):

| Field | Type | Meaning |
| --- | --- | --- |
| `appName` | string | Analysed app name |
| `appgraphVersion` | string | Version of appgraph that built the graph |
| `screens` | integer | Screens, API routes excluded |
| `components` | integer | Components |
| `endpoints` | integer | Distinct endpoints |
| `deadLinks` | integer | Dead navigation links |
| `apiRoutes` | integer | API routes |
| `redirects` | integer | Redirects |
| `renderEdges` | integer | Render edges |
| `navEdges` | integer | Navigation edges |
| `maxDepth` | integer | Render tree depth the graph was built with |
| `errors` | integer | Error diagnostics |
| `warnings` | integer | Warning diagnostics |
| `infos` | integer | Info diagnostics |
| `emptyResult` | boolean | True when no screens were found |
| `emptyReason` | string \| null | Why no screens were found |

**Examples:**

```bash
appgraph stats
appgraph stats --cached --json
```

**Exit codes:** `0`, `1`, `2`, `3`, `5`, `6`.

### `usages`

Find the screens that use a component, endpoint, test id, store, query key or i18n namespace.

Reverse lookup the report has no tab for: the screens and components that use the term. Type detection: --type wins; else the first type in component, endpoint, testid, store, query-key, i18n order whose index holds the term exactly (a component name aliases to its files, a bare url to every "METHOD url" key); else by shape: a source-file extension means component, a leading HTTP method, "/" or http(s):// means endpoint, anything else matches nothing.

```
appgraph usages <term> [options]
```

- `term`: Component file or name, endpoint, test id, store, query key or i18n namespace

Shared options: project (`--root`, `--config`, `--out`); graph (`--source`, `--all-sources`, `--depth`); query (`--cached`, `--limit`, `--offset`, `--fields`); output (`--quiet`, `--json`, `--timing`).

| Option | Meaning |
| --- | --- |
| `--type <type>` | Term type: component \| endpoint \| testid \| store \| query-key \| i18n. |

**Output.** One row per screen or component using the term. With --json: { item: { term, type, detected, matched, suggestions }, total, offset, limit, truncated, items }.

**Item fields** (`--fields` selects from these):

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | string | What uses the term (one of `screen`, `component`) |
| `id` | string | Screen id or component file |
| `url` | string \| null | Screen url, or the route a component belongs to |
| `type` | string | Term type (one of `component`, `endpoint`, `testid`, `store`, `query-key`, `i18n`) |
| `via` | string | Where the use was found (one of `entry`, `tree`, `reachable`, `shell`, `facts`, `renders`, `uses`) |
| `match` | string | The index key that matched the term |

**Envelope extras:**

| Field | Type | Meaning |
| --- | --- | --- |
| `item` | object | How the term was resolved |
| `item.term` | string | The term as given |
| `item.type` | string \| null | Resolved term type; null when nothing matched by index or shape (one of `component`, `endpoint`, `testid`, `store`, `query-key`, `i18n`) |
| `item.detected` | boolean | The type was detected rather than forced with --type |
| `item.matched` | string[] | Index keys the term resolved to |
| `item.suggestions` | string[] | Nearest keys when nothing matched |

**Examples:**

```bash
appgraph usages src/components/InvoiceTable.tsx
appgraph usages 'GET /api/invoices' --type endpoint --json
```

**Exit codes:** `0`, `1`, `2`, `3`, `5`, `6`.

### `glossary`

Explain the report's terms.

Print the glossary the report shows in its info tips, or one term of it.

```
appgraph glossary [term] [options]
```

- `term` (optional): Term id or label to explain

Shared options: output (`--quiet`, `--json`, `--timing`); `--limit`; `--offset`; `--fields`.

**Output.** Aligned id/term/description rows; with a term, that term's id, term and description. With --json: { total, offset, limit, truncated, items }, or { item } with a term.

**Item fields** (`--fields` selects from these):

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Term id; pass it to appgraph glossary <term> |
| `term` | string | Term as the report labels it |
| `description` | string | What the term means |

**Examples:**

```bash
appgraph glossary
appgraph glossary shell
```

**Exit codes:** `0`, `2`.

### `schema`

Print the JSON Schema of a command's --json output.

Machine-readable output contracts, generated from this registry. Without a command: one document whose $defs holds every command's schema keyed by command name, plus error. Pass error for the --json error object every command prints on failure.

```
appgraph schema [command] [options]
```

- `command` (optional): Command whose schema to print, or error; all when omitted

Shared options: output (`--quiet`, `--json`, `--timing`).

**Output.** A JSON Schema (2020-12 subset) document.

**Examples:**

```bash
appgraph schema
appgraph schema screens
appgraph schema error
```

**Exit codes:** `0`, `2`.


## HTML report to CLI parity

Every read capability of the HTML report has a CLI command. The IDs are stable, and rows that were deliberately skipped stay in the table. In the "Derived" column, **S** means the value is computed server-side in `src/emit`. **C** means it is computed in a shared module that both the report UI and the CLI import.

| ID | UI capability | Report tab | Derived | CLI | Deliberately skipped |
| --- | --- | --- | --- | --- | --- |
| P1 | Header stats: screens, components, endpoints, dead links; API routes, redirects, render/nav edges, max depth | Header | S | `appgraph stats` | — |
| P2 | App name, appgraph version | Header | S | `stats` (`appName`, `appgraphVersion`; the cache block names the cache file) | Generation timestamp: the cache holds none, by design |
| P3 | Screen search (url, title, id, flag, route name, activations, entries) | Screens | S | `appgraph screens --search <query>` | — |
| P4 | Screen row: primary label, title, badges (auth, redirect, flag, dev-only, unaddressable, shell) | Screens | S/C | `screens` columns and `badges`; filters `--auth`, `--flag [name]`, `--api` / `--no-api`, `--kind`, `--from` | — |
| P5 | API routes grouped last | Screens | S | `screens` order: pages first, API routes last; `isApi` | Collapse state (UI-only) |
| P6 | Default selected screen, j/k navigation | Screens | C | — | Yes: interactive selection has no CLI meaning |
| P7 | Screen detail: header, activation, tree, navigation, ancestors, shell, endpoints, stores, query keys, i18n, feature gates, forms, test ids, messages, extra channels, params, reachable | Screens | S | `appgraph screen <id\|url>`; `--sections <list>` selects sections; `--tree-depth <n>` cuts the tree | — |
| P8 | Redirect screen → "go to target" | Screens | C | `screen` prints `redirectTarget` (the resolved screen id) | — |
| P9 | Grouped outgoing navigation chips (deduplicated, sources, via redirect) | Screens | S | `screen --sections navigation`; `links <id> --outgoing` | — |
| P10 | Render-tree tags (sometimes/only, null guard +N, repeated, truncated) | Screens | C | Raw fields (`conditions`, `alwaysRendered`, `nullGuards`, `repeated`, `truncated`) in `screen` output | The "+N" condensation is presentation-only |
| P11 | Empty sections folded | Screens | C | `screen` omits empty sections | — |
| P12 | Map: nodes and collapsed edges (weight, dynamic) | Map | S | `appgraph links <id\|url>` with `weight`, `dynamic`, `triggers`; `--incoming` / `--outgoing` | SVG layout geometry, pan/zoom |
| P13 | Map search, neighbour highlight, degree | Map | C | `links` neighbours with `item.degree`, `inDegree`, `outDegree` | Dimming and visual state |
| P14 | Map excludes null-url and API screens | Map | S | `links` reports `item.excluded` (`no-url` \| `api-route`) | — |
| P15 | Menu table (group, title, i18n key, path, flag, parent), group filter, search | Menu | C | `appgraph menu --group <name> --search <query>` | — |
| P16 | Menu path "missing in router" | Menu | S | `menu` fields `linkedScreen` and `missing`; `menu --missing` | — |
| P17 | Components table (component, kind, file, renders, endpoints, mutations, stores), kind filter, sort | Components | S/C | `appgraph components --kind <kind> --sort renders\|file --search <query>` | — |
| P18 | Component → route inference | Components | S | `components` field `route` | — |
| P19 | Findings: limitations | Findings | S | `appgraph findings --section limitations` | — |
| P20 | Findings: dead links (path, label, source, location) | Findings | S/C | `findings --section dead-links` | — |
| P21 | Findings: orphan screens with labels | Findings | S/C | `findings --section orphans` (id and label) | — |
| P22 | Findings: confidence (area, count, dependency, status, level) | Findings | S | `findings --section confidence`, including `level` | — |
| P23 | Findings: diagnostics, severity filter, counts | Findings | S/C | `findings --section diagnostics --severity <level> --code <code>`; `severityCounts` | — |
| P24 | Empty-result alert and reason | All | S | `emptyResult` / `emptyReason` in every query envelope and in `stats`; an analysis with zero screens exits 3 | — |
| P25 | Command palette (screens, components, menu; token-AND match) | Palette | C | `appgraph search <query>` (grouped; `--limit`/`--offset` per group) | The palette UI itself |
| P26 | Deep links `#tab=&screen=` | All | C | `screen <id\|url>` accepts an id, url or concrete path, and prints `htmlLink` (`appgraph.html#tab=screens&screen=<id>`) | — |
| P27 | Copy buttons | All | C | — | Yes: stdout is already copyable |
| P28 | Glossary (31 terms), info tips | All | C | `appgraph glossary [term]`; field descriptions in `appgraph schema` | — |
| P29 | Theme, shortcuts dialog, hotkeys, virtualisation, lazy tabs | All | C | — | Yes: presentation only |
| P30 | Locale en/pl | All | S | — (`--locale` affects only the HTML report) | Yes: CLI output stays English |
| P31 | Shell section (layouts, file, shell navigation, shell tree) | Screens | S | `screen --sections shell` | — |
| P32 | Endpoints table per screen (method, url, transport) | Screens | S | `screen --sections endpoints` | — |
| P33 | Not in the UI: reverse lookup of component, endpoint, test id, store, query key or i18n namespace → screens | — | — | `appgraph usages <term> [--type component\|endpoint\|testid\|store\|query-key\|i18n]` | — |
| P34 | Not in the UI: reachable file list (the UI shows only a count) | Screens | S | `screen --sections reachable` | — |

## Full YAML v2 shape

`--format full` writes `appgraph.yaml` with `meta.schemaVersion: 2`. It is opt-in, because the default is `index` + `html`. Two techniques keep its render trees small (on Sentry they shrink the file from 182 MB to 52 MB).

**Default-valued tree fields are omitted.** A tree node always carries `component`, `file` and `kind`. The following fields appear only when they differ from these defaults:

| Field | Default when omitted |
| --- | --- |
| `conditions` | `[]` |
| `alwaysRendered` | `true` |
| `repeated` | `false` |
| `nullGuards` | `[]` |
| `truncated` | `false` |
| `repeat` | `false` |
| `children` | `[]` |

`via` is emitted when present. The defaults live in one table, `TREE_DEFAULTS` (`src/emit/tree-intern.ts`), which drives both omission and hydration.

**Repeated subtrees are interned.** The trees of all screens and shells are hash-consed. A subtree with **at least 3 nodes** that occurs **at least twice** moves to a top-level `subtrees:` map, keyed `t<n>`. Every occurrence becomes `{ref: t<n>}`. Smaller subtrees, and subtrees that occur once, stay inline. Occurrences are counted after the enclosing subtrees have been interned, so a subtree that occurs only inside one interned parent is not split out. Keys are numbered children-first, so a `t<n>` refers only to lower-numbered keys. Numbering is deterministic: screens in emitted order (`screens`, then `stateScreens`), then shells by key.

```yaml
meta:
  schemaVersion: 2
  # …
screens:
  - id: /invoices/:id
    # …
    tree:
      - component: InvoicePage
        file: src/pages/InvoicePage.tsx
        kind: page
        children:
          - ref: t0                 # shared subtree, defined below
          - component: Totals
            file: src/pages/Totals.tsx
            kind: component
            conditions:
              - invoice.paid
            alwaysRendered: false
stateScreens: []
redirects: []
shells: {}
subtrees:
  t0:
    component: InvoiceTable
    file: src/components/InvoiceTable.tsx
    kind: component
    children:
      - component: Row
        file: src/components/Row.tsx
        kind: component
        repeated: true
        children:
          - component: Cell
            file: src/components/Cell.tsx
            kind: component
components: {}
navGroups: []
navigation: []
deadNavLinks: []
orphanScreens: []
diagnostics: []
```

To read a tree, replace each `{ref: t<n>}` with `subtrees.t<n>`, recursively, and fill in the defaults above. The top-level key order is `meta`, `selectors`, `screens`, `stateScreens`, `redirects`, `shells`, `subtrees`, `components`, `navGroups`, `navigation`, `deadNavLinks`, `orphanScreens` and `diagnostics`.

The `index` and `detail` formats inline their trees and are not interned. `detail` omits default tree fields as well. The HTML report interns its embedded payload in the same way (`paths`, `subtrees`, and a `tree` of refs per screen and shell). The report UI rehydrates the payload on load, so it renders the full trees. On Sentry, interning shrinks the HTML report from 82 MB to 18 MB.

## Graph cache and sidecar

### `appgraph.graph.json`

Every analysis writes this file into `--out`, whatever `--format` says. You can also request it on its own with `--format graph`. The `all` format includes it. It is written on exit 0, 1 and 4, and on exit 3 with `--allow-empty`. It is not written on a refusal or a usage error. The envelope is compact JSON:

| Key | Meaning |
| --- | --- |
| `format` | `"appgraph-graph"` |
| `schemaVersion` | `2` |
| `appgraphVersion` | Version that wrote it. A different version makes the cache incompatible |
| `paths` | Interned file paths. Tree-node `file` and `screen.reachable` hold indexes into this array |
| `subtrees` | Every distinct tree node, children first, with default-valued fields omitted (thresholds 1/1: all nodes are interned). `children` holds subtree indexes |
| `graph` | The `AppGraph`. `screens[].tree` and `shells[*].tree` are arrays of subtree indexes, and `screens[].reachable` is an array of path indexes |

The cache holds **no timestamp and no fingerprint** (`graph.meta.fingerprint` is empty). Identical input therefore gives a byte-identical file. Freshness is decided by the sidecar, never by the cache. A cache with another `format`, `schemaVersion` or `appgraphVersion` is incompatible, and a cache that does not parse is corrupt. Both are rebuilt by a query, or reported as exit 6 under `--cached`.

`decodeGraphCache` / `readGraphCache` in `src/emit/graph-cache.ts` rehydrate the envelope into a plain `AppGraph`.

### `.appgraph-fingerprint` (sidecar v2)

This is one JSON line, written next to the artifacts by every analysis that writes files, and by every query refresh:

```json
{"schemaVersion":2,"run":{"fingerprint":"…","artifacts":["appgraph.graph.json","appgraph.html","appgraph.index.yaml"],"exitCode":0,"counts":{"screens":2}},"graph":{"fingerprint":"…","options":{"source":null,"depth":null,"allSources":false},"tsconfigFiles":["tsconfig.json"],"configFile":null}}
```

- **`run`** is used by `--if-stale`. It holds the run fingerprint (the graph fingerprint plus `formats`, `out`, `screen`, `locale`, `timestamp` and the run config), the artifacts the run wrote, its exit code and its counts. It is recorded only after a clean run (exit 0), so `--if-stale` never skips past an error, a strict warning or a zero-screen result. A run skipped by `--if-stale` prints the same `--json` shape as a real run, with `skipped: true` and the recorded counts.
- **`graph`** is used by queries. It holds the graph fingerprint, the sticky graph options, the tsconfig chain files and the config file. A query refresh rewrites only `graph`, so after a refresh the next `appgraph --if-stale` still regenerates the YAML and HTML.
- A plain-text sidecar, or one that does not parse, reads as "no record", which means stale.

If you commit `docs/appgraph/`, add `appgraph.graph.json` and `.appgraph-fingerprint` to `.gitignore`. Both are machine-local caches, and the fingerprint hashes file mtimes.
