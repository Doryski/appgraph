# appgraph — Architecture Specification

**Status:** authoritative. This document is the contract implementers build against. Each decision is
recorded together with the rejected alternative in one line, so nobody re-litigates it.

**Version:** targets appgraph `0.1.0`. Output `meta.schemaVersion: 2` (§14). **There is no public plugin
contract in 0.1** — see §5.0 and §5.9.

**Prototype of record:** a private application's component-map generator script (2,774 lines incl. the
HTML report assets), from which appgraph is ported. Every mechanic marked "preserved" below was read out
of that source.

---

## 0. Measured constraints

Every item here is forced by an **empirical measurement against a real target app**, not by an
argument. Each entry names the measurement and the rule it fixes.

### 0.1 The resolver is configurable (§7.2, §8.10)

**Measured.** The AdminJS acceptance app is `"moduleResolution": "nodenext"`: every relative specifier
carries a `.js` extension while every source file is `.tsx`/`.ts`. The prototype's resolver
(`CANDIDATE_SUFFIXES`) appends its suffixes to the *whole specifier*, producing probes like
`foo.component.js.tsx` — never `foo.component.tsx`. Running the prototype's resolver over that app's
AdminJS options module and its component-loader module yields **`imports resolved: 0, bindings: 0`**. An
adapter can extract every AdminJS screen perfectly and every single render tree still comes back empty.

