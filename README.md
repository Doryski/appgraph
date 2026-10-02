# appgraph

[![CI](https://github.com/doryski/appgraph/actions/workflows/ci.yml/badge.svg)](https://github.com/doryski/appgraph/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/appgraph)](https://www.npmjs.com/package/appgraph)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> Static map of a React/TypeScript app's screens — routes, component render trees,
> navigation edges, API endpoints, feature flags and test-id selectors — emitted as
> **YAML for AI agents** and a **self-contained interactive HTML report for humans**.
> Parser-only: fast, and it works on a repo that does not compile.

## Why

Point a browser agent at a web app and it clicks. It lands on `/`, hunts for a link,
guesses at a sidebar, discovers three screens in and that the page needed a login it
never had, or a feature flag that is off, or a URL parameter it had no way to know
about. Every one of those discoveries costs a screenshot, a model call and a wrong turn.

The information the agent needed was in the source the whole time.

`appgraph` reads the repository with the TypeScript **parser** and writes down what it
finds: which URL reaches which screen, what component tree can render underneath it,
which HTTP calls that subtree makes, which screens need authentication, which sit behind
a feature gate, which URL params are required, how screens navigate to each other, and
which sidebar links point at nothing. The agent reads **one small index file** — measured
at 8.7 KB to 42.9 KB across the five applications this was built against, and about 250 KB
for an app with ~800 screens, scaling with screen and redirect count — and goes straight to a URL.

Three properties make that practical rather than aspirational:

- **Parser-only, never the TypeChecker.** Analysis is `ts.createSourceFile` and AST
  reads. No `ts.Program`, no type resolution. A run is fast, and it works on a repo
  mid-refactor that does not currently compile — which is exactly when you want a map.
- **One runtime dependency.** `commander`. `typescript` is a **peer** dependency, so the
  tool parses your code with *your* project's compiler and never disagrees with your
  repo about syntax. The report UI is compiled at build time and ships inside the
  package as a string, so it adds no runtime dependency.
- **Honesty over coverage.** A confidently wrong map is worse than no map. Where the
  parser cannot tell, the artifact says so — a stated limitation, a diagnostic, or a
  refusal to write anything at all. See [What it does not do](#what-it-does-not-do);
  that section is not boilerplate, it is the design premise.

## Features

- **Zero-config detection.** `npx appgraph` on a repo it has never seen. Detection
  scores each screen source with **evidence at `file:line`**, and `appgraph doctor`
  prints the whole trace so a wrong guess is diagnosable rather than mysterious.
  A subdirectory with its own `package.json` is a separate project: it is not scored for
  the root, so an extension or docs app nested inside a React app does not make the
  repo multi-source. When a repo is genuinely multi-source, the run refuses and
  `appgraph doctor` names the flag to use.
- **Nine screen sources.** react-router (data routers, JSX `<Routes>` and `useRoutes`),
  Next.js App Router, TanStack Router (file-based and code-based), Vue 3 vue-router
  (route tables and file routes), Nuxt 3/4 (`pages/`), Angular (standalone and NgModule
  `Routes`), Expo Router (`app/`), React Navigation (named screens), AdminJS, and
  **router-less apps** (Chrome MV3 extensions) via
  state-activated screens. See [Supported stacks](#supported-stacks).
- **Render trees with the guards that gate them.** Each screen carries a depth-bounded
  component tree, and each node carries the conditional-rendering expressions above it
  as **text**. The tool reports what *can* render, not what *does*.
- **Facts aggregated over the reachable set.** HTTP/RPC endpoints, feature gates, stores,
  query keys, i18n namespaces, form fields, messages and test-id selectors, unioned over
  each screen's transitive closure rather than just its tree. Endpoints carry a
  `transport`, and `rpc` ones are marked as **not callable by a browser agent**. On the
  reference application this finds **407 distinct endpoints, a superset of the golden
  baseline's 333** — see [Known gaps](#known-gaps-in-v010).
- **Navigation edges, and the dead ones.** Screen-to-screen navigation is reconciled
  against the route table, so a sidebar entry matching no screen is reported as a
  **dead link** — in the index, as a diagnostic, and as a badge in the HTML report. An
  agent told to click "Results" needs to know the link goes nowhere, or it loops
  retrying.
- **Two artifacts, two audiences.** A small YAML index built for an agent's context
  budget, a full YAML graph, per-screen detail files, and a single self-contained HTML
  report (no CDN, no network) for humans. The report is an interactive React app with
  keyboard shortcuts (`/` search, `Ctrl/Cmd+K` command palette, `g` then `s`/`n`/`m`/`c`/`f`
  for tabs, `?` for help). English and Polish locales.
- **Query commands for agents.** `screens`, `screen`, `links`, `search`, `components`,
  `menu`, `findings`, `stats` and `usages` cover every read path of the HTML report and
  answer from a graph cache in about 0.2 s. They print paged `--json` with published JSON
  Schemas, and a Claude Code skill ships in the package. See [For AI agents](#for-ai-agents).
- **Deterministic output.** Identical input produces byte-identical output on any machine
  in any locale, for `index`, `detail`, `html` and the graph cache. No `localeCompare` (banned by an ESLint
  rule, not by convention), one injected clock, everything sorted by code point, no
  absolute paths. Diffing two runs is meaningful.
  The CLI does not embed `meta.fingerprint` (a hash over file mtimes and the effective
  options, which `--if-stale` runs on) in the artifacts, so `full` is reproducible too; the
  fingerprint lives in the `.appgraph-fingerprint` sidecar and the `--json` summary.
- **Reports rather than guesses.** Detection never silently picks a winner between two
  live screen sources — it reports both with their evidence and asks you to choose. See
  [Multi-source repositories](#multi-source-repositories).
- **States its own confidence.** Each fact section is scored against whether its enabling
  dependency is installed. A section that is empty *while its library is present* is
  flagged `confidence/empty-section` — because an empty section is otherwise
  indistinguishable from one that legitimately has nothing to report, and a report that
  looks complete while missing an entire data layer is the exact failure this tool exists
  to prevent.
- **Typed config, typed API.** `appgraph.config.ts` via `defineConfig`, and a
  programmatic `analyze()` that performs no writes.
- **`--if-stale` fingerprinting**, `--json` for machine consumption, and documented
  exit codes for CI.

## Installation

```bash
npm install -D appgraph
# or
pnpm add -D appgraph
```

Or run it without installing:

```bash
npx appgraph
```

Requires **Node >= 20**. The package is **ESM-only**. CI runs on Linux with Node 20, 22
and 24; macOS and Windows are not covered by CI.

`typescript` (`>=5.0.0`) is a **required peer dependency** and is deliberately not
bundled — `appgraph` parses your code with your project's own compiler. Any project it
can analyse already has it.

`vue` (`>=3.4 <4`) is an **optional peer dependency**, used to read Vue templates. It is
resolved from your project first, then from appgraph's own install. If it is absent, `.vue`
scripts are still parsed, templates are skipped, and one warning says so.

`@angular/compiler` (`>=14`) is a second **optional peer dependency**, used to read Angular
templates. It is resolved from your project first, then from appgraph's own install. If it is
absent, screens, auth and `<router-outlet>` splices (a built-in tag scan) are still produced,
other template facts are skipped, and one warning (`project/template-compiler-missing`) says so.

## Usage

### CLI

```bash
# analyse the current project, write docs/appgraph/ (index + html + the graph cache)
appgraph

# a specific app, a specific output dir, only the agent index and the HTML report
appgraph --root ./frontend --out docs/appgraph --format index --format html

# one screen in full detail
appgraph --format detail --screen /invoices/:id

# skip the run entirely when nothing that affects the output has changed
appgraph --if-stale --quiet

# machine-readable run summary on stdout, all prose on stderr
appgraph --json > appgraph-run.json

# explain what detection decided, and write nothing
appgraph doctor

# query the graph: answered from the cache in --out, refreshed when the project changed
appgraph stats
appgraph screens --search invoice --auth protected
appgraph screen /invoices/42 --sections endpoints,test-ids --json
appgraph usages src/components/InvoiceTable.tsx
```

The bin is `dist/cli/bin.js` (`appgraph` on the PATH after install). Every command takes `--help`, which prints its options, output, examples and exit codes.

| Command | What it does |
| --- | --- |
| `analyze` | Analyse the project and write the artifacts (default command). A bare `appgraph [flags]` runs it. |
| `doctor` | Print the full detection trace and write nothing. |
| `screens` | List screens, filtered and searched like the report's screen list. |
| `screen <id\|url>` | Show one screen's detail: tree, navigation, endpoints, stores and more. |
| `links <id\|url>` | List a screen's navigation neighbours, as on the report's map. |
| `search <query>` | Search screens, components and menu entries at once. |
| `components` | List components with their route, renders, endpoints and stores. |
| `menu` | List navigation menu entries and whether the router knows their path. |
| `findings` | List limitations, dead links, orphan screens, confidence and diagnostics. |
| `stats` | Print the report header counts and the cache state. |
| `usages <term>` | Find the screens that use a component, endpoint, test id, store, query key or i18n namespace. |
| `glossary [term]` | Explain the report's terms. |
| `schema [command]` | Print the JSON Schema of a command's `--json` output. |

Every option, output field and example per command is in [`docs/agents.md`](docs/agents.md).

**Analysis flags** (`analyze`; `doctor` takes only the project and graph flags plus `--json` and `--timing`, and rejects the rest with exit `2`):

| Flag | Meaning |
| --- | --- |
| `--root <dir>` | Project root. Default: nearest ancestor with both `package.json` and `tsconfig.json`. |
| `--config <file>` | Config file. Default: `<root>/appgraph.config.{ts,mts,js,mjs}` if present. |
| `--out <dir>` | Output directory, where the graph cache lives too. Default: `docs/appgraph`. |
| `--source <name>` | Force one screen source, bypassing detection. |
| `--all-sources` | Run every detected screen source; screens are namespaced by source. |
| `--depth <n>` | Render tree depth. Default: `3`. |
| `--format <format>` | Repeatable. `index` \| `detail` \| `full` \| `html` \| `graph` \| `all`. Default: `index` + `html`. The graph cache is always written. |
| `--screen <id>` | Restrict output to one screen. Requires `--format detail` and is rejected with any other format. An id that matches no screen is a usage error (exit `2`, `emit/unknown-screen`). |
| `--locale <locale>` | HTML report locale: `en` \| `pl`. |
| `--no-timestamp` | Omit the HTML generation timestamp (for byte-reproducible output). |
| `--allow-empty` | On zero screens still exit non-zero, but write a marked `screens: []` artifact. |
| `--if-stale` | Skip the run when the fingerprint matches the previous *clean* run and every artifact that run wrote still exists. |
| `--strict` | Exit non-zero on any `warning` diagnostic. |
| `--quiet` | Print errors only. |
| `--json` | Emit one machine-readable object on stdout; all prose goes to stderr. |
| `--timing` | Print per-phase durations (ms) to stderr; `analyze` and `doctor` also add a `timing` object to `--json` output. |

**Query flags** (every query command takes `--root`, `--config`, `--out`, `--source`, `--all-sources`, `--depth`, `--quiet`, `--json` and `--timing`, plus):

| Flag | Meaning |
| --- | --- |
| `--cached` | Answer from the existing graph cache only and never analyse. Exits `6` when the cache is missing, stale, incompatible or corrupt. |
| `--limit <n>` | Maximum number of items to print. Default: `50`. A truncated list reports `truncated: true` and `nextOffset`. |
| `--offset <n>` | Number of items to skip before the first one printed. Default: `0`. |
| `--fields <list>` | Comma-separated item fields to keep. An unknown field is exit `2`, and the hint lists the valid ones (`appgraph schema <command>`). |

A query reads `<out>/appgraph.graph.json`. When the cache is missing or out of date, the query re-analyses first: it rewrites only the cache and its sidecar entry, never the YAML or HTML, and then answers. `--source`, `--all-sources` and `--depth` are sticky: a query that omits them reuses the values recorded by the last analysis.

`appgraph doctor` prints the resolved root and why, the config file in use, the tsconfig
chain, every source's detection score with its evidence, every directory excluded from
discovery with the rule that excluded it, the nested packages not scored for this root (with
the `--root` that maps each one), the globs attempted, the near-misses, the test-id attribute histogram, the stated limitations of the run and the
fingerprint. It **always exits 0** once the flags themselves parsed: it reports, it does
not judge. When something looks wrong, run this first.

#### Output files

Written into `--out` (default `docs/appgraph/`):

| Format | File | Contents |
| --- | --- | --- |
| `index` | `appgraph.index.yaml` | **Default.** The agent index, small on purpose. Measured with the built CLI at `--format=index --no-timestamp`: **8.7 KB** (Chrome extension, 9 screens) · **12.7 KB** (Next App Router, 37) · **19.9 KB** (the reference app, 31) · **34.4 KB** (TanStack Router, 100) · **42.9 KB** (AdminJS, 230). The index scales with screen and redirect count: **51.5 KB** (umami, 58 screens) and **250 KB** (Sentry, 824 screens). The stated limitations are a flat ~4.0 KB of that, whatever the app, with the 4096 B budget enforced by a test. |
| `html` | `appgraph.html` | **Default.** Self-contained interactive React report (keyboard shortcuts, light/dark/system theme); no network requests. Its tree payload is interned and rehydrated in the browser. |
| `graph` | `appgraph.graph.json` | **Always written.** The graph cache the query commands read. Compact JSON with interned trees and paths, and no timestamp or fingerprint, so identical input gives an identical file. |
| `full` | `appgraph.yaml` | **Opt-in.** The whole graph. In `schemaVersion: 2`, default-valued tree fields are omitted and repeated subtrees are interned into a top-level `subtrees:` map (`{ref: t<n>}`). See [docs/agents.md](docs/agents.md#full-yaml-v2-shape). |
| `detail` | `appgraph.<slug>.yaml` | One screen, in full. Requires `--screen`. |
| `all` | — | `index` + `html` + `full` + `graph`. |

Measured on Sentry (824 screens, 9,416 files):

| Measure | Result |
| --- | --- |
| Default run | **10.5 s / 1.6 GB** (`index` + `html` + `graph`) |
| Index-only run | **10.0 s** |
| `appgraph.yaml` (`full`) | **52 MB** |
| `appgraph.html` | **18 MB** |
| `appgraph.graph.json` | 21 MB |
| A query on a fresh cache | **~0.2 s** |

Every run also writes a `.appgraph-fingerprint` sidecar (one JSON line, `schemaVersion: 2`) with two records:

- **`run`** serves `--if-stale`. It holds the run fingerprint, every artifact the run wrote, the exit code and the counts. It is recorded only after a **clean** run (exit `0`), so a later `--if-stale` never skips past an error, a `--strict` warning or a zero-screen result, and a missing or rewritten artifact makes the next run go ahead. A skipped run's `--json` has the same shape as a real one, with `skipped: true`.
- **`graph`** serves the query commands. It holds the graph fingerprint, the sticky `--source`/`--all-sources`/`--depth`, and the tsconfig and config files. A query refresh rewrites only this record, so the next `--if-stale` still regenerates the YAML and HTML.

The fingerprints hash the analyser version, the resolved config and options, the tsconfig chain's contents, the dependency manifests, and the **paths plus modification times** of every file under the source roots (not file contents), so a `touch` counts as a change. The graph fingerprint leaves out the output-only options (`--format`, `--locale`, `--screen`, the timestamp). A sidecar that does not parse, or carries another `schemaVersion`, reads as stale.

`meta.fingerprint` is not embedded in the artifacts by the CLI, which is what makes
`--no-timestamp` output byte-reproducible; the fingerprint lives in the sidecar and in the
`--json` summary.

If you commit `docs/appgraph/`, add the machine-local caches to `.gitignore`:

```gitignore
docs/appgraph/appgraph.graph.json
docs/appgraph/.appgraph-fingerprint
```

Writes are atomic: every artifact is staged to a temporary sibling file and renamed into
place only once all of them were staged. A target that is a **symlink**, or sits inside a
symlinked directory, is refused (exit `5`). Two agents querying at once is safe: the last writer wins.

Under `--json`, **every** failure, including a usage error, still prints exactly one object on stdout, with the prose on stderr:

```json
{ "command": "screen", "exitCode": 2, "error": { "code": "emit/unknown-screen", "message": "unknown screen 'nope'", "hint": "run appgraph screens to list them" }, "diagnostics": [] }
```

`error.code` is stable (`cli/usage`, `usage/unknown-field`, `emit/unknown-screen`, `cache/missing`, `cache/stale`, `analysis/refused`, …), and `hint` names the next step. `appgraph schema error` prints the JSON Schema of this object.

#### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Clean run, or the query was answered. |
| `1` | At least one `error` diagnostic, including a multi-source refusal. |
| `2` | Usage error (unknown command or flag, bad value, unknown screen or field). |
| `3` | No screens found. The full detection trace is printed. |
| `4` | `--strict` and at least one `warning` diagnostic. |
| `5` | The run itself failed (unsupported compiler, config load, unwritable output directory). |
| `6` | `--cached` and the graph cache is missing, stale, incompatible or corrupt. |

When several apply, the precedence is `2` > `6` > `5` > `3` > `1` > `4`.

Note that **zero screens is a failure, not an empty success** (exit `3`), and that a
refusal writes no files at all. A run that finds only API routes or redirects counts as
zero screens too: they are listed, but they are not screens. Both are deliberate: a CI job that silently publishes an
empty map is the failure mode this tool exists to avoid.

### Library

`analyze()` performs **no writes**. Emitted files come back as an array and the caller
decides where they land. When you pass no `config` object it loads `appgraph.config.*` from
the root itself, exactly as the CLI does; `configFile` names a specific file to load.

```ts
import { analyze } from "appgraph"

const result = await analyze({ root: "./frontend" })

if (result.refused) {
  // several live screen sources; result.trace explains and nothing was emitted
  console.error(result.trace)
} else {
  for (const screen of result.graph.screens) {
    console.log(screen.id, screen.activation)
  }

  for (const file of result.files) {
    // file.path is relative ("appgraph.index.yaml"); file.content is the text
  }
}

for (const diagnostic of result.diagnostics) {
  console.log(diagnostic.severity, diagnostic.code, diagnostic.message)
}
```

The config file is typed through `defineConfig`:

```ts
// appgraph.config.ts
import { defineConfig } from "appgraph"

export default defineConfig({
  sourceRoots: ["src"],
  screenSource: "react-router",
  depth: 4,
  out: "docs/appgraph",
  formats: ["index", "html"],
  testIdAttribute: "data-testid",
  redirects: { unauthenticated: "/login" },
})
```

CLI flags win over the config file. `--root` wins over the config file's own `root`,
which wins over the nearest ancestor with `package.json` + `tsconfig.json`, which wins
over the current directory.

## For AI agents

An agent should not read a multi-megabyte YAML file to answer "which screen is `/invoices/42`". The query commands answer that kind of question in about 0.2 s from the graph cache, and each takes `--json` for one compact, paged object (`--limit`, `--offset`, `--fields`). The cache refreshes itself when the project changes. `appgraph schema <command>` prints each output contract as JSON Schema, and every failure prints `{error: {code, message, hint}}`.

```bash
appgraph stats --json                              # what is in the graph, and whether the cache is fresh
appgraph screens --search invoice --json           # find screens
appgraph screen /invoices/42 --json                # one screen: tree, navigation, endpoints, test ids, …
appgraph usages 'GET /api/invoices' --json         # which screens call this endpoint
appgraph findings --section dead-links --json      # links that go nowhere
```

The package ships a **Claude Code skill** in [`skills/appgraph/SKILL.md`](skills/appgraph/SKILL.md). It covers when to reach for appgraph, recipes, paging, cache semantics, exit codes and the usual pitfalls. To install it, copy it into your project's skills:

```bash
mkdir -p .claude/skills
cp -R node_modules/appgraph/skills/appgraph .claude/skills/
```

You can also point your agent's instructions (`CLAUDE.md`, `AGENTS.md`) at `node_modules/appgraph/skills/appgraph/SKILL.md` and leave it in place, so it stays in step with the installed version. The complete reference is [`docs/agents.md`](docs/agents.md). It covers every command, option and output field, the HTML report to CLI parity table, the full YAML v2 shape and the cache format.

## Configuration

Every field is optional; the point of the zero-config layer is that a config file is an
**override**, not an entry fee. Detection produces the same resolved shape a hand-written
config would.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `root` | `string` | resolved from cwd | Project root. Resolved relative to the config file. |
| `sourceRoots` | `string[]` | `["."]` | Directories to analyse, project-relative. |
| `screenSource` | `string` | detected | Force one screen source. Bypasses detection. |
| `screenSources` | `string[]` | detected | Force several screen sources. |
| `depth` | `number` | `3` | Render tree depth bound. |
| `out` | `string` | `"docs/appgraph"` | Output directory. |
| `formats` | `string[]` | `["index","html"]` | Which artifacts to emit. The CLI always adds the graph cache (`graph`). |
| `conflicts` | `"merge" \| "first" \| "error"` | `"merge"` | What to do when two sources claim the same URL. |
| `kindRules` | `KindRule[]` | derived | Directory-to-kind classification, and which directories are traversable for reachability. A rule from the config **wins over the presets**: one without a `priority` ranks at `100`, above every built-in rule. `pathRegex` and `fileRegex` must be valid regular expressions (`config/invalid-field`). |
| `navSources` | `string[]` | all registered | Restrict which navigation sources run. |
| `menus` | `MenuSpec[]` | `[]` | Menu/nav configs named explicitly. Auto-discovery still runs alongside them. |
| `stringSources` | `string[]` | derived | Files whose string constants feed path resolution (e.g. a `Paths` enum). |
| `testIdAttribute` | `string` | detected | Force the test-id attribute instead of probing for it. |
| `redirects.unauthenticated` | `string` | — | Where an unauthenticated visitor is sent. Also narrows loader guards (`loader`, `clientLoader`, `getServerSideProps`, TanStack `beforeLoad`): when set, only a conditional redirect to this target marks a route protected; other redirects stay as evidence. |
| `redirects.flagOff` | `string` | — | Where a visitor with the flag off is sent. |
| `redirectRules` | `{ source, destination }[]` | `[]` | Extra redirect rules in Next.js `redirects()` syntax (`:p`, `:p?`, `:p*`, `:p+`). A menu entry or navigation that matches no screen follows the first matching rule in declaration order, as Next.js does (config rules first, then the discovered ones; at most 5 hops) and records `viaRedirect`. Regex sources and `/*`-like sources never resolve. Merged across layers, and joined with the rules read from the root `next.config.*`. Separate from `redirects`. |
| `strict` | `boolean` | `false` | Treat warnings as failures. |
| `allowEmpty` | `boolean` | `false` | Write a marked empty artifact on zero screens (still exits non-zero). |
| `extensionRewrites` | `ExtensionRewrite[]` | derived | Import-specifier extension rewriting, e.g. `nodenext`'s `.js` → `.tsx`. Merged **over** the derived set. |
| `candidateSuffixes` | `string[]` | derived | Extra module-resolution probe suffixes. Merged over the derived set. |
| `exclude` | `string[]` | `[]` | Directory names, root-relative paths and globs to skip (`packages/legacy`, `apps/*/generated`). A name written as `!name` **restores** a default exclusion (`!dist`). |
| `generated` | `string[]` | `[]` | Paths to treat as generated. |
| `wrapperRoles` | `WrapperRule[]` | the react-router defaults | `{ name, role, tagRegex?, exported?, importedFrom?, reads?, entryFrom? }` rules that classify wrapper tags in react-router `element`s (`role`: `layout` \| `guard` \| `errorBoundary` \| `redirect` \| `transparent`). Merged **by `name`** over the defaults, so a rule named like a default replaces it and the rest stay. `entryFrom` (a guard rule; the default `protected-route` has `"component"`) names the member of a mapped route item that holds the page: a guard handed the item (`route={route}`) or that member makes the page the entry, and the guard is spliced where it renders it. |
| `pathlessRoles` | `Record<string, { auth?: "protected" \| "public" }>` | `{ _authed: { auth: "protected" } }` | What a TanStack pathless segment (`_authed`) or code-route `id` means. Merged **by key** over the default. |
| `reactRouter.routeDialect` | `{ name?, fields?, translators?, unwrapCalls?, prefixRules? }` | `@sentry/*` dependency: the built-in Sentry preset; otherwise plain react-router | The property names of a custom route-object dialect. `fields` renames `path`, `element`, `component`, `children`, `redirect`, `index`, `lazy`; `translators` are calls whose arguments use the dialect (when set, the names apply only there); `unwrapCalls` are wrappers around the real route or component (`memoize`); `prefixRules` (`{ flag, prefix, keepPlain }`) mount a flagged route under `prefix`, and also unprefixed when `keepPlain`. A later config layer replaces the dialect as a whole. A configured dialect disables the Sentry preset. |
| `entryComponents` | `{ file, exportName? }[]` | derived from the MV3 manifest | The components whose guarded JSX branches become `state-screens` screens. Replaces the manifest-derived set. |
| `vueAuth` | `{ protectedMiddleware?, publicMiddleware?, authMetaKeys? }` | `protectedMiddleware`: `admin`, `auth`, `authenticated`, `moderator`, `permission`; `publicMiddleware`: `guest`; `authMetaKeys`: `auth`, `requireAuth`, `requiresAuth` | What vue-router `meta` and Nuxt `definePageMeta` mean for a screen's `auth`. A middleware name in `protectedMiddleware` marks the screen `protected` and one in `publicMiddleware` marks it `public`; a `meta` key in `authMetaKeys` set to `true` means protected and to `false` means public. Each list is **added to** the defaults (merged and sorted, never replacing them). Auth is inherited by child routes; a screen with both a protected and a public signal is `unknown`. Each value is an array of strings. |
| `angular` | `{ protectedGuards?, publicGuards?, authDataKeys?, publicData?, redirectDataKeys? }` | `protectedGuards`: `AuthGuard`, `authGuard`, `LoginGuard`, `loginGuard`, `AuthenticatedGuard`, `AuthenticationGuard`, `isAuthenticatedGuard`; `publicGuards`: `UnloggedGuard`, `GuestGuard`, `guestGuard`, `NoAuthGuard`, `noAuthGuard`, `AnonymousGuard`; `authDataKeys`: `auth`, `authorities`, `roles`, `permissions`; `publicData`: `{ module: "public" }`, `{ public: true }`, `{ isPublic: true }`; `redirectDataKeys`: `redirectTo` | What Angular route guards and `data` mean for a screen's `auth`. A guard in `protectedGuards` marks the screen `protected` and one in `publicGuards` marks it `public`; a `data` key in `authDataKeys` marks it `protected` when any guard is present (the value is kept as evidence); a route whose `data` matches an entry of `publicData` is `public` and wins over guards; a `data` key in `redirectDataKeys` on a componentless guarded leaf becomes redirect rules. Each list is **added to** the defaults (merged and sorted, never replacing them). `canActivate` and `canMatch` cover the route and its descendants, `canActivateChild` its descendants only, and `canDeactivate` is ignored. A guard that always returns `true` is neutral; an unrecognised guard leaves `auth` `unknown`. `publicData` is an array of objects; the other values are arrays of strings. |
| `expoRouter.root` | `string` | the `expo-router` plugin's `root`, else `app/`, else `src/app/` | The Expo Router routes directory, project-relative. A literal `root` option of the `expo-router` plugin in `app.config.*`, `app.config.json` or `app.json` is tried first, then this field, then `app/` and `src/app/`; the first that holds route files is used. An `app.config.*` that is not a literal object is the info `project/expo-config-dynamic`. |
| `reactNavigation` | `{ pathTables?, authOptionKeys? }` | `pathTables`: none; `authOptionKeys`: `requireAuth` | `pathTables` (`{ callee, argument }[]`) names calls or `new` expressions whose argument at index `argument` is an object mapping route names to a path or an array of paths: `{ callee: "Router", argument: 0 }` reads `new Router({ Home: ["/", "/download"] })`. Entries that do not fold are counted in one `screens/path-table-unreadable` warning. `authOptionKeys` are the screen `options` booleans that decide `auth` (`true` protected, `false` public), **added to** the default. |
| `nativeAuth.signedIn` | `string[]` | `isSignedIn`, `isLoggedIn`, `isAuthenticated`, `hasSession`, `session`, `user`, `currentUser` | The signed-in names that let an Expo `Stack.Protected guard` or a React Navigation `if:` / conditional JSX guard decide `auth`. The guard's last segment must match a name or its hook form (`auth.isSignedIn`, `isSignedIn()`, `useIsSignedIn`); a plain or `=== true` guard is `protected`, a negated one (`!x`, `x === false`, `x == null`) `public`, anything else leaves `auth` unset. **Added to** the defaults. |
| `featureFlags.lookupFunctions` | `string[]` | `getConfiguration`, `useFlag`, `isEnabled`, `useFeatureFlag` | Extra flag-lookup function names, matched bare or as a method (`enabled` matches `ax.features.enabled(…)`). **Added to** the defaults. For a configured name, a first argument that does not fold but is a member access (`Features.X`) records the member name. |
| `adminjs` | `{ optionsFile?, componentLoaderFile? }` | probed | The AdminJS options file (skips the content probe, and makes AdminJS detectable when the probe cannot recognise it) and the `componentLoader` file. |
| `extractors` | `string[]` | all | The **exact** set of fact extractors to run, by name: `component-tree`, `http-client`, `server-fn`, `navigation`, `query`, `convex`, `store`, `i18n`, `forms`, `feature-flags`, `messages`, `test-ids`. An unknown name is an error (`config/unknown-extractor`). |

Unknown keys are **errors** (`config/unknown-field`) with a "Did you mean …?" hint (also for
`pathless` and `wrappers`, and for a top-level `pathTables`, `signedIn` or
`lookupFunctions`, which name their nested field), and a value of the wrong shape is
`config/invalid-field`. A path named by `entryComponents` or `adminjs` that is not a file
under the root is `config/missing-file`. Regular expressions in `kindRules` and
`wrapperRoles[].tagRegex` are validated up front rather than failing mid-run.

The output folders `build`, `builds`, `dist`, `out`, `coverage` and `storybook-static` are
excluded only where they are build output: at the project root, directly inside a package
(a directory with its own `package.json`), or outside every source root. A folder with one
of those names deeper inside your sources, say `src/features/out/`, is analysed.

`stringSources` is the field most worth knowing about, because `navigate(Paths.ORDERS)` is
only resolvable if the analyser knows where `Paths` lives. **Detection derives it**: on the
reference application a zero-config run locates the path-constant module on its own and
produces the same **148 navigation edges** as a run with `stringSources` pinned by hand,
with identical `reachable` on every screen. Set the field when your path constants live
somewhere detection does not reach — `appgraph doctor` prints what it derived — not as a
matter of routine.

### What a config file may import

The config loader deliberately is not a bundler. **An `appgraph` config may import only
`"appgraph"` itself, Node builtins, and plain `.js`/`.mjs` files.** It may **not** import
other `.ts` files, path-aliased modules, or JSON. Keep the config self-contained; if you
need shared values, put them in a plain `.mjs` file.

A `.ts`/`.mts` config is transpiled to a temporary `.mjs` file **next to the config file**
(so its relative and bare imports resolve from there) and removed again afterwards; this works
on Node 20+, the minimum the package supports, with no loader flag.

The config file **is executed** (via a transpile-then-dynamic-import step), so it runs with
your privileges like any other JavaScript config. Treat one from an untrusted source the
way you would treat an untrusted `vite.config.ts`.

## Supported stacks

Each of these has a working adapter and tests. "How complete" is stated honestly, and the
differences are real. Every accepted configuration form, every refused one, and every library the
fact extractors read (HTTP clients, query, stores, i18n, forms, flags, test ids, tsconfig shapes) is
catalogued in [docs/supported-libraries.md](docs/supported-libraries.md).

| Stack | Detected by | How complete |
| --- | --- | --- |
| **Next.js App Router** | `next` in deps **and** a `page.{tsx,jsx,ts,js}` under any `app/` directory | Screens from the file convention (private `_folders` opted out), plus `route.ts` handlers emitted as `kind: "api"` screens listed separately from human screens. Parallel (`@slot`) and intercepting (`(.)`, `(..)`, `(..)(..)`, `(...)`) routes are read: slot files never become screens, a layout with `@x` gets slot branches in its tree, and an intercepting page adds an `intercept` activation to its target (see [supported libraries](docs/supported-libraries.md#22-nextjs-app-router)). The root `next.config.*` `redirects()` table is also read statically. Linking a client call site to the `"use server"` action it invokes needs the TypeChecker; the action is recorded and `facts/needs-typechecker` is emitted instead. |
| **Next.js Pages Router** | `next` in deps **and** a page file under `pages/` (or `src/pages/`) other than `pages/api/**` and the root special files (100; API-only projects score 1) | One screen per page file: `[id]`, `[...slug]`, `[[...slug]]`; `_x`/`(x)` folders stay literal segments; a root `pages/` wins over `src/pages/`; a literal `pageExtensions` in `next.config.*` is honoured. The entry is the default export followed through re-exports. `_app` is the outermost layout (spliced at its single `<Component/>`), and a literal `Page.getLayout = (page) => <Layout>{page}</Layout>` adds layouts inside it. `pages/api/**` are emitted as `kind: "api"` screens. A `getServerSideProps` redirect marks the page protected (conditional) or a redirect (unconditional). Runs together with the App Router in one graph. `basePath`, `rewrites()` and `i18n` are not read. See [supported libraries](docs/supported-libraries.md#28-nextjs-pages-router). |
| **React Router framework mode / Remix v2** | `@react-router/dev` or `@remix-run/dev` in deps **and** `app/routes.ts`, an `app/routes/` folder, a `remix.config.*` or a vite `remix()` plugin (100) | `routes.ts` (`route`, `index`, `layout`, `prefix`, `relative`), `flatRoutes()` from `@react-router/fs-routes`, the Remix v2 default flat-file convention and remix-flat-routes (`+` folders, `_layout`) via `remixRoutesOptionAdapter`. `root.tsx` is the outermost layout; a module with no default export is a resource route (`kind: "api"`). `loader`/`clientLoader` redirects decide auth (conditional: protected, with the condition as evidence; unconditional: a redirect), and a helper is followed one hop. An unknown call over route arrays (`mergeRoutes(a, b)`) is read as their union with an info; imperative `defineRoutes` and non-default remix-flat-routes options are **reported, not read**. See [supported libraries](docs/supported-libraries.md#29-react-router-framework-mode-and-remix-v2). |
| **AdminJS** | `adminjs` in deps **and** an `AdminJSOptions` type reference or an object literal with both `resources` and `rootPath` | Screens and URL templates from `AdminJSOptions`. **Render trees for framework-generated screens are empty by design** — see below. |
| **react-router v5/v6/v7 (library mode)** | `react-router*` in deps **and** a `createBrowserRouter`/`createHashRouter`/`createMemoryRouter` call (90), or `<Routes>`/`<Route>`/`useRoutes` (80); test, mock and Storybook routers ignored | Object-literal route arrays, JSX `<Routes>`/`<Route>` trees, `createRoutesFromElements`, `useRoutes`, and descendant `<Routes>` under a `path="x/*"` route. `.map` over a literal route array is read; a `.map` over any other data is **reported, not read**. v5 `<Switch>` roots are read with `component`, `render` and children routes, path arrays, `exact` (as evidence), `<Redirect from to>`, `${match.path}` nesting and `useState`/`push`-built route arrays (treated as a runtime gate). Framework mode is read by its own source (below); in such a project this one scores 1 and does not run. |
| **wouter** | `wouter` in deps **and** a file importing `wouter` with `<Switch>`/`<Route>` (80) | `<Switch>` and loose `<Route>` groups, `component`/children/function-child routes, `nest`, same-file `<Router base>`, `<Redirect>`, `:id?`/`*?` paths. Verified on a synthesized fixture (no large public wouter app is known). |
| **TanStack Router** | `@tanstack/react-router`/`react-start` in deps **and** a `createFileRoute(`/`createLazyFileRoute(` call (100), or `createRoute`/`createRootRoute` (90) | File-based routes (the literal is authoritative, the filename cross-checks it; `.lazy` halves, route groups, optional params and `route.tsx` files understood) and code-based `createRoute`/`getParentRoute` trees. `createServerFn` endpoints are marked `transport: "rpc"`. `validateSearch` schemas yield param **names only, not required-ness**. |
| **Vue 3 + vue-router** | `vue-router` or `unplugin-vue-router` in deps (and no `nuxt`) **and** a `createRouter(` call from `vue-router` with a `routes` mention (90), or file routes via `unplugin-vue-router` / `vue-router/auto-routes` (100) | Explicit route tables: `createRouter({ routes })` arrays (inline, by `const`, spreads, `.map`/`.filter` unwrapped), nested `children` with absolute and relative paths, lazy `() => import(...)` components, named views (`components: {}`), `redirect` by path or route name, `meta`-based `auth` (`vueAuth`), `name` kept as `routeName`, `<RouterView>` as the splice point. File routes (`src/pages` or the plugin's `routesFolder`): `[id]`, `[[id]]`, `[...all]`, dot-nesting, `parent.vue` + `parent/` nesting, `definePage({ ... })` literals and `<route>` JSON blocks. `.vue` scripts are read with no extra dependency; template facts (render edges, `v-if`/`v-show`/`v-for` guards, test ids, `RouterLink`, `$t`) need the optional `vue` peer. `router.addRoute(...)` is reported, not read; a global `beforeEach` with no `meta` signal leaves auth `unknown`. Vue 2 is not supported. |
| **Nuxt 3 / 4** | `nuxt` in deps **and** a pages directory (`pages/` or `app/pages/`) or an `app.vue` | One screen per page file: `[id]`, `[[id]]`, `[...slug]`, `(group)` folders, `parent.vue` + `parent/` nesting under `<NuxtPage>` (a parent with a child `index.vue` is a layout, not a screen), `definePageMeta` (`middleware`, `layout`, `path`, `name`, `redirect`), `app.vue` and `layouts/` as ancestors, auto-imported components resolved by Nuxt's directory naming (`components:` config dirs and `pathPrefix: false` honoured), `routeName` from the meta or Nuxt's generated name. Directories come from literal `nuxt.config` fields (`srcDir`, `dir.*`, `components`). Auth comes from middleware names; when a global middleware (`*.global.*`) exists and a page has no signal, auth is `unknown`. Components and pages from `extends` npm layers are **not read** (one info names them). A missing generated `.nuxt/tsconfig.json` is an info, not an error. Template facts need the optional `vue` peer. |
| **Angular (standalone and NgModule)** | `@angular/router` **and** `@angular/core` in deps **and** a `provideRouter(` or `RouterModule.forRoot(` call (90); an AngularJS-only project scores 0 | Standalone `provideRouter(routes)` and NgModule `forRoot`/`forChild` tables, the latter mounted through the `imports`/`exports` closure of the bootstrapped module. Nested `children`, `loadChildren` (a routes file or a module, default exports included), `loadComponent`, factory functions called with literal arguments, `if`/`push` building and object spreads, `redirectTo`, and a literal `data.redirectTo` on a guarded componentless leaf as conditional redirect rules. `canMatch` siblings on one URL merge into one screen. `auth` comes from guards and route `data` (`angular` key); an unrecognised guard is `unknown`. `<router-outlet>` and `<ng-content>` splice layouts even without the compiler; tag-to-class edges resolve selectors through standalone `imports` or NgModule `declarations`/`exports`, and `@if`/`@for`/`@switch`/`@defer` and `*ngIf`/`*ngFor` become guards. Template facts need the optional `@angular/compiler` peer. |
| **Expo Router** | `expo-router` in deps **and** a route file in the routes directory: the literal `root` of the `expo-router` plugin in `app.config.*` / `app.json`, else `expoRouter.root`, else `app/` or `src/app/` (100) | One screen per route file: `index`, `[id]`, `[...rest]`, `(group)` and group-array `(a,b)` folders (a `_` prefix is **not** private), `+not-found` as a catch-all at its folder, and `*+api` files as `kind: "api"` screens; `+html`, `+native-intent`, `+middleware` and `_sitemap` are skipped. `_layout` files are layout ancestors, spliced at their `Stack`/`Tabs`/`Drawer`/`Slot`/`NativeTabs` or `withLayoutContext(...)` navigator. Every screen carries a `route` activation per group-qualified name (`(tabs)/(home)/index`), so group-qualified hrefs resolve by name. When groups put several files on one URL, the first group-qualified name by code point keeps the URL and the others stay addressable by name (`screens/shared-route`). Platform variants (`x.ios.tsx`, `x.web.tsx`, and `.tv` with a tvOS dependency) are one screen with extra entries tagged `platform`. `auth` comes from `Stack.Protected guard={…}` through `nativeAuth.signedIn`; hook guards and conditional `<Redirect>` stay `unknown` with evidence. See [supported libraries](docs/supported-libraries.md#211-expo-router). |
| **React Navigation** | an `@react-navigation/*` package in deps **and** a `create…Navigator(` call in an app file, with **no** `expo-router` dependency (90) | One screen per route name, from JSX `<X.Screen name component\|getComponent\|children>` under any `create…Navigator()` result (custom factories included; a helper that takes the navigator as a parameter is followed one level) and static `create…Navigator({ screens, groups })` configs (a component, a nested navigator, `{ screen, linking, if, options }`, `create…Screen`). A name registered in several navigators is one screen with a `route` activation per navigator. URLs come from `linking.config.screens` (nested paths joined), static `linking` fields, `enabled: "auto"` (kebab-case names) and `reactNavigation.pathTables`; a screen with no path is a named screen under `stateScreens`, with the id `screen://react-navigation/<name>`. `navigation.navigate("Name")` and the other name forms resolve to it. `auth` comes from `options` keys (`reactNavigation.authOptionKeys`, default `requireAuth`) and `if:` / `{isSignedIn ? … : …}` guards through `nativeAuth.signedIn`. A non-literal name is `screens/dynamic-registry`. See [supported libraries](docs/supported-libraries.md#212-react-navigation). |
| **Router-less (Chrome MV3)** | an MV3 `manifest.json` with `manifest_version: 3` plus a popup, content script, service worker or offscreen document | State-activated screens, host patterns and the message graph. **Partially served by design** — see below. |

**Vue and Nuxt.** On the corpus apps the URL set matches a hand-verified list of each app's own
routes with recall and precision of **1.00** for n8n and vikunja (vue-router route tables) and
for kun-galgame-forum and OpnForm (Nuxt `pages/` trees). Beyond screens, the Vue ecosystem
extractors read Pinia `defineStore`, `vue-i18n` (`useI18n`, template `$t`), `$fetch` / `useFetch` /
`useLazyFetch` and `ofetch`, and `@tanstack/vue-query`; navigation reads `<RouterLink>` /
`<NuxtLink>`, `navigateTo` and `$router`. The known gaps:

- **Vue 2 is not supported.** The template pass is off and one warning (`project/template-compiler-unsupported`) says so; scripts are still read. With no compiler at all the warning is `project/template-compiler-missing`.
- **`lang="pug"` templates and `<template src>` are not read.** One info diagnostic reports the
  unsupported template blocks; the rest of the file is still read.
- **Nuxt `extends` layers are not read.** Pages, layouts and components that come from an npm layer
  never become screens or render edges; `project/nuxt-layer-skipped` names each layer.
- **`router.addRoute(...)` routes are diagnosed, not mapped** (`screens/dynamic-registry`), and so is a
  `createRouter` call whose `routes` does not fold to a literal list.
- **An imperative `router.beforeEach` guard is never evaluated.** An app whose access rules live in
  one (vikunja's exemption list) gets `auth: unknown` on every route with no `meta` signal, not a
  guessed `public`.
- **Mid-template interpolation expressions are not resolved against script constants**: a bound
  link target that interpolates a script `const` into a template literal stays unresolved.
- **Two files claiming one auto-import component name** get no render edge, plus the info
  `facts/ambiguous-component-name`.

**Angular.** On the corpus apps the URL set matches a hand-derived list of each app's own routes:
PeerTube (standalone) maps **121 screens** and thingsboard (NgModule) **570 screens**, each with
recall and precision of **1.00** (thingsboard against a 637-URL list), and the extractors find 72 and
646 endpoints (`HttpClient`) respectively. StreamPipes, whose `app.routes.ts` is generated from a
`.mst` template, gets one `screens/route-module-missing` naming `deployment/app.routes.mst` instead
of guessed URLs; Oppia maps 79 screens. Beyond screens, the Angular extractors read
`routerLink`, `router.navigate`/`navigateByUrl`, `HttpClient`, ngx-translate and `$localize`
namespaces, and NgRx features. The known gaps:

- **`matcher` routes and named outlets (`outlet:`) are reported, not mapped.** Each gets
  `screens/unsupported-router-style` (info) and its subtree is not read; a URL decided by a
  matcher function is runtime logic.
- **AngularJS is not supported.** A project with an `angular` 1.x or `@angular/upgrade` dependency
  gets the info `project/angularjs-hybrid`; its Angular routes are mapped where literal and its
  AngularJS directives and controllers are not read. An AngularJS-only project matches no screen source.
- **Relative `routerLink` and `navigate` targets are counted, not resolved.** Without a leading `/`
  they need the active route, so they are skipped and counted as `unresolvedNavigations`.
- **i18n is namespaces only**, as everywhere (ngx-translate and `$localize` record `default`).
- **Selector matching ignores `:not()` and class selectors.** Two components that match one tag get
  no edge, plus the info `facts/ambiguous-component-name`.
- **`const router = inject(Router)` locals are not followed**: only `this.<member>` receivers (a
  constructor parameter property or an `inject()` field) that resolve to `Router` are read as navigation.
- **Service URLs built from class statics may not flatten**, so an `HttpClient` endpoint can be missing
  or partial.
- **Without `@angular/compiler`**, only screens, auth, `<router-outlet>` splices and script facts are
  produced (see the requirements above).

**Expo Router and React Navigation.** The corpus checks streamyfin (E1) and cherry-studio-app (E2)
against URL lists derived from their `app/` trees (recall ≥ 0.98, precision 1.00), and Bluesky (E4)
against every literal name it registers, the URLs of its `src/routes.ts` table (read through
`reactNavigation.pathTables`, recall ≥ 0.95) and at least one resolved name edge. Measured: streamyfin
maps 66 screens and cherry-studio-app 54, both at recall and precision 1.00; Bluesky maps 84 named
screens (all 83 expected names, plus the cast `MyProfile`) at URL recall 1.00 with 85 resolved name
edges. Beyond screens,
navigation reads Expo's `router` and `useRouter()` (`push`, `replace`, `navigate`, `dismissTo`),
`<Link href>`, `<Redirect href>` and `{ pathname }` objects, and React Navigation's `useNavigation()`
and screen `navigation` props (`navigate`, `push`, `replace`, `popTo`, nested `{ screen }`),
`StackActions` / `CommonActions` and `<Link screen>`; the extractors also read `testID`, Lingui and
GrowthBook. The known gaps:

- **Auth from hook guards stays `unknown`.** An Expo layout that redirects through `useSegments()` plus
  `router.replace`, or a conditional `<Redirect>`, is recorded as evidence and never decides `auth`.
  Only `Stack.Protected` / `Tabs.Protected` guards, React Navigation `options` keys and `if:` or
  conditional-JSX guards that match `nativeAuth.signedIn` do.
- **The shared-route winner is the documented cold-link rule, not Expo's runtime sort.** When groups
  put several files on one URL, the first group-qualified route name by code point owns it, as Expo
  documents for a cold link ("renders the first alphabetical group match"). In-app navigation can land
  on another of those files; each loser stays a named screen with the info `screens/shared-route`.
- **Two files of one group path on one URL keep only one.** `a.tsx` next to `a/index.tsx`, or an
  `+api` file on a page's URL, is the warning `screens/route-conflict`: the first file by path (or the
  page) wins and the other is not mapped.
- **URL-less named screens are not orphans and are not on the Map.** A React Navigation screen with no
  path, or an Expo shared-route loser, sits under `stateScreens`; `screens/orphan` and the report's Map
  tab cover addressable screens only.
- **Vue and Nuxt do not emit `route` activations yet.** Their names still resolve through
  `Screen.routeName`; only Expo Router and React Navigation screens carry the activation.
- **Dynamic names are not mapped.** A non-literal `<Stack.Screen name>` is `screens/dynamic-registry`,
  and `navigate(name)` with a non-literal name is an unresolved navigation. A literal name that matches
  no screen is a `nav/dead-link` warning, its target `name:<Name>`.

Two of these need their limits spelled out, because a table row is too small to be honest:

**AdminJS emits screens with empty render trees, on purpose.** An AdminJS action with no
custom component gets a screen whose URL is discoverable and whose render tree is
**empty**, because AdminJS renders it from library-internal components that never appear
in your source. The adapter supplies `ancestors: []` as an *assertion of absence* rather
than staying silent about it. A URL with an empty tree is more useful than no row at
all — but do not read those empty trees as a bug in your app or as full coverage of it.

**Router-less apps are partially served, and that is stated in the design.** With no URLs,
the primary value proposition — an agent jumping straight to a URL instead of clicking —
**does not exist for these apps**. The reference extension therefore configures
`formats: ["full", "html"]` and **opts out of the agent index entirely**; that is a
per-project config choice, not something the tool does for you. If you do emit an index
for a router-less app, non-addressable screens are separated out under `stateScreens` with
the note that they have no URL and must be reached through the app. The same section holds
**named screens**: a React Navigation screen with no linking path, or an Expo shared-route
loser, has a `route` activation (`name`, `navigator`) instead of a URL, so an agent reaches it
through in-app navigation by that name.

The Chrome extension case is in the supported set to prove the data model does not assume
URLs, *not* to claim that URL-less apps get equal value from the tool. For such an app the
useful output is the state-activation list, the host patterns and the message graph — the
`MessageType` chain between popup, content script and service worker genuinely *is* that
app's edge graph, because there is no navigation to find.

## What it does not do

This project's premise is that a confidently wrong map is worse than no map. The
following are not oversights, and none of them is a roadmap promise.

### Guards are text, never evaluated

Conditional-rendering guards are captured as **source text** and are never executed or
evaluated. `appgraph` reports what **can** render, not what **does**. A render tree is
the union of every branch, annotated with the conditions above each node — not a
prediction of one runtime state. An agent reading it learns "this subtree appears when
`user.isAdmin && flags.billing`", which is exactly as much as static analysis can
truthfully claim.

The same applies to guard-derived screen identity: a screen's stable id is structural
(`src/App.tsx#0`), not derived from the guard text, because guard text shifts when a
formatter reflows it.

### Most real apps have no test-id attributes, and it says so

`appgraph` probes for `data-testid`, `data-test`, `data-cy` and `data-qa`, records the
full occurrence histogram as evidence, and uses the most frequent.

**Four of the five applications this tool was developed against have zero test-id
attributes.** When none is found, the output states plainly that the repository declares
no test-id attributes and that elements should be selected by role or visible text. It
never emits a bare `testIds: []`, because an agent reads that as "I have not been told"
rather than "there are none", and it never fabricates selector guidance.

Relatedly, a dev-only preview component whose `data-testid`s are real strings in real JSX
is **masked** on the test-id channel with a diagnostic, rather than advertised to an agent
as selectors for the shipping UI.

### Non-goals in v0.1

Some of these are **refused loudly with a diagnostic**; the rest are documented limitations
with no diagnostic behind them. The third column says which, because "refused loudly" is a
promise. Every code named below is in `DIAGNOSTIC_CODES` **and** has at least one
emit site — `test/core/diagnostic-codes.test.ts` asserts the registry and the emit sites
agree in both directions, so this table cannot silently rot.

| Non-goal | Behaviour | Diagnostic |
| --- | --- | --- |
| react-router `<Route>` elements built inside a callback over non-literal data (`{useRouteData().map(…)}`) or non-`<Route>` children of `<Routes>` | reported per occurrence; those routes are not discovered (a `.map` over a literal route array IS read) | `screens/unsupported-router-style` (warning) |
| Next parallel and intercepting routes outside the modelled cases: an intercepting route whose target is not found or whose marker climbs above `app` | reported per occurrence; no screen gets the `intercept` activation | `screens/unsupported-next-convention` (warning) |
| Next interception outside any `@slot` (activation added, the page joins no tree), a slot page matching no page below its layout, an `@slot` with no `layout.*` beside it | reported per occurrence; the file joins no tree | `screens/unsupported-next-convention` (info) |
| `next.config` `redirects()` entries a static reader cannot read (regex `source`, non-literal fields, unresolvable spreads or calls) | one warning per config file: up to 5 `file:line` sites, then "and N more"; those entries never resolve a link | `nav/redirect-unreadable` (warning) |
| Anything needing the TypeScript TypeChecker (cross-file type flow, inferred types) | reported per occurrence | `facts/needs-typechecker` (info) |
| Runtime / dynamic component registries, and route lists that are not literals | reported per occurrence | `screens/dynamic-registry` (warning; info for an unreadable AdminJS component key) |
| TanStack code routes declared in test/mock/Storybook files that no app `addChildren` mounts | dropped, listed once (up to 5, then "and N more"); a harness whose whole tree is non-app is silent | `screens/unmounted-route` (info) |
| JS-only projects with no `tsconfig.json` | reported | `project/no-tsconfig` |
| Framework-mode routes that are not static: imperative `defineRoutes` builders, the Remix `routes` option, remix-flat-routes with a non-default `paramPrefixChar` / `nestedDirectoryChar` / `routeRegex` | reported; no route is read from the unreadable part | `screens/dynamic-registry` / `screens/unsupported-router-style` (warning) |
| Loader redirects (`loader`, `clientLoader`, `getServerSideProps`, `beforeLoad`) | **heuristic**: a conditional redirect marks the route protected, an unconditional one a redirect; conditions are text, never evaluated, and a helper is followed one hop only | none |
| Vue 2 | **warned**, scripts still read, templates skipped | `project/template-compiler-unsupported` |
| Non-React, non-Vue, non-Angular frameworks (Svelte, Solid) | **documented limitation** | none specific to it — there is no framework probe; such a repo matches no screen source and lands in the same place |
| Monorepo cross-package graphs in one run | **documented limitation** | none — run `appgraph` per package, or narrow with `--root`. Pointed at a monorepo root, detection reports every live source it finds and asks you to choose |
| Condition **evaluation** — guards stay text | documented limitation | none |
| i18n **key** extraction — namespaces only | documented limitation | none |
| Watch mode | not implemented | `--if-stale` covers the incremental case |
| Third-party plugins of any kind | no mechanism exists in 0.1 | — |

On plugins: there is no plugin API in 0.1, so the question does not arise. If one
arrives, **auto-discovery from `package.json` will never be part of it** — a static
analyser that scans dependencies for `appgraph-plugin-*` and `import()`s whatever it
finds turns "I installed a transitive dependency" into "I executed its code during my
build". Plugins would be listed explicitly in `appgraph.config.ts` or not run.

### Multi-source repositories

When more than one screen source is **live** in one repository, `appgraph` reports
`error project/multiple-screen-sources` rather than silently picking one. It prints every
live source with its score and its evidence at `file:line`, and the exact flag that
resolves it:

```
error  project/multiple-screen-sources
  3 screen sources matched in /repo. appgraph will not guess which one you meant.

    react-router   90   apps/web/src/router.tsx:14  createBrowserRouter([...])
    state-screens  51   apps/extension/manifest.json:2  "manifest_version": 3
    next-app      100   apps/docs/src/app/page.tsx  App Router page convention

  Pick one:            appgraph --source=react-router
  Or analyse all:      appgraph --all-sources
  Or narrow the root:  appgraph --root=./src
```

Resolve it one of three ways: `--source=<name>` to pick one, `--all-sources` to run every
live source with screens namespaced by source, or `--root=<dir>` to narrow the scope.
The last is usually correct — pointed at a monorepo root, "run them all" produces a
twenty-app graph nobody asked for. In a config file the equivalents are `screenSource`
(one) and `screenSources` (several).

**The Next family co-runs.** `next-app` and `next-pages` are one bundle: a project with both
`app/` and `pages/` runs both sources in one graph with no refusal, and an explicit
`--source=next-pages` (or `next-app`) also runs the other. A URL claimed by both routers gets the
warning `screens/unsupported-next-convention` (Next treats it as a build error). Every other
combination still refuses. Supabase studio, for example, has a `pages/` tree **and** a TanStack
`routes/` mirror, so a bare run refuses and you pick one: `--source=next-pages` or
`--source=tanstack-router`.

**Nested packages are not part of the root.** A subdirectory with its own `package.json`
(the outermost one, when they nest) is left out of the root's source scoring and listed by
`doctor` under "nested packages (not scored for this root)" with the `--root` that maps it.
This applies only when the root itself has a `package.json`; a root without one scores
everything beneath it. The scoping applies to detection: with an explicit `--source` or
`--all-sources`, discovery still globs the whole root.

> **The refusal is enforced, not just reported.** With `react-router` (score 90) and
> `state-screens` (score 51) both live, the run prints both sources with their evidence,
> states `No output file was written. Nothing already in the output dir was overwritten.`,
> **exits `1`**, and does not even create the output directory. Measure the exit code
> without piping: in a shell pipeline `$?` is the *last* command's status, not `appgraph`'s.

Detection **scores are reported, never used to pick a winner.** They order the display,
set the near-miss threshold, and break ties within `--all-sources` for stable output.
A source scoring in `[1, 50)` is a *near-miss*: it is reported by `doctor` and never runs
on its own, but `--source` can select it.

### How to read a render tree without over-reading it

Every run emits its own limitations into `meta.limitations`, **in every format** — the
index an agent loads, the `full` graph, each `detail` file and the HTML report. The index
is the artifact the honesty architecture exists for, and `test/emit/view-index.test.ts`
pins the block there. The limitations that most often lead to a wrong conclusion:

- **A tree node is a *file*,** labelled with its main component. Several components
  declared in one file collapse into one node, with two exceptions: a screen that declares a
  sub-file root (its root node is labelled `<Component>#<localId suffix>`), and a **route
  ancestor** whose file declares several components (`RootLayout` + `AppLayout`, or a
  `LayoutWrappers.tsx` with several wrappers). Such an ancestor gets one node per export,
  labelled with the export's name. Its children are what that export's own JSX renders —
  including same-file helpers it uses and files it references by name — and its splice point
  is found in that export's body. An edge no export can be shown to use stays with the main
  component (with every export when the main component is not a route export); one only a
  sibling export uses is dropped from this node. Screen fact totals, `uses` and the shell
  report still cover the whole file.
- **`conditions` on a node are alternatives (OR), not a conjunction.** They are the
  distinct guarded usage sites of that file. To get the condition under which a node
  actually renders, read the **ancestor chain as an AND** of its conditions. Guards on
  intermediate wrappers, props passed down, and early returns inside hooks are *not*
  folded in.
- **Screen aggregates cover everything reachable, including shared components.**
  `endpoints`, `stores`, `testIds` and friends are the union over the screen's whole
  reachable set, not just its tree. **Presence does not mean the screen always uses it.**
- **Trees are cut at `meta.maxDepth`** (default 3). Nodes with `truncated: true` have
  unexplored children — though those children still count toward `reachable`.
- **An ancestor's `{children}` splice point must be in that ancestor file's own code** — a
  JSX expression (`{children}`, `{props.children}`, a renamed destructuring, `{children ??
  <Outlet/>}`), a `return children`, or a `{...props}` spread. `children` reachable only through
  a component the ancestor renders (context, a store, a render prop) is not found. An
  `<Outlet/>` (or `useOutlet()`) **is** also searched for in the components the ancestor
  renders, up to `maxDepth` levels. An ancestor with no splice point found is skipped with
  `warning walk/no-splice-point` — one per ancestor, with the number of affected screens; only
  an ancestor file that cannot be read is an error.
- **Components chosen dynamically from a config map or registry are invisible** to static
  analysis, as are endpoint URLs and navigation targets built from non-literal
  expressions (those are marked with a `:param` placeholder or `dynamic: true`).

### Composition is reported as the framework describes it, not as the code proves it

This is the sharpest edge in the tool, and it is worth stating in the tool's own words:
`appgraph` reports composition **as the framework's convention describes it, not as the
code proves it**. There are at least four ways an ancestor chain can be wrong *invisibly*:

- a layout that forwards `children` into an imported component;
- a two-slot layout, where the first splice point by source position is taken and the
  choice is a coin flip (a warning is emitted naming every candidate);
- a conditional shell (`isMobile ? <MobileShell> : <DesktopShell>`), flattened to one
  ancestor with the alternative silently dropped;
- a route-group layout that applies to some but not all of its descendants.

In every one of those cases the output is **structurally complete and subtly wrong**. If
your app does any of them, verify the shell before trusting it.

### Known gaps in v0.1.0

`test/parity/known-gaps.ts` is the machine-checked list — every entry wired to a test that
flips when it closes. **`test/parity/BASELINE.md`** (in the repo) explains how the
parity gate is kept honest. The measured baseline itself lives with the golden, outside
this repository, because it names the routes and endpoints of a private application; where
that record and this section disagree, it is right. Read one of them before pinning any
number from the output into your own tests.

The numbers below were measured directly against the reference application with the built
CLI (`--source=react-router --format=full --no-timestamp`), on the commit the golden was taken
from. Render edges through `React.lazy` and the `ProtectedRoute`/`RouteErrorBoundary` wrappers
appear in the tree, and each screen's layout ancestor chain is spliced into its closure, so
`components` and `renderEdges` exceed the golden's counts. A zero-config run produces the same
counts.

| Count | Observed | Golden |
| --- | --- | --- |
| `components` | 922 | 696 — higher, and expected |
| `renderEdges` | 1076 | 689 — higher, and expected |
| `endpoints` | 407 | 333 — higher, and expected |
| `navigationEdges` | 148 | 28 — higher, and expected |
| `screens` | 31 | — |
| `shells` | 3 | 3 |
| `deadNavLinks` | 0 | — |
| `orphanScreens` | 11 | — |

`endpointTransports` is `http: 407`, `rpc: 0`; every one of the golden's 333 distinct
endpoints is present. Navigation edges exceed the golden because aliased `useNavigate()`
bindings resolve and because edge identity includes the file the call was found in, so two
reachable files navigating the same pair both count — the golden's 28 edges are all present.

The gaps that remain, and are most likely to affect you:

- **Reachability only follows `uses` edges INTO files the kind rules mark traversable**,
  from any file, plus files named `use…`. The presets cover the `services|api|clients`,
  `stores|store|state` and `hooks` directory families at `src/<dir>/` and `<dir>/`, and the
  hook-name rule accepts `useOrders.ts`, `use-orders.ts` and `use_orders.ts`. If your data
  layer lives somewhere else and is not named `use…`, its files still appear as render-tree
  nodes but never enter the closure, and the endpoint, store, query-key and i18n aggregates
  will be **small for a reason that is about the traversal default, not about your code**.
  This is not a subtle effect. Measured on the TanStack acceptance app, whose `src/` holds
  **241** `createServerFn` occurrences and names every file kebab-case: a hook rule that
  matches only camelCase `useX.ts` yields **1** endpoint; the rule as it ships yields **207**.
  The extractor reads those files correctly in both runs; the narrower traversal never offers them.
  If your aggregates look empty, suspect this before suspecting the extractors. `kindRules`
  in `appgraph.config.ts` is the lever, `appgraph doctor` prints what matched, and the
  emitted `meta.limitations` states it too, so an agent reading a sparse index is told why.
- **A screen's shell is its innermost layout, not its nearest wrapper.** The react-router
  adapter maps `errorBoundary` and guard wrappers into the ancestor chain, but `Screen.shell`
  is the innermost ancestor whose role is `layout`; a guard or error boundary only stands in
  when the chain holds no layout at all. An error boundary or auth guard wrapped around the
  outlet therefore does not become a shell of its own, and the shell set matches the
  golden's 3.
- **Router literals in scripts still count.** react-router ignores routers in `*.test.*`,
  `*.spec.*` and `*.stories.*` files and under `test/`, `tests/`, `__tests__/`, `test-utils/`,
  `__mocks__/`, `mocks/`, `.storybook/` and `storybook/`, but a `scripts/` or other tooling
  file that calls `createBrowserRouter` is still detection evidence and still read for routes.
  If one claims real URLs in your repo, `exclude` is the lever.
- **Directory exclusion follows `.gitignore` without running git.** Dot-directories, the default
  build-output names, a literal Next `distDir` and every applicable `.gitignore` (plus
  `.git/info/exclude`) are skipped, so build output that is ignored or hidden is not
  walked. The flip side: a **tracked** file that matches an ignore pattern is skipped too, and
  build output that is neither ignored, dot-prefixed nor one of the default names is walked. `appgraph doctor` lists every exclusion rule with its reason.

## API reference

The public surface is deliberately small. There is **no plugin contract** in 0.1: nothing
from the internal `core/` or `pipeline/` modules is exported, and the adapter interface is
internal and unstable.

| Export | Signature | Notes |
| --- | --- | --- |
| `analyze` | `analyze(options?: AnalyzeOptions): Promise<AnalyzeResult>` | The entry point. Runs detection then the pipeline. **Performs no writes** — emitted files come back as `files`. |
| `defineConfig` | `defineConfig(config: AppgraphConfig): AppgraphConfig` | Identity at runtime; gives `appgraph.config.ts` inference and field checking. |
| `BUILTIN_KINDS` | `readonly ["screen","module","layout","ui","hook","service","store","shared","other"]` | The built-in node kinds. `NodeKind` also admits custom strings via `kindRules`. |

### `AnalyzeOptions`

The commonly used fields:

| Field | Type | Notes |
| --- | --- | --- |
| `root` | `string` | Project root. Falls back to `config.root`, then to the nearest ancestor with `package.json` + `tsconfig.json`, then to `cwd`. |
| `config` | `AppgraphConfig` | The same shape `defineConfig` accepts. Supplying it **skips** loading `appgraph.config.*`; omit it and `analyze()` loads the file itself, as the CLI does. |
| `configFile` | `string` | Root-relative or absolute. Names the config file to load when `config` is omitted, and labels `config` diagnostics. |
| `emit` | `{ locale?: "en" \| "pl" }` | Settings for the built-in emitters, without replacing the set. |
| `allSources` | `boolean` | Run every live source instead of refusing to choose. |
| `timestamp` | `string \| null` | The HTML report's generation timestamp. `null` (the default) omits it, for byte-reproducible output. |
| `sourceRoots`, `kindRules`, `emitOptions`, `fingerprint`, `cwd`, `appgraphVersion` | | Advanced overrides. |

`AnalyzeOptions` is exactly these fields: `root`, `cwd`, `config`, `configFile`, `emit`, `kindRules`, `sourceRoots`, `appgraphVersion`, `allSources`, `fingerprint`, `timestamp` and `emitOptions`. The compiler, filesystem, detection, adapter, extractor and emitter injection points the CLI and the tests use are internal and not part of the package surface.

### `AnalyzeResult`

| Field | Type | Notes |
| --- | --- | --- |
| `graph` | `AppGraph` | Screens, navigation groups, and `meta` (counts, confidence, stated limitations, fingerprint). `meta.counts.screens` excludes redirects and API routes, which have their own `redirects` and `apiRoutes` counts. `graph.redirects[]` lists every redirect rule with `declaredAt` (`file:line`) and, for a rule under a ternary branch, `condition`. A navigation edge or menu entry that resolved only through a rule carries `viaRedirect: { from, to }`. |
| `files` | `readonly { path: string; content: string }[]` | One entry per artifact. Nothing has been written. |
| `diagnostics` | `readonly Diagnostic[]` | `severity` (`error` \| `warning` \| `info`), `code`, `message`, location. |
| `emptyResult` | `boolean` | Zero screens were found. |
| `refused` | `boolean` | Several live sources; **no files were produced**. Check this before reading `files`. |
| `exitCode` | `number` | Equal to the CLI's exit code for the same run (`0` clean, `1` error diagnostic or refusal, `2` an unknown `emitOptions.screen`, `3` no screens, `4` a warning under `config.strict`), computed by the same function the CLI uses. Config-load and write failures (`5`) happen outside `analyze()`. |
| `trace` | `string` | The detection trace for a zero-screen run or a refusal. Empty otherwise. |
| `detection` | `object` | Per-source scores with evidence, globs attempted, near-misses, the test-id histogram. Returned on **every** run — a guess is just as wrong when it produced screens from the wrong source. |

### Exported types

`Activation`, `AncestorRef`, `AppGraph`, `AppGraphMeta`, `AppgraphConfig`, `AuthState`,
`Diagnostic`, `Endpoint`, `EntryRef`, `Evidence`, `FactChannel`, `FileFacts`, `NavEntry`,
`NavGroup`, `Navigation`, `NavigationEdge`, `NodeKind`, `NodeLocator`, `Provenance`,
`RenderEdge`, `ResolvedNavigation`, `Screen`, `ScreenFacts`, `ScreenId`,
`SectionConfidence`, `Severity`, `ShellReport`, `SpliceMode`, `TreeNode`, plus
`AnalyzeOptions`, `AnalyzeResult`, `GraphRedirect` and `SlotBranch`.
The shapes of `files` entries and of `detection` are part of `AnalyzeResult` but have no
exported name of their own; `FileHost`, `TypeScriptApi`, `EmitFile` and `DetectionTrace`
are internal.

`Activation` is the concept worth knowing, because it is why router-less apps fit at all.
A screen is not "a route"; it is something with an activation:

```ts
type Activation =
  | { kind: "url";     template: string; params: readonly string[] }
  | { kind: "state";   holder: string;   expr: string }
  | { kind: "host";    pattern: string }
  | { kind: "message"; messageType: string }
```

## Design notes

The design reference is [`docs/architecture.md`](./docs/architecture.md). It states each
design decision together with the alternative it rejects and the measurement against real
applications that forces it, and it lists which core components are frozen (a component is
declared frozen only after it has run against every acceptance app) and which are not. If
you are considering a contribution or wondering why a boundary sits where it does, read it
before the source.

It also specifies four CLI flags that 0.1.0 does not implement: `--explain`, `--dry-run`,
`--no-test-ids` and `--no-verify-emit`. Its CLI surface section (§14.2) marks each one
`PLANNED (not in 0.1.0)`, and §14.3 specifies the `--explain` printer. **The flag table in
this README is the implemented surface**; where the two differ, this README and
`appgraph --help` are correct.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for development
setup, the quality-check commands, testing conventions, and what a new adapter is
expected to bring.

The one thing worth repeating here: the README states what the tool does **not** do, and
that is load-bearing. A change that moves one of those boundaries should move the
documentation in the same pull request.

## License

[MIT](./LICENSE) © Dominik Rycharski
