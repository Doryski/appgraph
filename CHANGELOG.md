# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Initial public release.

### Added

#### Core analysis

- **Static map of a web application's screens**: routes, render trees, API calls, navigation and selectors, from source alone. Parser-only (`ts.createSourceFile`; never `ts.createProgram` or the TypeChecker), so a run is fast and works on a repo that does not currently compile. `typescript` is a peer dependency and the host project's own compiler is used; `commander` is the only runtime dependency.
- **`Activation` model**: a screen is activated by `url`, `state`, `host`, `message`, `route` (`{ kind: "route", name, navigator }`) or `intercept`, so router-less and native apps are represented without fake URLs. A URL-less screen gets the id `screen://<source>/<name>` and is listed under `stateScreens`.
- **Structural screen identity**: `localId` is `<file>#<ordinal>` or `<file>#<name>` via a `// @appgraph-id` pragma, never derived from expression text, so renames, reordering and reformatting keep ids stable.
- **Render trees with guards as text**: depth-bounded per-screen component trees; each node carries the conditional expressions above it plus `alwaysRendered`, `repeated`, `nullGuards` and `truncated`. Guards are captured, never evaluated. Render edges follow `React.lazy`/`lazy`, `next/dynamic`, `@loadable/component` (including `.then((m) => m.Named)`), compound components `<NS.Member/>` (`Object.assign`, static assignment, object literal, `export * as`, `import * as`) and CommonJS `require()` bindings, with edge provenance `via: "lazy" | "reference"`.
- **Per-branch trees and reach**: a screen's tree and reachable set hold only its own branch; a page referenced as a value in a route table (`component: Page`) is a registration, not a render. A layout file declaring several components gets one render-tree node per export, each with its own children and splice point.
- **Splice points**: `<Outlet/>`, `useOutlet()`, `return children`, `props.children`, renamed destructuring (`{ children: content }`), `{children ?? <Outlet/>}`, `{...props}` spreads, outlets rendered by a component the ancestor renders (up to `maxDepth` levels) or by a same-file component (up to four levels), and layouts wrapped in calls (`withAuth(Layout)`, `observer(memo(Layout))`). Member tags match an outlet only by full dotted path (`Router.Outlet`) or as a member of a namespace import.
- **Reachability**: a shortest-path closure, so `reachable` is independent of traversal order. `uses` edges follow into files the kind rules mark `traversable` and files named `use…`.
- **Fact channels aggregated over each screen's reachable set**: HTTP/RPC endpoints (with `transport`; `rpc` is flagged as not callable by a browser agent), in-app navigations, stores, query keys, i18n namespaces (namespaces only), form schemas and fields, feature gates, custom hooks (`facts.hooks`) and test-id selectors.
- **Navigation reconciled once**: menus and route tables are discovered independently and reconciled in one place. Entries resolving to no screen are dead links, reported as a `nav/dead-link` diagnostic, a block in the agent index, a report badge and an error under `--strict`. Menus attach to shells. External targets (`mailto:`, `https:`, any `scheme:`, `//host`) and `#anchor` targets are dropped. Catch-alls match their base path (react-router `*`, TanStack `$`, Next `[[...slug]]`; a required `[...slug]` does not). In multi-host Next.js apps (`app/<hostname>/…`), host-relative links also match the hostname folder without shadowing a screen that owns the path.
- **Navigation lookups**: targets read from static records/arrays with runtime keys (`tabToPath[tab]`, `ROUTES[key].path`), mapped arrays, destructured params, `.filter` chains, `for…of` and imported `const` strings, up to 64 values, marked dynamic when a runtime key is involved; edges carry the lookup `expr`. A route name that only partly folds is an unresolved navigation.
- **Redirects**: root `next.config.{ts,mts,js,mjs}` `redirects()` are read without evaluation (HOC unwrapping, `module.exports`/`export default`, spreads of local or imported consts, ternary unions with the condition kept). Unmatched menu entries and navigations resolve through redirect rules (first by code point, at most 5 hops) and record `viaRedirect`; `has`/`missing`, regex and `/*`-like rules never resolve. `redirects[]` carries `declaredAt` and `condition`.
- **Loader guards**: a redirect in `loader`, `clientLoader`, `getServerSideProps` or TanStack `beforeLoad` is read by one rule. A conditional redirect marks the route (and a layout's descendants) `protected` with the condition as evidence; an unconditional one sets `redirectTo`; helper functions are followed one hop. `redirects.unauthenticated` narrows protection to redirects aimed at that target. The root route's `beforeLoad` is not inherited.
- **Dev-only routes**: TanStack file and code routes declared under a build-mode condition (`__DEV__`, `isDevelopment`, `import.meta.env.DEV`/`PROD`, `NODE_ENV`/`MODE` comparisons), with a production-only throwing `beforeLoad`, or registered only through dev-gated `addChildren`, are `devOnly`. react-router's probe also recognises `__DEV__`.
- **Fact masking**: a dev-only preview subtree can be masked on the test-id channel (`facts/masked`); masking never affects render edges or `reachable`.
- **Test-id probing**: `data-testid`, `data-test`, `data-cy`, `data-qa`, `data-test-id` and `testID` are probed (ties in that order); the occurrence histogram is evidence and the most frequent wins. With none found, the output says to select elements by role or visible text. Test ids imported from a constants module are resolved.
- **Self-reported confidence** per section, scored against whether the enabling dependency is installed; `confidence/empty-section` warns per extractor whose library is installed but produced nothing.

#### Screen sources

- **react-router**: object-literal `createBrowserRouter`/`createHashRouter`/`createMemoryRouter` arrays (nested `children`, spreads, `lazy` imports, path constants via a string table, `const` route objects and lists, single-`return` functions, Sentry `wrapCreate{Browser,Hash,Memory}RouterVn`); JSX `<Routes>`/`<Route>`, `createRoutesFromElements`/`createRoutesFromChildren` and `useRoutes` (bound by import, including barrels); descendant `<Routes>` under `path="x/*"`, including behind `lazy()`; `.map` over literal route arrays; `Component` and module `lazy` entries; optional params (`/users/:id?/edit`). Wrapper roles (guard, layout, error boundary, redirect, transparent) become ancestor chains; `protected-route` matches `PrivateRoute`, and `wrapperRoles[].entryFrom` handles guards handed the route item. Factory routers share one merge scope. Unclaimed route lists are read top-level only when provable, otherwise withdrawn with `screens/conflict-dropped`. Runtime-gated lists give `auth: unknown` with evidence. Routers in test, mock and Storybook files are ignored.
- **react-router v5**: `<Switch>` roots per root (v5 and v6 coexist via `react-router-dom-v5-compat`), `component`/`render`/children routes, path arrays, `<Redirect from to>`, `${match.path}` nesting, path-to-regexp syntax. Versions below v4 warn `screens/unsupported-router-style`.
- **Route dialects**: `reactRouter.routeDialect` (`fields`, `translators`, `unwrapCalls`, `prefixRules`), and a built-in Sentry preset triggered by a `@sentry/*` dependency (`translateSentryRoute`, `memoize`/`errorHandler` unwrapping, `make(() => import())`, `redirectTo`, `withOrgPath` dual routes).
- **wouter**: `<Switch>` and loose `<Route>` groups, `component`/children/function-child routes, `nest`, same-file `<Router base>`, `<Redirect>`, regexparam paths.
- **react-router-framework** (React Router framework mode and Remix v2): `app/routes.ts` (`route`, `index`, `layout`, `prefix`, `relative`), `flatRoutes()`, the Remix v2 flat-file convention and remix-flat-routes via `remixRoutesOptionAdapter`. `root.tsx` is the outermost layout; a module with no default export is an `apiRoute`. Detection scores 100.
- **next-app** (App Router): `[param]`, `[...slug]`, route groups, private `_folder`s (and `%5F` escapes), the outermost `app` directory, parallel `@slot` routes and intercepting `(.)`/`(..)`/`(...)` routes (an `intercept` activation `{ from, slot, file }`), and `route.ts` handlers as `kind: "api"` screens.
- **next-pages** (Pages Router): `pages/` or `src/pages/`, `[id]`/`[...slug]`/`[[...slug]]`, literal `pageExtensions`, `pages/api/**` as `apiRoute` screens, `_app` as outermost layout and `Page.getLayout` layouts. `next-app` and `next-pages` co-run in one graph through `Preset.companions`.
- **tanstack-router**: file routes (`createFileRoute` literal cross-checked against the filename, `$param`, pathless `_` layers, `{-$param}`, trailing-`_` un-nesting, `[x]` escapes, `(group)` folders, `createLazyFileRoute`/`.lazy.tsx`, `route.tsx`), virtual file routes (`virtualRouteConfig`), custom `routesDirectory` (`tsr.config.json`, Vite plugin, `tanstackStart`), code routes (`createRootRoute`, `createRoute`, `lazyRouteComponent`, `.lazy`, `getParentRoute` with `addChildren` fallback) and TanStack Start server routes as `apiRoute`. The screen entry is the page component.
- **vue-router** (Vue 3): `createRouter({ routes })` tables (inline, `const`, spreads, `.map`/`.filter`/`.concat`, nested and named views, `redirect`, lazy imports) and file routes (`unplugin-vue-router`, `definePage`, `<route>` blocks). `auth` from `meta.middleware` and boolean `meta` flags.
- **nuxt** (Nuxt 3 `pages/`, Nuxt 4 `app/pages/`): `[id]`/`[[id]]`/`[...slug]`/`(group)`, `parent.vue` nesting under `<NuxtPage>`, `definePageMeta`, `app.vue` and `layouts/` ancestors, auto-imported components by Nuxt directory naming. Default `~/*`, `@/*`, `~~/*`, `@@/*` aliases apply when `.nuxt/tsconfig.json` is not generated.
- **angular** (standalone and NgModule, Angular 14+): `provideRouter` and `RouterModule.forRoot`/`forChild` tables through the bootstrapped module's import closure, `loadChildren`, `loadComponent`, literal-argument factories, `redirectTo` and conditional `data.redirectTo`, `canMatch` siblings merged. `auth` from guards and route `data`.
- **expo-router**: one screen per route file (`index`, `[id]`, `[...rest]`, groups and group arrays, `+not-found`, `*+api` as `kind: "api"`), `_layout` navigators (`Stack`/`Tabs`/`Drawer`/`Slot`/`NativeTabs`/`withLayoutContext`), shared routes, platform variants (`.ios`, `.android`, `.native`, `.web`, `.tv`), and `Stack.Protected guard` for `auth`.
- **react-navigation**: JSX `<X.Screen>` under any `create…Navigator()` and static `create…Navigator({ screens, groups })` configs; URLs from `linking.config.screens` and `reactNavigation.pathTables`; `auth` from `options` keys (`requireAuth` by default).
- **adminjs**: screens from `AdminJSOptions.resources[]` and `pages{}` with URLs from an adapter-declared template, including bulk actions at `/resources/:resourceId/bulk/:action`.
- **state-screens** + **manifest-activation**: router-less apps (Chrome MV3 extensions) through state-activated screens, host patterns from `content_scripts[].matches` and a message graph.

#### Fact extractors

- **HTTP**: the packages in one `HTTP_CLIENT_PACKAGES` list (including superagent, undici, `node-fetch`), Angular `HttpClient`, `$fetch`/`useFetch`/`useLazyFetch`/`ofetch`, SWR keys (`useSWR`, `useSWRImmutable`, client `swr`).
- **Convex**: `api.*`/`internal.*` references via `convex/react`, `convex/nextjs`, `@convex-dev/react-query` and `convex-helpers/react` become `rpc` endpoints (`QUERY`/`MUTATION`/`ACTION`), cross-checked against `convex/<path>.ts` exports (`facts/convex-unknown-function`).
- **Query**: TanStack Query (including `@tanstack/query-core`, `@tanstack/vue-query`, `queryOptions`, `fetchQuery`/`prefetchQuery`/`ensureQueryData`, key-factory references) and react-query v3 positional keys.
- **Stores**: `use…Store` hooks (excluding React-family imports such as `useSyncExternalStore`), valtio, Redux Toolkit `createSlice`, `configureStore`/`createStore`, typed redux hooks, react-redux `useStore`, Pinia and NgRx features.
- **i18n**: `useTranslation` (no argument records `default`), i18next core, react-intl, Lingui, `vue-i18n` (including template `$t`), ngx-translate and `$localize`; a key without a namespace records `default`.
- **Forms**: formik, react-final-form and form schemas (a validator alone never implies a form).
- **Feature flags**: GrowthBook hooks, client methods and components, plus `featureFlags.lookupFunctions`.
- **Navigation**: `useHistory().push/replace`, `<Redirect to>`, wouter `useLocation()`/`navigate`, `<RouterLink>`/`<NuxtLink>`/`navigateTo`/`$router`, Angular `routerLink` and `router.navigate`, Expo `router`/`useRouter()`, React Navigation `navigation` calls, `StackActions`/`CommonActions` and `<Link screen>`. Named-route targets resolve through `Screen.routeName` and `route` activations.
- **Templates**: a framework-neutral template registry with optional peers `vue` (`>=3.4 <4`) and `@angular/compiler` (`>=14`), loaded from the project first, then from appgraph's install, never fatal (`project/template-compiler-missing`, `project/template-compiler-unsupported`). Templates contribute test ids, render edges and `v-if`/`v-show`/`v-for`, `@if`/`@for`/`@switch`/`@defer` and `*ngIf`/`*ngFor` guards.

#### Detection and project setup

- **Zero-config detection**: every screen source is scored with evidence at `file:line`; detection yields the same resolved config shape a config file would.
- **Refuses to guess**: more than one live screen source produces `project/multiple-screen-sources`, naming each source, its evidence and the resolving flag (`--source`, `--all-sources`, `--root`). Nothing is written, the output directory is not created, and the run exits `1`. A source never emits screens without its framework dependency.
- **Nested packages** (subdirectories with their own `package.json`) are scoped out of root detection when the root has a `package.json`.
- **Exclusions follow `.gitignore`** (`.git/info/exclude` and every `.gitignore` from the git root down), plus dot-directories, a literal Next `distDir`, and root-only `cypress`/`e2e`/`playwright` and output folders (`build`, `builds`, `dist`, `out`, `coverage`, `storybook-static`). Test, mock and Storybook directories are excluded at any depth.
- **tsconfig**: solution-style `references` (picking the config covering the most files, with `tsc` include semantics), `extends` through workspace packages (`pnpm-workspace.yaml`, `package.json` `workspaces`, `dir/**`, `!` patterns), `moduleSuffixes`, and a wildcard `include` adding the project root to source roots. An unresolvable `extends` is a warning (`project/tsconfig-error`). Extensionless imports resolve to TypeScript candidates, then `.js`, `.jsx` and `/index.js`. Unresolved imports are reported as info (`project/unresolved-import`).
- **Probe budgets**: the `stringSources` and test-id probes read up to 20,000 files and skip test, spec, story and mock files. Nav auto-discovery skips nested packages, generated and minified files, and files over 512 KB.

#### Configuration

- **Typed config**: `appgraph.config.{ts,mts,js,mjs}` through `defineConfig`; `ts`/`mts` load on Node 20+ without a loader. CLI flags take precedence; config options merge over derived defaults.
- **Keys**: `kindRules` (priority 100 over presets), `exclude` (root-relative paths and globs; `!name` restores a default), `wrapperRoles`, `pathlessRoles`, `entryComponents`, `adminjs`, `extractors`, `redirectRules`, `reactRouter.routeDialect`, `vueAuth`, `angular`, `expoRouter.root`, `reactNavigation` (`pathTables`, `authOptionKeys`), `nativeAuth.signedIn` and `featureFlags.lookupFunctions`.
- **Validation**: unknown keys are errors (`config/unknown-field`) with a "Did you mean …?" hint; invalid regexes are `config/invalid-field`; missing files are `config/missing-file`; unknown extractors are `config/unknown-extractor`; an unknown `--source`/`screenSource` names the valid ones.

#### CLI

- **Commands**: `analyze` (default; a bare `appgraph [flags]` analyses), `doctor`, query commands, `glossary` and `schema`. Per-command `--help` with output description, examples and exit codes comes from one command registry (`src/cli/commands.ts`).
- **Output formats**: `index` (`appgraph.index.yaml`, a compact agent-facing index) and `html` (`appgraph.html`, a self-contained report with no network requests) by default, into `docs/appgraph`; `full` (`appgraph.yaml`), `detail` (`appgraph.<slug>.yaml`) and `graph` via `--format` (or `all`). The graph cache `appgraph.graph.json` is always written. Report locales: English and Polish (`--locale`).
- **Full YAML**: repeated render subtrees (at least 3 nodes, occurring at least twice) are interned in a top-level `subtrees:` map as `{ref: t<n>}`, and default-valued tree fields are omitted. `meta.schemaVersion` is 2 in every artifact.
- **`appgraph doctor`**: prints the detection trace (root, config file, tsconfig chain, per-source scores and evidence, globs, near-misses, exclusion rules, nested packages, test-id histogram, Vue compiler, limitations, fingerprint) and writes nothing. It accepts `--root`, `--config`, `--out`, `--source`, `--all-sources`, `--depth`, `--json` and `--timing`, and exits 0 once flags parse.
- **CI**: `--if-stale` skips a run after a clean run while every artifact still exists, using the `.appgraph-fingerprint` sidecar (one JSON line, `{schemaVersion: 2, run, graph}`); `--json` (machine summary on stdout, prose on stderr), `--strict`, `--allow-empty`, `--no-timestamp`, `--timing` (per-phase ms on stderr, and a `timing` object in `--json`).
- **Exit codes**: seven documented codes, `0`–`6`, including `6` (`EXIT_CACHE_UNAVAILABLE`); when several apply, the non-zero codes rank `2 > 6 > 5 > 3 > 1 > 4`. A zero-screen run exits non-zero and prints the detection trace.
- **`--json` errors**: `{command, exitCode, error: {code, message, hint}, diagnostics}` with stable codes (`cli/usage`, `usage/unknown-field`, `emit/unknown-screen`, `cache/*`, `analysis/refused`, `analysis/no-screens`).
- **Safe writes**: atomic writes (temp file plus rename); symlinked output targets are refused. Terminal output and YAML scalars escape control characters.
- **Startup**: the bin `dist/cli/bin.js` enables Node's module compile cache (opt out with `NODE_DISABLE_COMPILE_CACHE=1`).

#### Query commands and agent support

- **Query commands** answer from the graph cache and cover every read path of the HTML report: `screens` (`--auth`, `--api`/`--no-api`, `--flag`, `--kind`, `--from`), `screen <id|url>` (`--sections`, `--tree-depth`), `links <id|url>` (`--incoming`, `--outgoing`), `search <query>`, `components` (`--kind`, `--sort`, `--search`), `menu` (`--group`, `--missing`, `--search`), `findings` (`--section`, `--severity`, `--code`), `stats`, `usages <term>` (reverse lookup from a component, endpoint, test id, store, query key or i18n namespace; query strings ignored) and `glossary [term]`.
- **Paged output**: `--limit` (default 50), `--offset` and `--fields` on every list; `--json` prints `total`, `offset`, `limit`, `truncated`, `nextOffset`, `items`/`item` and `cache: {status, path, fingerprint}`. Unknown screens or fields exit 2 with nearest matches.
- **Graph cache** `appgraph.graph.json`: a byte-reproducible envelope `{format: "appgraph-graph", schemaVersion: 2, appgraphVersion, paths, subtrees, graph}`, refreshed automatically when the graph fingerprint changes. `--cached` never analyses; `--source`, `--all-sources` and `--depth` are sticky.
- **`appgraph schema [command]`** prints the JSON Schema (2020-12 subset) of each command's `--json` output, plus `error`.
- **Agent docs**: a Claude Code skill (`skills/appgraph/SKILL.md`, shipped in the package), a README "For AI agents" section and `docs/agents.md`.

#### HTML report

- **React 19 app** (Vite single-file build, Tailwind v4, shadcn/ui, TanStack Table/Virtual/Hotkeys) embedded in one self-contained file, byte-identical under `--no-timestamp`; the payload interns paths and subtrees.
- Navigation map in URL-prefix columns with hover tracing, filter and pan/zoom; a separate API routes section; virtualized sortable tables; 3-state auth badge; copy buttons; error boundary; light/dark/system theme; mobile layout with a bottom tab bar; accessible tabs and map.
- Deep links `#tab=…&screen=…` (and `#screen=…`) with back/forward support.
- Keyboard: `/` search, `Ctrl/Cmd+K` command palette (also from inputs), `g` then `s`/`n`/`m`/`c`/`f` to switch tabs, `j`/`k` or arrows in the screen list, `?` help, `Esc`. A glossary explains report terms.

#### Library API

- **`analyze()`** performs no writes: artifacts return as `{ path, content }`. It loads `appgraph.config.*` itself (`configFile` names the file) and `AnalyzeResult.exitCode` equals the CLI's exit code. Default formats match the CLI.
- **`AnalyzeOptions`**: `root`, `cwd`, `config`, `configFile`, `emit`, `kindRules`, `sourceRoots`, `appgraphVersion`, `allSources`, `fingerprint`, `timestamp`, `emitOptions`.
- ESM-only, Node >= 20, with TypeScript declarations.

#### Output guarantees

- **Deterministic output**: code-point ordering everywhere (`localeCompare` and `Intl.Collator` are lint-banned), sorted globs, no absolute paths, no timestamps in YAML, one injected clock, no symlink following. Identical input yields byte-identical output on any machine and locale.
- **Emitter self-check**: emitted YAML is asserted to re-parse, with fuzz coverage in CI.
- **Diagnostics with provenance**: every diagnostic has a stable code and its producing adapter; every screen records `provenance`. `DIAGNOSTIC_CODES` is checked against emit sites in both directions. No adapter throw is fatal (`plugin/threw`).
- **Counts**: "screens" exclude redirects and API routes; `meta.counts` includes `apiRoutes`.
- **Stated limitations**: `meta.limitations` is emitted in every format, including the agent index.

#### Performance

Measured on Sentry (824 screens, 9,416 files): a default run takes 10.5 s and 1.6 GB RSS; an index-only run 10.0 s; outputs are 52 MB (`full`), 18 MB (`html`) and 21 MB (`graph`); a query on a fresh cache takes ~0.2 s.

#### Documentation

- `docs/supported-libraries.md`: every supported library and configuration shape, what is detected but refused, and what is unsupported.

### Known limitations

- Guards are captured as text and never evaluated: the map shows what *can* render, not what *does*.
- Zero-config detection refuses when more than one screen source is live, even when one contributes no screens; `--source` resolves it.
- Reachability follows `uses` edges only into `traversable` files and `use…` files; a data layer outside the preset directory families (`services|api|clients`, `stores|store|state`, `hooks`) needs `kindRules`. `appgraph doctor` shows what matched.
- Ancestor chains follow framework convention rather than proof; forwarded `children`, two-slot layouts, conditional shells and partial route-group layouts can be subtly wrong. Whether an error boundary counts as a shell is open.
- Router literals in test files and `scripts/` count toward detection evidence; `exclude` is the lever.
- Build-output exclusion is pattern-based and not exhaustive.
- A config file may import only `"appgraph"`, Node builtins and plain `.js`/`.mjs` files.
- `--explain`, `--dry-run`, `--no-test-ids` and `--no-verify-emit` are planned, not implemented.
- Refused with a diagnostic: dynamic component registries (`screens/dynamic-registry`), anything requiring the TypeChecker (`facts/needs-typechecker`), and unsupported router or Next conventions (`screens/unsupported-router-style`, `screens/unsupported-next-convention`).
- A project with no `tsconfig.json` is still analysed, without path aliases, and reported as an error diagnostic (`project/no-tsconfig`), so the run exits `1`.
- Not supported, with no dedicated diagnostic: unrecognised frameworks and monorepo cross-package graphs in one run (ending at `project/no-screen-source` or `project/multiple-screen-sources`), condition evaluation, i18n key extraction, watch mode and third-party plugins.

[Unreleased]: https://github.com/Doryski/appgraph/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Doryski/appgraph/releases/tag/v0.1.0