**Rule.** Alias resolution and module probing are not frozen. The resolver takes adapter/config inputs:
`extensionRewrites`, configurable candidate suffixes, and `sourceRoots` covering *both* hardcoded
`<root>/src` checks (the resolver's containment test and the root derivation itself).

**The freeze rule, stated plainly:** *a core component may only be declared frozen after it has been
executed against all acceptance apps.* §7.0 lists which components have earned that status and which
have not.

**Also measured:** the prototype's fact extractor's `USES_DIR` (`/^src\/(services|stores|
shared\/hooks)\//`) is the **sole feeder** of `facts.uses`, and `facts.uses` is what drives the graph
builder's `collectDeep` reachability. It matches **nothing** in a Next, TanStack or AdminJS
layout, so `reachable` silently collapses to render edges only and every route aggregate
under-reports. `KIND_BY_DIR`, the router's entry filter and `USES_DIR` are therefore all folded into
`KindRule`, `USES_DIR` as the `KindRule.traversable` flag (§7.3, §8.11).

### 0.2 Every discovery-site type test goes through `unwrap` (§6.2, §8.12)

**Measured.** The prototype's router reader calls `ts.isArrayLiteralExpression(argument)` on the raw
argument of `createBrowserRouter`. With `createBrowserRouter(routes as const)` it is `false`; with
`createBrowserRouter(routes satisfies RouteObject[])` it is `false`. The prototype's AST helpers export
an `unwrap` that handles both — and it is **not called there**. The identical defect sits in the same
reader's `children` test. Adding a *type-only* `satisfies` annotation to the host's router file takes the
prototype from **every screen to zero**, and under an absolute "never write an empty artifact, throw instead" rule
that becomes a hard CI failure caused by an annotation that changed no behaviour.

**Rule (a):** every discovery-site type test goes through `unwrap`. This is a stated invariant with
an enumerated call-site checklist (§6.2).
**Rule (b):** a zero-screen run exits non-zero and prints the full trace, and `--allow-empty` produces
an explicit `screens: []` artifact **unambiguously marked as a zero-screen result**
(`meta.emptyResult: true`), so a CI pipeline can tell "the tool broke" from "the tool found nothing".
Rule (b) is only safe *because of* rule (a): once the common syntactic escapes cannot silently zero out
discovery, an empty result is far more likely to be a true empty result.

### 0.3 The walk takes adapter-supplied inputs: ancestor chains and sub-file roots (§5.2, §6.3)

**Measured.** Files carrying a JSX tag matching the prototype's `LAYOUT_TAG` `/Layout(Wrapper)?$/`:

| App | Scope | Matches |
|---|---|---|
| the Next.js app | `src/app/**/page.tsx` | **0 of 7** |
| the TanStack Start app | `src/routes/**` | **0 of 101** |

In both stacks layouts are **file-convention ancestors** composed via `{children}` (the Next.js root
`layout.tsx`) or `<Outlet/>` (the TanStack `__root.tsx` and the pathless `_authed.tsx` layout route).
With a tag-only rule, `route.layoutFile` is `null` for every screen, `shells` is `{}`, and the map claims
**98 of the TanStack app's 100 screens have no auth shell** — while `_authed.tsx` holds exactly the
`beforeLoad` redirect an agent most needs to know about.

**Also measured.** The browser extension's content-script component selects **five** distinct states in
**one file**, and the prototype's graph builder documents that a tree node *is a file*. A file-granular
walk gives five screens five byte-identical trees.

A tag-matching `WrapperRole` cannot express "file A is the render ancestor of file B". Passing
`entries: [layout.tsx, page.tsx]` does not work either: the prototype's graph builder makes each entry a **sibling
tree root**, and the layout's own tree terminates at an opaque `{children}` `JsxExpression`.

**Rule.** **The walk algorithm is closed, but its inputs are adapter-supplied.** There is no free-form
walk hook and no `TreeProvider`. Two inputs are specified in §5.2 / §6.3:

1. **Ancestor chain per screen** — an ordered file list wrapping the screen entry, so the tree is
   `root layout → … → nearest layout → page`, spliced at `{children}` / `<Outlet/>`.
2. **Sub-file root** — a screen's tree may start at a *node inside a file*, addressed by a structural
   node locator, so the content-script component's five states produce five *different* trees.

### 0.4 The parity gate does not assert byte equality (§12)

**Measured.** `localeCompare` ordering and codepoint ordering diverge at **index 4 of the 696 component
keys**. Byte-for-byte equality against a golden produced with `localeCompare`, combined with mandated
codepoint sorting (#7/§8.9), cannot pass. Normalising by re-sorting both sides removes the gate's
ability to detect ordering regressions, which is the exact property the codepoint sort exists to
guarantee. Additionally the prototype's entry script embeds
`new Date().toISOString()` in the HTML, so **the HTML golden is non-deterministic by construction**.

**Rule.** The parity gate is four concrete gates: set equality on the agent-facing contract, monotonic
coverage floors, one named falsifiable assertion per fixed bug, and parsed-object comparison with
sorted keys — plus the zero-config run == pinned-config run stage (§12.4). The HTML is **excluded from
goldens** (§12.6).

### 0.5 Detection reports every live source and never silently picks (§10.1)

**Measured, all four in the acceptance set:**

- The browser extension's `public/manifest.json` is a real MV3 manifest (scores 50) sitting **inside**
  the react-router reference app (scores 90). "Highest score wins" silently **deletes the extension**
  from the output.
- There are **9 `manifest.json` files under the reference app** — one a PWA manifest with no
  `manifest_version`, three under build output.
- The Next.js app's `.next/` contains **23 additional `page.*` files** on an `app/**` path. A
  `**/app/**/page.tsx` glob — which is *required*, since pages live under `src/app`, not root `app/` —
  reports **30 screens, 23 of them generated garbage**.
- Pointing the tool at the monorepo root fires `adminjs`, `next`, `createFileRoute` and multiple
  `createBrowserRouter` across many sibling apps.
- **Every** host pins `"typescript": "npm:@typescript/typescript6@^6.0.2"`, so any dependency-version
  parsing sees the literal `npm:` alias spec.

**Rule.** Detection reports **all** sources above threshold; when more than one fires, appgraph either
runs all of them with screens namespaced by source, or requires an explicit choice — **never silently
picks**. Exclusion lists and symlink handling are load-bearing, not cosmetic.

### 0.6 Screen identity is structural, never source text (§4.1)

The prototype's `conditionText` (in its AST helpers) is `getText().replace(/\s+/g,' ').trim().slice(0,110)`. An
identity built on that changes on a variable rename, on reordering `a && b`, on added parentheses, or
when Prettier shifts the 110-character cut — none of which are behaviour changes. Each one rewrites the
screen's identity: the YAML shows one screen deleted and another added, an agent's stored target breaks,
and the parity gate reports churn indistinguishable from regression.

**Rule.** `localId` is **structural and author-overridable**: default
`<file-relative-path>#<ordinal-of-guarded-branch>`, with a `// @appgraph-id <name>` source pragma as the
stable override. Deriving identity from expression text is **forbidden**. The guard text is emitted as a
descriptive `activation.expr` field — useful to an agent, never identity.

### 0.7 Extraction is a phase graph, not one traversal per file (§5.4, §7.4)

**Measured** in the preserved core: `collectStringConstants` runs **three full walks** before any
`flattenString` call can work, because a constant may be declared below its use; `nullGuardsIn` is a
fourth walk; `guardOf` walks **upward** per JSX element and `containsJsx` walks **downward** inside that;
and the fact extractor's `renders` calls `resolver.declarationFile`, which **parses other files
mid-traversal**.
The unit of work is a cross-file fixpoint, not one pass.

**Rule.** Extraction is an explicit **phase graph** (§7.4): prepass channels (string constants, enums,
bindings) complete file-wide before consumer channels run; then the shared main walk; then `finalize`.
A **masking/precedence** mechanism lets an extractor suppress facts inside a subtree — the real case is
the browser extension's `DevStatesPreview`, a dev-only preview inside its content-script component whose
testIds must not be advertised to an agent.

### 0.8 The YAML emitter quotes defensively and checks its own output (§7.12, §8.13)

**Measured by fuzzing the prototype's YAML emitter.** The value `k: foo:` (trailing colon) is emitted
unquoted and then **fails to parse**: `NEEDS_QUOTES` catches `": "` but not a trailing `:`. Two sites
truncate arbitrary source text at fixed offsets — the condition text (`slice(0,110)`) and the query-key
fallback (`slice(0,60)`) — so a cut landing right after a colon (trivially reachable from `{ status: filter }`)
emits a document no parser can read **while the tool reports success**. Also `LOOKS_NUMERIC`
over-quotes anything starting with a digit, and `JSON.stringify` as the escaper leaves U+2028/U+2029
raw.

**Rule (keeping zero runtime deps, but earning it):** a corrected quoting predicate; **always** quote
any string that was truncated; the emit path **asserts its own output re-parses** and fails the run if
not; and a permanent CI fuzz job runs over the emitter. §7.12 names the trigger that forces taking a
real YAML dependency instead.

### 0.9 tsconfig handling (§8.4)

The prototype's resolver uses `ts.parseConfigFileTextToJson` — raw JSON — so `extends` is not
followed and `baseUrl` is ignored. None of the five targets uses `extends`, but it is the most common
monorepo shape and the failure is **silent**: zero aliases → every `@/…` import resolves to `null` →
empty graph, no error. appgraph uses `ts.parseJsonConfigFileContent` with a real `ParseConfigHost`.
**Non-wildcard** path entries keep working — the reference app's tsconfig declares two of them, matched
by full-specifier equality as the prototype's resolver does.

### 0.10 Adapters are separated internally; no contract is published (§5.0, §5.9)

The phase pipeline, the `Activation` model, the normalized `Screen`/`AppGraph` model, and **adapter
separation** are what make five stacks work. The *published* contract does not exist: no `apiVersion`,
no stability promise, no `experimental_` prefixes, no `./plugins/*` export map, no contract-versioning
policy. Adapters ship as **internal modules implementing an internal interface**, and five adapters ship
before *any contract is published at all*.

Public API surface for 0.1 is exactly: **`analyze(options)`, `defineConfig`, the emitted data-model
types, and the CLI.** Nothing else.

### 0.11 MV3 scoring and the preset companion source (§10.1, §5.9)

Both numbers follow from §10.1 rule 4 (more than one live source → refuse):

- **`state-screens` scores `1` unconditionally, and `51` on an MV3 manifest.** A score conditional on
  finding a component with guarded top-level JSX alternatives would vanish exactly when the guarded-JSX
  heuristic fails, which is precisely when an operator needs `--source=state-screens` to still be
  selectable. The probe lives in the adapter and produces the **evidence**; the score is unconditional.
  The MV3 bonus adds on top of it, so the live score is 51.
- **`manifest-activation` scores `1`.** It reads the *same* `manifest.json` field the MV3 bonus reads.
  At 50 it would be live alongside `state-screens` at 51 on every browser extension, so rule 4 would
  refuse on every bare run against one — a refusal caused by the tool shipping two views of one file,
  not by the repo holding two apps. It is registered, ordered last in `SOURCE_PRECEDENCE`, and selected
  by the `browser-extension` **preset**, which names both sources. A preset may bundle a **companion**
  source that is never live on its own. A companion is selected, not detected, and the multi-source
  refusal counts only live sources.

Measured on the browser extension: `state-screens` alone reports **4** screens; with the
`manifest-activation` companion, **8** — the popup, the service worker and the content scripts are
screens no guarded-JSX probe can see.

---

## 1. What appgraph is

appgraph reads a TypeScript/React repository **with a parser only** and emits a static map of its
screens: what URL reaches them, what component tree can render underneath, which HTTP/RPC calls that
subtree makes, which stores, query keys, i18n namespaces, form schemas, feature gates and test-id
selectors it touches, and how screens navigate to each other.

Two audiences, two artifacts:

- **Agents** — a small YAML index whose entire purpose is: *go straight to a URL instead of clicking
  through the UI*. Measured at 0.1.0 with the built CLI across the five acceptance apps: 8.7 KB
  (9 screens) to 42.9 KB (230). Screen count drives it; the stated limitations are a flat ~3.4 KB.
- **Humans** — a single self-contained HTML report.

The prototype does this for exactly one app, with the router file, path-enum file and menu export
hardcoded as CLI defaults. appgraph generalises it along two independent axes at once:

1. **An adapter-first internal architecture**, so the notion of "screen" is supplied by an adapter
   rather than baked in as "a react-router route object". In 0.1 adapters are **internal modules
   implementing an internal interface** — the separation is real, the contract is unpublished (§5.0).
2. **A zero-config layer**, so `npx appgraph` works on a repo it has never seen, because that is the
   only realistic adoption path for an OSS tool.

Both are load-bearing. The zero-config layer is *not* an optional convenience: architecturally it is a
config producer that runs before phase 1 and emits the same `ResolvedConfig` a hand-written config file
would produce, so it is testable by the same parity gate as everything else.

---

## 2. Decisions and their rationale

| # | Decision | Why (one sentence) | Rejected alternative |
|---|---|---|---|
| 1 | `Activation` union; URL is one kind of activation, not identity | A Chrome MV3 extension has screens and no router, and a model that starts from URLs cannot represent it at all. | `Screen.url: string` as primary key (URL-first design). |
| 2 | `typescript` is injected as `ctx.ts`; adapters never import it | The reference app's host repo aliases its `typescript` devDependency to `npm:@typescript/typescript6`, so a plugin importing its own compiler can get a different realm than the resolver that produced the `ts.SourceFile` it is handed, and `ts.isX()` then fails **silently**. | Plugins `import ts from 'typescript'` and we document a version constraint. |
| 3 | The package exports exactly `analyze`, `defineConfig`, the data-model types and the CLI. **The published surface is lint-free to enforce — tsup builds two entries and `package.json` declares no `exports` subpaths.** The internal adapters↔core seam is **convention in 0.1, not lint**: the adapters import value exports from `core/ast`, `core/order`, `core/url` and `core/strings`, so §3's `no-restricted-imports` rule covers only `typescript` (type-only allowed) and `pipeline/**`, and the `core/**` half lands with the 0.3 extraction that makes it true. | Adapters reach core through context objects for the *stateful* things (`ctx.ts`, `ctx.resolve`), which is where realm and I/O bugs live; sharing a pure AST walker and a comparator is not a seam violation worth a duplicate implementation. Nothing about this seam is promised outside the repo in 0.1 — measurement already showed the seam is not where a tag-based design puts it (§0.3). | Publishing `./plugins/*` with an `apiVersion` at 0.1; or keeping a mandated rule that every adapter violates. |
| 4 | `field?: T` = "no opinion, fall through"; `field: T \| null` = "asserts absence, stop" | Multi-source composition needs a difference between silence and denial; `exactOptionalPropertyTypes` makes `{title: undefined}` a type error, so the distinction is enforced at compile time. | A single `T \| null` and a separate per-field `override` flag. |
| 5 | 7 phases; **the walk algorithm is closed, but its inputs (ancestor chain, sub-file root) are adapter-supplied** | Measured: 0 of 7 Next pages and 0 of 101 TanStack routes carry a layout *tag*; layouts are file-convention ancestors, and 5 extension screens live in 1 file. A walk with no adapter input at all cannot represent either. | A free-form `visitNode` hook for tree shaping (still rejected — it would make every output field adapter-dependent). |
| 6 | Extraction is a **phase graph**: prepass channels → shared main walk → finalize, with subtree masking | Measured: the "preserved" core already runs 4+ walks per file and parses other files mid-traversal (§0.7). A single-pass claim would make `flattenString` returning `null` for a not-yet-folded identifier indistinguishable from "not a string". | One shared traversal per file (false of the preserved core); or each extractor walking independently (N full walks per file). |
| 7 | Codepoint comparison everywhere; never `localeCompare` | The prototype sorts with `localeCompare` in five places, which makes byte output ICU- and locale-dependent — i.e. not reproducible across machines. | Keep `localeCompare` for "nicer" ordering. |
| 8 | No adapter throw is fatal | A broken extractor must degrade one fact channel, not destroy the report. | Fail fast on any adapter error. |
| 9 | Emitters are pure `AppGraph → EmitFile[]`; the kernel does all I/O | Makes `--dry-run`, `--if-stale` and golden tests trivial, and structurally prevents an emitter writing outside the output dir. | Emitters get an `fs`-like handle. |
| 10 | Mandatory `provenance` on every Screen, an origin stamp on every Diagnostic, plus `--explain <screenId>` (the flag is PLANNED, §14.3; `provenance` and origin stamps ship in 0.1) | With adapter-supplied screens and adapter-supplied ancestor chains, "which adapter produced this wrong row?" is the first question every bug report asks; answering it must not be optional. | Add tracing later when it hurts. |
| 11 | **No plugin contract is published in 0.1**; only `meta.schemaVersion` is versioned | The obvious seam (`WrapperRole`, tag-declared wrappers) is proven wrong by measurement; a boundary that has to move before the first external user is not a boundary worth publishing (§5.9). | `apiVersion: 1` + additive-only policy + `experimental_` prefixes at 0.1. |
| 12 | `NodeKind` is open; HTML derives kind colours and method badges from observed data | The prototype hardcodes 5 of 9 kinds in its stylesheet and 5 HTTP methods, so an adapter introducing a kind produces an unstyled row. | Closed union of kinds. |
| 13 | **Detect ALL sources above threshold and report every one**; never silently pick a winner | Measured: the browser extension's `manifest.json` (MV3, 50) sits inside the react-router app (90), so "highest wins" deletes the extension from the output. | Highest score wins with a warning for the loser. |
| 14 | Zero screens → non-zero exit + full trace + **no artifact**, unless `--allow-empty` writes an explicitly-marked `screens: []` | A confidently empty map is the worst artifact; but with `unwrap` invariants in place (#21), CI must still be able to distinguish "tool broke" from "tool found nothing". | Unconditional throw (breaks CI on a `satisfies` annotation); or writing the empty file with only a warning. |
| 15 | `meta.confidence` per section; a section yielding zero facts while its enabling dependency is installed is a **warning** | An empty section is otherwise indistinguishable from a section that legitimately has nothing. | Report counts, let the reader judge. |
| 16 | `appgraph doctor` prints the entire detection trace | Detection that cannot be inspected cannot be trusted or bug-reported. | `--verbose` logging. |
| 17 | Derive every default from the host project (tsconfig chain, dependency union, attribute probing) | The prototype hardcoded eight project-specific values; each one we can derive is one fewer reason a new user must write a config. | Ship an interactive `appgraph init` wizard. |
| 18 | Nav auto-discovery by scoring; keep **every** candidate ≥ 0.5 | A sidebar and a topbar are both real navigation; merging them is more informative than guessing which one is "the" menu. | Highest-scoring single candidate wins. |
| 19 | Parity gate = **contract set-equality + monotonic coverage floors + one named assertion per fixed bug + parsed-object comparison**; plus the zero-config==pinned-config stage | Measured: `localeCompare` and codepoint ordering diverge at index 4 of 696 keys, so byte equality cannot pass; re-sorting to fix it destroys the gate's ability to see ordering regressions. | Byte-for-byte golden comparison after normalization. |
| 20 | ONE `KindRule[]` with `kind` / `traversable` / `screenEntry` flags, and `traversable` **also covers `USES_DIR`** | The prototype answers "what is this file" in **four** unrelated places; the fact extractor's `USES_DIR` is the sole feeder of `facts.uses` and matches nothing outside the single `src/` layout it was written against. | Three separate config arrays that "should" stay in sync; leaving `USES_DIR` hardcoded. |
| 21 | **Every discovery-site type test goes through `unwrap`** — a stated invariant with an enumerated checklist | Measured: one `satisfies RouteObject[]` on the host's router file takes the tool from every screen to 0, because the prototype's router reader type-tests the raw node while its `unwrap` sits unused. | Handle `satisfies` ad hoc where someone remembers to. |
| 22 | `Screen.localId` is **structural** (`<path>#<ordinal>`), never derived from expression text; `// @appgraph-id` overrides | Measured: the prototype's `conditionText` truncates guard text at 110 chars, so a rename, a reorder, an added paren or a Prettier reflow rewrites screen identity and shows up as delete+add. | `localId = '<holder>#<guardExpr>'`. |
| 23 | The resolver is **configurable**, and freezing requires execution against all acceptance apps | Measured: the prototype's resolver resolves **0 imports** in the AdminJS app. A component nobody ran on the targets cannot be called proven. | Resolver "preserved verbatim, non-configurable". |
| 24 | The YAML emitter **asserts its own output re-parses**, and a fuzz job is permanent CI | Measured: `k: foo:` is emitted unquoted and does not parse; two truncation sites can produce it from ordinary source. Zero runtime deps is a claim that must be earned, not assumed. | Trust the quoting regex; or add `yaml` as a dependency now. |

---

## 3. Package layout

Only `src/index.ts` and `src/cli/bin.ts` are entry points (`bin.ts` enables the compile cache, then imports `src/cli/index.ts`). **Nothing else is exported from the
package** — not `core/`, not `pipeline/`, and not `adapters/`. `tsup` builds exactly the two entries,
and `package.json` declares no `exports` subpaths.

**The import rule is enforced in part, and the part it does not enforce is stated as convention.** A
full ESLint `no-restricted-imports` rule would forbid `adapters/**` from importing `core/**` or
`pipeline/**` directly and from importing `typescript`. **The adapters import value exports from
core** — `walk` and `isComponentTag` from `core/ast`, `by`/`sortedUnique`/`uniqueBy`/
`thenBy`/`sortBy`/`byNumber` from `core/order`, `joinUrl`/`paramsOf`/`convertNextAppPath`/
`convertAdminJsUrl`/`convertTanStackRoutePath`/`expandAdminJsTemplate` from `core/url`, and
`collectStringMembers` from `core/strings` — so that rule would have to be either suppressed in every
adapter or paid for with a refactor that duplicates the AST walker and the comparators behind a context
object nobody outside this repo can see. `eslint.config.js` therefore enforces the two halves that are
**true and clean**:

- `typescript` may be imported **type-only** and never as a value
  (`@typescript-eslint/no-restricted-imports` with `allowTypeImports`), which is the half decision 2
  actually depends on: a value import can land in a different compiler realm than the resolver that
  produced the `ts.SourceFile`, and `ts.isX()` then fails silently. Verified to fire.
- `adapters/**` may not import `pipeline/**`. No adapter does; the rule keeps it that way.

The `core/**` half is **convention in 0.1**, not lint. What the package actually promises is the
*published* surface — `src/index.ts` and `src/cli/bin.ts`, the only two tsup entries, with no
`exports` subpaths — and that boundary is enforced structurally by the build rather than by a rule.
Per §2 decision 11 and §5.9 no plugin contract ships at 0.1, so the core/adapters split has no external
consumer to protect yet; when 0.3 extracts it, the refactor and the rule land together. A rule that is
mandated and violated teaches readers that mandates here are decorative, which costs more than the
seam it would protect.

```
src/
  index.ts                       Public API: analyze(), defineConfig(), BUILTIN_KINDS, the emitted data-model types.
                                 NOTHING ELSE. No adapter types, no context types, no Plugin type.
  cli/
    bin.ts                         Bin (`dist/cli/bin.js`): enables the module compile cache, then loads index.ts.
    index.ts                       runCli(); `analyze` and `doctor`; query dispatch; exit codes; --json failures.
    commands.ts                    COMMAND_SPECS: the one registry of commands, options, fields, examples, exit codes.
    args.ts                        Builds the commander program from the registry; CliOptions.
    print.ts                       Writer, diagnostic formatting, sanitizeForTerminal, written-file listing.
    stale.ts                       Graph and run fingerprints (paths + mtimes, TS-free); sidecar v2 read/write.
    query/                         One module per query command, plus runtime.ts (cache load/refresh), output.ts, schema.ts.

  config/
    define.ts                      defineConfig(): identity at runtime, inference at the call site.
    load.ts                        Finds appgraph.config.*; transpiles .ts/.mts/.cts to a temp .mjs; validation.
    merge.ts                       Keyed list merge for config rules (later `name` replaces in place).
    presets.ts                     Per-stack presets: screen source, wrapper roles, kind rules.
    resolve.ts                     Layered ResolvedConfig synthesis (defaults < preset < detection < config < flags).
    types.ts                       AppgraphConfig, ResolvedConfig, SourceDetection, defaults.

  core/                          NOT EXPORTED. The engine.
    app-name.ts                    App name derivation from package.json / root directory.
    ast.ts                         Shared AST helpers: walk, isComponentTag, isHookName, condense.
    bindings.ts                    BindingTable: imports, dynamic import(), hook-return bindings; RegExp module patterns.
    compiler-support.ts            Supported TypeScript range and the compiler-API check for the loaded peer.
    confidence.ts                  Confidence statuses (ok / partial / empty-expected / empty-unexpected).
    diagnostics.ts                 Diagnostic code registry and the diagnostic collector.
    extensions.ts                  Source extension lists (script, JSX, SFC).
    graph.ts                       Render-graph construction, via ranking, reachability, GRAPH_LIMITATIONS.
    host.ts                        FileHost (fs abstraction, NO symlink following), glob matching, toPosix.
    ignore-build-dirs.ts           Next distDir detection; dot-directory and build-output exclusion helpers.
    ignore-rules.ts                Parser-only .gitignore reader.
    kinds.ts                       KindRule evaluation (kind + traversable + screenEntry).
    model.ts                       The emitted data model: AppGraph, Screen, Activation, TreeNode, BUILTIN_KINDS...
    nuxt-project.ts                Nuxt config and component directory discovery.
    order.ts                       byCodepoint and the other sort comparators; the ONLY sorting utility.
    peer-loader.ts                 Loads peer packages from the project, falling back to appgraph's own.
    project.ts                     Project root, source roots, exclusions (DEFAULT_EXCLUDED_DIRS, OUTPUT_DIR_NAMES).
    resolver.ts                    Alias resolution, module probing, barrel/re-export chasing.
    sfc.ts                         .vue single-file component script/template extraction.
    source-file.ts                 Script and SFC source creation (parser-only ts.SourceFile).
    sources.ts                     SOURCE_PRECEDENCE: the fixed adapter ordering used by detection.
    strings.ts                     StringTable: constant folding of string constants and members.
    template-frameworks.ts         Template compiler registry types (vue, angular) and status records.
    tsconfig.ts                    tsconfig chain loading (extends, baseUrl/paths), extension rewrites.
    url.ts                         normalizeUrl, joinUrl, param extraction, template/canonical conversion.
    vue-compiler.ts                Vue compiler-sfc range check and node-type constants.
    vue-template.ts                Vue template AST reading (elements, directives).

  detect/                        Phase 0.
    index.ts                       Multi-source detection, scores, MULTIPLE_SOURCES_CODE, nested packages.
    project.ts                     Dependency union, library detection, source-file globs.
    conventions.ts                 Test-id attribute histogram and the no-test-ids notice.
    strings.ts                     Derives which files feed the shared StringTable.

  pipeline/                      NOT EXPORTED. The kernel.
    run.ts                         analyze(): config load, detection, the phases, public AnalyzeOptions.
    phases.ts                      configure, discover, resolveEntries, walk, normalize, aggregate, emit.
    registry.ts                    Built-in adapter/extractor/emitter registration and source precedence.
    context.ts                     PipelineEnv construction, dependency reading, @appgraph-id pragma.
    template-frameworks.ts         Template compiler loading and its diagnostics.
    exit-codes.ts                  EXIT_* constants and exitCodeFor(): the one run-to-exit-code mapping.

  adapters/                      Shipped screen/nav/redirect sources. INTERNAL modules, INTERNAL interface.
    types.ts                       Adapter, ScreenSource, NavSource, Emitter, EmitFile and draft types.
    builtin.ts                     createBuiltinAdapters(): the shipped adapter list and its per-source options.
    precedence.ts                  byAdapterPrecedence: adapter order derived from SOURCE_PRECEDENCE.
    react-router.ts                createBrowserRouter/Hash/Memory and <Routes> literal route arrays.
    react-router/                  The react-router and wouter reader behind react-router.ts (one reader, two profiles).
      index.ts                       Source and adapter factories for react-router and wouter.
      constants.ts                   Source names, router factories, elements, hooks, detection scores and regexes.
      detect.ts                      detectReactRouter / detectWouter: dependency, data-router and JSX-route probes.
      profile.ts                     RouterProfile: per-library exports, flavours and calls (react-router, wouter).
      state.ts                       Per-run discovery state; overridden-preset notice.
      discover.ts                    runDiscovery(): wires the reader modules into one discovery pass.
      discover-objects.ts            Object-literal route arrays.
      discover-jsx.ts                JSX <Routes>/<Route> trees.
      route-lists.ts                 Route-list reading shared by the object and JSX paths.
      roots.ts                       Router roots: factory calls, <Routes>/<Switch>, useRoutes.
      top-level.ts                   Components a router renders outside every route list; root wrappers framing every route.
      descendants.ts                 Descendant route lists rendered by a route's element.
      model.ts                       The one intermediate route model both forms read into.
      parse.ts                       parseRoute: paths, elements, wrappers and outlets.
      specs.ts                       Route specs from both route dialects, incl. unreadable mapped paths and dialect redirects.
      elements.ts                    Element and component reading for a route.
      lazy.ts                        lazy / React.lazy route entries.
      item-scope.ts                  Mapped route items: what a `.map` callback's expressions read of the item.
      mapped-routes.ts               Routes built by mapping over route data.
      route-data.ts                  Route arrays grown by push/unshift and state initialisers.
      resolve.ts                     Value and import resolution for the reader.
      v5-paths.ts                    v5 path syntax and query-string paths.
      wrappers.ts                    ReactRouterOptions; wrapper-role rules and ancestor roles.
      warnings.ts                    Unsupported router-style and pre-v4 version diagnostics.
    route-flavours.ts              JSX route semantics per react-router generation (v6/v7 <Routes>, v5 <Switch>, wouter).
    react-router-framework.ts      React Router v7/v8 framework mode and Remix v2 (routes.ts, root.tsx).
    route-config.ts                routes.ts route-config reader for the framework source.
    flat-routes.ts                 Remix v2 flat-file route convention.
    loader-guards.ts               Auth and redirects from route-module loader/clientLoader.
    next-app.ts                    Next.js App Router file conventions (page.tsx, route.ts).
    next-config.ts                 next.config redirects() table.
    next-pages.ts                  Next.js Pages Router (pages/, _app, getLayout, API routes).
    next-conventions.ts            File conventions the Next.js App and Pages sources share (extensions, pages root).
    file-routes.ts                 Shared file-route helpers: route dirs, route groups, convention ancestor chains.
    config-file.ts                 Reads literal members of a project config file without evaluating it.
    nuxt.ts                        Nuxt pages/ file routes.
    nuxt-components.ts             Nuxt auto-imported component directories.
    tanstack-router.ts             createFileRoute('...') literal argument, file fallback, TanStack Start.
    tanstack-code-routes.ts        Code-based createRoute / createRootRoute trees.
    tanstack-route-options.ts      TanStack route-option and splice-mode reading.
    vue-router.ts                  vue-router route arrays.
    vue-route-records.ts           Route-record reading shared by the vue-router paths.
    vue-router-files.ts            File-based vue-router (unplugin-vue-router) detection and naming.
    vue-auth.ts                    Auth inference from middleware and meta keys.
    angular/                       Angular router source.
      router.ts                      detectAngular, provideRouter / RouterModule.forRoot route trees, screen drafts.
      project.ts                     Decorated classes, NgModules and route registrations across the project.
      route-records.ts               Route-record reading: redirects, loadChildren, guards, pathMatch.
      values.ts                      Static folding of route arrays and bound objects.
      auth.ts                        Auth inference from guards and route data keys.
      selectors.ts                   Component/directive selector parsing.
      template.ts                    Component declarations and their template references.
      template-ast.ts                Angular template AST reading (elements, slots).
      template-resolve.ts            Template tag to component resolution.
    expo-router.ts                 Expo Router app/ file routes, layouts and platform variants.
    expo-routes.ts                 Expo route planning: URLs, kind tags, platform variants, route conflicts.
    react-navigation.ts            React Navigation navigator registrations as screens.
    react-navigation-registry.ts   Navigator and Screen registration reading (dynamic and static API).
    route-tables.ts                Path tables and linking config read into screen-name -> path maps.
    native-auth.ts                 Auth inference for native sources from signed-in guards and screen options.
    adminjs.ts                     AdminJSOptions.resources[] + pages{}, URL templates.
    state-screens.ts               Router-less: guarded top-level JSX in a holder component.
    manifest-activation.ts         MV3 popup / service worker / content scripts as screens and activations.
    nav-config.ts                  Scored discovery over array-of-object-literals navigation config.
    route-conditions.ts            Build-mode (dev-only) route guards.
    route-dialects.ts              Route-object field names per router dialect.
    dynamic-imports.ts             React.lazy / import() target reading.
    array-values.ts                Static array-element folding.
    source-utils.ts                Object-literal member helpers.
    values.ts                      Imported-binding and string-value readers.

  extractors/                    Fact extractors; every one runs on every stack.
    types.ts                       FactExtractor contract, stages (prepass / main / finalize), channels.
    registry.ts                    Extractor registry and ExtractInput construction.
    component-tree.ts              Render edges, hooks and the traversable-file walk.
    navigation.ts                  navigate()/<Link>/<Navigate> targets via BindingTable.
    navigation-lookup.ts           Navigation targets read from static lookup literals.
    http-client.ts                 Endpoints via bound HTTP clients. transport:'http'.
    server-fn.ts                   createServerFn / "use server" / route handlers. transport:'rpc'.
    convex.ts                      Convex query/mutation/action calls.
    query.ts                       TanStack Query keys + mutation counts.
    store.ts                       Zustand / Pinia / Redux / Jotai / MobX store hooks.
    i18n.ts                        Namespaces (never keys).
    forms.ts                       Schema names + form field names.
    test-ids.ts                    Probed attribute -> selector list + histogram.
    feature-flags.ts               Feature-flag props and getConfiguration()-style calls.
    messages.ts                    MV3 message-type chains.
    imported-declaration.ts        Cross-file `export const` proof helper.

  emit/                          Emitters.
    yaml.ts                        Zero-dependency YAML serializer, quoting predicate, escaping, re-parse self-check.
    view-index.ts                  The agent index view.
    view-full.ts                   The full AppGraph view.
    view-detail.ts                 Single-screen detail view.
    html.ts                        renderHtml: fills the report template.
    html-graph.ts                  Map layout used by the report.
    html-util.ts                   HTML escaping.
    report-derive.ts               Derived report data (kinds, endpoints, colors).
    report-payload.ts              Builds the JSON payload the report UI reads.
    i18n-runtime.ts                Plural-aware string interpolation for the report.
    strings.ts                     en/pl string tables and Locale.
    assets/generated.ts            Generated (gitignored) REPORT_TEMPLATE from `pnpm assets`; the UI source is
                                   `report-ui/` at the repo root (React 19 + Vite + Tailwind + shadcn/ui).
```

---

## 4. The public model

### 4.1 Activation and screen identity

```ts
export type Activation =
  | { readonly kind: 'url'; readonly template: string; readonly params: readonly string[] }
  | { readonly kind: 'state'; readonly holder: string; readonly expr: string }
  | { readonly kind: 'host'; readonly pattern: string }
  | { readonly kind: 'message'; readonly messageType: string }
  | { readonly kind: 'intercept'; readonly from: string; readonly slot: string | null; readonly file: string }
  | { readonly kind: 'route'; readonly name: string; readonly navigator: string | null };
```

- `template` uses the **normalized internal path syntax**: `:param` for a dynamic segment, `*` for a
  catch-all. Every screen source converts its native syntax into this (`$param` → `:param`, `[id]` →
  `:id`, `[...slug]` → `*`). This is preserved from the prototype (`paramsOf` matches
  `/:([A-Za-z0-9_]+)/g`).
- `params` is derived from `template` by the core, never supplied by the adapter.
- `intercept` is descriptive, never identity: a Next.js intercepting route (`(.)x`, `(..)x`, `(...)x`)
  shows the target screen when navigated to from `from` (a normalized URL; `normalize` runs it through
  `normalizeUrl`). `slot` names the `@slot` the intercepting page sits in, `null` outside one; `file` is
  the intercepting page. It sits beside the target's `url` activation, which keeps the id and `url`
  (`url` consumers ignore it), and sorts after every other kind. The modal's tree comes from the slot
  branch (`AncestorRef.branches`), not from this activation.
- `route` is a screen reached **by name** in a native navigator: `name` is the route name an app passes
  to `navigate`, and `navigator` says where it is registered (React Navigation: the navigator's bound
  name; Expo Router: the folder of the governing `_layout`). A screen may carry several: one per
  navigator that registers the name (React Navigation), or one per group-qualified name such as
  `(tabs)/(home)/index` (Expo Router, where every screen has them, URL or not). Beside a `url`
  activation it is a lookup key, never the id; alone it is the identity of a URL-less screen (below).

```ts
export type ScreenId = string;
```

`ScreenId` is:

- the **canonical URL** (the `template` of the first url-activation, after `normalizeUrl`) when the
  screen is addressable;
- otherwise, for a draft with a `route` activation, `screen://<sourceName>/<encodeURIComponent(name)>`,
  where `name` is the first of its route names by code point (`screen://react-navigation/Profile`,
  `screen://expo-router/(tabs)%2F(home)%2Findex`);
- otherwise `screen://<sourceName>/<encodeURIComponent(localId)>`.

The name rule keeps a named screen's id independent of which file registers it first. Vue and Nuxt
drafts carry their names in `routeName`, not as activations, so the name rule does not apply to their ids.

**Name resolution** is one path in the kernel (`src/core/graph/route-names.ts`, `targets.ts`). The
route-name table maps every name to a screen: the `routeName` and its aliases (vue-router, Nuxt), then
each `route` activation's `name`, visited in screen-id order; a name claimed twice keeps the first
screen and warns `screens/conflict-dropped`. A navigation with an empty `to` and a `routeName`
(`navigate("Profile")`), or whose `routeName` is in the table (an Expo group-qualified href), resolves
by name: to the named screen's first URL when it has one (then through the redirect rules like any
URL), else to its id. A name-only navigation with an unknown name targets `name:<Name>`, matches
nothing and warns `nav/dead-link`; an Expo href whose name is unknown falls back to matching its URL.
URL matching indexes **every** `url` activation of a screen, first activations before the rest, so a
React Navigation screen with several paths (`Home: ['/', '/download']`) is reached through each.

`Screen.url` is a **derived convenience**, not identity: the `template` of the first url activation, or
`null` when the screen is not addressable. Emitters and the HTML report read `url`; the graph keys on
`id`.

> Rejected: URL as the primary key with a `virtual:` escape hatch — it forces every non-URL stack to
> mint fake URLs, and the fake URLs then leak into the agent index where they are actively harmful.

#### `localId` is structural. Identity is NEVER derived from expression text.

A guard-text id such as `localId = '<holderComponent>#<guardExpr>'` (e.g. `App#isAuthenticated`) is
rejected. Guard text comes from the prototype's `conditionText`:
`getText().replace(/\s+/g,' ').trim().slice(0,110)`; an id built on it moves when a variable is renamed,
when `a && b` is reordered, when a parenthesis is added, or when Prettier shifts the 110-character cut.
None of those are behaviour changes, and every one of them would rewrite the screen's identity —
producing a delete + an add in the YAML, breaking an agent's stored target, and generating parity-gate
churn that cannot be told apart from a regression.

The rule, in order of precedence:

1. **Author pragma (stable override).** A comment `// @appgraph-id <name>` on, or immediately above, the
   guarded branch (for a sub-file screen) or the module's default export (for a whole-file screen).
   `<name>` matches `/^[A-Za-z0-9_-]{1,64}$/`. `localId` is exactly `<file-relative-path>#<name>`.
   Two pragmas with the same `<name>` in one file are an `error screens/duplicate-id`.
2. **Structural default.** `<file-relative-path>#<n>`, where `n` is the **0-based ordinal of the guarded
   branch** in a deterministic enumeration of the file: the guarded alternatives of the holder
   component's top-level JSX, in source-position order (`node.pos` ascending). For a whole-file screen
   with no branch, `localId` is the file-relative path with no `#` suffix.

`<file-relative-path>` is POSIX-separated and relative to `project.root`, exactly as everywhere else
(§11 rule 5).

**What still moves this id, honestly stated:** inserting a *new guarded branch before* an existing one
shifts every later ordinal. That is a real structural change to the file, it is visible in the diff, and
the pragma exists precisely for screens whose identity must survive it. **What does not move it:**
renames, reorderings within a condition, parenthesisation, formatting, and truncation-boundary shifts.

The guard text is emitted — as `Activation.expr` and as the descriptive `activation` field in the
index. An agent benefits from reading *"shown when `isAuthenticated && !isLoading`"*. It is description,
not identity, and no code may key on it.

> Any PR that constructs an id, a cache key, a golden key or a diff key from `getText()` output is
> rejected. This belongs in `CONTRIBUTING.md` next to the §7.0 freeze rule.

### 4.2 Screen

```ts
export type Screen = {
  readonly id: ScreenId;
  readonly localId: string;                    // structural, source-local, stable (§4.1)
  readonly source: string;                     // ScreenSource.name that produced this draft
  readonly activations: readonly Activation[];
  readonly url: string | null;                 // derived; null = not addressable
  readonly params: readonly string[];
  readonly title: string | null;
  readonly kindTag: string | null;             // e.g. 'apiRoute', 'generated', 'layout'
  readonly entries: readonly EntryRef[];
  readonly ancestors: readonly AncestorRef[];  // outermost first; [] when the screen has no wrappers
  readonly shell: string | null;               // = the innermost `layout`-role ancestor's file (else the nearest ancestor's), or null. Derived, not supplied.
  readonly auth: 'protected' | 'public' | 'unknown';
  readonly featureFlag: string | null;
  readonly redirectTo: string | null;
  readonly devOnly: boolean;
  readonly addressable: boolean;
  readonly tree: readonly TreeNode[];
  readonly reachable: readonly string[];
  readonly facts: ScreenFacts;
  readonly navigatesTo: readonly ResolvedNavigation[];
  readonly provenance: Provenance;             // MANDATORY
};

export type EntryRef =
  | { readonly kind: 'file'; readonly file: string; readonly exportName: string;
      readonly at?: NodeLocator;                                     // sub-file root (§6.3)
      readonly platform?: string }                                   // platform variant ('ios', 'web', …)
  | { readonly kind: 'opaque'; readonly expr: string; readonly file: string; readonly line: number };

export type AncestorRef = {
  readonly file: string;
  readonly exportName: string;
  readonly splice: SpliceMode;      // how the next level down is inserted (§6.3)
  readonly role: 'layout' | 'guard' | 'errorBoundary' | 'transparent';
  readonly branches?: readonly SlotBranch[];  // parallel-route slots this ancestor renders beside the next level
};

export type SlotBranch = {
  readonly file: string;
  readonly exportName: string;
  readonly splice: SpliceMode;                // `{ kind: 'slot', name }`: where the ancestor renders the branch
  readonly conditions: readonly string[];     // carried onto the branch node, e.g. ['slot modal']
};

export type SpliceMode =
  | { readonly kind: 'children' }                 // an ancestor rendering {children}
  | { readonly kind: 'outlet'; readonly tag: string }   // an ancestor rendering <Outlet/> (or a named equivalent)
  | { readonly kind: 'at'; readonly locator: NodeLocator }  // adapter names the splice point explicitly
  | { readonly kind: 'slot'; readonly name: string };    // an ancestor rendering a named slot prop, {modal}
```

`AncestorRef.branches` keeps the chain linear while expressing a Next.js parallel-route slot, which is a
sibling of the continuation rather than a level of it. Each branch is judged apart from its link: the
ancestor's own export must render the slot prop (`{modal}`, `props.modal`, or a destructured alias; a
`{...props}` spread forwards only `children`), else the branch is dropped with one aggregated
`walk/no-splice-point` warning and the chain is kept. A kept branch is grafted after the continuation
under the same host, ordered by slot name then file, as a node with `conditions = branch.conditions` and
`alwaysRendered: false`; its files count toward `reachable` and the screen facts. Emitted views add
`branches` only when present, so the output of an app without slots carries no `branches` key.

`EntryRef.platform` marks a platform variant of a file route. Expo Router maps `x.tsx`, `x.ios.tsx` and
`x.web.tsx` to **one** screen: the base file is the first entry (no `platform`), and each variant is an
extra file entry with `platform` set (`ios`, `android`, `native`, `web`, and `tv` in a tvOS project), so
variants are visible without duplicating the screen. Every file entry is a tree root, so each variant's
components are in the tree; the ancestor chain comes from the base entry, or from the first variant when
no base exists. The field is optional and emitted only when set.

`EntryRef.opaque` is how an unresolvable entry stays **visible**. The prototype drops such routes
entirely (in its router reader); here they are retained, the hole is in the output, and a diagnostic names it.

`AncestorRef` and `EntryRef.at` are the two walk-phase inputs (§0.3). They exist
because measurement shows **0 of 7** Next pages and **0 of 101** TanStack routes carry a layout *tag* —
their layouts are file-convention ancestors — and because
the browser extension's content-script component holds five distinct screens in one file, which a
file-granular tree node (the prototype's graph builder) cannot distinguish.

### 4.2.1 `NodeLocator` — structural sub-file addressing

A locator names a node **inside** a file without depending on its text. It is the addressing scheme for
sub-file tree roots and for explicit splice points. **It is not a hash of source text** — for exactly
the reasons §4.1 gives for `localId`.

```ts
export type NodeLocator = {
  readonly export: string;        // the exported binding whose declaration contains the node ('default' allowed)
  readonly path: readonly number[];  // child indices from that declaration, via forEachChild order
};
```

Resolution (`ctx.locate`, built on `locate` in `src/core/ast.ts`):

1. find the declaration of `export` in the file (the prototype resolver's `declaresLocally` logic,
   then barrel-chased per §7.3);
2. walk `path` by index using `node.forEachChild` order — the same order `walk` (`src/core/ast.ts`) uses,
   so the enumeration is the one the rest of the engine trusts;
3. a path index out of range is an `error screens/unresolvable-locator` naming the file, the export and
   the failing index; the screen is retained with an empty tree rather than dropped.

Locators are **serialized into the output** (`entries[].at`) so `--explain` can replay them and so a
diff shows structural movement as structural movement.

**Stability characteristics, stated honestly:** a locator survives renames, reformatting and edits
*inside* the addressed subtree. It does **not** survive inserting a sibling statement earlier in the same
declaration. That is the same tradeoff as `localId`'s ordinal, and the same escape hatch applies: an
adapter may emit `at` derived from an `// @appgraph-id` pragma's node instead of a raw path, and the
`state-screens` adapter does exactly that when a pragma is present.

> Rejected: a text hash of the addressed node (`sha256(getText())`). It is stable against nothing that
> matters — a whitespace change moves it — and it is unreadable in a diff.
> Rejected: a `line:column` pair. Every edit above the node moves it.

### 4.3 Screen draft (what an adapter actually returns)

This is where optionality semantics live.

```ts
export type ScreenDraft = {
  readonly localId: string;                     // structural; see §4.1
  readonly activations: readonly Activation[];
  readonly entries: readonly EntryRef[];
  readonly ancestors?: readonly AncestorRef[];  // outermost first; absent = no opinion, [] = asserts none

  // `?:` = no opinion, fall through to the next contributing source.
  // `: T | null` = this source asserts absence; fallthrough stops.
  readonly title?: string | null;
  readonly kindTag?: string | null;
  readonly shell?: string | null;
  readonly auth?: 'protected' | 'public' | null;
  readonly featureFlag?: string | null;
  readonly redirectTo?: string | null;
  readonly devOnly?: boolean;
  readonly evidence: readonly Evidence[];
};
```

**Rule for adapter authors (enforced by `exactOptionalPropertyTypes: true` in `tsconfig.json`):** never write `{ title: undefined }` — it will not compile. Build drafts with
conditional spread:

```ts
const draft: ScreenDraft = {
  localId,
  activations,
  entries,
  evidence,
  ...(titleFound !== null ? { title: titleFound } : {}),
  ...(sawProtectedWrapper ? { auth: 'protected' as const } : {}),
};
```

Merging a field across sources: take the first source in contribution order whose key is **present**;
if that value is `null`, the field is `null` and later sources are not consulted.

### 4.4 Facts

```ts
export type FactChannel =
  | 'endpoints' | 'navigations' | 'stores' | 'queryKeys' | 'mutations'
  | 'i18nNamespaces' | 'testIds' | 'formSchemas' | 'formFields'
  | 'featureGates' | 'hooks' | 'messages'
  | (string & {});                                     // open, like NodeKind

export type Endpoint = {
  readonly method: string;
  readonly url: string;
  readonly transport: 'http' | 'rpc';
  readonly client: string | null;    // binding/module the call receiver rooted in; null only for rpc
};

export type Navigation = {
  readonly to: string;
  readonly trigger: 'navigate' | 'link' | 'redirect' | (string & {});
  readonly dynamic: boolean;
};

export type ScreenFacts = {
  readonly endpoints: readonly Endpoint[];
  readonly navigations: readonly Navigation[];
  readonly stores: readonly string[];
  readonly queryKeys: readonly string[];
  readonly mutations: number;
  readonly i18nNamespaces: readonly string[];
  readonly testIds: readonly string[];
  readonly formSchemas: readonly string[];
  readonly formFields: readonly string[];
  readonly featureGates: readonly string[];
  readonly hooks: readonly string[];
  readonly messages: readonly string[];
  readonly extra: Readonly<Record<string, readonly unknown[]>>;   // open channels land here
};
```

### 4.5 Tree, nav, diagnostics, provenance

```ts
export const BUILTIN_KINDS = [
  'screen', 'module', 'layout', 'ui', 'hook', 'service', 'store', 'shared', 'other',
] as const;

export type NodeKind = (typeof BUILTIN_KINDS)[number] | (string & {});

export type TreeNode = {
  readonly file: string;
  readonly component: string;
  readonly kind: NodeKind;
  readonly conditions: readonly string[];   // ALTERNATIVE usage sites (OR), not a conjunction
  readonly alwaysRendered: boolean;
  readonly repeated: boolean;
  readonly nullGuards: readonly string[];
  readonly children: readonly TreeNode[];
  readonly truncated: boolean;
  readonly repeat: boolean;
};

export type NavEntry = {
  readonly path: string;
  readonly parentPath: string | null;
  readonly label: string | null;
  readonly labelKey: string | null;
  readonly featureFlag: string | null;
  readonly source: string;                  // 'file.tsx#EXPORT'
  readonly file: string;
  readonly line: number;
  readonly resolvedScreen: ScreenId | null; // null = DEAD LINK
};

export type NavGroup = {
  readonly name: string;                    // the discovered binding name
  readonly source: string;
  readonly score: number;                   // share of entries resolving to a known screen
  readonly availableOnShells: readonly string[];
  readonly entries: readonly NavEntry[];
};

export type Severity = 'error' | 'warning' | 'info';

export type Diagnostic = {
  readonly severity: Severity;
  readonly code: string;                    // stable, greppable, e.g. 'nav/dead-link'
  readonly message: string;
  readonly plugin: string | null;           // MANDATORY field; null only for kernel-origin diagnostics
  readonly file?: string;
  readonly line?: number;
  readonly screenId?: ScreenId;
};

export type Evidence = {
  readonly what: string;                    // 'createFileRoute literal', 'manifest content_scripts[2]'
  readonly file: string;
  readonly line: number;
};

export type Provenance = {
  readonly sources: readonly string[];      // every ScreenSource that contributed, in contribution order
  readonly evidence: readonly Evidence[];
  readonly mergedFrom: readonly { readonly source: string; readonly localId: string }[];
  readonly decisions: readonly string[];    // one line per merge/conflict decision, --explain reads these
};
```

### 4.6 AppGraph

```ts
export type AppGraph = {
  readonly meta: {
    readonly schemaVersion: 2;
    readonly appgraphVersion: string;
    readonly root: string;                   // relative label only, never an absolute path
    readonly appName: string | null;         // package.json `name`, else the root dir name (§4.6.1)
    readonly sourceRoots: readonly string[];
    readonly screenSources: readonly string[];   // EVERY live source, not just a winner (§10.1)
    readonly maxDepth: number;
    readonly fingerprint: string;                // §8.5
    readonly emptyResult?: true;                 // present ONLY on a zero-screen artifact (§10.2)
    readonly emptyReason?: string;
    readonly counts: Readonly<Record<string, number>>;  // `screens` = screens[] minus redirects and API routes (§7.9)
    readonly confidence: readonly SectionConfidence[];
    readonly limitations: readonly string[];
  };
  readonly screens: readonly Screen[];
  readonly redirects: readonly { readonly from: string; readonly to: string; readonly declaredAt?: string; readonly condition?: string }[];  // rules from config and `next.config`
  readonly shells: Readonly<Record<string, ShellReport>>;
  readonly components: Readonly<Record<string, FileFacts>>;
  readonly navGroups: readonly NavGroup[];
  readonly navigation: readonly NavigationEdge[];
  readonly deadNavLinks: readonly NavEntry[];
  readonly orphanScreens: readonly ScreenId[];
  readonly diagnostics: readonly Diagnostic[];
};

export type SectionConfidence = {
  readonly section: FactChannel | 'screens' | 'nav';
  readonly count: number;
  readonly enablingDependency: string | null;   // e.g. 'zustand'
  readonly dependencyInstalled: boolean;
  readonly level: 'high' | 'low' | 'suspect';   // 'suspect' = count 0 while dependency installed
};
```

`level: 'suspect'` **always** emits a warning diagnostic. Rationale, to be written into the README as
well: an empty section is otherwise indistinguishable from a section that legitimately has nothing, and
the TanStack Start acceptance app is exactly this trap — its data layer is `createServerFn`, so an axios/fetch extractor
returns nothing and the report still looks complete.

### 4.6.1 `appName` and the reported four-state confidence status

`meta.root` is a **path label**, so it cannot title a report. `meta.appName` carries the analysed
project's own name — its `package.json` `name` (the manifest's own name; the `npm:` alias rule for
dependency specifiers does not apply), falling back to the root directory name, `null` when neither
exists. Derivation lives in `src/core/app-name.ts` (`resolveAppName`), never in an emitter; a missing
or malformed manifest degrades to the fallback instead of throwing.

Every emitter reports confidence in the four-state vocabulary of §10.3 — `ok` / `partial` /
`empty-expected` / `empty-unexpected` — derived from the three-state `level` by the single shared
`confidenceStatus` in `src/core/confidence.ts`. `level` stays the kernel's record of what it measured;
the status is what the reader sees, and it exists exactly once.

---

## 5. The internal adapter interface

### 5.0 What is public and what is not

**Public API surface for 0.1, in full:**

| Surface | Where |
|---|---|
| `analyze(options): Promise<AnalyzeResult>` | `src/index.ts` |
| `defineConfig(config): AppgraphConfig` | `src/index.ts` |
| The **emitted data-model types** — `AppGraph`, `Screen`, `Activation`, `TreeNode`, `NavEntry`, `NavGroup`, `Endpoint`, `Navigation`, `Diagnostic`, `Evidence`, `Provenance`, `EntryRef`, `AncestorRef`, `NodeLocator`, `SectionConfidence`, `AppgraphConfig`, `BUILTIN_KINDS` | `src/index.ts` |
| The CLI (§14.2) | `src/cli/index.ts` |

That is the whole list. Everything in §5.1–§5.7 is **internal**: it has no `apiVersion`, no stability
promise, no `experimental_` prefix, no export-map entry, and no versioning policy. It may change in a
patch release. See §5.9 for why, and §17.3 for when it stops being internal.

The types listed as public are public because they describe **the artifact on disk**. A consumer that
parses `appgraph.yaml` is depending on them whether we export them or not, so exporting them costs
nothing and helps. `meta.schemaVersion` versions exactly that surface, and nothing else.

### 5.1 Adapter

```ts
type Adapter = {
  readonly name: string;                     // unique; stamps every diagnostic it produces
  readonly screens?: readonly ScreenSource[];
  readonly nav?: readonly NavSource[];
  readonly facts?: readonly FactExtractor[];
  readonly emitters?: readonly Emitter[];
  readonly kindRules?: readonly KindRule[];
  readonly configure?: (ctx: ConfigureContext) => void;
};
```

No `apiVersion` field: there is nothing to version, because every adapter lives in this repository and
is type-checked against the current interface by the build. A registry that validated a version number
against itself would be theatre.

`WrapperRole` is **not part of the adapter surface** and exists only as an internal helper inside the
react-router adapter, where tag-matching genuinely is how wrappers are declared (§16.1). Measurement
shows it expresses nothing about the other four apps (§0.3).

### 5.2 ScreenSource

```ts
type ScreenSource = {
  readonly name: string;
  readonly detect: (ctx: ProjectContext) => DetectResult;
  readonly discover: (ctx: DiscoverContext) => readonly ScreenDraft[];
  readonly resolveEntry?: (ref: EntryRef, ctx: ResolveContext) => EntryRef;

  // ---- walk-phase inputs (§0.3). Both are OPTIONAL and default to "no wrappers".
  readonly ancestorsOf?: (screen: Screen, ctx: ResolveContext) => readonly AncestorRef[];
};

type DetectResult = {
  readonly score: number;                   // 0..100; 0 means "not this stack"
  readonly evidence: readonly Evidence[];
};
```

**`ancestorsOf`** returns the ordered wrapper chain for one screen, **outermost first**. It runs in
phase 4 (after entries resolve, before the walk), so it can consult resolved entry files. A source may
also put `ancestors` straight on the `ScreenDraft` when the chain is known at discovery time — the
file-convention adapters do, because the chain is literally the directory path. `ancestorsOf` exists for
the case where the chain depends on a resolved entry (the Next.js App Router and Pages Router adapters
use it).

The ordered result feeds §6.3, which owns the actual splicing. An adapter **never** builds a tree; it
names files and splice modes.

The sub-file root is supplied through `EntryRef.at` (§4.2.1), not through a separate hook: an entry
already names a file and an export, and `at` narrows it to a node within that export's declaration.

### 5.3 NavSource

```ts
type NavSource = {
  readonly name: string;
  readonly discover: (ctx: DiscoverContext) => readonly NavGroupDraft[];
};

type NavGroupDraft = {
  readonly name: string;
  readonly source: string;
  readonly entries: readonly Omit<NavEntry, 'resolvedScreen'>[];
};
```

`resolvedScreen` is filled by the kernel during reconciliation. A nav source **must not** resolve
screens itself; navigation and screens stay separate sources of truth and are reconciled exactly once
(§9).

### 5.4 FactExtractor and the extraction phase graph

Extractors are not "visitors in ONE shared AST traversal per file": measurement (§0.7) shows that is
false even of the preserved core. Extraction is an explicit **phase graph**; the intent — do not run N
independent full walks — is kept as a cost budget, not as a false description.

```ts
type ExtractStage = 'prepass' | 'main' | 'finalize';

type FactExtractor = {
  readonly name: string;
  readonly provides: readonly FactChannel[];
  readonly enablingDependency?: string;
  readonly requires?: readonly FactChannel[];         // prepass channels this extractor reads
  readonly stage?: ExtractStage;                      // default 'main'
  readonly accepts?: (file: FileHandle) => boolean;   // cheap gate: extension, path, source text probe
  readonly enter: (node: TsNode, ctx: ExtractContext) => void;
  readonly mask?: (node: TsNode, ctx: ExtractContext) => MaskDecision | null;
  readonly finish?: (ctx: ExtractContext) => void;    // called once per file, at the end of its stage
};

type MaskDecision = {
  readonly channels: readonly FactChannel[] | 'all';
  readonly reason: string;                            // surfaced in --explain and as an info diagnostic
};
```

**The phase graph, per file.**

| Stage | What runs | Guarantee it establishes |
|---|---|---|
| `prepass` | string-constant folding (3 passes), string-enum collection, `BindingTable` construction, `nullGuardsIn` | Every identifier that *can* fold to a string **has** folded, file-wide, before any consumer looks at one |
| `main` | one shared walk; every `stage:'main'` extractor's `enter` is called per node, in registry order | The traversal cost stays one walk regardless of extractor count |
| `finalize` | `finish` on every extractor, in registry order; then masking is applied; then cross-file resolution (`declarationFile`, receiver-root lookups) settles | Cross-file work happens once per file, after all in-file facts exist |

**The failure this ordering prevents, stated because it is subtle and silent.** `flattenString`
returns `null` both for "this identifier is not a string" and for "this identifier is a
string constant I have not folded yet". At a call site the two are indistinguishable, so a fact whose
key came from a constant declared *below* its use is **silently dropped** — no diagnostic, no count
anomaly, just a missing endpoint. `collectStringConstants` running three passes is the prototype's
already-existing acknowledgement of this; making it a declared prepass stage is what stops the next
extractor author from reintroducing the bug. An extractor at `stage:'main'` that calls `flattenString`
on an identifier is therefore guaranteed a settled answer, and a `null` genuinely means "not a string".

**Cross-file fixpoint.** `renders` calls `resolver.declarationFile`, which parses
other files mid-traversal. That is allowed, but it is confined to `finalize`: during
`main`, an extractor records the *unresolved* binding name and resolves it in `finish`. This keeps the
`main` walk free of re-entrant parsing and makes the per-file cost predictable.

**Masking and precedence.** `mask` lets an extractor declare that facts inside a subtree must be
suppressed. It is evaluated during `main`; when it returns a decision for node `N`, every fact emitted
from within `N`'s subtree on the named channels is dropped at `finalize`, and one
`info facts/masked` diagnostic is emitted naming the reason, the file and the line.

- **The real case behind this:** the browser extension's content-script component renders
  `DevStatesPreview`, a dev-only preview of every dialog state. Its `data-testid`s are real strings in
  real JSX, and advertising them to an agent as selectors for the *shipping* UI is actively harmful.
- Precedence when two extractors mask overlapping subtrees: **union of channels**, innermost reason
  recorded first. Masking never un-masks; there is no `unmask`, deliberately.
- Masking applies to facts, never to `renders` edges or `reachable`. A masked subtree's components stay
  in the tree — the agent should still see that the component exists.

`provides` is used to (a) build `meta.confidence`, (b) tell the user which channel degraded when an
extractor throws, and (c) skip a whole extractor when its channel is disabled in config. `requires`
is checked at registration: an extractor requiring a channel no `prepass` extractor provides is an
`error` and is skipped.

### 5.5 Emitter

```ts
export type Emitter = {
  readonly name: string;                       // becomes the --format value
  readonly emit: (graph: AppGraph, ctx: EmitContext) => readonly EmitFile[];
};

export type EmitFile = {
  readonly path: string;                       // relative to the output dir; '..' is rejected by the kernel
  readonly content: string;
};
```

Emitters are **pure**. They receive no `fs`, no `path.resolve`, no clock. The kernel writes the files,
which is what makes `--dry-run`, `--if-stale` and golden tests trivial and structurally prevents an
emitter writing outside the output dir. The one legitimate need for a clock — the HTML report's
"generated at" line — is satisfied by `EmitContext.timestamp: string | null`, which the kernel sets to
`null` under `--no-timestamp`.

### 5.6 Contexts

`typescript` is injected on every context that can see AST. **No adapter imports `typescript`.**

```ts
export type TsNode = import('typescript').Node;      // type-only import, erased at build

export type ProjectContext = {
  readonly ts: typeof import('typescript');          // THE injected compiler realm
  readonly root: string;
  readonly sourceRoots: readonly string[];
  readonly dependencies: ReadonlySet<string>;        // union of deps + devDeps + peerDeps of all manifests
  readonly hasDependency: (name: string | RegExp) => boolean;
  readonly tsconfig: TsconfigChain;
  readonly glob: (pattern: string) => readonly string[];   // sorted, codepoint order
  readonly readFile: (relPath: string) => string | null;
  readonly exists: (relPath: string) => boolean;
};

export type ConfigureContext = ProjectContext & {
  readonly config: ResolvedConfig;
  readonly addKindRule: (rule: KindRule) => void;
  readonly diagnostic: (d: Omit<Diagnostic, 'plugin'>) => void;
};

export type DiscoverContext = ProjectContext & {
  readonly sourceFile: (relPath: string) => import('typescript').SourceFile | null;
  readonly resolveModule: (fromRel: string, spec: string) => string | null;
  readonly declarationFile: (rel: string, exportName: string) => string;
  readonly bindingsFor: (relPath: string) => BindingTable;
  readonly strings: StringTable;                     // shared constant/enum table (§7.3)
  readonly unwrap: (node: TsNode) => TsNode;         // MANDATORY before any type test (§6.2)
  readonly locate: (file: string, at: NodeLocator) => TsNode | null;   // §4.2.1
  readonly flattenString: (node: TsNode | undefined, file: string) => FlatString | null;
  readonly guardOf: (node: TsNode) => { condition: string | null; repeated: boolean };
  readonly normalizeUrl: (raw: string) => string;
  readonly diagnostic: (d: Omit<Diagnostic, 'plugin'>) => void;
};

export type ResolveContext = DiscoverContext;

export type ExtractContext = DiscoverContext & {
  readonly file: string;                             // relative path of the file being traversed
  readonly bindings: BindingTable;                   // this file's table, precomputed
  readonly emitFact: <C extends FactChannel>(channel: C, value: unknown) => void;
};

export type EmitContext = {
  readonly format: string;
  readonly timestamp: string | null;                 // null under --no-timestamp
  readonly options: Readonly<Record<string, unknown>>;
  readonly asset: (name: string) => string;          // report-assets/, read by the kernel, not the emitter
};
```

**Why `ctx.ts` and not `import ts from 'typescript'`.** The reference app's host repo aliases its `typescript`
devDependency to `npm:@typescript/typescript6`. A plugin that imports its own `typescript` may therefore
resolve a *different module realm* than the one the resolver used to produce the `ts.SourceFile` the
plugin is handed. `ts.isCallExpression(node)` then compares `SyntaxKind` numerics and class identities
across realms and returns `false` for nodes that plainly are call expressions — **silently**, with no
error, producing an empty report. Injection is what makes `typescript` a peerDependency instead of a
hard dependency, and what makes the whole thing survive a host that pins a fork.

### 5.7 BindingTable

`BindingTable` is the core surface behind two correctness rules (§8.1, §8.2).

```ts
export type Binding =
  | { readonly kind: 'import'; readonly module: string; readonly imported: string; readonly file: string | null }
  | { readonly kind: 'dynamic-import'; readonly module: string; readonly imported: string; readonly file: string | null }
  | { readonly kind: 'hook-result'; readonly hook: string; readonly module: string | null }
  | { readonly kind: 'local'; readonly declaredAt: number };

export type BindingTable = {
  readonly get: (local: string) => Binding | null;
  readonly rootsInModule: (local: string, modulePattern: string | RegExp) => boolean;
  readonly isHookResult: (local: string, hook: string, module?: string) => boolean;
  readonly moduleOf: (local: string) => string | null;
};
```

Built per file, once, and cached. It records, in this order of precedence:

1. static `import` clauses (default, named, namespace) — as in the prototype's `resolver.imports`;
2. `const { default: X } = await import('…')` — the prototype's `lazyBindings`, held in core;
3. `const [{ default: A }, { default: B }] = await Promise.all([import('…'), import('…')])` — the
   array-destructured variant, as in the prototype;
4. hook-return bindings: `const nav = useNavigate()` → `{ kind:'hook-result', hook:'useNavigate',
   module: <module useNavigate was imported from> }`;
5. plain local declarations, so a shadowing local can be recognised as *not* an import.

`BindingTable` construction is a **`prepass` channel** (§5.4): it must complete file-wide before any
`main`-stage extractor asks it a question, for the same reason string folding must.

### 5.9 Why the adapter contract is deferred to 0.3

The adapter architecture and a published adapter contract are two different things, and the split is
worth stating precisely, because the two halves are usually confused.

**What exists, because it is what makes five stacks work:**

- the phase pipeline (§6.1);
- the `Activation` model — the AdminJS app has no route table anywhere and a URL-first model would have
  to invent one (§16.4);
- the normalized `Screen` / `AppGraph` data model;
- **adapter separation itself** — five separate modules, one interface, no `if (stack === 'next')`
  anywhere in `core/`.

**What does not exist:** the *published* contract. No `apiVersion`. No stability promise. No
`experimental_` prefixes. No `./plugins/*` export map. No contract-versioning policy. Adapters are
internal modules implementing an internal interface, type-checked against the current source by the
build.

**The reason, and it is a measurement, not a preference.** The obvious guess for the extension seam —
the thing an external adapter author would need — is `WrapperRole`: declare your layout tags and your
guard tags, and the engine does the rest. Measurement shows:

- **0 of 7** Next pages and **0 of 101** TanStack routes carry a layout tag at all;
- the real seam is **ancestor chains plus sub-file roots** (§6.3), which `WrapperRole` cannot express
  even in principle — it names tags, and the thing that needs naming is a file relationship.

**A boundary that has to move before the first external user is not a boundary worth publishing.** A
contract published with `apiVersion: 1` and `WrapperRole` would carry a permanent field that does
nothing for four of five stacks, plus a deprecation cycle, plus a migration note, plus every future
adapter author asking why it exists.

**When it gets published: 0.3, extracted from working code**, under two conditions, both of which are
observable rather than judgemental:

1. **five adapters exist** — react-router, Next file conventions, TanStack file conventions, AdminJS
   templates, and the router-less state model — and all five pass their acceptance app's gates (§12.3);
2. **the walk-phase inputs have stabilised** — `AncestorRef`, `SpliceMode` and `NodeLocator` have gone a
   full minor release with no shape change forced by an adapter.

Until then the interface changes when measurement says it should, in the same commit, with no ceremony.
That is the whole benefit of not publishing it.

---

## 6. Pipeline

Eight stages, seven of which are numbered phases; phase 0 is the zero-config layer.

### 6.1 The phases

| # | Phase | Input | Output | Adapter hook |
|---|---|---|---|---|
| 0 | **detect** | `root`, filesystem, manifests | `ResolvedConfig` (possibly multi-source) | `ScreenSource.detect` |
| 1 | **configure** | `ResolvedConfig` | registry populated; `KindRule[]` merged | `Adapter.configure` |
| 2 | **discover** | `Project`, resolver | `ScreenDraft[]`, `NavGroupDraft[]` | `ScreenSource.discover`, `NavSource.discover` |
| 3 | **normalize** | drafts | canonical activations, `ScreenId`s, merged screens, conflicts resolved | — (kernel) |
| 4 | **resolve-entries** | screens with `EntryRef`s | entries resolved to files/locators or marked `opaque`; **ancestor chains resolved** | `ScreenSource.resolveEntry`, `ScreenSource.ancestorsOf` |
| 5 | **walk** | entries + ancestors + `KindRule[]` | `TreeNode[]`, `reachable[]` per screen | **NONE — the algorithm is closed; its INPUTS come from phase 4** |
| 6 | **extract** | reachable file set | `FileFacts` per file | `FactExtractor` (prepass → main → finalize, §5.4) |
| 7 | **aggregate** | facts + trees + nav | `AppGraph`, reconciliation, confidence, explicit re-sort | — (kernel) |
| 8 | **emit** | `AppGraph` | `EmitFile[]` → kernel writes | `Emitter.emit` |

### 6.2 INVARIANT: every discovery-site type test goes through `unwrap`

**Measured (§0.2):** the prototype's router reader type-tests the raw argument of
`createBrowserRouter`. Under `satisfies RouteObject[]` or `as const` the test is `false` and discovery
yields **zero screens** — from a type-only annotation. `unwrap` handles
`ParenthesizedExpression`, `AsExpression`, `SatisfiesExpression`, `NonNullExpression` and
`JsxExpression`, and the prototype does not call it there.

**The invariant:** *no `ctx.ts.isX(node)` call at a discovery site may be applied to a node that has not
passed through `ctx.unwrap`.* Fixtures pin it: the router-forms corpus (`test/fixtures/router-forms/`)
applies 8 wrapping forms — including `X as const`, `X satisfies T`, `(X)`, identifier and cross-file
indirection, and an `as unknown as X` + `!` chain — to both the router argument and a nested `children`
array, and `test/adapters/react-router.test.ts` asserts every form yields the same screen set; the AdminJS
adapter has its own wrapping-form suite (`test/adapters/adminjs.test.ts`).

**The checklist. Every site below calls `unwrap`.**

| # | Site | Prototype location | Node under test |
|---|---|---|---|
| 1 | router array argument | router reader | `createBrowserRouter(<arg>)` |
| 2 | `children` array | router reader | `children: <init>` |
| 3 | `path` value | router reader | `path: <init>` |
| 4 | `element` value | router reader | `element: <init>` |
| 5 | `lazy` value | router reader | `lazy: <init>` |
| 6 | spread element target | router reader | `...<expr>` |
| 7 | dynamic-import argument | router reader | `import(<arg>)` |
| 8 | `Promise.all` array | router reader | `Promise.all(<arg>)` |
| 9 | `queryKey` array + first element | fact extractor | `queryKey: <init>` |
| 10 | `zodResolver` argument | fact extractor | `zodResolver(<arg>)` |
| 11 | JSX attribute initializer | AST helpers | unwrapped via `flattenString` |
| 12 | nav array / `Record` literal | menu reader (nav discovery) | the exported binding's initializer |
| 13 | AdminJS options object | none (`src/adapters/adminjs.ts`) | `new AdminJS(<arg>)` / `AdminJSOptions` binding |
| 14 | `createFileRoute` argument | none (`src/adapters/tanstack-router.ts`) | `createFileRoute(<arg>)` |
| 15 | MV3 manifest JSON parse boundary | none (`src/adapters/manifest-activation.ts`) | n/a — JSON, listed so the checklist is exhaustive |

Sites 1–11 exist in the prototype and are the ones measurement proved broken or at risk. Sites 12–15
have no prototype counterpart and follow the invariant by construction.

`unwrap` is deliberately **not** applied inside `walk`'s generic traversal (`src/core/ast.ts`): unwrapping every
node would erase the `as`/`satisfies` nodes from the tree, and `guardOf`'s ancestor walk depends on the
real parent chain. It is a discovery-site discipline, not a global transform.

### 6.3 The walk phase: closed algorithm, adapter-supplied inputs

The render tree and reachability *are* the product, so an adapter may **not** alter traversal:
`reachable` means one thing across every stack and the parity gate has something stable to assert. That
does not mean the walk needs no adapter input at all — measurement shows it does (§0.3). The
formulation is: **the walk algorithm is closed; its inputs are adapter-supplied.**

Two inputs, both specified precisely.

#### 6.3.1 Ancestor chain

`Screen.ancestors` is an ordered list, **outermost first**. The kernel builds the screen's tree as

```
ancestors[0] → ancestors[1] → … → ancestors[n-1] → entry
```

by building each ancestor's own tree and **splicing** the next level down at that ancestor's splice
point. The result is a single tree whose root is the outermost layout — not a list of sibling roots, as
the prototype's graph builder builds.

**How the splice point is detected**, in `SpliceMode` order:

| `SpliceMode` | Detection |
|---|---|
| `{kind:'children'}` | in source-position order, any of: a `JsxExpression` that renders `children`, an alias from a renamed destructuring (`({ children: content })`), or any `x.children`, including inside `??` / `||` / `&&`, a ternary or a call argument (`{children ?? <Outlet/>}`); a `return children` / `=> children` (only `children`, an alias or `props.children` outside JSX); a JSX spread `{...props}` (or a parameter rest binding that did not pull `children` out first) |
| `{kind:'outlet', tag}` | a JSX element whose tag is `tag` as written, the name it was imported under (`import { Outlet as Slot }`), or a namespace member (`<Router.Outlet/>`); or a call to `use${tag}()` (`useOutlet()`). When the ancestor itself has none, the components it renders are searched breadth-first, up to `maxDepth` levels, and the next level is spliced under the first host found (several hosts at that level → `walk/ambiguous-splice`) |
| `{kind:'at', locator}` | `ctx.locate(file, locator)` — the adapter names the node itself |

A `{children}` reachable only through a component *rendered by* the ancestor (context, a store, a render
prop's closure) is **not** found: the `children` splice point must be in the ancestor file's own code.
That is a real limitation and it is stated in `meta.limitations`.

**Where the next level goes.** Inside the host node, the next level is placed under the child node of
the nearest component element that encloses the splice point as its children (JSX content, or a
`{...props}` spread): `<Wrapper>{children}</Wrapper>` puts the page under `Wrapper`, but only when
`Wrapper`'s own declaration splices its children (`{children}`, `props.children`, a forwarding
`{...props}` spread, or a `return children` in the component's own function, also through a same-file
higher-order component or alias such as `withAuth(memo(Content))`; a `<Ctx.Provider>`, or an alias of
one, always does). A wrapper that only hands `children` to a hook or effect and returns `null`, an alias
of a component outside the project, or a wrapper whose source cannot be read receives nothing. A splice point at the layout's own level, one handed to a component as
a named prop (`show={children}`), or one whose enclosing elements have no node in the host's tree is
placed directly under the host. Slot branches are placed the same way, by their own slot's splice point.

**More than one splice point in an ancestor.** Graft under a wrapper only when the candidates are
**unanimous**: every one sits in the same splicing wrapper. When they disagree (a bare site and a wrapped
one, two different wrappers, or a wrapper that never renders its children), the sites are runtime
branches the walk cannot choose between (`isStandalone ? children : <MainLayout>{children}</MainLayout>`,
`if (skipAuthLayout) return <Outlet/>`), so the next level goes **directly under the host**: imprecise,
never confidently wrong. Emit `warning walk/ambiguous-splice` naming the file, the line of every
candidate, and either that every site gives the same tree or that no single placement holds. Every
screen under such an ancestor also carries `placementAmbiguous: [<ancestor file>, …]`, in the index row,
the detail view and the full view, because the one diagnostic per ancestor names at most three screens
and carries a `screenId` only when it affects exactly one. Several outlet hosts at the shallowest level
mark the screen the same way. Do **not** splice into all of them: that would duplicate the entire
subtree under one screen and double every aggregate. Do **not** drop the screen: a two-slot layout is a
legitimate app shape and a wrong-but-visible tree beats no tree. An adapter that knows better overrides
with `{kind:'at'}`.

**No splice point in an ancestor.** Emit `warning walk/no-splice-point` naming the file and the mode
looked for — **once per ancestor**, with the number of affected screens (the first three named), not once
per descendant screen — then **treat that ancestor as transparent**. An ancestor file that cannot be read
at all is the one `error` case: the adapter named a file the project cannot parse. An adapter that knows a
level renders an implicit outlet (a component-less TanStack route) marks it `role: 'transparent'` and
nothing is reported. In every case the ancestor is skipped in the chain, the next level is spliced
into its parent instead, and the walk keeps the ancestor's own file in `reachable` (its facts are real — it runs).
The failure mode this avoids is the one measurement found: `route.layoutFile === null` for 100% of
screens, `shells === {}`, and the TanStack app's `_authed.tsx` `beforeLoad` redirect invisible.
Reporting a chain with a hole beats reporting no chain.

**One node per exported ancestor.** When a route ancestor's file declares several components
— `RootLayout` + `AppLayout` in one file, or a `LayoutWrappers.tsx` holding several wrappers — the
ancestor is rendered as its own node, labelled with the export's name rather than the file's main
component (`subFileRoot` / `exportRenderEdges` in `core/graph.ts`). Its children are the edges that
export's own JSX produces (including same-file helpers it uses, with the guards found there) plus
whole-file edges to files it references by name. The splice point is searched in that export's body. A
whole-file edge no export can be shown to use (a `lazy(() => import(…))` binding) stays with the file's
main component when that is one of the route exports, and with every export otherwise — never dropped;
an edge only a sibling export uses is dropped from this node. Screen fact totals, `uses` and the shell
report still cover the whole file. Without this, a screen under one wrapper would pick up the links and
children of every sibling wrapper in the same file.

**Depth accounting.** Ancestors do **not** consume the screen's `maxDepth` budget. Each ancestor's tree
is built at depth 0 with its own budget, and the spliced subtree restarts at depth 0. Rationale: a
three-level Next layout chain would otherwise exhaust `maxDepth: 3` before reaching `page.tsx`, and the
screen — the thing the user asked about — would come back empty. `reachable` is the union across the
whole chain.

**`repeat` detection across the splice.** The prototype graph builder's "already expanded in this screen's tree"
check spans the whole chain, so a component rendered by both the layout and the page appears expanded
once and `repeat: true` the second time. This is the prototype's rule, applied to a larger tree.

**`Screen.shell`** is **derived**: the file of the **innermost ancestor whose role is `layout`**,
or — when the chain holds no layout — the nearest ancestor's file, or `null` with no ancestors. A guard
or error boundary nested inside a layout therefore never displaces it: the shell is the frame the screen
is drawn in, not whichever wrapper happens to sit closest. `AppGraph.shells` gets one `ShellReport` per
distinct shell file, computed from that file alone, preserving §7.10's "menus attach to shells" behaviour.

#### 6.3.2 Sub-file root

A screen's tree may start at a **node inside a file** via `EntryRef.at: NodeLocator` (§4.2.1). The walk
then:

1. resolves the locator to a node `N`;
2. collects render edges from **`N`'s subtree only** — `jsxElementsIn(N)` rather than
   `jsxElementsIn(sourceFile)`;
3. attributes facts to the screen from `N`'s subtree only, using the same subtree bound the masking
   mechanism (§5.4) uses;
4. labels the root node `component` as `<fileComponentName>#<localId-suffix>` so the HTML report and the
   YAML show five distinguishable roots rather than five identical ones.

`facts.uses` (module-level imports) are **not** subtree-scoped — an import is file-level and there is no
honest way to attribute it to one branch. They are attributed to every sub-file screen in the file, and
`meta.limitations` says so.

**How `guardOf` interacts with it.** `guardOf` walks **upward** from a JSX element and
stops at a function boundary. For a sub-file root at node `N`, the walk is additionally **clamped at
`N`**: conditions above `N` are not collected, because they are the screen's *own* activation condition,
not a condition *within* the screen. The clamped-off conditions are exactly what becomes
`Activation.expr` for that state screen. Without the clamp every node in the subtree would carry the
screen's own guard text as a redundant condition, and the five extension screens would differ only by a
string repeated on every node.

Concretely, for the browser extension's content-script component: its five guarded alternatives become
five entries with five different `at` locators and five different `localId` ordinals; each tree contains
only its own branch; each carries its own guard text as `activation.expr`; and the `DevStatesPreview`
subtree is additionally masked (§5.4) so its dev-only testIds never reach an agent.

### 6.4 `KindRule` — one answer to "what is this file"

```ts
type KindRule = {
  readonly match: { readonly pathPrefix?: string; readonly pathRegex?: string; readonly fileRegex?: string };
  readonly kind: NodeKind;
  readonly traversable: boolean;    // may be followed as a `uses` edge  ← the prototype's USES_DIR + HOOK_FILE
  readonly screenEntry: boolean;    // may be a screen entry
  readonly priority?: number;       // higher wins; default = rule order within an adapter
};
```

The prototype answers the same "what is this file" question in **four** unrelated places:

| Question | Prototype location | Prototype mechanism |
|---|---|---|
| What kind is this node? | resolver (`KIND_BY_DIR`) | 8 directory prefixes → kind |
| Is it a `uses` edge? | fact extractor (`USES_DIR` + `HOOK_FILE`) | `/^src\/(services\|stores\|shared\/hooks)\//` and `/\/use[A-Z]\w*\.tsx?$/` |
| Can it be a screen entry? | router reader | `if (/^src\/(routes\|layouts)\//.test(file)) continue` |
| Is it in scope at all? | resolver containment test | `resolved.startsWith(path.join(root, 'src'))` |

`KindRule.traversable` is the load-bearing one: `USES_DIR` is the **sole
feeder** of `facts.uses`, and `facts.uses` is the only thing `collectDeep` follows beyond render edges.
It matches **nothing** in the Next.js app's `src/app/`, the TanStack app's `src/routes/` or the AdminJS
app's sources, so on three of the five acceptance apps `reachable` silently degenerates to the
render tree and **every route aggregate under-reports** — with no diagnostic, because the section is not
empty, merely thin. The fourth question is answered by `project.sourceRoots` (§8.6).

One `KindRule[]` answers all four. Making the duplication *structurally impossible* is the point: there
is no second place to put a path regex.

### 6.5 Error containment

`safeCall` (`src/pipeline/registry.ts`) wraps **every** hook invocation:

```ts
const safeCall = <T>(plugin: string, hook: string, fallback: T, fn: () => T): T => { … };
```

A throw becomes `{ severity:'error', code:'plugin/threw', plugin, message: <hook> + <error.message> }`
plus the fallback value (`[]` for discover/emit/`ancestorsOf`, the input for `resolveEntry`, `undefined`
for `enter`/`mask`/`configure`), and the run continues. **A broken extractor degrades one fact channel,
not the report.** The only conditions that abort a run are: no screens discovered **and no
`--allow-empty`** (§10.2), an unwritable output directory, and a YAML self-check failure (§7.12).

---

## 7. The core — what is frozen, what is not, and how a thing earns freezing

### 7.0 The freeze rule

Nothing in this section is frozen by declaration. Measurement shows why: the prototype's resolver, the
obvious candidate for "preserved core", resolves **zero** imports in the AdminJS app (§0.1). A component that
has never been executed against the targets is not proven; it is merely untouched.

> **The rule, and it is the important sentence in this section: a core component may only be declared
> frozen after it has been executed against ALL acceptance apps and its output inspected.** Freezing is
> a *conclusion from evidence*, not a design posture.

**Status board.** Every core component, and what it has actually been run against.

| Component | § | Status | Evidence |
|---|---|---|---|
| Parser-only TS usage (`createSourceFile`, no program, no checker) | 7.1 | **FROZEN** | Runs on all five apps; the property is structural, not app-dependent |
| `/^[A-Z]/` component tags, `/^use[A-Z]/` hooks | 7.8 | **FROZEN** | JSX/React specification, not convention |
| `normalizeUrl` | 7.5 | **FROZEN** | Exercised on all five URL shapes incl. AdminJS templates and Next `[param]` |
| `flattenString` + constant folding | 7.4 | **FROZEN (behaviour)**; its *scheduling* is a declared prepass stage (§5.4) | 3-pass fixpoint verified against the reference app; §0.7 governs when it runs, not what it does |
| Barrel / re-export chasing, 6-hop limit | 7.3 | **FROZEN** | Exercised on the reference app and on AdminJS factory chains |
| `guardOf` ancestor walk | 7.6 | **FROZEN**, plus the sub-file clamp of §6.3.2 | Exercised on the reference app + the extension's five states |
| `nullGuardsIn` | 7.7 | **FROZEN** | 57 files on the reference app |
| Render tree / reachability / aggregation | 7.9 | **NOT frozen** — adds ancestor splicing and sub-file roots (§6.3) | 0/7 Next pages and 0/101 TanStack routes produce a shell under tag matching (§0.3) |
| Menu-attaches-to-shells | 7.10 | **FROZEN** | Verified on the reference app; follows from `shell` regardless of how `shell` is derived |
| Route-scoped filtering | 7.11 | **FROZEN** | Mechanical over the graph |
| **Alias resolution + module probing** | 7.2 | **NOT frozen** — configurable | `imports resolved: 0, bindings: 0` on the AdminJS app (§0.1) |
| **`USES_DIR` / `HOOK_FILE` traversal feeder** | 6.4 | **NOT frozen** — folded into `KindRule.traversable` | Matches nothing on 3 of 5 apps (§0.1) |
| **tsconfig reading** | 8.4 | **NOT frozen** — real `parseJsonConfigFileContent` | Raw-JSON reading leaves `extends` unfollowed and `baseUrl` ignored (§0.9) |
| **YAML serializer** | 7.12 | **NOT frozen** — corrected quoting + self-check | `k: foo:` does not parse under the prototype's predicate (§0.8) |
| **Discovery-site type tests** | 6.2 | **NOT frozen** — `unwrap` invariant | every screen → 0 on one `satisfies` (§0.2) |

**Review rule (put this in `CONTRIBUTING.md` and in the PR template):** *any PR that adds a config
option, adapter hook or context method touching a **FROZEN** row must be rejected unless it also deletes
an existing option, or unless it carries a measurement against an acceptance app showing the frozen
behaviour is wrong.* Generality against a frozen row is a regression. Generality against a
not-frozen row is the point.

### 7.1 Parser-only TypeScript usage

`ts.createSourceFile(abs, text, ts.ScriptTarget.ESNext, /* setParentNodes */ true, scriptKind)` and
nothing else. **Never `ts.createProgram`. Never the TypeChecker.**

There is exactly one parse door: `createScriptSource` (`src/core/source-file.ts`). The resolver's
`sourceFile` and the phase-0 project probe both go through it. It picks the `ScriptKind` from the
extension (`src/core/extensions.ts` is the single source of truth for source extensions); phase 0, which
has no resolver yet, passes `inferKind` to let the parser decide.

A Vue single-file component is parsed as a **virtual script**: `virtualScript` (`src/core/sfc.ts`) keeps
the `<script>` and `<script setup>` contents at their original offsets and blanks everything else to
spaces, preserving newlines. The result has the same length as the file and nothing is appended, so every
line number, `pos` span and structural locator computed on it is valid in the real `.vue` file. A `.vue`
file is therefore always a whole-file root.

`vue/compiler-sfc` is an **optional peer** (`>=3.4 <4`) and is used only to build template ASTs
(Phase 2). `src/core/vue-compiler.ts` is the only module allowed to import it (lint-enforced). It is
loaded from the analysed project first and falls back to appgraph's own install. It is never fatal: when
it is absent or out of range the run emits `project/template-compiler-missing` or `project/template-compiler-unsupported`,
skips template facts, and still parses every script; a template using a feature it cannot read (pug, `<template src>`,
a parse error) yields partial facts and one info `facts/unsupported-template`. `appgraph doctor` prints a `vue compiler:`
line with the resolved version and origin. The mechanism is framework-neutral: see §7.1.1.

This is not an omission to be fixed later — it is a load-bearing property:

- **Speed.** No type graph, no module resolution through node_modules, no `lib.d.ts` load. The
  prototype analyses the reference app's 696 files in seconds.
- **Tolerance.** A repo that does not compile still produces a full map. An agent asking "where is the
  invoices screen" must get an answer mid-refactor, which is exactly when it does not compile.
- **No install requirement.** Analysing a checked-out repo does not require `npm install` to have
  succeeded.

The cost is stated honestly in §11 and in every emitted `limitations` block: anything needing
cross-file type flow is out of reach.

`setParentNodes: true` is mandatory — `guardOf` and `nullGuardsIn` walk `node.parent`.

### 7.1.1 Template seams — a framework registry, not Vue code

Template-bearing frameworks plug in through a registry. Nothing outside `src/core/vue-compiler.ts` and
`src/core/vue-template.ts` knows Vue exists.

- **Spec.** `TEMPLATE_FRAMEWORK_IDS` (`src/core/template-frameworks.ts`) lists the ids; one
  `TemplateFrameworkSpec` per id declares the compiler packages and `moduleKind` (`cjs` or `esm`), `appliesTo`
  (dependencies and files), `projectMajor` and `checkVersion` (a non-null return is the reason the version is
  unsupported), `fallbackOnUnsupported`, `adapt` (module to a narrow compiler API, or `null`), `producer`, the
  `installHint`/`skippedNote` used in diagnostics, and the framework's `TemplateTags`.
  `TEMPLATE_FRAMEWORKS` (`src/pipeline/template-frameworks.ts`) is the list of specs actually registered.
- **Loading.** `loadTemplateCompilers` runs once per run, only for specs whose `appliesTo` holds, and returns the
  loaded APIs, a per-framework status (for `doctor`) and the diagnostics. The shared `loadPeer`
  (`src/core/peer-loader.ts`) tries the analysed project first and then appgraph's own install; a project
  resolution that lands outside the project's `node_modules` is rejected (isolation check), so a hoisted copy
  from elsewhere is never silently used. `moduleKind` picks `require` or dynamic `import`. When a spec sets
  `fallbackOnUnsupported`, an unsupported project copy is retried against appgraph's own. Compilers are
  injectable per framework for tests.
- **Diagnostics.** `project/template-compiler-missing` (not loadable) and `project/template-compiler-unsupported`
  (wrong version or API shape) are warnings and never fatal; script analysis continues. `facts/unsupported-template`
  is an info, one per framework, listing files whose template used a feature appgraph cannot read (pug,
  `<template src>`, `<script src>`, parse errors, a missing `templateUrl`, an interpolated inline template); the
  facts from such a file are partial.
  `project/nuxt-layer-skipped` (info) reports Nuxt `extends` layers that are not analysed, and
  `facts/ambiguous-component-name` (info) reports an auto-import component name claimed by two files, for which no
  render edge is drawn.
- **Neutral model.** `src/core/template-doc.ts` defines `TemplateDoc` (`framework`, `file`, `owner`, `partial`,
  `elements`, `expressions`, `unsupported`), `TemplateElement` (tag, candidate `names`, kind, a `guard`, a
  `slotName`, attributes with a neutral kind) and `TemplateExpression` (text, `origin` of interpolation, attribute or
  event, pipes). Every node carries `pos`, `end` and `line` in the real file. `TemplateTags` states the framework's
  vocabulary: outlet tags, the children and named-slot tags, built-ins, link tags and link/target attributes, so
  extractors and the walk never hard-code `<RouterView>` or `<router-link>`. `TagResolution` is either a `file` (with
  `exportName` and a `via` of `selector`, `selector-global`, `ambient` or `lazy`) or `ambiguous`.
- **Producers.** A `TemplateProducer` (`claims`, `docsOf`, optional `resolveTag` and `componentNameOf`) turns a file
  into zero or more `TemplateDoc`s. `createTemplateSource` assembles the producers into the `TemplateSource` the
  pipeline uses: it caches `templatesOf`, falls back to the Nuxt-style `ambient` resolver when a producer does not
  resolve a tag, and exposes `tagsOf`, `labelOf` and `claims`. The Vue producer is `createVueTemplateProducer`
  (`src/core/vue-template.ts`). `src/core/tag-scan.ts` (`scanTags`) is a small comment-aware tag scanner for markup
  the compiler is not asked to parse.
- **Extractors.** `FactExtractor.template(doc, ctx)` (`src/extractors/types.ts`) is called once per `TemplateDoc` of a
  file. `ExtractContext` carries `templates`, `templateExpression` (parses an expression's text into a
  `ts.Expression`, so the existing script helpers apply), `resolveTag` and `tagsOf`. `anchorOf(doc, node)` builds the
  `FactAnchor` for a template node: its `file` is the template file, its `line` is exact, and a fact whose anchor file
  differs from the file being extracted records `Fact.origin`.
- **Splice.** `GraphProviders.spliceCandidatesOf(ref: SpliceRef)` (`src/core/graph.ts`) answers "where does the next
  level land in this file" for `children`, `outlet` and `slot` splices. `templateSpliceCandidatesOf`
  (`src/pipeline/phases/template-splice.ts`) serves it from the `TemplateDoc`s when the source claims the file, and
  returns `null` otherwise so the script path is used; `at` splices always use the script path.
- **Script regions.** `SCRIPT_REGION_SPLITTERS` (`src/core/source-file.ts`) maps a single-file-component extension to
  `{ framework, split }`; `createScriptSource` uses it so the script part is parsed at its original offsets (only
  `.vue` is registered).

**Adding a framework** is four edits and no pipeline change: (1) one `TemplateFrameworkSpec` and its id in
`TEMPLATE_FRAMEWORK_IDS`, registered in `TEMPLATE_FRAMEWORKS`; (2) one `TemplateProducer` (plus the one module that
may import the compiler); (3) one `SCRIPT_REGION_SPLITTERS` entry if the framework uses single-file components;
(4) one `TEMPLATE_COMPILER_PEERS` entry in `eslint.config.js`, which bans importing the compiler anywhere but its
loader.

#### 7.1.2 The Angular producer

Angular is the second registered framework (`angular` in `TEMPLATE_FRAMEWORK_IDS`; compiler loader
`src/core/angular-compiler.ts`, producer in `src/adapters/angular/template.ts`). It plugs into the §7.1.1 seams and
adds no pipeline code.

- **One doc per `@Component`.** The producer claims each `.ts` file that declares components and emits one
  `TemplateDoc` per class, with `owner` set to the class name and `ownerFile` to the `.ts` file. `ownerFile` is an
  optional `TemplateDoc` field: when absent, `file` is the owner, as for Vue. A file with exactly one `@Component`
  also supplies the component's display name through `componentNameOf`.
- **`templateUrl` pairing.** `templateUrl` is resolved by path math against the component file, never through module
  resolution (which rejects `.html`). The doc's `file` is the `.html` file, so every node's `pos` and `line` are real
  template lines, and facts stay keyed on the component's `.ts` file with `Fact.origin` pointing into the `.html`.
  The `.html` file never enters `reachable` or `extractedFiles`. An inline `template:` is read from the raw literal
  text so offsets stay exact; a template literal with `${…}` is `unsupported`.
- **Scan mode without a compiler.** With no resolvable `@angular/compiler`, the producer does not parse. It runs
  `scanTags` (`src/core/tag-scan.ts`) over the template text and emits docs that carry only the outlet tags
  (`<router-outlet>`, `<ng-content>`), flagged `partial`. Layout splices therefore work, and no other template fact
  exists. The run reports one `project/template-compiler-missing` naming Angular.
- **Selector scope.** `src/adapters/angular/selectors.ts` indexes every component by selector and answers a tag from
  the standalone `imports` or the NgModule `declarations`/`exports` closure (`via: "selector"`), then a unique global
  match (`via: "selector-global"`), else `ambiguous`.
- **`templateTagResolver` seam.** `Adapter.templateTagResolver` (`src/adapters/types.ts`) is a framework-neutral
  hook: given the `DiscoverContext` it returns a tag resolver or `null`. The discover phase
  (`src/pipeline/phases/discover.ts`) records each resolver on the pipeline environment, wrapped so a throwing
  resolver is reported and skipped. `TemplateSource.resolveTag` (`src/pipeline/template-frameworks.ts`) consults the
  recorded adapter resolvers **first**, then the framework's `TemplateProducer.resolveTag`, then the ambient
  resolver. The Angular adapter uses it because selector scope lives in the NgModule and bootstrap state that only the
  adapter has built. A later Svelte or Astro adapter needs only this hook plus a producer.

### 7.2 Alias resolution and module probing — **NOT frozen; configurable**

**The single most consequential configurable component.** Measurement: on the AdminJS app
(`"moduleResolution": "nodenext"`, `.js` specifiers, `.tsx` sources) the prototype's resolver reports
`imports resolved: 0, bindings: 0` for its options module and its component-loader module, because the
resolver's `CANDIDATE_SUFFIXES` appends to the whole specifier and probes `foo.component.js.tsx`. A
perfect AdminJS adapter on top of that resolver produces correct screens and empty trees, one for one.

Preserved **defaults** (the prototype's behaviour when nothing is configured):

- ignore `\.(test|spec|stories)\.[tj]sx?$` and `\.d\.ts$`;
- aliases sorted **longest prefix first** so `@/modules/*` beats `@/*`;
- wildcard aliases match by prefix, **exact (non-wildcard) aliases by full-specifier equality** —
  load-bearing because the reference app's tsconfig declares two aliases with no wildcard;
- relative specifiers resolve against the importing file's directory.

**Configurable inputs (adapter- and config-supplied):**

```ts
type ModuleResolutionOptions = {
  readonly candidateSuffixes: readonly string[];      // default ['', '.tsx', '.ts', '/index.tsx', '/index.ts']
  readonly extensionRewrites: readonly ExtensionRewrite[];
  readonly sourceRoots: readonly string[];            // covers BOTH of the prototype's hardcoded `<root>/src` checks
};

type ExtensionRewrite = { readonly from: string; readonly to: readonly string[] };
```

**`extensionRewrites`** is applied **before** the candidate-suffix probe: a specifier whose tail matches
`from` is rewritten once per entry in `to`, in order, and each rewrite is probed to completion before
the next is tried; if no rewrite resolves, the original specifier is probed with the candidate suffixes
as a fallback. Defaults, derived by phase 0 when the tsconfig chain reports `node16`/`nodenext`:

```ts
[{ from: '.js',  to: ['.ts', '.tsx'] },
 { from: '.jsx', to: ['.tsx'] },
 { from: '.mjs', to: ['.mts', '.ts'] }]
```

so `import { x } from './foo.js'` resolves to `./foo.ts` or `./foo.tsx`. Overridable in
`appgraph.config.ts` (§15.1).

**`candidateSuffixes`** is configurable because the default list encodes a `.tsx`-first React
convention. A repo whose components are `.ts` with `.tsx` only for JSX-carrying files, or one using
`/index.js` barrels, needs a different order — and the failure of a wrong order is a silently smaller
graph, never an error.

**`sourceRoots`** covers the prototype's two hardcoded `<root>/src` checks: the resolver's
containment test and the root derivation itself (§8.6). There is exactly one containment predicate in the package,
`project.contains(abs)`.

**When this may be frozen:** after the AdminJS and TanStack Start apps both report non-zero `imports resolved`
and non-empty render trees in CI. Until then it stays explicitly open.

### 7.3 Barrel / re-export chasing and the string table

`declarationFile(abs, name)`: if the file declares `name` locally, stop; otherwise follow
`export … from '…'` statements, mapping through `propertyName` on named re-exports, up to **6 hops**,
memoised on `` `${abs}#${name}` ``. Preserved including the hop limit.

`readStringEnum` collects `Enum.Member` → string literal from **string enum declarations**, keyed as
`` `${enumName}.${memberName}` ``. In appgraph this is a **shared `StringTable`** populated from
every file listed in `config.stringSources` (auto-detected in phase 0 as: files whose enum members are
referenced from a discovered screen source). `flattenString` reads it for `PropertyAccessExpression`
lookups.

### 7.4 `flattenString` and constant folding

Preserved exactly from the prototype's AST helpers. Handles, in order:

| Node | Result |
|---|---|
| string literal / no-substitution template | `{value, dynamic:false}` |
| identifier | file-local constant table lookup, else `null` |
| `A.B` property access | `StringTable` lookup, else `null` |
| template expression | head + spans; an unresolvable span contributes `:param` and sets `dynamic:true` |
| `a + b` binary | concatenation; an unresolvable side contributes `:param` and forces `dynamic:true` |
| ternary | `whenTrue` else `whenFalse`, always `dynamic:true` |
| `.replace(…)` call | receiver's value, `dynamic:true` |
| anything else | `null` |

`DYNAMIC_PLACEHOLDER` is the literal `':param'`, which is the same syntax as a route parameter — that is
deliberate and load-bearing: it is what lets `createRouteMatcher` probe a dynamic endpoint URL against
route patterns.

`collectStringConstants` runs **three passes** over the file's variable declarations, recording only
non-dynamic values and never overwriting an existing key, so a constant defined in terms of two earlier
constants folds. Three is the fixed point observed in practice; it stays 3.

**This is a `prepass` stage, not part of the main walk (§5.4).** `collectStringConstants` is three full `walk`
calls over the file before any consumer can call `flattenString` usefully — which is why "one shared
traversal per file" is false of it (§0.7). The scheduling is declared rather than incidental, because
the bug it prevents is silent: `flattenString` returns `null` both for "not a
string" and for "not folded yet", so a consumer that runs too early drops the fact with no diagnostic.

**`slice(0, 60)` in the fact extractor** (the query-key fallback) and **`slice(0, 110)` in
`conditionText`** (condition text) both truncate arbitrary source text. Any value produced by either must
be flagged `truncated` and is **always quoted** on emit (§7.12), and neither may ever be used as an
identity (§4.1).

Unwrapping (`unwrap`) transparently drops parentheses, `as`, `satisfies`, `!` and `{…}` JSX
expressions. The `satisfies` case is what makes the reference app's menu array (`… satisfies Route[]`)
parse.

### 7.5 `normalizeUrl`

Strip everything from the first `?` or `#`; collapse runs of `/`; drop a trailing `/` unless the whole
URL is `/`. Nothing else. In particular it does **not** lowercase and does **not** decode.

### 7.6 `guardOf`

Ancestor walk from a JSX element upward, collecting the conditions under which it renders:

- `X && <El/>` where the element is the **right** operand → push text of `X`;
- `X ?? <El/>` → push text of `X`;
- `X || <El/>` → push `!(X)`;
- `c ? <El/> : …` → push `c`; `c ? … : <El/>` → push `!(c)`;
- any enclosing `.map(…)` call → `repeated = true`;
- **stops at a function boundary** (function declaration, arrow, function expression, method) — *unless*
  that function is itself a call argument, i.e. a callback. This exception is what lets guards survive
  through `.map(item => …)` and `<Suspense fallback={…}>`-style render props.

Condition text is `node.getText()` with whitespace collapsed to single spaces, trimmed, truncated to
**110 characters**. Collected conditions are `reverse()`d (outermost-first) and joined with `' && '`.

Guards are **texts, never evaluated**. Condition evaluation is a non-goal (§13).

### 7.7 `nullGuardsIn`

An `if` statement with **no** `else`, whose body contains a `return null` or `return <></>` (an empty
JSX fragment), inside a function that contains JSX anywhere. The condition text goes into the file's
`nullGuards`. The "does this function render JSX" answer is memoised per function node.

### 7.8 `/^[A-Z]/` and `/^use[A-Z]/`

`isComponentTag` is `/^[A-Z]/` on the tag name. This is **JSX specification**, not convention: a
lowercase tag is a host element. Never make it configurable.
`tagName` resolves `<Foo>` to `Foo` and `<Foo.Bar>` to `Foo` (the namespace root).

`/^use[A-Z]/` is the React Rules-of-Hooks naming rule and is likewise spec-adjacent. Hook detection and
the `Store$` suffix convention on top of it stay in core.

### 7.9 The render tree, reachability and aggregation algorithm — **NOT frozen**

Preserved from the prototype's graph builder **except** for the two additions of §6.3 (ancestor-chain
splicing, sub-file roots) and the `traversable` rule of §6.4. Specifically: the ancestor chain, not
the prototype's "each entry is a sibling tree root", shapes the tree, and `facts.uses` is fed by
`KindRule.traversable`, not `USES_DIR`. Everything below is preserved:

- `maxDepth` default **3**; `USES_DEPTH_BONUS = 3`, so `uses` edges are followed to `maxDepth + 3`.
- `buildNode`: a file already expanded anywhere in this screen's tree returns `{children: [],
  repeat: true}`; at `depth >= maxDepth` it returns `{children: [], truncated: renders.length > 0}` and
  the children are still added to `reachable` via `collectDeep`.
- `reachable` is the transitive closure over `renders ∪ uses`, depth-bounded, per screen.
- Aggregates (`endpoints`, `stores`, `queryKeys`, `i18nNamespaces`, `testIds`, `formSchemas`,
  `formFields`, `featureGates`) are the union over the whole `reachable` set — **not** the tree. The
  limitation this implies is stated in the emitted `limitations` array and must stay there.
- A render edge merges repeated JSX usages of the same file: `conditions` is the **set union** of the
  guard texts (alternative usage sites, OR), `alwaysRendered` is true if *any* usage had no guard,
  `repeated` is true if *any* usage was inside a `.map`.
- Screen self-edges are filtered out of `navigatesTo`; `matchedRoute === screenId` edges are filtered
  out of the global `navigation` array.
- `createRouteMatcher`: exact URL match first; otherwise the probe URL has `:param` replaced by
  `value` and is tested against static patterns before dynamic ones; the `/*` catch-all route is
  excluded from the pattern set. A `*` catch-all also matches its base path (`/app-store/*` ↔
  `/app-store`), as react-router `*`, TanStack `$` and Next `[[...slug]]` do at runtime; the one
  exception is a Next required `[...slug]`, recognised from the screen's entry file
  (`isRequiredNextCatchAll`), which needs at least one segment. The template stays `*` either way, so
  ScreenIds do not change.
- Shells: one `ShellReport` per distinct shell file (innermost layout ancestor, §6.3.1), computed by running the same
  analysis with that file as the entry, and `layouts` listing every layout component name that mapped to
  it.
- Counts: `meta.counts.screens` is every `screens[]` entry that is neither a redirect (`redirectTo`
  set) nor an API route (`kindTag` `apiRoute`) — addressable and state screens alike. Redirects and API
  routes are counted apart (`redirects`, `apiRoutes`), so `screens + redirects + apiRoutes` equals the
  length of `screens[]`. The HTML report header uses the same definition.

### 7.10 Menu edges attach to shells

Preserved: a menu is *available on shells* (`menu.availableOnShells`, computed by checking whether any
file reachable from the shell imports the menu's source file), not multiplied into per-screen navigation
edges. 12 menu items × 30 screens = 360 meaningless edges; 12 items on 1 shell is the truth.

### 7.11 Route-scoped filtering

`filterToRoute` semantics preserved: keep the screen, its shell, every component in its `reachable` set
and tree, redirects touching it, navigation edges touching it, and recompute the affected counts. In
appgraph it is `filterToScreen(graph, screenId)`.

### 7.12 The zero-dependency YAML serializer — **NOT frozen; self-checked and fuzzed**

The structural behaviour is preserved: no newlines in a plain scalar; empty array → `[]`; empty object →
`{}`; arrays of containers inline their first line after `- `. The **quoting predicate is not**.

**Measured (§0.8), by fuzzing the prototype's YAML emitter.** The value `k: foo:` — a trailing colon — is emitted as a
plain scalar and then **fails to parse**. `NEEDS_QUOTES` catches `": "` but not a colon at end of
string. And two sites truncate arbitrary source code at fixed offsets (condition text at
`slice(0,110)`, the query-key fallback at `slice(0,60)`), so a cut landing immediately after a colon — trivially reachable
from source as ordinary as `{ status: filter }` — emits a document no parser can read **while the tool
reports success**. Two further defects: `LOOKS_NUMERIC` (`/^[+-]?(\d|\.\d)/`) over-quotes every string
merely *starting* with a digit, and `JSON.stringify` as the escaper leaves U+2028/U+2029 raw, which is
legal JSON and illegal in a YAML plain/double-quoted scalar.

**Three rules.**

1. **Quoting predicate.** A string is quoted if any of:

   ```
   /^$/                                   empty
   /^[-?:,[\]{}#&*!|>'"%@`]/              leading indicator character
   /: /                                   colon-space anywhere
   /:$/                                   TRAILING COLON                (the measured failure)
   /\s#/                                  space-hash anywhere
   /^\s|\s$/                              leading or trailing whitespace (incl. \t \r \f \v)
   /^#/                                   leading hash
   /[\u2028\u2029]/                      line/paragraph separator
   /[\n\r]/                               any newline
   /^(true|false|null|yes|no|on|off|~)$/i YAML boolean/null lookalikes
   value.truncated === true               ALWAYS quote a truncated string (see below)
   ```

   Beyond the table, a string is quoted when it would resolve to any YAML implicit type
   (`IMPLICIT_TYPE_PATTERNS` in `src/emit/yaml.ts`): the keyword set (adding `y`, `n`, `<<` and `=`),
   decimal, octal, hex, binary, underscored and sexagesimal numbers, `.inf` / `.nan`, and timestamps
   (`YYYY-M-D`, optionally with a time and zone). It also quotes any string carrying a C0 control or
   non-printable character. The numeric test matches a string that **is** a number, not one that merely
   starts with a digit: `1.5`, `1e10` and `2024-01-01` are quoted; `1.2.3` and `v2` are not. This is
   cosmetic, not a correctness matter, and it moves bytes relative to the golden — see §12.3.

   The escaper is a purpose-written double-quote escaper, not `JSON.stringify`: it escapes `"`, `\`, the
   C0 controls, U+2028 and U+2029 as `\u2028` / `\u2029`, and U+0085.

2. **Always quote anything truncated.** Values produced by the two truncation sites carry a
   `truncated: true` marker from the point of truncation to the point of emission (a branded string type,
   `TruncatedString`, so it cannot be lost by an intermediate `String(...)`). The emitter quotes them
   unconditionally. This removes the entire class rather than chasing which cut positions are dangerous —
   the cut position is by definition arbitrary.

3. **The emit path asserts its own output re-parses.** `toYaml` (`src/emit/yaml.ts`) verifies every
   document incrementally while emitting it: each entry of a large container (more than 2,048 weighted
   nodes) is re-parsed on its own as soon as it is written, and a document with no large container is
   re-parsed whole at the end. Every check deep-compares the round-tripped value against the input (after
   the documented lossy conversions: everything is a string on the way back, so the comparison is against
   `String(...)` of each scalar). A failed local check, a line holding a control or non-printable
   character, a sparse-array hole or an empty document marks the document dirty, and only a dirty document
   gets the full round trip: `parseYamlDocument` over the whole text. A mismatch there is a **fatal**
   `error emit/unparseable-yaml` naming the failing key path and the offending scalar, and **no file is
   written**. The self-check has no opt-out (§14.2); the `verifyEmit` field of `ResolvedConfig` (default
   `true`) is not read by the emitter.

**Mandatory permanent CI job: `test/emit/yaml.fuzz.test.ts`.** Property test over the emitter: generate
random nested structures whose scalars are drawn from an adversarial alphabet (`:`, `#`, `-`, `"`, `'`,
`\n`, `\t`, U+2028, U+2029, leading/trailing space, YAML keywords, numeric lookalikes, and **strings cut
at every offset from a corpus of real source lines**), emit, re-parse, assert deep equality. It runs on
every commit, not nightly. A failure is a release blocker.

**The tradeoff, stated explicitly.** Hand-rolling YAML keeps the package at **one runtime dependency**
(`commander`), which matters for an OSS static analyser people run in CI. That is worth having, but it
is a claim that must be *earned* by the self-check and the fuzz job, not assumed from a regex — the
prototype's had a hole in it.

> **The named trigger that forces taking a real YAML dependency:** *any second class of malformed
> output found after the fuzz test exists.* One bug found by fuzzing is the fuzzer working. A second,
> structurally different bug reaching a user afterwards means the hand-rolled emitter's defect rate is
> not converging, and `yaml` goes into `dependencies` in the next patch release with no further debate.

---

## 8. Correctness rules from prototype defects

Each rule answers a real defect located in the prototype source, and each has a directional effect on
the parity diff (§12.3).

### 8.1 Endpoints require a known HTTP client

The prototype's fact extractor treats **any** property-access call whose method name is in
`{get, post, put, patch, delete}` and whose first argument flattens to a string starting with `/` as an
HTTP endpoint. `someMap.get('/x')`, `params.delete('/y')`, `cache.get('/z')` are all phantom endpoints.
With 335 endpoints in the baseline, an unknown fraction is noise.

**Rule.** An endpoint is emitted only when the call **receiver roots in a known HTTP client** —
`bindings.rootsInModule(receiverRoot, /^(axios|ky|got|node-fetch)$/)`, a binding whose module is the
project's own api-client module (auto-detected in phase 0 as the module that a plurality of
method-named calls root in), or a bare global `fetch`. `Endpoint` carries `transport: 'http' | 'rpc'` and
`client: string | null` naming the module or binding it rooted in. Receiver-root resolution walks the
property-access chain to its leftmost identifier and asks the `BindingTable`.

### 8.2 `navigate(...)` is matched by binding, not identifier name

The prototype's fact extractor: `if (name === 'navigate') addNavigation(...)`. A file writing
`const go = useNavigate()` produces zero navigations, and a file with an unrelated local function
called `navigate` produces false ones.

**Rule.** `bindings.isHookResult(local, 'useNavigate', 'react-router-dom')` (module optional so
`react-router` v6/v7 and `@tanstack/react-router`'s `useNavigate` are covered by the adapter declaring the
module it cares about). The `navigations` fact extractor asks the binding table, never the identifier
text.

### 8.3 Routes with neither a screen entry nor a redirect are retained

The prototype's router reader: `if (info.screens.length === 0 && !info.redirectTo) return;`. A pathless layout route,
a route whose element is a component the resolver could not bind, and any route whose entry is behind a
registry, all vanish with no trace.

**Rule.** Such routes are **retained**, tagged (`kindTag: 'layout'` or `'entryless'`), and marked
`addressable` according to whether they have a url activation. An entry the adapter could not resolve to
a file becomes `EntryRef.opaque` carrying the source expression text, file and line, plus an
`error`-severity diagnostic `screens/opaque-entry`. **A visible hole, never a silent drop.**

### 8.4 tsconfig handling

The prototype's resolver: `fs.readFileSync(configPath)` with **no existence check** (raw ENOENT crash on any
repo without a root `tsconfig.json`); its `ts.parseConfigFileTextToJson` returns **raw
JSON**, so `extends` is not followed and `baseUrl` is ignored; only `targets[0]` of each `paths` entry
is used.

**Measured (§0.9):** none of the five acceptance apps uses `extends`, so this is latent there — but
`extends` is the most common monorepo tsconfig shape and the failure mode is **silent**:
zero aliases parsed → every `@/…` import resolves to `null` → an empty graph, with no error and no
diagnostic. It is exactly the class of failure this document exists to prevent, and it is one
`tsconfig.base.json` away from being live.

**Rule.** `src/core/tsconfig.ts` produces a `TsconfigChain`:

```ts
export type TsconfigChain = {
  readonly files: readonly string[];             // resolution order, base first
  readonly baseUrl: string | null;
  readonly paths: Readonly<Record<string, readonly string[]>>;   // ALL targets
  readonly include: readonly string[];
  readonly moduleResolution: string | null;
  readonly jsx: string | null;
};
```

**Use `ts.parseJsonConfigFileContent` with a real `ParseConfigHost`**, not
`parseConfigFileTextToJson`. The host is a thin adapter over `fs` (`useCaseSensitiveFileNames`,
`readDirectory`, `fileExists`, `readFile`) plus the §10.7 exclusion list and the no-symlink rule, so the
compiler's own `extends` resolution, `baseUrl` handling and `include`/`exclude` expansion are reused
rather than reimplemented. `extends` is therefore followed in its string, array and node-module-specifier
forms with the compiler's cycle guard.

`paths` from a child override the same key in a parent; **every** target is a probe candidate, tried in
declaration order; and **non-wildcard entries keep working** — the reference app's tsconfig declares
two aliases with no `/*`, matched by full-specifier equality (as in the prototype's resolver).
An implementation that only handles wildcard keys silently drops two aliases on the parity app.

A missing tsconfig is a clean `error project/no-tsconfig` diagnostic naming the searched path, never a
crash: the run continues with an empty chain (no `baseUrl`, no `paths`, so alias imports do not resolve),
writes its artifacts and exits `1` — or `3` when it found no screens. See §13: JS-only projects with no
tsconfig are an explicit non-goal, reported loudly.

### 8.5 The `--if-stale` fingerprint covers every input

The prototype's entry script compares output mtimes against `newestSourceMtime(root/src)` only.
Changing the analyzer, the config, or the tsconfig does not invalidate the cache, so the tool cheerfully
serves a stale map after its own upgrade.

**Rule.** `src/cli/stale.ts` computes a SHA-256 fingerprint over: the appgraph version, the serialized
`ResolvedConfig`, every file in the tsconfig chain, and the sorted (relative path, mtime) list of
**every** `project.sourceRoots` entry (not just `src/`). After a clean run it is written, with the list
of artifacts that run produced, to the `.appgraph-fingerprint` sidecar in the output directory — never
into the artifacts, so `--no-timestamp` output stays byte-reproducible. The next `--if-stale` run skips
only when the fingerprint matches, every recorded artifact still exists, and none was rewritten after
the sidecar.

**Sidecar v2.** The sidecar is one JSON line, `{schemaVersion: 2, run, graph}`, written by every run that
writes files. There are two fingerprints. The **graph fingerprint** hashes the inputs above plus the dependency
manifests and template-compiler peers, and the graph options (`--source`, `--all-sources`, `--depth`). It
leaves out the output-only options. The **run fingerprint** is `sha(graph fingerprint + formats, out, screen,
locale, timestamp, run config)`. `run: {fingerprint, artifacts, exitCode, counts}` is recorded only after a
clean run and serves `--if-stale`. `graph: {fingerprint, options, tsconfigFiles, configFile}` serves the
query commands (§14.2). A query refresh rewrites only `graph`, so `run` keeps pointing at the artifacts the
last full run wrote. The fingerprint path is TypeScript-free: the tsconfig files come from the recorded
`graph.tsconfigFiles` plus a probe of the root `tsconfig.json`. A v1 text sidecar parses as `null`, which means stale.

### 8.6 One source-root containment predicate

In the prototype, the resolver's containment test (`if (!resolved.startsWith(path.join(root, 'src'))) return null;`) is a second,
independent place that assumes `src/` — the first being the root derivation itself. A repo with
`app/` and `lib/` gets a silently empty graph.

**Rule.** Both are `project.sourceRoots`, which phase 0 derives from the tsconfig chain. There is one
containment predicate in the package, `project.contains(abs)`.

### 8.7 The index names no host script and asserts no runtime behaviour

The prototype's index emitter has two separate problems in one 105-line file:

1. `DETAIL_COMMAND = 'npx tsx scripts/<generator>.ts --route=<url> --format=detail'` embeds the *host repo's own script path* into published output. **Rule:** the
   emitted command is `npx appgraph --screen=<id> --format=detail`, built from the package's own bin
   name.
2. The `readMe` block asserts application runtime behaviour as fact:
   *"auth: protected → log in first, otherwise the route redirects to /login"* and *"flag: the route
   silently redirects to / when the feature flag is off"*. appgraph cannot know either. **Rule:** these
   lines are emitted **only** when the config declares them:

   ```ts
   readonly redirects?: {
     readonly unauthenticated?: string;   // e.g. '/login'
     readonly flagOff?: string;           // e.g. '/'
   };
   ```

   With the config present, the line is a statement of the configured fact. Without it, the hedged form
   is emitted: *"auth: protected → the screen is behind an auth guard; the redirect target was not
   configured."*

### 8.8 The project root comes from the analysed project, never the tool's location

The prototype's entry script:
`const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')`. For a published
package that resolves inside `node_modules/appgraph/dist` — fatal.

**Rule.** Root resolution order: explicit `--root` → `analyze({root})` → the config file's directory →
`process.cwd()` walked upward to the nearest directory containing a `package.json` **and** a
`tsconfig.json`. `import.meta.url` is used for exactly one thing: locating `report-assets/`, and that
read happens in the kernel (`EmitContext.asset`), not in an emitter.

### 8.9 Codepoint ordering, never `localeCompare`

Prototype occurrences: the graph builder (endpoints, navigations, the components map), the fact extractor
(endpoints, navigations), the report script (component table). `localeCompare` without an explicit locale uses the host ICU default, so the same repo on two
machines can produce byte-different YAML. That is a correctness bug in a tool whose output is
git-committed and diffed.

**Rule.** `src/core/order.ts` exports `byCodepoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)`
and every comparator in the package is built from it. `localeCompare` is banned by an ESLint
`no-restricted-syntax` rule in `eslint.config.js`, together with a companion selector for
`Intl.Collator`. The exemptions are enumerated file by file rather than globbed: `test/core/order.ts`
and three `test/parity/*` helpers call `localeCompare` deliberately, because asserting that the golden's
locale order diverges from codepoint order at index 4 requires computing both.

**Measured:** `localeCompare` ordering and codepoint ordering diverge at **index 4 of the 696 component
keys** of the reference app. This is precisely why a byte-for-byte parity gate cannot pass, and why
the gate is not byte equality, normalised or otherwise (§0.4, §12).

### 8.10 The resolver handles `nodenext` specifiers

Covered in full at §7.2 and §0.1. Summary: the prototype resolver's `CANDIDATE_SUFFIXES` appends to the
whole specifier, so `./foo.js` probes `./foo.js.tsx` and never `./foo.tsx`. Measured on the AdminJS app:
`imports resolved: 0, bindings: 0`.

**Rule.** `extensionRewrites`, configurable `candidateSuffixes`, `sourceRoots` (§7.2).
**Parity effect:** the AdminJS app gets non-empty render trees where the prototype's resolver yields
empty ones. The reference app has no `.js` specifiers, so this rule is a **no-op on the parity app** and
a **coverage floor lift on the AdminJS app** (§12.3 assertion A3).

### 8.11 `KindRule.traversable` feeds reachability

The prototype's fact extractor: `USES_DIR = /^src\/(services|stores|shared\/hooks)\//`, joined by
`HOOK_FILE = /\/use[A-Z][A-Za-z0-9]*\.tsx?$/`. Together they are the **only** producer of
`facts.uses`, and `facts.uses` is the only thing the graph builder's `collectDeep` follows beyond render
edges.

**Measured:** matches nothing in the Next.js app's `src/app/`, the TanStack app's `src/routes/` or the
AdminJS app's sources. On those three apps `reachable` degenerates to the render tree and **every route
aggregate under-reports** — silently, because the sections are thin rather than empty, so §10.3's
confidence check does not fire.

**Rule.** `KindRule.traversable` (§6.4) takes its place. It is the member of the `KindRule` family that
actually changes output on four of five apps.
**Parity effect:** `reachable` is larger than the prototype's on the AdminJS, TanStack Start and
Next.js apps. On the reference app the derived rules reproduce the hardcoded regex's traversable set,
and each screen's `reachable` is a superset of the golden's: the excess is the closure of the §6.3.1
ancestor chain, which the prototype never walks (§12.3 assertion A4).

### 8.12 Discovery-site type tests go through `unwrap`

The prototype's router reader calls `ts.isArrayLiteralExpression` on the raw router argument and the raw
`children` value while its `unwrap` — which handles exactly these cases — sits unused at those sites.

**Measured:** adding `satisfies RouteObject[]` to the host router file takes the prototype from **every
screen to 0**. `as const` does the same. Neither changes runtime behaviour.

**Rule.** The §6.2 invariant, its 15-site checklist and the wrapping-form fixtures.
**Parity effect:** none on the reference app's source (it uses neither annotation on the router array),
which is precisely why the prototype's defect went unnoticed. Asserted by the fixtures, not by the
golden.

### 8.13 The YAML emitter never produces unparseable output

Covered in full at §7.12 and §0.8. Summary: the prototype emits `k: foo:` unquoted and it does not parse; two
truncation sites can produce that shape from ordinary source; `LOOKS_NUMERIC` over-quotes;
`JSON.stringify` leaves U+2028/U+2029 raw.

**Rule.** Corrected predicate, always-quote-truncated, emit-path re-parse self-check, permanent fuzz job.
**Parity effect:** relative to the golden, a small number of scalars the prototype leaves unquoted are
quoted, and a larger number of digit-initial scalars the prototype quotes are not. This moves bytes and
no values — a failure under a byte-equality gate, and invisible, correctly, under §12's parsed-object
gate.

---

## 9. Screens, navigation, and reconciliation

### 9.1 Two sources of truth, reconciled once

Screens come from `ScreenSource.discover`. Navigation comes from `NavSource.discover`. **Neither knows
about the other.** They are reconciled exactly once, in phase 7, by matching each `NavEntry.path`
through the same `createRouteMatcher` used for navigation edges, and writing
`NavEntry.resolvedScreen: ScreenId | null`.

This separation is not tidiness: a nav config is a *claim about what the app offers*, and a screen set
is *what the app actually has*. Collapsing them destroys the ability to see them disagree — which is the
single most valuable thing a nav parse produces.

### 9.2 Dead links, reported four ways

`resolvedScreen === null` means the menu points at a URL no screen serves. The Next.js acceptance app
ships **four** such entries in its grouped nav config (§16.2). Every one is reported:

1. a `warning` diagnostic `nav/dead-link` with the nav entry's `file` and `line`;
2. a top-level `deadNavLinks` block **in the agent-facing index** — this is not optional: an agent told
   to click "Results" must know the link goes nowhere, or it will loop retrying;
3. a badge in the HTML report's Menu table;
4. under `--strict`, the `nav/dead-link` warning makes the run exit `4`, so CI fails.

A link that matches no screen directly is first resolved through the redirect rules (`resolveTarget` /
`followRedirects` in `src/core/graph.ts`), in declaration order, as Next.js does (`redirectRules` config
first, in config order, then the discovered rules in the order they were read), at most
`MAX_REDIRECT_HOPS` (5) hops. A rule's `condition` (the `c` / `!c` branch texts it was declared under,
joined with ` && `) is read as a conjunction:

- a hop whose condition contradicts one already held on the chain (`c` against `!c` or `!(c)`, by exact
  text) belongs to another deployment and does not match, so no chain mixes branches;
- several rules matching the same URL are tried in declaration order, and the first chain that reaches a
  screen wins. A later rule is skipped when an earlier match always applies first wherever the later one
  could (an unconditional rule, or one whose conditions are a subset), so a dead first branch falls
  through only to a rule for another deployment.

The result is recorded as `viaRedirect: { from, to, declaredAt?, condition? }` on the
`NavEntry`/`NavigationEdge`/`ResolvedNavigation`: `declaredAt` is the rule the link matched first, and
`condition` joins every condition held on the chain, so a deployment-specific answer says so. The emitted `redirects` list stays sorted for diffable
output; only resolution follows declaration order. Conditional (`has`/`missing`, listed with
`conditional: true`) and `/*`-like rules are excluded; `basePath` is out of scope. Rules come from `redirectRules` config and
the static `next.config` reader (`src/adapters/next-config.ts`, `array-values.ts`). See
`docs/supported-libraries.md`, Redirects.

### 9.3 Orphan screens

`orphanScreens` = addressable screens with no inbound nav edge and no inbound in-app navigation edge.
Reported at **info** severity only, never under `--strict`. Deep-linked screens (a share-token
page, an integration's confirm callback) are entirely legitimate; treating them as
errors would train users to ignore diagnostics.

### 9.4 Screen conflict resolution

Two sources can legitimately claim the same URL (a Next `page.tsx` and an AdminJS page mount at the same
path; a state-screen and a url-screen for the same component).

```ts
readonly conflicts?: 'merge' | 'first' | 'error';   // default 'merge'
```

- **`merge`** (default): collections (`activations`, `entries`, `evidence`) are unioned and re-sorted;
  scalars follow the `?:`/`null` rule of §4.3 in **contributing-source order** (the detection precedence
  order of §10.1); an `info` diagnostic `screens/merged` names every contributing source and localId,
  and `provenance.mergedFrom` records them.
- **`first`**: the first contributing source wins the whole screen; a `warning` diagnostic
  `screens/conflict-dropped` names the loser.
- **`error`**: an `error` diagnostic and the screen is kept as the first source's version.

**Same-source duplicates are always an `error`, in every mode.** A source contradicting itself is an
adapter bug and must not be papered over by a merge policy.

**Under `--all-sources` (§10.1) this machinery is what makes multi-app analysis coherent:** `ScreenId`
namespaces non-URL screens by source, and url-addressable collisions between sources route straight into
the `conflicts` policy above. Running several sources needs no further mechanism.

---

## 10. Zero-config: the phase 0 detection layer

`npx appgraph` with no config file, on a repo it has never seen, must produce a correct map. Everything
in this section runs before phase 1 and produces exactly the `ResolvedConfig` a hand-written config
would.

### 10.1 Source detection: detect ALL, report ALL, never silently pick

A "scores + fixed precedence, **highest score wins**, warn about the loser" rule fails on the acceptance
set itself:

| Measurement | Consequence under "highest wins" |
|---|---|
| The browser extension's `public/manifest.json` is a genuine MV3 manifest (scores 50) living **inside** the react-router app (scores 90) | The extension is **silently deleted** from the output. It is a real app with real screens and the tool reports it does not exist. |
| **9** `manifest.json` files under the reference app; one is a PWA manifest with no `manifest_version`; three are under build output | The MV3 probe must discriminate, and must not see build output at all |
| The Next.js app's `.next/` holds **23** extra `page.*` files on an `app/**` path | A `**/app/**/page.tsx` glob — **required**, since pages live under `src/app`, not root `app/` — reports **30 screens, 23 of them generated garbage** |
| The monorepo root fires `adminjs`, `next`, `createFileRoute` and multiple `createBrowserRouter` across many sibling apps | "Highest wins" picks one of them at random-by-score and calls it the answer |

A repo containing two apps is not an ambiguity to be resolved by a tiebreak. It is two apps.

**The rule:**

1. Run `detect` for **every** screen source. Record every result, score and evidence — including zeros.
2. Every source scoring **≥ 50** is a *live* source. All of them are reported, always, in `doctor`, in
   `meta.screenSources`, and in the run's summary output.
3. **One live source** → run it.
4. **More than one live source** → one of two behaviours, and never a silent pick:
   - **`--all-sources` (or `screenSources: [...]` in config): run them all.** Screens are namespaced by
     source. This is the design's natural shape: `ScreenId` namespaces non-URL
     screens as `screen://<sourceName>/<localId>` (§4.1), so a second source's screens have somewhere
     well-defined to live without inventing anything. URL-addressable screens from different sources at
     the same URL go through §9.4 conflict resolution, which exists for exactly this.
   - **Default: refuse and require an explicit choice.** `error project/multiple-screen-sources`, exit
     non-zero, write nothing, and print every live source with its score, its evidence at `file:line`,
     and the exact config line or CLI flag that selects it.
5. A source scoring in `[1, 50)` is reported as a *near-miss* in `doctor` and never runs on its own.

```
error  project/multiple-screen-sources
  3 screen sources matched in /repo. appgraph will not guess which one you meant.

    react-router   90   src/router.tsx:14  createBrowserRouter([...])
    state-screens  51   extension/manifest.json:2  "manifest_version": 3
    next-app      100   apps/docs/src/app/page.tsx  App Router page convention

  Pick one:            appgraph --source=react-router
  Or analyse all:      appgraph --all-sources
  Or narrow the root:  appgraph --root=./src
```

Refusing by default rather than running everything by default is deliberate: on the monorepo root the
"run them all" answer is a whole-monorepo graph nobody asked for, and the correct fix is almost always a
narrower `--root`. The error text says so.

Every `ScreenSource` exposes `detect(project) => {score, evidence[]}`. Shipped signals:

| Source | Signal | Score |
|---|---|---|
| `next-app` | `next` in dependencies **and** `**/app/**/page.{tsx,jsx,ts,js}` matches | 100 |
| `expo-router` | `expo-router` in deps **and** ≥1 route file (`.tsx`/`.ts`/`.jsx`/`.js`) under the configured root, `app/` or `src/app/` | 100 |
| `next-pages` | `next` in deps **and** a non-API page under `pages/` or `src/pages/` | 100 |
| `next-pages` (API only) | the same, but only `pages/api/**` routes | 1 |
| `nuxt` | `nuxt` in deps **and** a page under the pages directory or an `app.vue` | 100 |
| `vue-router` (file-based) | `vue-router` or `unplugin-vue-router` in deps, no `nuxt`, **and** an `unplugin-vue-router` / `vue-router/auto-routes` import or the `unplugin-vue-router` dependency, with no hand-written `createRouter` that ignores the auto routes | 100 |
| `vue-router` | the same deps **and** a file importing `vue-router` with a `createRouter(` call and a `routes` mention | 90 |
| `angular` | `@angular/core` **and** `@angular/router` in deps **and** a `provideRouter(` / `RouterModule.forRoot(` call | 90 |
| `react-navigation` | an `@react-navigation/*` dep, no `expo-router`, **and** a `create…Navigator(` call | 90 |
| `tanstack-router` | `@tanstack/react-router` or `@tanstack/react-start` in deps **and** ≥1 `createFileRoute(` / `createLazyFileRoute(` occurrence | 100 |
| `tanstack-router` (code-based) | the same deps, no file route, **and** a `createRoute` / `createRootRoute(WithContext)` call | 90 |
| `adminjs` | `adminjs` in deps **and** an `AdminJSOptions` type reference, or an object literal having both a `resources` and a `rootPath` property | 100 |
| `react-router-framework` | `@react-router/dev` or `@remix-run/dev` in deps **and** one of: a `routes.ts`, a `routes/` folder, a Remix config, a vite `reactRouter()`/`remix()` plugin call (`react-router` then scores 1) | 100 |
| `react-router` | `react-router*` in deps **and** a literal `createBrowserRouter` / `createHashRouter` / `createMemoryRouter` call | 90 |
| `react-router` (JSX / hook) | `react-router*` in deps, no data-router call, but `<Routes>` / `<Route>` / `useRoutes(` in a file mentioning `react-router` | 80 |
| `wouter` | `wouter` in deps **and** a `<Switch>` / `<Route>` element in a file importing `wouter` or `wouter/preact` | 80 |
| `state-screens` | **unconditional last resort** — always applicable, never live on its own | 1 |
| `state-screens` (MV3) | a `manifest.json` **outside the exclusion list (§10.7)** with an integer `manifest_version: 3` **and** at least one of `content_scripts` / `action.default_popup` / `background.service_worker` | 1 + 50 = **51** |
| `manifest-activation` | the same MV3 manifest surfaces (popup, service worker, content scripts) | 1 |

`state-screens` scores **1 unconditionally**, not conditionally on finding guarded top-level JSX. The
guarded-JSX probe is still run — inside the adapter — but it produces the **evidence** line, not the
score: an app whose state selection the probe cannot see is still an app `--source=state-screens`
must be able to select, and a score that vanished with the evidence would make that impossible. On an
MV3 manifest the bonus lifts it to **51**, over the live threshold, which is the one case a router-less
app is picked up with no flag at all.

`manifest-activation` scores in the **same last-resort tier**, deliberately: it reads the *same*
`manifest.json` as the MV3 bonus above, so scoring it 50 would put two live sources on every browser
extension and make a bare `appgraph` run refuse (rule 4) on every single one of them. It reaches the run
a different way — the `browser-extension` preset names **both** `state-screens` and
`manifest-activation`, so detecting the live one selects the pair. A preset companion is selected, never
live; the refusal still counts only live sources.

The MV3 signal is written that narrowly because measurement found **9** `manifest.json` files under
the reference app alone: one PWA manifest (no `manifest_version`, correctly scores 0), three under build
output (excluded before probing), and the real MV3 one. Every `**/manifest.json` glob in this document
is understood to run **after** §10.7 exclusion.

**Scores are reported, never used to pick a winner** (§10.1 rule 4). They order the *display*, size the
near-miss threshold, and break ties **within** `--all-sources` for stable ordering, by `SOURCE_PRECEDENCE`
(`src/core/sources.ts`): `next-app` > `expo-router` > `next-pages` > `react-router-framework` > `nuxt` >
`tanstack-router` > `vue-router` > `angular` > `react-navigation` > `adminjs` > `react-router` > `wouter` >
`state-screens` > `manifest-activation`.

**Rationale for the score values:** file-based sources are
unambiguous ground truth — a `page.tsx` under `app/` *is* a route, by framework contract. A code-literal
parse is a guess about which of possibly several `createBrowserRouter` calls is live. Ground truth
outranks a guess *in confidence*. It does not license deleting the other app.

**The JSX-only react-router case is read, not refused.** The adapter reads `<Routes>`/`<Route>` trees,
`createRoutesFromElements`/`createRoutesFromChildren` and `useRoutes` into the same route model as
object-literal arrays, and the case scores **80** (live). `screens/unsupported-router-style` is a
per-occurrence **warning** for what that model cannot read: `<Route>` elements built inside a
callback (`.map` over route data) and non-`<Route>` children of `<Routes>`. Routers in test, mock and
Storybook files are excluded from both detection and discovery. The full list of accepted forms is in
[supported-libraries.md](supported-libraries.md#21-react-router).

### 10.2 Zero screens: fail loudly by default, `--allow-empty` to record a true zero

An empty YAML is the worst possible artifact, because an agent will *trust it* and conclude the
application has no screens — so zero screens fails loudly. An absolute rule (throw, exit non-zero, write
nothing, ever) is not enough on its own: measurement (§0.2) shows a **type-only annotation** (`satisfies
RouteObject[]` on the router array) takes the prototype from every screen to zero. Under the absolute rule
that is a hard CI failure caused by a change that altered no behaviour, and — worse — a CI pipeline has
no way to tell it apart from "this package genuinely has no screens yet".

**Default behaviour:**

1. throw;
2. exit non-zero;
3. write **no output file** — not even a partial one, and never over an existing good one;
4. print the full diagnostic trace: resolved root; every live source and its evidence; every glob and
   probe attempted with match counts; up to **5 near-miss files** (matched a glob, failed a content
   probe) naming the probe that failed; and **every discovery-site `unwrap`
   checklist entry (§6.2) that saw a wrapped node**, because that is the single most likely cause.

**With `--allow-empty`:**

1. still **exit non-zero** and still print the full trace — nothing about the failure signal is softened;
2. **write exactly one artifact**, and mark it unambiguously:

   ```yaml
   meta:
     schemaVersion: 2
     emptyResult: true
     emptyReason: "no screen source produced a draft"
     screenSources: [react-router]
   screens: []
   ```

   `meta.emptyResult` is a **required marker on any zero-screen artifact** and is absent on every
   non-empty one, so `emptyResult: true` is a single greppable token. The index emitter additionally
   emits a `readMe` line stating in prose that this file records a zero-screen result and is not
   evidence the application has no screens.

**Why this is safe, and it is only safe because of §6.2.** Failing loudly on zero screens stops a
*broken* tool from producing a confident empty map. The dominant way the prototype breaks silently is
discovery-site type tests bypassing `unwrap` — one token, thirty-four screens, no error. With the
`unwrap` invariant held at every discovery site and pinned by the wrapping-form fixtures, that failure
class is closed, and a zero result is far more likely to be a true zero. **Rule (b) is downstream of
rule (a).**

`--allow-empty` never suppresses the non-zero exit. A pipeline that wants to *tolerate* zero screens
must check `meta.emptyResult` itself and decide — which is the whole point: the tool reports, the
pipeline judges.

### 10.3 `meta.confidence` per section

For every fact channel, phase 7 records `SectionConfidence` (§4.6). The hard rule:

> **Any section that yields zero facts while its enabling dependency is installed is a warning.**

`zustand` in `dependencies`, zero stores found → `warning confidence/empty-section`. The mapping from
channel to enabling dependency is declared by the extractor
(`FactExtractor.enablingDependency?: string`).

A section's dependencies are the union over **every** extractor that provides it, and a
section with an always-on provider (one with no `enablingDependency`, e.g. `http-client` for
`endpoints`) is never "suspect" as a section. A second warning covers an extractor whose own library is
installed yet which produced nothing while sibling extractors filled all its sections (a Convex app
whose endpoints all came from axios). Extractors are not gated automatically by detected libraries:
gating could silently drop facts, and measurement shows no speed-up worth that risk. `extractors` in
`appgraph.config` is the explicit override.

### 10.4 `appgraph doctor`

Writes nothing. Prints:

- resolved root and how it was resolved;
- the tsconfig chain, in order, with the merged `baseUrl`, `paths` and `include`;
- derived `sourceRoots`;
- **every** `ScreenSource.detect` result: name, score, evidence with file:line — including near-misses,
  and marked *live* (≥ 50) or not. Nothing is a "loser" (§10.1);
- the resolved `extensionRewrites`, `candidateSuffixes` and how they were derived (§7.2);
- the **exclusion list** in force, every directory skipped by it, every file skipped as generated with
  the rule that matched, and every symlink not followed (§10.7);
- every dependency specifier that used the `npm:` alias form, with its parsed alias target and range;
- every glob attempted and its match count;
- the **test-id attribute histogram** (§10.5) in full;
- nav candidates with their scores, including those below the 0.5 threshold;
- the dependency union entries that mapped to a fact extractor.

Detection that cannot be inspected cannot be trusted or bug-reported. `doctor` is the first thing an
issue template asks for.

### 10.5 Deriving defaults from the host project

**Source roots and `KindRule[]`.** From the tsconfig chain: `include` patterns, `baseUrl`, and **all**
`paths` targets. Each distinct first path segment of a `paths` target becomes a source root; each
`paths` key becomes a `KindRule` seed. Directory-name conventions layer on top with lower priority:
`modules|features|pages|screens|views` → `module` (`screenEntry: true`); `layouts` → `layout`;
`components|ui` → `ui`; `services|api` → `service` (`traversable: true`); `stores|state` → `store`
(`traversable: true`); `hooks` → `hook` (`traversable: true`); `shared|common|lib|utils` → `shared`;
`routes` → `shared` with `screenEntry: false`.

**Test-id attribute.** Probe which of `data-testid`, `data-test`, `data-cy`, `data-qa` actually occurs
in the source roots, record the **full occurrence histogram** as evidence, and pick the most frequent.

> **Four of the five acceptance apps have ZERO test-id attributes.** When none is found, the emitted
> index must state plainly: *"this repository declares no test-id attributes; select elements by role
> or visible text."* It must **never** fabricate selector guidance, and it must never emit an empty
> `testIds: []` with no explanation, because an agent reads that as "I have not been told" rather than
> "there are none".

**Library detection.** Query/store/i18n/forms/http libraries come from the dependency union across
every `package.json` in the root and in each source root's nearest ancestor. `@tanstack/react-query` →
`query` extractor; `zustand`/`jotai`/`valtio` → `stores`; `react-i18next`/`next-intl` → `i18n`;
`react-hook-form` → `forms`; `axios`/`ky`/`got` → `http`. A validator (`zod`, `yup`, `valibot`) is a
companion only: it never implies a form on its own, because the same schema library validates API
payloads.

The list of detected packages, and which of them the fact extractors actually read, is in
[supported-libraries.md](supported-libraries.md#5-detection-vs-extraction-matrix).

### 10.6 Nav auto-discovery by scoring

For every **array-of-object-literals** and every `Record<…, object>` in the source roots:

1. take the first property named in `['path','to','href','url','route','link']`;
2. flatten its value with `flattenString`;
3. recurse into **array-valued properties** of each element, so grouped configs
   (`routeGroups: [{label, items: [...]}]`) are flattened;
4. score = **share of flattened elements whose value resolves to a known screen**.

**Keep every candidate scoring ≥ 0.5, each with its score visible in the output.** A sidebar and a
topbar are both legitimate navigation; merging them loses which is which, and picking one throws away
half the map.

The label field is the first present of `['title','label','menuLabel','labelKey','name','text']`. When
the chosen field's value does not flatten to a literal (an i18n key expression, a component), it is
recorded as `labelKey` rather than `label`.

> Rejected: require the user to name the menu export. That is precisely the hardcoded menu-export
> default that makes the prototype single-app.

### 10.7 Filesystem walking: exclusions, generated files, symlinks, `npm:` specs

**This section is load-bearing, not hygiene.** Every rule below is forced by a measurement on the
acceptance apps, and each failure it prevents is silent — a plausible-looking map with wrong contents.

#### Directory exclusion list (mandatory, applied before ANY glob or probe)

```
node_modules/   .next/   dist/   build/   builds/   .output/   .vercel/
out/   coverage/   storybook-static/   .turbo/   .cache/   .git/
```

**Measured:** the Next.js app's `.next/` contains **23** `page.*` files on an `app/**` path. The
`next-app` glob **must** be `**/app/**/page.{tsx,ts,jsx,js}` and not `app/**/page.tsx`, because pages
live under `src/app`, not root `app/` — and that broader glob is exactly what makes `.next/` fatal:
**30 screens reported, 23 of them generated garbage.** Three of the reference app's nine `manifest.json`
files are likewise build output.

The list is a **default**, extendable via `exclude` in config, and **never** reducible below
`node_modules/` and `.git/`. `doctor` prints it.

**Four more rules sit on top of the list** (`core/project.ts`, `core/ignore-rules.ts`,
`core/ignore-build-dirs.ts`), and `doctor` prints each with its reason:

- **every dot-directory** (`.storybook/`, …) — measured: built Storybook assets under a
  dot-directory otherwise surface as detection near-misses;
- the default names also include `.claude`, `.idea`, `.nuxt`, `.svelte-kit` and `.vscode`;
- **Next `distDir`**: a string-literal `distDir` in `next.config.{js,mjs,cjs,ts,mts}` at the project root
  (both branches of a ternary) is excluded at that path; a computed value contributes nothing;
- **`.gitignore`**: `.git/info/exclude`, every `.gitignore` from the git root down to the project root,
  and nested `.gitignore` files below it, read by a parser-only implementation of gitignore(5). Git is
  never spawned and the index is never read, so a *tracked* file matching an ignore pattern is treated as
  ignored.

An excluded directory excludes its whole subtree; the verdict is computed top-down and cached per
directory.

#### Generated-file detection (applied to files that survive the directory exclusion)

A file is treated as generated — skipped for discovery, skipped for facts, never a screen entry — when
any of:

1. its basename matches `*.gen.ts`, `*.gen.tsx`, `*.generated.*`, `*.g.ts`;
2. **its first 5 lines contain both a `@ts-nocheck` / `eslint-disable` directive and a generated-by
   marker** (`/generated|auto-?generated|do not edit|DO NOT EDIT/i`). Both conditions, not either: a
   lone `@ts-nocheck` is a human decision, and a lone "generated" in a comment is a coincidence;
3. it is listed in `config.generated`.

**Measured:** the TanStack app's `src/routeTree.gen.ts` is **2,251 lines** matching rules 1 and 2. It duplicates
every one of the 101 routes; parsing it doubles every screen. This is a project-wide rule, not a
per-adapter skip of that exact filename (§16.3), because the next stack will generate a
differently-named file.

A generated file is still **listed** in `doctor` with the rule that matched, so a false positive is
diagnosable rather than mystifying.

#### Symlinks: do not follow, ever

The filesystem walker (`FileHost`, `src/core/host.ts`) uses `withFileTypes` and **skips any entry where
`isSymbolicLink()` is true**, recording it in `doctor`'s trace. It does not stat-through, and it keeps no
visited-inode set, because not following is simpler and strictly sufficient.

**Measured:** the TanStack app's `node_modules` contains **46 pnpm symlinks** that can form cycles. pnpm's store
layout makes symlink loops the normal case, not an edge case, and `node_modules/` exclusion alone is not
protection — a `packages/*` workspace symlink sits outside it.

#### `npm:` alias version specifiers

**Measured:** **every** acceptance host pins `"typescript": "npm:@typescript/typescript6@^6.0.2"`. Any
code that reads a dependency *version* sees the literal string `npm:@typescript/typescript6@^6.0.2`.

Rules:

- **Dependency presence** (`ProjectContext.hasDependency`, the §10.5 library detection, the
  `enablingDependency` check) keys on the **manifest key**, never on the value. `typescript` is present
  because the key `typescript` exists. This must stay correct.
- Any code that must read a version parses the `npm:` form first: strip a leading `npm:`, then split the
  remainder on its **last** `@` to separate the aliased package name from the range, so
  `@typescript/typescript6@^6.0.2` yields `@typescript/typescript6` and `^6.0.2`. A specifier with no
  `@` after the name has no range and is treated as `*`.
- `doctor` prints both the declared specifier and the resolved alias target, because "which TypeScript
  is this actually" is the first question when §5.6's realm problem bites.

---

## 11. Determinism

Every rule here is mandatory. Output YAML is committed to git and diffed by humans and CI.

1. **Codepoint comparison everywhere.** `core/order.ts::byCodepoint` is the only string comparator.
   `localeCompare` is banned by lint. (§8.9)
2. **Globs are sorted** by codepoint before use, at the `ProjectContext.glob` boundary, so filesystem
   enumeration order never reaches the output.
3. **No timestamps in YAML.** The generation timestamp exists only in the HTML report, and
   `--no-timestamp` removes it there too — not so a golden can assert the HTML (it cannot; §12.6), but
   so two runs in one process can be compared for determinism. YAML is byte-stable and git-diffable by
   construction. Measured motivation: the prototype's entry script puts `new Date().toISOString()`
   straight into the HTML.
4. **No reliance on `Map`/`Set` iteration order.** Insertion order is a valid intermediate, never a
   final ordering. Every collection is explicitly sorted before it enters an `EmitFile`.
5. **No absolute paths in output.** Every path is relative to `project.root`, POSIX-separated
   (`split(path.sep).join('/')`, preserved from `resolver.relative`). `meta.root` is a **label**
   (the root directory's basename), not a path.
6. **Explicit re-sort at aggregation.** Phase 7 re-sorts every array in the `AppGraph` even when the
   producer claims to have sorted it. An adapter cannot break determinism by forgetting.
7. **Stable adapter order.** The registry orders adapters by `(detectionPrecedence, name)`, never by
   registration or filesystem order. Under `--all-sources` this is also the order screens are namespaced
   and emitted in.
8. **No randomness, no `Date.now()`, no `process.hrtime`** anywhere outside the CLI's own progress
   logging, which never reaches an artifact.
9. **No symlink following, and a fixed exclusion list** (§10.7). Filesystem *shape* must not reach the
   output any more than filesystem *order* does; a pnpm store symlink is not part of the app. Measured:
   the TanStack app's `node_modules` holds 46 pnpm symlinks that can loop.

---

## 12. Parity

### 12.1 The frozen goldens

The prototype's three YAML outputs — the full map, the agent index and one single-screen detail file —
are frozen as a baseline directory, together with a snapshot of the prototype's source and a
`MANIFEST.md` that records their checksums and counts.

**The golden lives OUTSIDE this repository and is never committed to it.** The target app it was
produced from is private, so `test/golden/` is not part of the library. The parity suite locates the
baseline directory through the `APPGRAPH_PARITY_GOLDEN` environment variable, or — when that is unset —
through the gitignored pointer file `test/parity/golden.local`, which contains the path to it.

The application checkout is named the same way: `APPGRAPH_PARITY_FIXTURE`, or the gitignored pointer file
`test/parity/target.local` (`vitest.config.ts` forwards both files' trimmed content into the test
workers). `parsePointer` (`test/parity/target.ts`) accepts a bare path or a JSON object
`{ "root": "/abs/path", "commit": "<sha>", "config": { "stringSources": [...], "kindRules": [...] } }`.
`commit` is the application commit the golden describes, and `config` is the target-specific half of the
pinned config (§12.4); both describe the private application, so they live on the untracked side next to
the path. `config` goes through the same field-by-field validation as a user's config file, and any issue
or unknown field is an error. The suite measures only a checkout whose `HEAD` is exactly that commit
(`pinMismatch`): a bare path, or a checkout at another commit, fails the suite with the
`git worktree add --detach` command that creates a pinned worktree, because application drift would
otherwise read as appgraph regressions.

When the target or the golden is absent the parity suite is reported as skipped, with the reason in its
name, rather than failing; the gates of §12.3 run for whoever has both, and the rest of the test suite is
unaffected. The same gate machinery also runs in CI against a committed synthetic app
(`test/parity/fixture.test.ts`), which supplies its own target-specific config (`fixture/mini-app.ts`).

**The HTML output is deliberately not among them** (§12.6): the prototype's
entry script embeds `new Date().toISOString()`, so it is non-deterministic by
construction and is not a viable golden.

Baseline counts, from `MANIFEST.md`:

| metric | value |
|---|---|
| routes | 30 (+ 4 redirects; the `routes:` array holds all 34) |
| components | 696 |
| render edges | 689 |
| navigation edges | 28 |
| endpoints | 335 |
| menu items | 12 |
| tree nodes with a non-empty `conditions` array | 280 |
| tree nodes with `repeated: true` | 62 |
| files with a non-empty `nullGuards` array | 57 |
| shells | 3 — the conventional root, wrapper and login layouts |

### 12.2 Why the gate does not assert byte equality

A gate that runs with a pinned config, normalizes, and asserts **byte equality** with the frozen golden —
with a list of dozens of fields asserted for exact equality — **cannot pass, and cannot be made to pass
without destroying itself**:

- **Measured:** `localeCompare` ordering and codepoint ordering diverge at **index 4 of the 696
  component keys**. The golden is produced with `localeCompare` (in the prototype's graph builder); decision #7/§8.9
  mandates codepoint. Byte equality is therefore false on line 5 of the components map, by design.
- The obvious repair — have the normalizer re-sort both sides — **removes the gate's ability to detect
  ordering regressions**, which is the exact property the codepoint sort exists to guarantee. A gate
  that must be blinded to the thing it is testing is not a gate.
- Most §8 rules change counts, so a byte-equality assertion would be false in many different ways. An
  accepted-diff list (`expected-diff.md`) would be a list of exceptions to a rule that has no
  non-exceptional cases.
- **Measured:** the prototype's entry script embeds `new Date().toISOString()` in the
  HTML, so the **HTML golden is non-deterministic by construction** and cannot be asserted at all.

What follows asserts the properties that actually matter, each one falsifiable on its own.

### 12.3 The four gates

All four run against every acceptance app that has a golden (§12.1). Gates 1, 2 and 4 live in
`test/parity/gates.ts`, gate 3 in `test/parity/assertions.ts`.

#### Gate 1 — Set equality on the agent-facing contract

Assert **exact set equality** (not ordering, not byte layout) on:

| Field | Shape on the reference app |
|---|---|
| the set of screen URLs | one short string per screen |
| per screen, `entries[0]` | one relative path |
| per screen, `params` | one short list |
| per screen, `auth` | one enum value |
| per screen, `redirectTo` | one nullable string |

This is **one row of short strings per screen, which a human reviews by eye in under a minute**, and it is precisely the
contract an agent depends on: *what can I navigate to, what does it need, will it bounce me*. A
regression here is a product regression. A regression anywhere else is a coverage regression, which
gate 2 handles.

Ordering is deliberately **not** asserted here — §11's determinism rules are tested separately, by
running the same analysis twice in one process and once in a fresh process and comparing bytes. Mixing
"is the content right" with "is the order stable" is what makes a byte-equality gate circular.

#### Gate 2 — Monotonic coverage floors

For every screen, assert:

```
screen.reachable.length  >= golden.reachable.length
screen.endpoints.length  >= golden.endpoints.length
screen.testIds.length    >= golden.testIds.length
screen.facts.stores.length, .queryKeys.length, .i18nNamespaces.length,
  .formSchemas.length, .formFields.length, .featureGates.length  >= golden
```

**The insight this encodes:** every rule in §8 either *adds* coverage (§8.2 navigations, §8.3
entryless routes, §8.4 tsconfig, §8.10 resolver, §8.11 traversable) or is neutral. A rule that *removes*
coverage must say so explicitly as a gate-3 assertion. Everything else is a floor. This means a fix
lands without anyone hand-maintaining a diff list, while a change that silently drops render edges,
endpoints or selectors **fails immediately** — which is the regression class that actually hurts an
agent.

Floors are **ratcheted**: when a fix raises a number, the golden's number is raised in the same commit,
so the floor only ever goes up. A deliberate lowering requires a gate-3 assertion and a one-line
justification in the commit message.

The one rule that legitimately reduces a count — §8.1's endpoint binding table, which deletes phantom
`someMap.get('/x')` endpoints — is handled entirely by gate 3.

#### Gate 3 — One named, falsifiable assertion per known bug fixed

Each rule in §8 has **one named assertion in `test/parity/assertions.ts`**, stating a specific
observable fact that is false before its fix and true after. Not a diff list — a claim. App-specific
values (route names, module paths, endpoint URLs) are read from `expectations.json`, which sits with the
golden; the assertions themselves name no application.

| ID | Rule | Assertion |
|---|---|---|
| A1 | §8.1 endpoints | No golden endpoint disappears: every `.get\|post\|put\|patch\|delete('/…')` receiver on the parity app is a genuine HTTP client, so its phantom-endpoint set is empty. |
| A2 | §8.2 `useNavigate` | Binding-resolved `navigate()` retains every golden navigation edge and never lowers the count. |
| A2b | §8.2 aggregation | `via` is part of a navigation edge's identity: a shell file and a page file that navigate the same screen to the same target produce **two** edges, so the shell's cannot shadow the page's. |
| A3 | §8.10 resolver | On the AdminJS app, its options module resolves **≥ 1** import (the prototype: 0) and every resource screen has `reachable.length ≥ 1` (the prototype: 0). |
| A4 | §8.11 `traversable` | On the reference app, every screen's `reachable` length is **≥** the golden's and at most the size of the component map: the derived rules lose nothing the hardcoded `USES_DIR` reached, and the excess is the closure of the §6.3.1 ancestor chain, which the prototype never walks. `a4Traversable` still states the equality form and is wired as an expected failure under `SPEC-A4-MISREADS-ANCESTOR-REACHABLE` (`test/parity/known-gaps.ts`); the superset check is the passing assertion. |
| A5 | §8.3 entryless | The four zero-entry URLs are **present** in `screens` and each carries its golden `redirectTo`: they are redirects, not entryless routes, so no `entryless` kindTag is expected. |
| A5b | §8.3 pathless | At least one pathless layout route is retained as a non-addressable screen. |
| A5c | §8.3 entryless tagging | A route with no element, no `lazy` and no redirect is retained and tagged `kindTag: 'layout' \| 'entryless'` (committed fixture only; the parity app has no such route). |
| A6 | §6.3.1 ancestors | On the TanStack Start app, **≥ 98** screens have `auth: 'protected'` sourced from the pathless `_authed.tsx` layout route and a non-null `shell` (the prototype: `shells` is `{}` and 98 screens report no shell). |
| A7 | §6.3.2 sub-file roots | On the browser extension, its content-script component yields **exactly 5** screens with **5 pairwise-different** trees (the prototype: 5 byte-identical trees). |
| A8 | §5.4 masking | On the browser extension, no screen's `testIds` contains any selector declared inside `DevStatesPreview`. |
| A9 | §10.5 test-ids | A witness screen has `testIds.length ≥ N`, with the screen and `N` pinned from the golden. |
| A10 | §8.13 YAML | At least one YAML document is emitted, and every emitted YAML document re-parses with the independent reader `test/parity/yaml-read.ts`. Runs only when the emitted files are passed in. |
| AORD | §8.9 ordering | The golden's component keys are in `localeCompare` order, appgraph's are in codepoint order, and the two orders first diverge at index 4 of the golden's key list. |
| ATEST | §10.7 exclusions | No `*.test.*` / `*.spec.*` / `*.stories.*` / `*.d.ts` file is a screen entry or a component-map key. |

A3, A6, A7 and A8 assert on other acceptance apps and belong with those apps' goldens; the parity suite
lists them, together with A5c (fixture only), in `NOT_APPLICABLE_HERE`. `runAssertions` runs A1, A2, A2b,
ATEST, A4, A5, A5b, A9, A10 and AORD, in that order.

An assertion is written **before** its fix, must **fail** on the pre-fix build, and is kept forever. A
fix without a named assertion does not merge.

#### Gate 4 — Compare parsed objects with sorted keys, never text

The gate **parses both sides** (`test/parity/yaml-read.ts`, a reader independent of the emitter) and
compares the resulting object graphs with keys sorted by codepoint at every level. It never diffs text.

This kills the ordering-versus-content confusion permanently: gate 4 answers "is the content the same",
and only the dedicated determinism test answers "is the order stable". A byte-equality gate makes those
two questions share one assertion, so fixing either one breaks the other.

Consequence: §8.13's quoting differences — some scalars gain quotes, more digit-initial scalars lose
them — are **invisible to the gate**, correctly, because no value changes.

### 12.4 The zero-config == pinned-config stage

**The most valuable single test in the suite.**

Run appgraph twice against the same app:

1. **pinned** (`runPinned`, `test/parity/pinned.ts`): the generic half, `PINNED_BASE` — formats
   `full`/`index`/`html`, depth 3, `screenSources: ['react-router']`, `sourceRoots: ['src']`,
   `testIdAttribute: 'data-testid'` — plus the prototype's wrapper rules as wrapper roles
   (`DEFAULT_WRAPPER_RULES`, passed as adapters because there is no config key), merged with the
   target-specific half: the string sources and the first-match-wins kind rules from the target pointer's
   `config` (§12.1);
2. **zero-config** (`runZeroConfig`): `analyze({ root })` and **nothing else**.

Assert the two `AppGraph`s are equal under gate 4's parsed comparison.

Two prototype inputs cannot be pinned, because `AppgraphConfig` has no key for them: the **router file**
(the react-router source globs for `createBrowserRouter`, so naming the source pins which source runs,
not which file it reads) and the **menu source** (both runs find the menu by nav scoring). The comparison
is therefore blind on those two axes, and the menu is asserted separately against the golden's items.

> This proves detection independently reproduces every value the prototype had to be told. If it
> diverges, the zero-config layer is not done, regardless of how good the other gates look.

### 12.5 `--compat=prototype` is rejected

A compatibility mode would mean shipping the phantom endpoints and the locale-dependent sort *forever*,
keeping two code paths through the hottest part of the engine, doubling the golden set, and — the
decisive reason — it would let appgraph claim parity while knowingly emitting wrong data. Parity is a
*migration tool*, not a *feature*. Gate 3's named assertions are the honest version of the same
reassurance, and they beat accepted-diff files because a claim can be falsified and a diff list cannot.

### 12.6 The HTML is excluded from goldens

**Measured:** the prototype's entry script passes
`new Date().toISOString().slice(0,16)` into `toHtml`. The HTML golden is **non-deterministic by
construction** — it differs from itself on every run, at minute granularity.

Fixing this with `--no-timestamp` and then asserting the HTML byte-for-byte is possible but not worth
it: the HTML is a **human** artifact whose entire content is a rendering of the `AppGraph` that gates
1–4 already assert. Byte-asserting it means every CSS tweak, every colour-palette index shift and every
string-table change breaks the parity gate for reasons that have nothing to do with analysis
correctness — training everyone to regenerate the golden without reading it, which is how goldens stop
working.

**What is asserted about the HTML instead:**

- it is produced without throwing, for every acceptance app;
- payload tests (`report-payload.ts`): the embedded JSON round-trips and cannot break out of its `<script>`;
- the template contract (`test/emit/report-template.test.ts`): exactly four placeholders, the size budget, no network references;
- UI component and hook tests (vitest `ui` project, jsdom) cover rendering, hotkeys, tabs and the URL hash;
- Playwright e2e (`pnpm e2e`, `file://`, chromium) drives the built report;
- every `kind` and every HTTP method observed in the graph has a corresponding CSS custom property
  (§14.4's de-hardcoding, testable without byte comparison);
- under `--no-timestamp`, two runs in the same process produce identical bytes — a determinism check,
  not a golden.

`--no-timestamp` exists in the CLI for exactly that last check and for users who commit the report.

---

## 13. Non-goals for v0.1

A static analyser that quietly produces a wrong map is worse than one that stops. Most of these are
therefore **refused loudly with a diagnostic**.

Rows marked "documented limitation, no specific diagnostic" have no dedicated refusal because nothing
detects them: such a repository matches no screen source and ends at `project/no-screen-source` (or, in
a monorepo, at `project/multiple-screen-sources`). A promised-but-absent refusal is exactly the failure
this section exists to prevent, so every code in the table has an emit site, and
`test/core/diagnostic-codes.test.ts` asserts the `DIAGNOSTIC_CODES` registry and the emit sites agree in
both directions.

| Non-goal | Diagnostic code |
|---|---|
| react-router `<Route>` built inside a callback, or a non-`<Route>` child of `<Routes>` (JSX routes themselves are read) | `screens/unsupported-router-style` (warning) |
| React Router v7/v8 framework mode / Remix v2 routes defined in code through the Remix `routes` config option | `screens/dynamic-registry` (warning); `routes.ts` and the flat-file convention are read by the `react-router-framework` source ([supported-libraries.md §2.9](supported-libraries.md#29-react-router-framework-mode-and-remix-v2)) |
| Next interception whose target is not found or climbs above `app` | `screens/unsupported-next-convention` (warning); parallel and intercepting routes are otherwise modelled ([supported-libraries.md §2.2](supported-libraries.md#22-nextjs-app-router)) |
| Next interception outside a slot, an unmatched slot page, an `@slot` without a layout | `screens/unsupported-next-convention` (info) |
| `next.config` `redirects()` entries that cannot be read statically | `nav/redirect-unreadable` (warning, one per config file) |
| Non-React frameworks (Vue and Angular are supported; Svelte, Solid) | documented limitation, no specific diagnostic — falls through to `project/no-screen-source` |
| Monorepo cross-package graphs in one run | documented limitation, no specific diagnostic — run appgraph per package, or narrow with `--root` |
| Anything needing the TypeChecker (cross-file type flow, inferred types) | `facts/needs-typechecker` (info) |
| Condition **evaluation** — guards stay texts | documented limitation, no diagnostic |
| Runtime / dynamic component registries | `screens/dynamic-registry` (info, per occurrence) |
| i18n **key** extraction — namespaces only | documented limitation |
| Watch mode | not implemented; `--if-stale` covers the incremental case |
| **Third-party plugins of any kind** | no mechanism exists; see §5.9 |
| **Plugin auto-discovery from package.json** | not implemented, deliberately |
| Analysing a whole monorepo in one run | `project/multiple-screen-sources` — narrow `--root` or `--all-sources` (§10.1) |
| JS-only projects with no tsconfig | `project/no-tsconfig` (error): the run analyses without path aliases or `baseUrl`, writes its artifacts and exits `1` (§8.4) |

**On third-party plugins in 0.1:** there is no plugin API, so the question does not arise (§5.9). It
returns at 0.3.

**On plugin auto-discovery specifically — a permanent no, whenever the API does arrive:** a static
analyser that scans `dependencies` for `appgraph-plugin-*` and `import()`s whatever it finds is a
supply-chain footgun — it turns "I installed a transitive dep" into "I executed its code during my
build". Plugins will be listed explicitly in `appgraph.config.ts` or they will not run.

---

## 14. Emitters, CLI and the HTML report

### 14.1 Formats

| Format | Emitter | Output |
|---|---|---|
| `index` | `yaml-index` | `appgraph.index.yaml` — the agent index (8.7–42.9 KB measured across the five acceptance apps; 18.6 KB on the reference app). **Default.** |
| `html` | `html` | `appgraph.html` — self-contained report. Its tree payload is interned (`paths`, `subtrees`, refs) and rehydrated by the UI. **Default.** |
| `graph` | `graph` | `appgraph.graph.json` — the graph cache the query commands read. The CLI always appends it. |
| `full` | `yaml-full` | `appgraph.yaml` — the whole `AppGraph`. Opt-in. |
| `detail` | `yaml-detail` | `appgraph.<slug>.yaml` — one screen; requires `--screen` |
| `all` | — | `full` + `index` + `html` + `graph` |

`DEFAULT_FORMATS` (`src/config/types.ts`) is `["index", "html"]`.

**Full YAML v2.** `yaml-full` interns the render trees of every screen and shell. A subtree with at least 3
nodes that occurs at least twice moves to a top-level `subtrees:` map keyed `t<n>`. Each occurrence becomes
`{ref: t<n>}`. Tree fields equal to `TREE_DEFAULTS` (`src/emit/tree-intern.ts`: `conditions: []`,
`alwaysRendered: true`, `repeated: false`, `nullGuards: []`, `children: []`, `truncated: false`,
`repeat: false`) are omitted. One table drives both omission and hydration. The hash-consing is post-order,
and its ids are first-seen in a fixed traversal, so the output stays deterministic. `docs/agents.md` documents
the shape for readers.

**Graph cache.** `src/emit/graph-cache.ts` encodes `{format: "appgraph-graph", schemaVersion: 2,
appgraphVersion, paths, subtrees, graph}`. Every tree node is interned (thresholds 1/1). Node `file` and
`screen.reachable` are indexes into `paths`. The cache carries no timestamp and no fingerprint, because
freshness lives in the sidecar (§8.5). The CLI writes it through the same staged atomic writer as the other
artifacts, on every exit except a usage error, a refusal or a zero-screen result without `--allow-empty`.

`slugOf` is preserved: `url.replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-|-$/g,'') || 'root'`.

### 14.2 CLI surface

> **Spec vs 0.1.0.** Four flags below are marked `PLANNED` and **are not implemented in
> 0.1.0**: `--no-test-ids`, `--no-verify-emit`, `--dry-run` and `--explain`. `src/cli/args.ts`
> is the implemented surface, and the README's flag table mirrors it. Every other flag listed
> here exists.

The CLI is a set of subcommands defined in one registry, `COMMAND_SPECS`
(`src/cli/commands.ts`). The registry drives commander, the per-command `--help`, `appgraph schema`, and
the docs-drift test (`test/docs/agent-docs.test.ts`). `analyze` is the default command, so a bare
`appgraph [flags]` analyses. `doctor` takes only the project and graph flags plus `--json` and `--timing`.
The query commands are `screens`, `screen`, `links`, `search`, `components`, `menu`, `findings`, `stats`
and `usages`. They read `appgraph.graph.json`, re-analyse with formats `["graph"]` when the graph
fingerprint changed, and honour `--cached` (exit `6` instead of analysing), `--limit`, `--offset`,
`--fields` and `--json`. `glossary` and `schema` read no graph. The reference for every command, option and
output field is `docs/agents.md`. The block below is the flag list for the analysis command.

```
appgraph [options]
  --root <dir>            Project root (default: nearest ancestor with package.json + tsconfig.json)
  --config <file>         appgraph.config.ts (default: <root>/appgraph.config.ts if present)
  --format <f>            all | full | index | detail | html | graph    (default: index + html; graph always)
  --screen <id>           Restrict output to one screen (required for --format=detail)
  --source <name>         Force one screen source, bypassing detection
  --all-sources           Run every detected source; screens namespaced by source (§10.1)
  --allow-empty           On zero screens, still exit non-zero but write a marked
                          `screens: []` artifact with meta.emptyResult: true    (§10.2)
  --depth <n>             Render tree depth                             (default: 3)
  --out <dir>             Output directory                              (default: docs/appgraph)
  --no-test-ids           PLANNED (not in 0.1.0) Index carries test-id counts, not full lists
  --no-timestamp          Omit the HTML generation timestamp (determinism check, §12.6)
  --no-verify-emit        PLANNED (not in 0.1.0) Skip the YAML re-parse self-check (§7.12).
                          The self-check always runs in 0.1.0.
  --if-stale              Skip when the fingerprint matches the previous run
  --dry-run               PLANNED (not in 0.1.0) Compute everything, write nothing, list the
                          files that would be written. The `analyze()` API covers this case:
                          it performs no writes.
  --strict                Non-zero exit (4) on any warning diagnostic
  --explain <screenId>    PLANNED (not in 0.1.0) Print the derivation chain for one screen and
                          exit — see §14.3. `provenance` is emitted; only the printer is absent.
  --locale <en|pl>        HTML report locale
  --json                  One machine-readable object on stdout; all prose to stderr
  --timing                Per-phase durations (ms) to stderr; adds a `timing` object to --json output
  --quiet
appgraph doctor           Print the full detection trace; write nothing
appgraph <query> …        screens | screen | links | search | components | menu | findings | stats | usages
appgraph glossary | schema
```

### 14.3 `--explain` — PLANNED, not implemented in 0.1.0

The data this section depends on (mandatory `provenance`, per-diagnostic origin stamps,
serialized locators) all ships in 0.1.0; the flag and its printer do not. `appgraph doctor`
covers the detection half. The rest of this section is the spec for the printer.

Prints, for one `ScreenId`:

1. every `ScreenSource` that contributed, in contribution order, with its `localId`;
2. every `Evidence` record (`what`, `file:line`) that produced the draft;
3. every field, with the source that supplied it and whether it was "present", "asserted null" or
   "fell through";
4. every `provenance.decisions` line (merge decisions, conflict resolutions, activation canonicalisation);
5. the entry resolution chain: `EntryRef` → module specifier → **every `extensionRewrite` and candidate
   suffix probed, in order** → declaration file after barrel chasing. This is the trace that makes a
   failure like §0.1's `imports resolved: 0` on the AdminJS app obvious in seconds instead of requiring a measurement;
6. the **ancestor chain**: each `AncestorRef` in order, its `splice` mode, the file:line of the splice
   point that was found (or the `walk/no-splice-point` / `walk/ambiguous-splice` decision and every
   candidate considered);
7. the **sub-file root**, if any: the `NodeLocator`, the node it resolved to, and the guard text that was
   clamped off into `activation.expr` (§6.3.2);
8. the tree root and the first level of children with their guard texts;
9. every masked subtree (§5.4) with its reason and the channels suppressed.

With adapter-supplied screens, "which adapter produced this wrong row?" is the first question every bug
report asks. `--explain` plus mandatory `provenance` and per-diagnostic origin stamps is the
non-optional mitigation. Adding it after it hurts is exactly how you end up unable to debug the tool.

### 14.4 De-hardcoding the HTML report

The prototype's stylesheet styles `.kind.module`, `.kind.ui`, `.kind.hook`, `.kind.service`,
`.kind.store` — **5 of the 9 built-in kinds** — and `.chip.method-get`, `.method-post/put/patch`,
`.method-delete`. An adapter introducing a kind, or a repo using `HEAD`/`OPTIONS`, gets unstyled rows.

**Rule.** The emitter walks the graph, collects the observed kind set and the observed HTTP-method set,
sorts both by codepoint, assigns colours from a fixed palette by index, and emits them as CSS custom
properties in a `:root` block:

```css
:root { --kind-color-module: …; --kind-color-ui: …; --method-color-get: …; }
.kind { background: var(--kind-color-, var(--kind-color-fallback)); }
```

Colour assignment is deterministic (index into a fixed palette, wrapping), so the HTML is byte-stable.

The prototype's report UI strings are Polish-only; appgraph's sit in a string table with English as the
default and Polish as a shipped locale, selected by `--locale`. This does not touch parity — the parity
gate compares YAML, and the HTML is excluded from goldens (§12.6).

---

## 15. Config file and its loading

### 15.1 Shape

```ts
export type AppgraphConfig = {
  readonly root?: string;
  readonly sourceRoots?: readonly string[];
  readonly screenSource?: string;                    // force one, bypassing detection
  readonly screenSources?: readonly string[];        // run several, namespaced by source (§10.1)
  readonly depth?: number;
  readonly out?: string;
  readonly formats?: readonly string[];
  readonly conflicts?: 'merge' | 'first' | 'error';
  readonly kindRules?: readonly KindRule[];
  readonly stringSources?: readonly string[];        // files whose string enums feed the StringTable
  readonly testIdAttribute?: string;
  readonly redirects?: { readonly unauthenticated?: string; readonly flagOff?: string };
  readonly strict?: boolean;
  readonly allowEmpty?: boolean;

  // --- filesystem + resolution (§7.2, §10.7). All merged OVER the derived defaults, never replacing them.
  readonly extensionRewrites?: readonly { readonly from: string; readonly to: readonly string[] }[];
  readonly candidateSuffixes?: readonly string[];
  readonly exclude?: readonly string[];              // added to the §10.7 exclusion list
  readonly generated?: readonly string[];            // extra generated-file globs
};

export const defineConfig = (config: AppgraphConfig): AppgraphConfig => config;
```

Every field is optional. A config file that sets nothing is equivalent to no config file. Anything set
here **overrides** the phase 0 derivation and is echoed in `doctor` as "from config" so the user can see
which of their overrides is fighting detection.

**There is no `plugins` field in 0.1**, because there is no published contract (§5.0, §5.9): adapters
ship inside the package and are selected by name (`screenSource` / `screenSources`), not supplied by the
user. A `plugins` field arrives with the contract at 0.3; its absence is what keeps the seam free to
move.

### 15.2 Loading, with zero dependencies

appgraph has exactly one runtime dependency (`commander`) and will not add a bundler to read a config
file. Loading:

1. read `appgraph.config.ts`;
2. `ctx.ts.transpileModule(text, { compilerOptions: { module: ESNext, target: ES2022 } })`;
3. write the JS to a temp file with an `.mjs` extension inside the OS temp dir;
4. `await import(pathToFileURL(tempFile))`;
5. delete the temp file;
6. take the default export, validate it structurally, and merge over the derived `ResolvedConfig`.

`appgraph.config.js` and `.mjs` skip steps 2–3.

**Documented limitation, stated in the README and in the error message when it bites:** the config file
may import only `appgraph`, Node builtins, and plain `.js`/`.mjs` files. It may **not** import other
`.ts` files, path-aliased modules, or JSON via `resolveJsonModule` — `transpileModule` is a
single-file transform with no module resolution. A failed dynamic import produces
`config/unresolvable-import` naming the specifier, not a stack trace.

---

## 16. The five acceptance apps

Five genuinely different stacks, chosen so that the internal adapter interface is proven by adapters that disagree with
each other, not by five variations of react-router. Each has its own golden and its own honest
shortfalls; the shortfalls are emitted as diagnostics and as `meta.limitations` entries, never hidden.

### 16.1 The reference app — the parity reference

**Stack.** Vite + React 19 + react-router, TypeScript 6 (the `npm:@typescript/typescript6` alias that
motivates §5.6).

**Config (the pinned side of §12.4):** `PINNED_BASE` (`screenSources: ['react-router']`, depth 3,
`sourceRoots: ['src']`, `data-testid`) plus the app's string sources and kind rules, read from the
untracked target pointer (§12.1).

**Wrapper roles** belong to the react-router adapter (`src/adapters/react-router/`), the only adapter for
which tag-matching is how wrappers are actually declared (§0.3: 0 of 7 Next pages and 0 of 101 TanStack
routes carry a layout tag). `wrapperRoles` in config is merged by `name` over the defaults (see
[supported-libraries.md](supported-libraries.md#21-react-router)). The defaults are the prototype's five
tag rules, all of them the ordinary react-router naming conventions rather than anything app-specific —
`RouteErrorBoundary` → `errorBoundary` reading `routeName`, `ProtectedRoute` → `guard` reading
`featureFlag`, `/Layout(Wrapper)?$/` → `layout` reading `title`, `Navigate` → `redirect`,
`Suspense`/`Fragment` → `transparent` — and converts a matched layout tag into an
`AncestorRef { file, exportName, splice: {kind:'outlet', tag:'Outlet'}, role:'layout' }`, so this app
goes through the **same** §6.3.1 ancestor machinery as the file-convention stacks rather than a parallel
path. **On the reference app this is a no-op:** the derived chain reproduces the prototype's `layoutFile`
for every screen and the same three shells.

**What the adapter handles** (all verified in the prototype source):

- a `createBrowserRouter([...])` literal, with nested `children` arrays and
  spread elements (`...[]`) that recurse and carry a `devOnly` flag when the spread text matches
  `DEV_GUARD` (`/isDevelopment|import\.meta\.env\.DEV|NODE_ENV|__DEV__/`, in
  `src/adapters/route-conditions.ts`, alongside the structural build-mode reader the TanStack
  adapters use);
- screens behind `lazy: async () => { const { default: X } = await import('@/modules/X'); … }` and the
  array-destructured `const [{default:A},{default:B}] = await Promise.all([import(),import()])` variant
  — both are `BindingTable` cases (§5.7);
- path constants as `Paths.Something` from a string `enum`, read through the `StringTable`;
- a menu array declared `satisfies Route[]` (hence `unwrap`'s `satisfies` case), fields
  `path`/`title`/`menuLabel`/`featureFlag`/`parentPath`;
- `data-testid` attributes; TanStack Query; Zustand `use*Store`; react-i18next; RHF + zod.

The router array is discovered through `unwrap` at all of §6.2's sites, pinned by the wrapping-form
fixtures. The prototype works on this app only because nobody has written `satisfies RouteObject[]` on
that array.

**§12.4's zero-config stage must derive all of the above with no config at all**: `src/` is the only
`paths` target; the two **non-wildcard** aliases are preserved (§8.4); `data-testid` is the only
attribute in the histogram; the menu array scores 12/12 = 1.0 in nav discovery; the path enum is reached
as a string source because the router file references `Paths.*`.

**Detection caveat, measured (§0.5):** this app's directory contains the browser extension, whose
`public/manifest.json` is a genuine MV3 manifest. Running appgraph at the app's root therefore produces
**two** live sources — `react-router` (90) and `state-screens` (51) — and a "highest wins" rule silently
deletes the extension. Under §10.1 the run **refuses** and names both, and
the parity configuration passes `screenSources: ['react-router']` explicitly. This is not a workaround; it
is the tool correctly reporting that the directory holds two applications.

**This app is the gate**, under gates 1–4 of §12.3 — not byte-parity, which §12.2 explains cannot pass.

**Shortfalls:** none beyond the shared limitations. This is the app the engine was written for.

### 16.2 The Next.js app — Next.js App Router

**Stack.** Next.js 15 App Router. Alias `@/*` → `./src/*`.

```ts
export default defineConfig({ screenSource: 'next-app' });   // and nothing else
```

**Globbing.** Pages live under `src/app`, not
root `app/`, so the glob **must** be `**/app/**/page.{tsx,ts,jsx,js}`. Measured: that glob also matches
**23 generated `page.*` files inside `.next/`**, giving **30 screens, 23 of them garbage**. §10.7's
directory exclusion is what makes the required glob safe, which is why it is classified load-bearing
rather than cosmetic.

**Ancestor chains — the mechanism this app requires (§0.3).** Measured: **0 of 7** `src/app/**/page.tsx`
files carry any JSX tag matching `/Layout(Wrapper)?$/`. Next layouts are **file-convention ancestors**:
`src/app/layout.tsx` wraps everything and composes via `{children}`. With tag matching alone every screen therefore reports
`layoutFile: null` and `shells: {}`.

The `next-app` adapter builds each screen's `ancestors` directly from the directory path — for
`src/app/items/[id]/page.tsx`, every `layout.tsx` from `src/app/` down to
`src/app/items/[id]/`, outermost first — each with
`splice: { kind: 'children' }`. Route groups `(group)` contribute a layout without contributing a URL
segment. `template.tsx` is treated as an ancestor with `role: 'transparent'`; `loading.tsx`,
`error.tsx` and `not-found.tsx` are **not** ancestors and are recorded as `kindTag`-tagged sibling
screens only if they are addressable, which they are not.

**Screens.** 7 from `src/app/**/page.tsx`, including a dynamic segment (`[id]` → `:id`). Plus **30 `route.ts` handlers**, emitted as screens tagged `kindTag: 'apiRoute'` with
`kind: 'api'`. These are addressable URLs but not human screens: the index lists them in a separate
block, and the HTML report gives them their own (data-derived) kind colour. An agent must be able to see
that an `/api/…` handler exists without being told to "navigate" to it.

**Nav.** A sidebar component's nav constant — a **grouped** config
(array of groups, each with an array-valued items property), which is exactly the recursion case of
§10.6. Fields `path`/`label`/`icon`.

> **Four entries point at routes that do not exist.** This app is the acceptance test for §9.2: four
> `nav/dead-link` warnings, four rows in `deadNavLinks` in the index, four badges in the report, and a
> non-zero exit under `--strict`. The nav group's score is therefore below 1.0 and that score is
> visible in the output — which is the point.

**Facts.** Data via `fetch()` and `"use server"` actions. No i18n, no stores, **0 test-ids**.

**Traversability (§8.11).** `USES_DIR`'s `/^src\/(services|stores|shared\/hooks)\//` matches **nothing**
here, so with it `reachable` for every screen collapses to the render tree and every aggregate
under-reports with no diagnostic. The derived `KindRule.traversable` rules pick up this app's
non-component modules, so a screen whose page imports from `src/lib/` reaches those modules.

**Shortfall to state, verbatim, in `meta.limitations` and as an info diagnostic:** linking a **client
call site** to the **server action** it invokes requires cross-file type flow — an imported symbol's
`"use server"`-ness is a property of its declaration, and connecting a call to that declaration through
a prop or a wrapper is a TypeChecker job. Parser-only cannot do it. appgraph therefore **records the
action** (file, exported name, `transport: 'rpc'`) and emits `facts/needs-typechecker` explaining that
the call sites are not linked.

### 16.3 The TanStack Start app — TanStack Start

**Stack.** TanStack Start / TanStack Router, file-based routes.

```ts
export default defineConfig({ screenSource: 'tanstack-router' });
```

**Screens.** 101 route files under `src/routes/_authed/**`, each calling `createFileRoute('/...')`.

- **The literal argument is authoritative.** The filename is a *fallback* when the literal is not a
  string literal, and otherwise a *cross-check*: a mismatch between the literal and the path implied by
  the filename produces a `warning screens/stale-route-literal`. Generated route trees drift, and that
  drift is exactly what this warns about.
- `$param` → `:param`; a bare `$` segment → `*`; dot-notation filenames (`posts.index.tsx`) split on
  `.` into path segments.
- `_`-prefixed pathless segments **leave the URL** but **carry semantics**: `_authed` sets
  `auth: 'protected'`. The adapter declares this as a segment-role mapping; the URL for
  `src/routes/_authed/items/index.tsx` is `/items`.
- `src/routeTree.gen.ts` is **skipped** — it is **2,251 lines** carrying both `@ts-nocheck` and a
  generated-by marker in its opening lines, and it duplicates every route, so parsing it would double
  every screen. It is caught by the project-wide generated-file rule (§10.7), not a per-adapter filename
  skip, so whatever the next generator names its output is caught too.

**Ancestor chains — the measurement behind §6.3.1.** Files under `src/routes/**` carrying a JSX tag
matching `/Layout(Wrapper)?$/`: **0 of 101**. TanStack layouts are pathless-route **ancestors** composing
via `<Outlet/>` — `src/routes/__root.tsx` and `src/routes/_authed.tsx`. With tag matching alone the map
claims **98 of 100 screens have no auth shell**, while `src/routes/_authed.tsx` holds exactly the
`beforeLoad` redirect an agent most needs to know about before it tries to navigate.

The `tanstack-router` adapter derives `ancestors` from the route-file path: every pathless `_`-prefixed
route file and `__root.tsx` on the path from `src/routes/` to the screen file, outermost first, each with
`splice: { kind: 'outlet', tag: 'Outlet' }`. `_authed.tsx` additionally contributes
`auth: 'protected'` — its pathless-segment role and its conditional `beforeLoad` guard — which is what
gate-3 assertion **A6** pins. An unconditional `beforeLoad` redirect makes a route a redirect
(`redirectTo`), never a guard. A redirect target that does not flatten to a string literal through
`flattenString` is never invented: `redirectTo` stays `null` and the auth shell is still reported.

**Nav.** A grouped nav constant in the sidebar component, fields `to`/`labelKey`/`icon`/`search`.
`to` is in the `['path','to','href',…]` list; `labelKey` is in the label list and, being an i18n key,
lands in `NavEntry.labelKey` rather than `label`.

**Facts.** The data layer is `createServerFn`. These calls become endpoints
with **`transport: 'rpc'`**.

> The index **must say** that RPC endpoints are **not hittable by a browser agent**. An agent that sees
> a list of endpoints and assumes it can `GET` them will waste an entire session on 404s. The index
> emits rpc endpoints under a separate key with an explicit note.

A feature-flag config array feeds `featureGates`. **0 test-ids** → the §10.5 "this repository
declares no test-ids" statement fires.

**Shortfall:** `validateSearch` Zod schemas yield search-param **names only, not required-ness**.
Determining whether `z.string()` vs `z.string().optional()` applies to a given key requires evaluating
the schema expression, which is condition evaluation by another name (§13). The index lists the names
and says they may be optional.

### 16.4 The AdminJS app — AdminJS 7

**Stack.** AdminJS 7. **No tsconfig `paths`**, `"moduleResolution": "nodenext"`, relative imports
written with `.js` extensions.

```ts
export default defineConfig({
  screenSource: 'adminjs',
  // extensionRewrites are derived automatically from moduleResolution: nodenext; shown for clarity:
  // extensionRewrites: [{ from: '.js', to: ['.ts', '.tsx'] }],
});
```

**This app is why the resolver is not frozen core (§0.1).** Measured against the prototype resolver: the
app's AdminJS options module and its component-loader module both report
**`imports resolved: 0, bindings: 0`**, because the resolver's `CANDIDATE_SUFFIXES` appends to the whole
specifier and probes `./foo.component.js.tsx`. Every screen below would extract perfectly and every
render tree would come back empty — the exact "structurally complete, substantively worthless" failure
§17.4 warns about, arriving through the resolver rather than through the walk.

`extensionRewrites`, `candidateSuffixes` and `sourceRoots` (§7.2) are resolver options, not adapter
capabilities, because module resolution is core — but core that is **configurable and not yet frozen**
(§7.0). Gate-3 assertion A3 is literally "the options module resolves a non-zero number of imports".

The app has **no tsconfig `paths`**, so alias resolution contributes nothing here and the whole graph
rests on relative-specifier probing — which is precisely why the `.js` rewrite is not a detail.

**Screens.** From `AdminJSOptions`:

- `resources[]` — `create*Resource()` factory calls assembled in the options module. The
  adapter follows each factory call to its declaration (barrel chasing, §7.3) and reads the resource `id`
  from a `Resource` enum through the shared `StringTable`.
- a `pages{}` map.

**URL comes from an adapter-declared TEMPLATE**, not from a router:

```ts
{ kind: 'url', template: `${rootPath}resources/${id}`, params: [] }
{ kind: 'url', template: `${rootPath}pages/${slug}`,   params: [] }
```

`rootPath` is read from the same options object. This is the case that proves `Activation` is the right
shape: there is no route table anywhere, and a URL-first model would have to invent one.

**Component resolution** needs a **prepass** (a `stage:'prepass'` channel per §5.4, not an ad-hoc first
loop): `componentLoader.add('Name', './path.js')` calls build a `Name → file` table, and
`actions.<name>.component: Components.X` is then resolved through it — and through `extensionRewrites`,
since every registered path ends in `.js`.

**Ancestors.** AdminJS renders every resource inside its own library-internal shell, which appgraph
never sees. The adapter therefore supplies `ancestors: []` — an **assertion of absence**, not silence
(§4.3) — so `shell` is `null` and no `walk/no-splice-point` diagnostic is emitted for a chain that
genuinely does not exist in the source.

**Nav.** A `Record<Resource, {name, icon}>` — the `Record<…, object>`
branch of §10.6 rather than the array branch.

**i18n.** A custom `locale/` directory, not react-i18next. Namespaces only.

**Shortfalls, both emitted:**

- An action with **no custom component** gets a **synthesized screen with empty `entries`**, tagged
  `kindTag: 'generated'`. Its URL is discoverable and its render tree is empty — which is honest: AdminJS
  renders it from library-internal components appgraph never sees. Better a URL with an empty tree than
  no row at all.
- A **computed resource id** (an id built from a non-literal expression) becomes an `EntryRef.opaque`
  plus a `screens/opaque-entry` diagnostic naming the expression, file and line.

### 16.5 The browser extension — Chrome MV3, no router

**Stack.** Chrome Manifest V3 extension. **No router at all.**

```ts
export default defineConfig({ screenSource: 'state-screens', formats: ['full', 'html'] });
```

**Detection caveat (§0.5).** `public/manifest.json` is a real MV3 manifest **inside** the react-router
reference app. Under a "highest score wins" rule this app (51) loses to react-router (90) and is
**silently deleted from the output**. Under §10.1 both sources are reported and the run refuses to
guess. This app is the acceptance test for that rule.

**Screens.** From `Activation.kind: 'state'`:

- the popup's root component: `isAuthenticated ? <MainPage/> : <Login/>` → two state screens.
- the content-script component: **five** distinct states in **one file**, selected by host-domain checks
  combined with state booleans.

**This app requires the sub-file root (§0.3, §6.3.2).** The prototype's graph builder documents that a
tree node **is a file**, so a file-granular walk gives those five screens **five byte-identical trees** — a map that says
five different things exist and cannot tell you how any of them differ. The `state-screens` adapter
emits five entries pointing at the same file with five different `EntryRef.at` locators (§4.2.1); the
walk collects render edges from each branch's subtree only; and `guardOf` is **clamped at the locator
node**, so the branch's own guard becomes `Activation.expr` rather than a redundant condition repeated
on every node of its tree. Gate-3 assertion **A7** pins "5 screens, 5 pairwise-different trees".

**Masking (§5.4).** The content-script component renders `DevStatesPreview`, a dev-only preview of every dialog
state whose `data-testid`s are real strings in real JSX. Advertising them to an agent as selectors for
the shipping UI is actively harmful, so that subtree is masked on the `testIds` channel with an
`info facts/masked` diagnostic. Gate-3 assertion **A8**.

**Identity (§0.6, §4.1).** A guard-text id — `localId = '<holderComponent>#<guardExpr>'`, e.g.
`App#isAuthenticated`, giving `screen://state-screens/App%23isAuthenticated` — is rejected. The guard
text comes from the prototype's `conditionText`, which collapses whitespace and truncates at 110 characters, so
renaming `isAuthenticated`, reordering `a && b`, adding a parenthesis or letting Prettier shift the cut
would each rewrite the screen's identity — a delete plus an add in the YAML, a broken stored target for
any agent, and parity churn indistinguishable from a regression. `localId` is
`src/App.tsx#0` / `src/App.tsx#1` structurally, or `src/App.tsx#login` when the source carries
`// @appgraph-id login`. **This app is where the pragma is expected to be used**, because five states in
one file is exactly the case where ordinals shift under ordinary editing. The guard text is emitted as
`activation.expr`, which is what an agent should read.

- `public/manifest.json` `content_scripts[].matches` map URL patterns → injected scripts, producing
  `Activation.kind: 'host'` on the content-script screens.
- A message-type enum plus the `if (message.type === X)` chain in the background worker is **the real
  edge graph** of this app — it is how the popup, the content script and the background worker actually
  talk. It produces `Activation.kind: 'message'` and the `messages` fact channel. There is no other
  navigation to find.
- **0 test-ids.**

> **This app is partially served, by design, and the spec says so out loud.** With no URLs, the primary
> value proposition — an agent jumping straight to a URL instead of clicking — **does not exist here**.
> This app therefore **opts out of the `index` format entirely** and emits `full` + `html` only. It is
> in the acceptance set to prove that the model does not assume URLs, **not** to prove that URL-less
> apps get equal value. Anyone reading a future issue titled "the extension index is useless" should
> find this paragraph first.

---

## 17. Risks, stated honestly

### 17.2 Risks, ranked by what measurement shows

Ranked by measurement, not by reasoning.

| Rank | Risk | Why it ranks here | Mitigation |
|---|---|---|---|
| **1** | **Silent under-reporting**: the tool runs, emits a complete-looking artifact, and the contents are thin or empty | Measurement found **three independent instances** in the prototype — the resolver on the AdminJS app (0 imports), `USES_DIR` on three apps (reachability collapses to render edges), layout tags on two apps (0 shells). All three produce a plausible artifact with no diagnostic. | §10.3 confidence, gate 2's coverage floors (§12.3), and the §7.0 freeze rule — nothing is called proven until it has been *run* on the targets |
| **2** | **A one-token syntax change zeroes discovery** | Measured: one `satisfies` → every screen to 0. | The §6.2 `unwrap` invariant, its 15-site checklist and the wrapping-form fixtures |
| **3** | Debuggability: a wrong row has no single obvious author | Inherent to adapter-supplied screens and chains | `provenance` on every Screen, `plugin` on every Diagnostic and `doctor` in 0.1; `--explain` is PLANNED (§14.3) |
| **4** | Identity churn making diffs unreadable | Measured: a `localId` from truncated expression text moves on renames and reformatting. | Structural `localId` + `@appgraph-id` pragma (§4.1); the ban on `getText()`-derived keys |
| **5** | Malformed output the tool reports as success | Measured: the prototype's `k: foo:` does not parse. | Corrected predicate + always-quote-truncated + emit self-check + permanent fuzz job (§7.12), with a named trigger for taking a real YAML dependency |
| **6** | **API ossification** | **Not publishing a contract at all** (§5.9) removes the risk rather than managing it with `apiVersion` + `experimental_`. | The contract is extracted at 0.3 from five working adapters |
| **7** | Line-count / complexity growth | Growth tracks configurability (§7.0) | The §7.0 status board keeps configurability tied to evidence rather than taste |

### 17.3 API ossification, and why it is cheap

A plugin API published before it has been proven against genuinely different stacks will be wrong, and
after 1.0 it cannot be fixed cheaply. appgraph mitigates this by **not publishing a contract in 0.1 at
all** (§5.9), not with `apiVersion` and an `experimental_` prefix — and measurement bears that choice
out: the obvious seam (`WrapperRole`) is not the seam (ancestor chains + sub-file roots).

The requirement: ship all **five** adapters of §16 — react-router, Next file
conventions, TanStack file conventions, AdminJS templates, and a router-less state model — before
publishing anything. Those five disagree with each other about what a screen even is, which is the only
way to find out whether `Activation`, `ScreenDraft`, `AncestorRef` and `NodeLocator` are the right
shapes. The escape hatch is not a version number; it is that nobody outside the repo can depend on the
interface yet.

### 17.4 The single biggest way this design fails

"Entry resolution is adapter-supplied but the render walk is core" is not it: the walk takes declared
inputs (§0.3, §6.3) — narrowly, not through a free-form hook or a `TreeProvider` — so that risk is
retired.

**The most likely failure, named honestly: the ancestor chain is a claim about composition that
appgraph cannot verify, and when it is wrong it is wrong invisibly.**

`AncestorRef` says "file A wraps file B". Nothing checks that at analysis time. The chain comes from a
*convention* — a directory path for Next and TanStack, a JSX tag for react-router — and the splice point
comes from finding a `{children}` or an `<Outlet/>` **lexically inside the ancestor's own JSX**
(§6.3.1). Every one of those is a heuristic that a real app can violate without doing anything unusual:

- a layout that forwards `children` into a component it imports — the splice point is then not lexically
  present, `walk/no-splice-point` fires, the ancestor is skipped, and the screen loses a real wrapper;
- a layout with two slots, where §6.3.1 places the next level directly under the host and warns —
  imprecise, with a warning most people will not read;
- a conditional shell (`isMobile ? <MobileShell> : <DesktopShell>`), which the chain flattens to one
  ancestor and silently drops the alternative;
- a route-group layout that applies to some but not all of its descendants.

In every case the output is **structurally complete and subtly wrong**: the screen has a shell, the
shell has a tree, the aggregates are non-empty, and the specific thing the agent needed — *is this
screen behind the auth guard* — may be inverted. Gate 2's coverage floors do not catch it, because
coverage went up. §10.3's confidence does not catch it, because no section is empty. This is the same
silent-under-reporting family as §17.2 rank 1, one level up the abstraction.

**What partially contains it, and it is genuinely partial:** every skip and every ambiguity is a
diagnostic (`walk/no-splice-point`, `walk/ambiguous-splice`), those diagnostics are per-screen and name
file and line, `--explain` (PLANNED, §14.3; not in 0.1.0) would print the resolved chain for one screen, and under `--strict` a warning among them makes the run exit `4`.
Gate-3 assertion A6 pins the one case we measured (98 TanStack app screens gaining a real auth shell).

**What does not exist and would be the 0.2 answer:** a *verification* pass that checks a claimed
ancestor actually renders the claimed descendant — which, for anything beyond the lexical case, needs
cross-file type flow and is therefore a TypeChecker job and out of reach for a parser-only tool (§7.1,
§13). The honest position is that appgraph reports composition **as the framework's convention
describes it**, not as the code proves it, and `meta.limitations` must say exactly that sentence.

`GRAPH_LIMITATIONS[0]` carries the sentence verbatim, and two tests pin it: `test/core/graph.test.ts`
asserts a built graph's `meta.limitations` contains it as an exact substring, and
`test/emit/view-index.test.ts` asserts it reaches the **index**, not only `full`. A mandate satisfied in
the format a human opens and absent from the format an agent loads is not satisfied.

**AdminJS is the honest floor** (§16.4): its synthesized action screens have real URLs and empty
trees, because the framework renders them from library internals appgraph never sees. A URL with an
empty tree and a stated reason is better than a URL with a confidently wrong tree — which is the whole
argument for keeping the walk's inputs *declared* rather than letting an adapter fabricate a tree.
