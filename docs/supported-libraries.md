# Supported libraries and configuration shapes

This is the catalogue of every library, framework convention and configuration shape
`appgraph` reads. Each entry lists what is **supported**, what is **detected but refused** (with the
diagnostic that says so), and what is **not supported** (nothing reads it, so it is silently absent).
The README's [Supported stacks](../README.md#supported-stacks) table is the summary; this page is
the detail behind it.

Three ground rules apply to everything below:

- **Parser only.** `appgraph` uses the TypeScript parser, never the TypeChecker. A value is read when
  it is written as a literal or folds to one (string literals, template literals, `+` concatenation,
  `const` identifiers, enum members, `as const` / `Object.freeze` member tables — see
  [String folding](#8-string-folding)). Anything that needs type flow is not read.
- **Library calls are matched by import binding, not by name.** `useQuery` counts only when the local
  name is bound by an ES `import` (static, or a destructured `await import()`) from the expected
  module. Aliased imports (`import { useQuery as q }`) match; a same-named local function does not.
  CommonJS counts too: `const x = require('m')` (default), `const { a, b: c } = require('m')` and
  `const a = require('m').a` bind like the equivalent imports. `require` inside an expression, or
  array destructuring of it, does not.
- **Detection is not extraction.** Phase 0 records which libraries are installed (the `library …`
  lines in `appgraph doctor`), but every built-in fact extractor runs on every project regardless
  (`extractors` in `appgraph.config` narrows the set explicitly).
  A library that is *detected* is not necessarily *extracted* — the [detection-vs-extraction
  matrix](#5-detection-vs-extraction-matrix) says which is which.

Contents:

1. [Detection and scoring](#1-detection-and-scoring)
2. [Screen sources](#2-screen-sources) — react-router (v6/v7 and v5 `<Switch>`), Next.js App Router,
   Next.js Pages Router, React Router framework mode and Remix v2, TanStack Router (file- and
   code-based), AdminJS,
   Chrome MV3 (state screens + manifest activation), vue-router (explicit and file routes), Nuxt,
   Angular (standalone and NgModule), Expo Router, React Navigation
3. [Navigation menus](#3-navigation-menus)
4. [Fact extractors](#4-fact-extractors) — HTTP, RPC / server functions, navigation, query, Convex, stores,
   i18n, forms, feature flags, messages, test ids, render tree
5. [Detection-vs-extraction matrix](#5-detection-vs-extraction-matrix)
6. [tsconfig shapes and module resolution](#6-tsconfig-shapes-and-module-resolution)
7. [Repository layout: monorepos, exclusions, generated files](#7-repository-layout-monorepos-exclusions-generated-files)
8. [String folding](#8-string-folding)

---

## 1. Detection and scoring

Every screen source's own `detect` runs in phase 0 and returns a score with evidence at `file:line`.
A score **≥ 50 is live**; `[1, 50)` is a near-miss that never runs on its own. More than one live
source is refused (`project/multiple-screen-sources`) until you pass `--source`, `--all-sources` or a
narrower `--root`.

| Source | Score | Probe (all must hold) | Evidence printed |
| --- | --- | --- | --- |
| `next-app` | 100 | `next` in dependencies **and** at least one file matching `**/app/**/page.{tsx,jsx,ts,js}` | first `page.*` file |
| `next-pages` | 100 | `next` in dependencies **and** a page file (not `pages/api/**`, not a special root file) under the active `pages/` root | first page file |
| `next-pages` | 1 | `next` in dependencies and only `pages/api/**` files | first API file; never live on its own, runs as the `next-app` companion |
| `react-router-framework` | 100 | `@react-router/dev` or `@remix-run/dev` in dependencies **and** one of: `<appDirectory>/routes.{ts,mts,js,mjs}`, a file under `<appDirectory>/routes/`, a `remix.config.*`, or a `remix(`/`reactRouter(` call in `vite.config.*` | dependency + the first trigger found |
| `tanstack-router` (file-based) | 100 | `@tanstack/react-router` or `@tanstack/react-start` in dependencies **and** a literal `createFileRoute(` or `createLazyFileRoute(` in a non-generated source file | dependency + every such call |
| `tanstack-router` (code-based) | 90 | same dependency, no file-route call, but a `createRoute(`, `createRootRoute(` or `createRootRouteWithContext(` call (or `<` for a type argument) | dependency + every such call |
| `adminjs` | 100 | `adminjs` in dependencies **and** a file that references the `AdminJSOptions` type **or** contains one object literal carrying both `resources` and `rootPath` | dependency + each matching file |
| `react-router` (data router) | 90 | `react-router` or `react-router-dom` in dependencies **and** a `createBrowserRouter(` / `createHashRouter(` / `createMemoryRouter(` call in an app file | dependency + each router call |
| `react-router` (JSX / hook) | 80 | same dependency, no data-router call, but a file that mentions `react-router` and contains `<Routes`, `<Route` or `useRoutes(` | dependency + first such site per file |
| `wouter` | 80 | `wouter` in dependencies **and** a file importing from `wouter` that contains `<Switch` or `<Route` | dependency + first such file |
| `react-router` (framework-mode project) | 1 | the `react-router(-dom)` dependency in a project where `react-router-framework` applies: the library source drops to a near-miss so it never competes with it | dependency + "framework-mode project" |
| `state-screens` | 51 | an MV3 `manifest.json` (see [Chrome MV3](#25-chrome-mv3-extensions)) | `"manifest_version": 3` line |
| `state-screens` | 1 | no MV3 manifest; a component returning JSX from two or more `return` statements | last-resort only, never live |
| `manifest-activation` | 1 | an MV3 `manifest.json` | never live on its own; runs as the `browser-extension` preset's companion |
| `vue-router` (explicit routes) | 90 | `vue-router` or `unplugin-vue-router` in dependencies, **no** `nuxt` dependency, and a non-generated source file with a `createRouter(` call, a `from 'vue-router'` import and the word `routes` | dependency + each `createRouter` file |
| `vue-router` (file routes) | 100 | same dependency rule, and either `unplugin-vue-router` in dependencies or a file importing `vue-router/auto-routes`, `vue-router/auto` or `unplugin-vue-router/*`; when a router file exists it must pass the auto-routes module to `createRouter` | first importing file (or `package.json`) |
| `nuxt` | 100 | `nuxt` in dependencies **and** a pages directory (`pages/`, `app/pages/`, or the one `nuxt.config` names) with at least one page file, or an `app.vue` | dependency + first page file or `app.vue` |
| `angular` | 90 | `@angular/router` **and** `@angular/core` in dependencies, and a non-generated source file with a `provideRouter(` or `RouterModule.forRoot(` call | dependency + each such call |
| `angular` | 0 | no `@angular/core` dependency (an AngularJS-only project: `angular` 1.x, no `@angular/*`) | never live; the run ends at `project/no-screen-source` |
| `expo-router` | 100 | `expo-router` in dependencies **and** a route file under the routes directory (the plugin `root`, `expoRouter.root`, `app/` or `src/app/`; see [Expo Router](#211-expo-router)) | dependency + the first route file |
| `react-navigation` | 90 | an `@react-navigation/*` package in dependencies, **no** `expo-router` dependency, and a `create…Navigator(` call in an app file | the first such call |
| `react-navigation` | 0 | `expo-router` in dependencies | never live; Expo Router owns the project |

When no source scores ≥ 50, the run warns `project/no-screen-source` and lists the near-misses.

**Nested packages.** Files under a subdirectory that has its own `package.json` (the outermost such
directory when they nest) are invisible to the root's scoring, so a nested extension, docs site or
sub-app cannot make the root multi-source. `doctor` lists each one under "nested packages (not scored
for this root)" with the sources it would have matched and the `--root` that maps it. The scoping is
detection-only: an explicit `--source` or `--all-sources` run still discovers across the whole root.
The rule applies only when the root itself has a `package.json`; a root without one (a plain folder
holding an app) scores everything beneath it, so `--root my-workspace/` still maps `my-workspace/app/`
(`nestedPackagesOf`, `src/detect/project.ts`). The same scoping keeps nav auto-discovery (§3) inside
the root's own package.

For react-router, "app file" excludes the throwaway routers that tests, mocks and Storybook build:
anything under a `test/`, `tests/`, `__tests__/`, `test-utils/`, `__mocks__/`, `mocks/`,
`.storybook/` or `storybook/` directory, and any `*.test.*`, `*.spec.*` or `*.stories.*` file. These
are excluded from both detection and discovery.

**Dependency presence.** The dependency union is read from the root `package.json` plus the
`package.json` at every ancestor directory of each source root, across `dependencies`,
`devDependencies`, `peerDependencies` and `optionalDependencies`. Presence keys on the **manifest
key**, never the version value; an `npm:` alias (`"typescript": "npm:@typescript/typescript6@^6"`)
counts under its key name and is listed by `doctor`.

**Presets.** A live source selects its preset automatically: `react-router`, `next-app`,
`next-pages`, `react-router-framework`, `tanstack-router`, `adminjs`, `vue-router`, `nuxt`, `angular`, `expo-router`
(`app/` and `src/app/` as screen entry directories), `react-navigation` (`src/screens/`), and `browser-extension` (which runs both `state-screens` and
`manifest-activation`). A preset contributes `kindRules` for the stack's conventional directories
(`src/routes/`, `src/layouts/`, `app/`, `src/app/`, `src/admin/`, plus the data-layer directories
`services|api|clients|server`, `stores|store|state`, `hooks`) and, for TanStack, marks
`**/routeTree.gen.ts` as generated. The `react-router-framework` preset adds `app/routes/` as a screen
entry directory and marks `**/.react-router/**` and `**/+types/**` (typegen output) as generated.

**Companions.** A preset may name companion sources that run with its own: `next-app` and `next-pages`
are each other's companions (the Next family). A live set that sits inside one such bundle is not a
`project/multiple-screen-sources` refusal, and an explicit `--source next-pages` also runs `next-app`
(and the reverse). Any other combination of live sources still refuses; for example a project with both
a `pages/` directory and a TanStack `routes/` tree (Supabase studio) is refused until you pass
`--source`.

---

## 2. Screen sources

### 2.1 react-router

Packages: `react-router`, `react-router-dom` (v4/v5 `<Switch>` and v6/v7 library mode),
`react-router-dom-v5-compat`. Source: `src/adapters/react-router.ts` (reader in
`src/adapters/react-router/`, per-flavour attribute semantics in `src/adapters/route-flavours.ts`).
Framework mode is a separate source, [§2.9](#29-react-router-framework-mode-and-remix-v2).

Object-literal route arrays and JSX `<Routes>`/`<Route>` trees are read into one route model, so every
rule below about paths, elements, wrappers and outlets applies to both dialects.

**Route roots**

| Form | Status |
| --- | --- |
| `createBrowserRouter(routes)`, `createHashRouter(routes)`, `createMemoryRouter(routes)` (also as a member, `ReactRouter.createBrowserRouter`) | supported |
| `createBrowserRouter(createRoutesFromElements(<Route …>…</Route>))`, and `createRoutesFromChildren(…)` | supported — the JSX is read like a `<Routes>` tree |
| `useRoutes(routes)` | supported — same route-list forms as the factories. The name must be bound by import from `react-router(-dom)` (aliased, as a namespace member, or through an app re-export barrel such as `export { useRoutes } from 'react-router-dom'`); an app's own `useRoutes` hook is not a route root |
| `const create = wrapCreateBrowserRouterV6(createBrowserRouter)` (also `Hash`, `Memory`, any `V<n>`) imported from an `@sentry/*` package | supported — `create(routes)` is read as the factory. Only that wrapper form is recognised |
| JSX `<Routes><Route …/></Routes>` | supported. `<Routes>` and `<Route>` must be imported from `react-router(-dom)` or be unbound names. |
| A root whose argument is a call to a function with a single `return` of a readable route list (`createBrowserRouter(buildRoutes())`) | supported — the returned expression is read; with two or more `return`s the call is unreadable |
| A root whose argument is any other unreadable expression | warning `screens/dynamic-registry`; that root contributes no screens |
| `createStaticRouter`, `<RouterProvider>` alone | not read — only the forms above are route roots |
| React Router v7/v8 framework mode / Remix v2 (`app/routes.ts`, file routes) | not read by this source — see [§2.9](#29-react-router-framework-mode-and-remix-v2). In a project where `react-router-framework` applies, this source scores 1 (near-miss) and does not run |
| `<Switch>` (react-router v4/v5) | supported — a v5 root; see *react-router v5* below |
| `react-router` / `react-router-dom` declared below v4, or `<Route>` elements with no `<Routes>`/`<Switch>`, router factory or `useRoutes` root | not supported — **warning** `screens/unsupported-router-style`; only v4+ library mode is read |

Routers in test, mock and Storybook files are skipped (see [Detection and scoring](#1-detection-and-scoring)).
Other non-app routers — a `scripts/` file, say — are still read; `exclude` is the lever.

**Route-list forms** — accepted as a root's argument and as a route's `children`:

| Form | Status |
| --- | --- |
| Inline array literal | supported |
| `[...] as const`, `[...] satisfies RouteObject[]`, `as const satisfies …` | supported |
| Parenthesised, non-null (`!`) and stacked assertions (`(x as unknown as RouteObject[])!`) | supported |
| Identifier bound to a `const` in the same file, or imported from the module that declares it (up to four hops of indirection) | supported |
| Identifier imported through a re-export barrel (`export { routes } from './routes'`) | not supported — the declaring module must be the one imported |
| Spread elements `...childRoutes` (local or imported) | supported |
| Spread of an expression containing arrays (`...(isDev ? [...] : [])`) | supported — every array inside is read |
| The same imported list used as `children` of two parents | supported — read under both |
| JSX children of `<Route>`: nested `<Route>`, fragments (`<>…</>`, `<Fragment>`), `{cond && <Route …/>}` and other expressions that contain `<Route>` elements | supported |
| `{getAdminRoutes()}` in JSX children, where the function has a single `return` of a fragment, a `<Route>` or an array of them | supported |
| An array entry that names a `const` route object (`[home, pluginRoute]`, local or imported) | supported — read like an inline object |
| An array entry that is neither a route object, a named route object nor a spread | **warning** `screens/unsupported-router-style`; skipped |
| `{routes.map((r) => <Route …/>)}` over a literal `const` array of route objects (local or imported; a `.filter(…)` of one; a ternary whose branches are such arrays; spreads of such arrays) | supported — see *Mapped route data* below |
| `<Route>` elements built inside a callback over any other data (fetched, computed, passed in) | **warning** `screens/unsupported-router-style`; those routes are not discovered |
| A JSX child that is neither `<Route>` nor a fragment, or an expression with no `<Route>` in it | **warning** `screens/unsupported-router-style`; skipped |

A spread or JSX expression whose text mentions `isDevelopment`, `import.meta.env.DEV`, `NODE_ENV` or
`__DEV__` marks every route inside it `devOnly` (a text probe; TanStack uses the structural reader in
§2.3). Children of a dev-only route inherit it.

**Mapped route data.** In `{items.map((route) => <Route path={route.path} element={route.element} …/>)}`
each object of the literal array becomes one route. `route.x` and destructured names
(`({ path, element }) => …`) are substituted into `path`, `element`, `Component`, `lazy` and `index`,
into the attributes of guard wrappers inside the element, and into a component tag
(`<route.component/>`). A route's `path` computed from the item (`` `/p/${page.slug}` ``) or not readable
after substitution gives **warning** `screens/unsupported-router-style`; the route and its children are
skipped. Each mapped route carries a `route data item` evidence line. An array entry that is not an
object literal warns the same way.

Registration is treated as a **runtime gate** when the route data is chosen at runtime: a `.filter`
whose predicate reads anything other than the item (`.filter(Boolean)` and predicates over the item's
own members read only the item) and any ternary between arrays. Such a route's `auth` becomes `unknown`
instead of `public` (a `protected` route stays `protected`), with an evidence line saying so.

A guard inside a mapped route's element that is handed the item (`<ProtectedRoute route={route}/>`)
gives `auth: unknown` with an evidence line, because which items it protects is decided at runtime;
a guard that does not read the item, or a protected parent, still gives `protected`.

**Route members** (object property or JSX attribute of the same name)

| Member | Read as |
| --- | --- |
| `path` | URL segment; string, template, `+` concatenation, `const`, enum member, `as const` / `Object.freeze` map member (local or imported). Relative paths join the parent's; a leading `/` replaces it. |
| `index` (`index: true`, `<Route index>`) | screen at the parent's URL |
| `element` | JSX: component tags become the screen's entries; wrapper tags are classified (below) |
| `Component: X` / `Component={X}` | the entry, classified exactly like `<X/>` |
| `lazy` | JSX written inside the `lazy` body (`return { element: <X/> }`, including the `Promise.all([import(), import()])` variant); when the body renders nothing, each `import('./X')` in it names the entry — the module's `Component` export, else its default export. An unresolvable module becomes a visible opaque entry. |
| `children` | nested routes (list forms above) |
| `errorElement`, `loader`, `action`, `handle`, `id`, `caseSensitive` | not read |

**Index ownership.** A route with an index child does not claim its own URL: the index child is the
screen at that URL and the parent is its layout. A route with neither a path nor `index` is a pathless
layout: no URL segment, and its element's innermost wrapper is spliced at `<Outlet/>`.

**Descendant routes.** A route whose path ends in `*` (`path="settings/*"`) and whose element's
component renders its own `<Routes>` or calls `useRoutes` gets those routes nested under its URL
(`/settings/...`), with the component as the layout ancestor spliced at its `<Routes>`. Only the
`<Routes>`/`useRoutes` inside that component's own declaration count. A `<Routes>` written inline in
the splat route's element (`element={<Shell><Routes>…</Routes></Shell>}`) nests the same way; each
nested list gets only the wrappers and guards that enclose its own mount, not those of other branches
of the element. Lists mounted side by side under one splat route that claim the same URL are merged
into one screen. When a nested route claims the splat parent's own URL, the parent gives up that URL
and only frames it, like an index owner. A route declared again at the same URL in one list is dropped
with **warning** `screens/conflict-dropped` (the first declaration renders).

**Unclaimed route lists.** A `<Routes>` or `useRoutes` list that no followed route claims is read
top-level only when that is provable: it sits under a router element (`BrowserRouter`, `HashRouter`,
`MemoryRouter`, `Router`, `RouterProvider`), it is in a component a router element renders through
plain component hops (not under a route), it is the app's only unclaimed list, or it belongs to a
factory call. Any other list could be a descendant list under a route this source cannot follow, so it
is withdrawn with **warning** `screens/conflict-dropped`, along with the descendant lists it mounts;
its routes are not discovered. The decision does not depend on file order, and applies whether or not
its URLs collide with another list's.

**Path syntax**

| Syntax | Result |
| --- | --- |
| `:param` | kept; listed in `params` |
| `*` splat | kept; least specific when matching navigation targets |
| Optional segment `:id?` | kept as the optional marker (`/users/:id?/edit`); matches with or without the segment |
| Optional static segment `edit?` | kept as written; matches a navigation target with or without the segment (ranked after a plain static segment, before a param) |

**Wrapper roles.** Tags inside `element`/`lazy` are classified by these defaults (matched by imported
binding first, then by tag name). `wrapperRoles` in `appgraph.config` adds rules, merged **by `name`**:
a rule named like a default replaces it, the others stay.

| Rule | Matches | Role | Attribute read |
| --- | --- | --- | --- |
| `protected-route` | `ProtectedRoute` or `PrivateRoute` | guard → `auth: protected` | `featureFlag`; `entryFrom: component` |
| `route-error-boundary` | `RouteErrorBoundary` | error boundary | `routeName` |
| `navigate` | `Navigate` from `react-router(-dom)` | redirect → `redirectTo` | `to` |
| `layout` | any tag ending `Layout` or `LayoutWrapper` | layout ancestor | `title` |
| `react-router-element` | any other `react-router(-dom)` import | transparent | — |
| `react-element` | `Suspense`, `Fragment`, `StrictMode`, `Profiler` | transparent | — |

Any other component tag is the screen's entry.

A screen's `shell` is the innermost ancestor whose role is `layout` (a guard or error boundary between it and the screen does not replace it); with no layout in the chain, the nearest ancestor.

**Wrapper `entryFrom`.** A `wrapperRoles` rule may set `entryFrom` (default `protected-route` has
`"component"`): the member of a mapped route item that holds the page component. In a mapped route, a
guard rule's tag that is handed the whole item (`<ProtectedRoute route={route}/>`) or that member makes
the page component the entry, with the evidence line "(via route prop)"; a member that is not an
identifier gives an opaque entry. The guard is spliced where its own declaration renders
`<route.component/>` (an at-locator), and falls back to its children when it does not. Tags that enclose
the guard and match no rule (`<LayoutPicker><ProtectedRoute route={route}/></LayoutPicker>`) become
layout ancestors instead of the entry.

**Route-list reads.** A `const` declared inside a function body (a component or a builder) can be a
`children:` list or a route root's list. All router factories (`createBrowserRouter` and friends) share
one merge scope, so two factories that claim the same URL merge into one screen instead of raising
`screens/duplicate-id`.

**Route dialects (`reactRouter.routeDialect`).** Apps whose route objects are not react-router's own
(Sentry's `SentryRouteObject`) declare the shape in `appgraph.config`:

| Key | Meaning |
| --- | --- |
| `name` | label only |
| `fields` | property names, each optional, over react-router's own: `path`, `element`, `component`, `children`, `redirect`, `index`, `lazy` (react-router has no `redirect` field) |
| `translators` | calls whose arguments are dialect routes (`translateSentryRoute`) |
| `unwrapCalls` | wrapper calls whose first argument is the real route or component (`memoize`, `errorHandler`) |
| `prefixRules` | `{ flag, prefix, keepPlain }`: a route whose `flag` property is `true` is also mounted at `prefix` joined with its path; with `keepPlain` the plain route stays too (a dual route, evidence `dual route (<flag>)`), else the evidence is `prefixed route (<flag>)` |

Scoping: when `translators` is set, the dialect's field names apply only inside translator arguments;
everywhere else plain react-router names apply. Without `translators` they apply to every route object.
Merge: a later config layer's `routeDialect` replaces the earlier one as a whole. An unknown key is
`config/unknown-field`; `routeDialect` at the top level hints `reactRouter.routeDialect`.

**Built-in Sentry preset.** With no `routeDialect` configured and a `@sentry/*` dependency, the preset
applies: `translators: [translateSentryRoute]`, `fields: { component, redirect: redirectTo }`,
`unwrapCalls: [errorHandler, memoize]`, `prefixRules: [{ withOrgPath, /organizations/:orgId, keepPlain }]`.
It also reads `make(() => import('./X'))` lazy components (the module's `Component` export, else default).
`redirectTo` gives the route a `redirectTo`; a relative target resolves against the route's own URL
(one leading `../` against its parent). `withOrgPath` gives two routes, plain and `/organizations/:orgId/…`,
with the evidence "dual route (withOrgPath)". `routeHook(...)` entries and template paths that cannot be
folded keep **warning** `screens/unsupported-router-style`, once each even under a dual route.
`customerDomainOnlyRoute` is not modelled, so some of its routes end as `screens/conflict-dropped`.

#### react-router v5 (`<Switch>`)

The unit of variation is the route **root**, not the project: a `<Switch>` imported from
`react-router(-dom)` is read as a v5 root and a `<Routes>` as a v6 root, so an app that mixes
`react-router-dom` v5 with `react-router-dom-v5-compat` reads each root by its own rules. The module
name may carry the `-v5-compat` suffix. Everything above that is not v5-specific (guard wrappers,
layouts, lazy, path constants, descendant lists) applies unchanged.

| v5 form | Read as |
| --- | --- |
| `<Route path component={X}/>` | entry `X` |
| `<Route path render={() => <X/>}/>` | the returned JSX, read like `element` |
| `<Route path><X/></Route>` (children as the element) | the element is what the route renders; its JSX children are not nested routes |
| `path={['/a', '/b']}` | one screen per path, in array order |
| `exact`, `strict` | recorded as evidence only; they change how a URL matches, not which URL a route has |
| A route without `exact` | matches by prefix, so a `<Switch>` rendered by its component nests under its URL |
| `<Route>` with no `path` in a `<Switch>` | catch-all (`*`) |
| `<Redirect from="/a" to="/b"/>` | a route at `/a` with `redirectTo: /b`; `to` params are substituted |
| `<Redirect to="/b"/>` with no `from` | catch-all redirect |
| Path syntax `:id?`, `:id*`, `:id+`, `:id(\d+)` | converted from path-to-regexp syntax |
| A literal path with a query string (`/x?tab=1`) | read at the pathname, with info `screens/unsupported-router-style` |
| `` `${match.path}/rest` ``, `match.path` or `useRouteMatch().path` as a path | joined onto the route that matched; any other template path is `screens/unsupported-router-style` |
| `const [routes] = useState(defaultRoutes)` as the route list | the initialiser is read as the list and treated as a **runtime gate** (`auth` becomes `unknown`, not `public`) |
| `routes.push(...)` / `routes.unshift(...)` in the declaring file | read as appended / prepended route data; a push inside an `if` is gated by that condition's text |

Guards and layouts that enclose a top-level `<Switch>` frame every route in it. `.map` over a
literal array of route objects works as for v6 (*Mapped route data*). The `react-router-dom` /
`react-router` range declared in `package.json` below v4 gets the `screens/unsupported-router-style`
warning.

#### wouter

`wouter` is its own source, read by the same reader with a wouter profile
(`src/adapters/react-router/profile.ts`): module `wouter` or `wouter/preact`, the `wouter` dependency
required. It scores 80 when a file imports from `wouter` and contains `<Switch` or `<Route`.

| wouter form | Read as |
| --- | --- |
| `<Switch>` | a root; first match wins |
| Sibling `<Route>`s outside a `<Switch>` | one non-exclusive root (every match renders) |
| `<Route path component={X}/>`, `<Route path>{children}</Route>`, `{(params) => <X/>}` | entry `X` / the children / the returned JSX |
| `<Route path="/app" nest>` | prefix route; JSX children and a `<Switch>` rendered by its component are relative to `/app` |
| `<Router base="/x">` around a root in the same file | prefixes every path in it; nested bases stack |
| `<Route>` with no `path` | catch-all (`*`) |
| `<Redirect to>` in a `<Switch>` | redirect at its `path`, or a catch-all redirect without one |
| Path syntax `:id`, `:id?`, `*`, `*?` | converted; `*` and `*?` both become a trailing `*` |
| A regex `path` | `screens/unsupported-router-style` |

A `base` set in a parent component in another file is not followed, and loose routes produced by
`.map` are not grouped. No large public wouter app is known, so the source is verified on a synthesized fixture.

### 2.2 Next.js App Router

Package: `next`. Source: `src/adapters/next-app.ts`, URL conversion in `src/core/url.ts`.

| Convention | Status |
| --- | --- |
| `page.{tsx,jsx,ts,js}` under any directory named `app` (`app/`, `src/app/`, nested apps) | screen; entry is the default export. The URL is taken from the **outermost** (first) `app` segment of the path, so a nested `app/` directory is part of the URL, not a second root. |
| `route.{ts,js}` | screen tagged `kindTag: apiRoute` (`kind: api`), listed apart from human screens |
| Static segment `about/` | `/about` |
| Dynamic `[id]` | `:id` |
| Catch-all `[...slug]` | `*` |
| Optional catch-all `[[...slug]]` | `*` — the bare parent URL (zero segments) is **not** emitted as a second activation |
| Route group `(marketing)` | dropped from the URL, nested groups included |
| `layout.{tsx,jsx,ts,js}` in each directory from `app` down | layout ancestor (spliced at `children`) |
| `template.{tsx,jsx,ts,js}` | transparent ancestor |
| Parallel route `@slot` | slot files (`page.*`, `default.*`, anything under `@x/`) never become screens; see [Parallel and intercepting routes](#parallel-and-intercepting-routes) |
| Intercepting routes `(.)`, `(..)`, `(..)(..)`, `(...)` | the intercepting page never becomes a screen; its target screen gets an `intercept` activation |
| `route.tsx` / `route.jsx` | not a screen (the screen glob is `route.{ts,js}`); handlers in them are still read as endpoints |
| `loading`, `error`, `not-found`, `global-error`, `default`, metadata files, `middleware` | not read |
| Private folders `_components/` | opted out: no `page.*` or `route.*` under a `_` folder becomes a screen |
| `%5Fsegment/` | the escape for a real URL segment starting with `_` (`/_segment`) |
| Pages Router (`pages/`) | read by a separate source, [`next-pages`](#28-nextjs-pages-router), which co-runs with this one |

Server code from the same stack is read by the [RPC extractor](#42-rpc-and-server-functions):
`"use server"` actions and `route.*` HTTP handlers.

#### Parallel and intercepting routes

- **Slot branches.** A `layout.*` with `@x` beside it gets, per slot, one branch on the screen's ancestor
  chain: the slot page whose URL matches the screen's remainder below the layout (shape match, param
  names erased), else the slot's `default.*`, conditioned `slot x`. Each intercepting page of that slot
  whose target is the screen adds a further branch, conditioned `slot x` and `intercepted from <from>`.
  Branch choice is fixed and stated in the graph limitations; it is not verified against the code that runs.
  The kernel keeps a branch only when the layout renders the slot prop (`walk/no-splice-point` otherwise).
- **Intercept activation.** A page under `(.)x`, `(..)x`, `(..)(..)x` or `(...)x` adds
  `{ kind: "intercept", from, slot, file }` to the target screen: `from` is the URL of the directory
  holding the marker, `slot` the enclosing `@slot` (`null` outside one), `file` the intercepting page.
  The target is the marker resolved against `from` (`(...)` from the app root), matched to a page by
  exact URL, else by the sole page of the same shape with param names erased.
- **Diagnostics** (`screens/unsupported-next-convention`). Warning: the target matches no single page,
  or the marker climbs above `app`; no screen gets the activation. Info: an interception outside any
  `@slot` (the target still gets the activation, the intercepting page joins no tree), a slot page that
  matches no page below its layout, an `@slot` with no `layout.*` beside it.

#### Redirects

Redirect rules come from two always-on sources, which are merged: the `redirectRules` config field and
the static reader of the root `next.config.{ts,mts,js,mjs}` (the first that exists; it runs whatever the
screen source is). Rules use Next's `source`/`destination` syntax. The reader never evaluates the config:

- **Config shape.** `export default` or `module.exports =`, unwrapped through any HOC call
  (`withSentryConfig(withX(cfg), opts)`: the first argument), a ternary (union of both branches), an
  identifier bound to a local or imported `const`, or a function (`(phase) => cfg`) with one `return`.
- **`redirects`.** A method, an arrow or function property, or a shorthand name bound to a function with
  a single `return`; a second `return` makes it unreadable.
- **Array contents.** Literals, spreads of local or imported `const` arrays, calls to single-return
  functions, and ternaries. Both ternary branches are kept, each rule carrying its condition
  (`cond` or `!cond`; nested ones joined with `&&`) as `redirects[].condition`.
- **Conditional.** A rule with `has` or `missing` is listed (with `declaredAt`) but never resolves a link,
  and neither does one from a ternary branch.
- **Unreadable.** A regex `source`, a non-literal `source`/`destination`, a non-object entry, or an
  expression the folder cannot follow is counted, never guessed. One `nav/redirect-unreadable` warning
  per config file lists up to 5 `file:line` sites, then "and N more".

**Resolution.** A menu entry or navigation that matches no screen is looked up against the rules: a
direct screen match always wins; otherwise the first eligible rule by code point of `source`, then
`destination`, is applied (its params substituted into the destination), repeating up to 5 hops, a loop
or a miss leaves the link dead. The result records `viaRedirect: { from, to }` on the navigation edge or
menu entry. Conditional rules, `/*`-like rules (every segment a param, one a catch-all) and
external or relative destinations never resolve. `basePath` is not applied: rules are matched against the
URL as the screen source reports it.

### 2.3 TanStack Router

Packages: `@tanstack/react-router`, `@tanstack/react-start`. Sources:
`src/adapters/tanstack-router.ts` (file-based), `src/adapters/tanstack-code-routes.ts` (code-based),
`src/adapters/tanstack-route-options.ts` (route options shared by both). Both run under the one
`tanstack-router` source; a project may mix them.

#### File-based routes

| Form | Status |
| --- | --- |
| `export const Route = createFileRoute('/path')({ component: Page })` | screen; the entry is the **page component** `Page` (local, inline, imported — barrels followed — or `lazyRouteComponent(() => import(…), 'Export')`). A route with no readable component keeps its route module's `Route` export as the entry. |
| `createLazyFileRoute('/path')({ component })` in `x.lazy.tsx` | merged into the route of the same-named critical file `x.tsx`: one screen. The `.lazy` half's `component` wins over the critical file's. A `.lazy` file with no critical twin is a screen of its own. |
| Aliased import `import { createFileRoute as fileRoute }` | supported |
| An app-declared function named `createFileRoute`, `createRoute` or another TanStack factory (a local, a hook result, or a project module's own export) | not a route factory — ignored, so a store action or helper of that name creates no screen |
| An app wrapper of that name whose declaring module imports **and** calls the real TanStack factory | **warning** `screens/dynamic-registry` naming the wrapper and its declaring file, once per call; the route it creates is not read. Test, mock and generated files are skipped |
| Path literal wrapped in parentheses, `as const`, `satisfies string`, or folded from constants | supported |
| Path that does not fold (dynamic template) | the URL is derived from the filename instead (under virtual file routes: warning `screens/dynamic-registry`, route skipped) |
| In a literal: `.`, a bare `_` segment, and whole segments named `routes`, `route` or `lazy` | read as literal URL text — `'/files/v1.2'` is `/files/v1.2`, `'/api/route'` is `/api/route` (a literal is a URL, not a filename) |
| Literal and filename disagree | warning `screens/stale-route-literal`; **the literal wins** |
| Several route calls in one file | one screen each (no `.lazy` merge, no layout detection) |
| `src/routeTree.gen.ts` | not opened, except under virtual file routes (below) |
| TanStack Start **server route**: a route with a `server` option (handlers) and no `component` | screen tagged `kindTag: apiRoute`, with the evidence line `tanstack start server route`; listed apart from human screens. Not applied to a pathless layout |

**Filename conventions** (for the cross-check, the fallback URL and the ancestor chain; the path is
taken after the last `routes/` directory unless a custom routes directory is configured, and both `/`
and `.` separate segments):

| Filename | URL |
| --- | --- |
| `users.$userId.tsx` | `/users/:userId` |
| `files.$.tsx` (bare `$`) | `/files/*` |
| `posts.{-$lang}.tsx` | `/posts/:lang?` (optional param) |
| `posts.{$id}.tsx`, `user-{$id}.tsx` | `/posts/:id`, `/user-:id` — a braced param, alone or embedded in a segment |
| `orders.$id.edit.tsx` | `/orders/:id/edit` |
| `posts.index.tsx`, `posts/index.tsx` | `/posts` |
| `posts/route.tsx`, `posts.route.tsx`, `posts.lazy.tsx` | `/posts` — the reserved tail configures `posts` itself |
| `_authed/dashboard.tsx`, `_authed.orders.index.tsx` | `/dashboard`, `/orders` — the `_` layer is pathless |
| `(auth)/login.tsx` | `/login` — route groups are dropped |
| `(auth)/route.tsx` | a pathless layout (no URL) for the routes in the group |
| `robots[.]txt.ts`, `sitemap[.]xml.tsx` | `/robots.txt`, `/sitemap.xml` — the `[x]` escape is unescaped and kept literal (it does not split segments or read as `_x`, `(x)` or `index`) |
| `posts.[_]foo.tsx` | `/posts/_foo` — an addressable route, **not** a pathless `_foo` layer. The filename tells the two apart: `posts/_foo/x.tsx` is still the pathless layer. `org.[_].tsx` is `/org/_` |
| `posts_.$id.edit.tsx` (trailing `_`) | `/posts/:id/edit`, **not** nested under `posts.tsx` |
| `__root.tsx` | root ancestor |
| `-`-prefixed ignored files | not understood — kept literally |

**Escaped segments (`[_]foo`).** TanStack's generator writes `posts.[_]foo.tsx` as
`createFileRoute('/posts/_foo')`, unbracketed, which on its own reads as a pathless layer. The
filename's `[_]` escape decides: the segment is a literal `_foo`. Both the `'/posts/_foo'` and the
`'/posts/[_]foo'` literal are accepted for such a file, and neither raises `screens/stale-route-literal`.
The same literal in a file with no escape stays a pathless layer.

**Custom routes directory.** By default route files are placed under their last `routes/` directory.
A configured directory replaces that: it is an exact, project-relative prefix, and a file outside it is
converted whole. It is read from the analyzed root's own configs (`tsr.config.json`, `vite.config.*`,
`app.config.*`):

- `tsr.config.json` `routesDirectory` (JSON; `./src/pages` and `src/pages` are the same);
- a string-literal `routesDirectory` in the options of `tanstackRouter(…)` or `TanStackRouterVite(…)`;
- `tanstackStart({ srcDirectory, router: { routesDirectory } })`, the routes directory relative to
  `srcDirectory` (default `src`; default routes directory `routes`).

A value that is non-literal, not a string, outside the analyzed root, or that disagrees with another
config's value is not used: the default applies, and one info `screens/dynamic-registry` names the
config `file:line` and why. Under virtual file routes (above) the routes directory is not read at all;
virtual mode takes precedence.

**Layouts and ancestors**

- A pathless file (`_authed.tsx`, `_authed/route.tsx`) is a layout with no URL.
- A route with an index child (`posts.tsx` + `posts/index.tsx` or `posts.index.tsx`) is that child's
  layout, not a second screen at `/posts`.
- Ancestor chain: `__root.*`, then every route file above the screen — pathless or not — located
  through the same tokens. A route that renders `<Outlet/>` (as written, aliased, or as
  `<Router.Outlet/>`) is a layout; one that renders exactly one imported component that renders
  `<Outlet/>` splices there instead.
- A route with **no `component`** (in either half) renders an implicit `<Outlet/>`: it is a
  transparent link, never a missing splice point. The same holds for a `createRootRoute` without one.
- The pathless segment `_authed` marks its screens `auth: protected`. `pathlessRoles` in
  `appgraph.config` (`{ _admin: { auth: "protected" } }`) adds or overrides roles, merged **by key**
  over that default; to drop the default, set `_authed: {}`.

**Virtual file routes.** A `virtualRouteConfig` key in the analyzed root's own `tsr.config.json`,
`vite.config.{ts,mts,js,mjs}` or `app.config.{ts,js}` (a text match; a nested package's config and the
`@tanstack/virtual-file-routes` dependency alone do not count) switches the source to virtual mode:

- the filename says nothing about a route, so the filename cross-check (`screens/stale-route-literal`)
  is off and the `createFileRoute` literal is the only path source; a route whose literal is unreadable
  warns `screens/dynamic-registry` and is skipped;
- layout chains are read from the generated tree — `src/routeTree.gen.ts`, or the `generatedRouteTree`
  string in the same config. A route is placed only when the tree's `id`s, joined from the root down,
  spell its `createFileRoute` literal, and every parent in the chain is a route this source read; the
  evidence says the chain came from the generated tree;
- otherwise (no tree, the tree disagrees with the literal, or a parent is unread) the route carries no
  ancestors, and **one** `screens/dynamic-registry` warning names the first five affected files.

**Dev-only routes** (file and code routes; `src/adapters/route-conditions.ts`). A route is `devOnly`
when:

- its declaration sits under a development-build condition — the `true` branch of a ternary, the
  right operand of `&&` (or of `||`, with the condition negated), or an `if`/`else` branch — read
  structurally:
  `__DEV__`, `isDevelopment`, `import.meta.env.DEV`, `!import.meta.env.PROD`,
  `process.env.NODE_ENV === "development"` / `!== "production"`, the same for `import.meta.env.MODE`,
  with `!`, parentheses, `&&` and `||` combined;
- its `beforeLoad` throws (`notFound()`, `redirect()`, …) only in a production build;
- (code routes) every `addChildren` registration of it is dev-gated — `DEV ? [devRoute] : []`,
  `...(DEV ? devRoutes : [])`, or `if (DEV) children.push(devRoute)` on an array later passed in;
- or a route above it is dev-only.

The evidence line says which.

#### Code-based routes

| Form | Status |
| --- | --- |
| `const rootRoute = createRootRoute({ component })`, `createRootRouteWithContext<Ctx>()({ … })` | root of the tree; not a screen |
| `const r = createRoute({ getParentRoute: () => parent, path: 'posts', component })` | screen; URL is the parent's URL joined with `path` (leading `/` optional) |
| `getParentRoute` naming a route declared in the same file or imported (barrels followed) | supported |
| `path: '/'` or `''` | index route at the parent's URL; the parent becomes its layout |
| `id: '_layout'` with no `path` | pathless layout; an `id` of `_authed` marks the routes below it `auth: protected` |
| `$param`, `$`, `{-$param}` in `path` | `:param`, `*`, `:param?` |
| `component: Page`, inline arrow/function, `lazyRouteComponent(() => import('./Page'), 'Page')` | the entry (named export, default `default`) |
| `createRoute({…}).lazy(() => import('./x.lazy').then((d) => d.Route))` with `createLazyRoute('/x')({ component })` in that module | the lazy module's `component` is used when the route declares none |
| `getParentRoute` | authoritative for the tree |
| `parent.addChildren([...])` (arrays, spreads, ternaries, object values, arrays named by a local or imported `const`, and `.push`es onto them) | the fallback parent when `getParentRoute` is missing or unreadable **and** exactly one parent registers the route; also the source of `addChildren`-only dev gating. When it disagrees with a readable `getParentRoute`: `getParentRoute` wins, and warning `screens/route-parent-mismatch` is raised only when a registering parent's URL does not cover the route's own URL (`/a` covers `/a` and `/a/b`, never `/ab`; `/` covers all). A disagreement where every registering parent covers it is only an evidence line on the route |
| Routes and `addChildren` registrations in test, mock and Storybook files (`isNonAppFile`) | never contribute router roots or mount routes into the app's tree. A route declared there is kept only when the app's tree mounts it (an `addChildren` in an app file, or inside an already admitted non-app subtree) |
| A route declared in a non-app file that no app `addChildren` mounts | dropped, with one info `screens/unmounted-route` per project listing up to five (`name (file)`) and "and N more". A tree rooted entirely in non-app files (a test harness) is silent |
| `createRouter({ routeTree })` | not read |
| No readable parent from either source, a non-string `path`, or a cycle | warning `screens/dynamic-registry`; that route and every route below it are skipped |

#### Route options (both styles)

| Option | What is read |
| --- | --- |
| `validateSearch` | The keys of the first object literal inside it (`z.object({ page: …, q: … })` → `page`, `q`) as search-param **names only**. Required-ness is never inferred: info `facts/needs-typechecker`. |
| `beforeLoad` | Read by the [loader-guard rule](#loader-guards): a conditional `redirect({ to })` (in an `if`/ternary, or after an earlier exit; a helper is followed one hop) makes the route and every route below it `auth: protected`, with the condition text in the evidence; an unconditional one sets `redirectTo`. `redirects.unauthenticated` narrows protection to redirects aimed at that target. A `beforeLoad` on the root route is not inherited by the other routes. A conditional guard wins over a pathless role's `auth: public`, and says so in the evidence. |
| `component` | the entry and the splice scope, as above |
| `loader` and other options | not read for screen metadata |

`createServerFn` endpoints are covered under [RPC and server functions](#42-rpc-and-server-functions).

### 2.4 AdminJS

Package: `adminjs`. Source: `src/adapters/adminjs.ts`.

`adminjs: { optionsFile?, componentLoaderFile? }` in `appgraph.config` names the options file (the
content probe is skipped, and AdminJS scores 100 on that file even when the probe would not recognise
it) and the `componentLoader` file (when it is not reachable by import). A path that is not a file is
`config/missing-file`.

**Finding the options object.** In each detected file: the object literal passed to
`new AdminJS({ … })` if there is one, otherwise the outermost object literal carrying `resources`
or `pages`. A file that matched detection but has neither is a near-miss.

| Option | Read as |
| --- | --- |
| `rootPath` | URL prefix; folded like any string; default `/`; a trailing `/` is added |
| `resources` | inline array, a local `const`, or a `const` imported from the module that declares it |
| each resource element | inline `{ resource, options: { … } }` (or an object with `id`/`actions`), **or** a call `createOrdersResource()` resolved to its function declaration (local or imported, barrels followed) |
| `options.id` | the resource id: literal, folded constant, or enum member (`Resource.Orders`, local or imported) |
| `options.actions` | every declared action; `actionType: 'record'` makes it record-scoped, `actionType: 'bulk'` (and the built-in `bulkDelete`) bulk-scoped |
| `pages: { name: { component } }` | one screen per page |
| `loginPath` | a public screen with no render tree |
| `dashboard`, `branding`, `locale`, `assets` | not read |

**URLs**

| Screen | URL template |
| --- | --- |
| resource list (`list`) | `${rootPath}resources/${id}` |
| resource-scoped action | `${rootPath}resources/${id}/actions/${action}` |
| record-scoped action (`show`, `edit`, `delete`, or `actionType: 'record'`) | `${rootPath}resources/${id}/records/:recordId/${action}` |
| bulk action (`bulkDelete`, or `actionType: 'bulk'`) | `${rootPath}resources/${id}/bulk/${action}` |
| page | `${rootPath}pages/${name}` |

`list`, `new`, `show` and `edit` are synthesised for every resource even when not declared. A
custom action with no `actionType` is assumed resource-scoped. A resource with no `options.id`
gets **warning** `screens/dynamic-registry` and no screens: AdminJS would take the id from its
database adapter, which this source does not read, so set `options.id` to map it.

**Components.** An action's or page's `component` is resolved through the `componentLoader`
registry: `Components.Foo` or a string key, looked up in calls `componentLoader.add('Foo', './Foo')`
/ `.override(…)` (and object members whose value is such a call). The loader file is the module the
options file imports as `Components` or `componentLoader`. `component: false` or no component means
an AdminJS-rendered screen: `kindTag: generated` with an **empty render tree by design**. A
component expression that is not a readable loader key becomes an opaque entry with info
`screens/dynamic-registry`; an id that does not fold gives a screen with no URL and a warning.
Every AdminJS screen has `ancestors: []` — the AdminJS shell is library code.

### 2.5 Chrome MV3 extensions

Sources: `src/adapters/manifest-activation.ts` (one screen per manifest surface) and
`src/adapters/state-screens.ts` (one screen per guarded top-level JSX branch). Both run under the
`browser-extension` preset.

**Manifest.** Any `manifest.json` (outside excluded directories) whose **field**
`manifest_version` is `3` and that declares at least one surface. A PWA `manifest.json` is ignored.

| Manifest key | Surface |
| --- | --- |
| `action.default_popup` | popup screen: HTML → `<script src>` → module |
| `background.service_worker` | background screen |
| `content_scripts[].js[]` | one content-script screen per script; `matches` become host-pattern activations |
| `"offscreen"` in `permissions` / `optional_permissions` | offscreen-document screen; the HTML is taken from `web_accessible_resources` or the `offscreen.html` convention |
| `manifest_version: 2`, `background.scripts`, `options_page` / `options_ui`, `side_panel`, `devtools_page`, `chrome_url_overrides` | not read |

**From built asset names back to source.** A manifest names built files, so each reference is
probed in this order: the path as written (manifest- and root-relative, with source extensions),
then the `input` map of any `vite.config.*` / `rollup.config.*` (`input: { content: resolve(__dirname,
'src/content/index.tsx') }`), then a unique basename match. Two basename candidates resolve to
nothing, with warning `screens/unresolvable-script`. A content-script loader stub —
`import(chrome.runtime.getURL('assets/content.js'))` (or `browser.runtime.getURL`) — is followed
through the bundler input map to the real module.

**State screens.** Holder components are the popup module, each content-script module, and every
component those modules import and render. In each holder, the guarded alternatives of its returned
JSX become screens: `if (x) return <A/>; return <B/>` (B gets `!(x)`), nested `if`/`else`, and
inline `cond ? <A/> : <B/>` / `cond && <A/>`. Guards are kept as text. Screen identity is the branch
ordinal, never the guard text. Without an MV3 manifest the source only scores 1. `entryComponents:
[{ file, exportName? }]` in `appgraph.config` names the holders directly and replaces the
manifest-derived set; a file that does not exist is `config/missing-file`.

The message graph between surfaces comes from the [messages extractor](#49-messages-chrome-extension-protocol).

### 2.6 vue-router

Source: `src/adapters/vue-router.ts` (records in `vue-route-records.ts`, file routes in
`vue-router-files.ts`, auth in `vue-auth.ts`). Vue 3 only. `.vue` files are read through a built-in
single-file-component splitter, so `<script>` / `<script setup>` code, route tables and page files need
no extra dependency; **template** facts need the optional `vue` peer (`>=3.4 <4`, resolved from the
project, then from appgraph's own install). Without it the run warns `project/template-compiler-missing`
(or `project/template-compiler-unsupported` for an out-of-range compiler or a Vue 2 manifest) and skips
templates. The source scores 0 when `nuxt` is a dependency, so a Nuxt repo never has two live sources.

#### Route roots

| Form | Status |
| --- | --- |
| `createRouter({ routes })` imported from `vue-router` (`createWebHistory`, `createWebHashHistory` and `createMemoryHistory` are irrelevant to the read) | supported |
| `routes` as an inline array, an identifier bound to a `const` (local or imported), or a `.map(...)` / `.filter(...)` chain over one (the receiver is read) | supported |
| Array spreads (`...childRoutes`), `.concat(...)` | supported — folded by the shared array folder; an item it cannot fold becomes warning `screens/unsupported-router-style` naming the item |
| `createRouter(options)` with no readable `routes` member | warning `screens/dynamic-registry`; that router contributes no screens |
| `router.addRoute(...)` | not read — one info `screens/dynamic-registry` with the call count and up to five `file:line` sites |
| Two records with the same URL | the first in tree order wins; a verbatim repeat of the same path is warning `screens/conflict-dropped` (vue-router matches the first declaration), a different spelling that lands on the same URL merges into one screen with both entries |
| Vue 2 projects | not supported (see the compiler diagnostics above) |

#### Route records

| Member | Read as |
| --- | --- |
| `path` | URL segment; string, template, `+` concatenation, `const`, enum member (the string folder of §8). Relative paths join the parent's, a leading `/` replaces it. `:id` and `:id?` are kept, a custom regex is stripped (`:id(\\d+)` → `:id`), and a repeatable (`:id+`, `:id*`) or any-match (`:id(.*)`, `/:pathMatch(.*)*`) parameter becomes `*`. A path that does not fold: warning `screens/unsupported-router-style`, the route and its children are skipped |
| `component` | the entry. An identifier (an import, or a `const X = () => import('./X.vue')` lazy binding, also `defineAsyncComponent(() => import(...))`) or an inline arrow with `import()`. A factory with several imports gives one entry per import and the routing `if`/ternary conditions as evidence `component chosen at runtime by …`; an unreadable component is a visible opaque entry |
| `components: { default, name }` (named views) | `default` first, then every other view by codepoint order, as extra entries of the one screen |
| `children` | nested routes (the list forms above). A parent that has a component and children becomes an outlet ancestor with `<RouterView>` as the splice point; a parent with no component is `kindTag: layout`, or `entryless` with no children and no redirect |
| An empty-path child (`path: ''`) | owns the parent's URL; the parent's own URL is then not a screen and its `redirect` is shadowed (evidence says so) |
| `redirect` | a path string (resolved against the parent), `{ name }` (resolved through the router's name table; an unknown name is evidence only), `{ path }`. A function or an unreadable expression sets no `redirectTo`; evidence says why |
| `name` | kept as the additive `Screen.routeName`, which resolves named-route navigation targets (`{ name: 'x' }`) in the kernel. A name declared twice: the first one (in tree order) wins |
| `meta` | read for `auth` only: `meta.middleware` (a string or a literal array) and boolean flags. See *Auth* |
| `beforeEnter` | evidence only (`per-route beforeEnter guard; evidence only, not asserted as protection`); never sets `auth` |
| `alias` | not mapped as screens — one aggregated info `screens/unsupported-router-style` with up to five sites |
| `props`, `sensitive`, `strict`, `end`, `components` other than named views | not read |
| A bare `RouterView` component (`component: RouterView`) | contributes no entry or ancestor; children render in the parent's outlet |
| `app.component('Name', X)` in a file that calls `createApp` | the component becomes an ambient registration, so templates using `<Name/>` get a render edge |

The root component of `createApp(App)` is an outlet ancestor of every screen (splice `RouterView`) when
exactly one distinct root is found.

#### Auth

`vueAuth` in `appgraph.config` adds names to the built-in lists (they are merged, never replaced):

| List | Default | Meaning |
| --- | --- | --- |
| `protectedMiddleware` | `admin`, `auth`, `authenticated`, `moderator`, `permission` | a `meta.middleware` entry here → `auth: protected` |
| `publicMiddleware` | `guest` | a `meta.middleware` entry here → `auth: public` |
| `authMetaKeys` | `auth`, `requireAuth`, `requiresAuth` | a boolean `meta` key here: `true` → protected, `false` → public |

Child routes inherit the nearest verdict; a record with both a protected and a public signal is
`unknown`. When no `meta` signal exists and the router file calls `.beforeEach(`, the screen stays
`unknown` and the evidence says `a global router.beforeEach guard decides access at runtime; auth is not
asserted` — an imperative guard with an exemption list (vikunja) is not evaluated, and claiming `public`
there would be a confident wrong fact.

#### File routes (unplugin-vue-router, Vue Router 5)

Scored 100 when `unplugin-vue-router` is a dependency or a file imports `vue-router/auto-routes`,
`vue-router/auto` or `unplugin-vue-router/*`. The generated route tree is never read; the conventional
`pages` tree is.

| Convention | Status |
| --- | --- |
| `src/pages/**/*.vue` | screens. The folder comes from a literal `routesFolder` option of the Vite plugin (`unplugin-vue-router/vite` or `vue-router/vite` in `vite.config.{ts,mts,js,mjs}`: a string, an array, or `{ src }` objects); no plugin call or no option means `src/pages`. A `routesFolder` that is not literal: info `screens/dynamic-registry`, the default folder is scanned |
| `index.vue` | the folder's own URL |
| `[id].vue`, `[[id]].vue` (optional), `[id]+.vue` / `[[id]]+.vue` (repeatable), `[...all].vue` | `:id`, `:id?`, `*` (required for `[id]+`, optional for `[[id]]+`), `*` |
| `(group)` folder or file part | dropped from the URL |
| `users.create.vue` (dot in the filename) | `/users/create` — a dot is a `/`, except inside `[…]` |
| `parent.vue` next to a `parent/` folder | nested: `parent.vue` is an outlet ancestor (`RouterView`) of the children under `parent/`; the dot form nests the same way |
| `definePage({ name, path, alias, redirect, meta })` with literal fields | overrides the file-derived value; `meta.middleware` and boolean `meta` flags feed `auth` |
| `<route>` custom block (`lang` `json` / `json5`, or none) | same overrides as `definePage`; the page's `definePage` wins over the block per field |
| A `definePage` without a literal object, or a `<route>` block in another `lang` | info `screens/unsupported-router-style`; the page keeps its file-based name, path and meta |
| `routeName` | the override, else the unplugin default name (`/users/[id]` style: each token joined as `/token`) |
| A `createRouter({ routes })` whose `routes` come from `vue-router/auto-routes` | takes this file-route path; one that passes a literal table takes the explicit path |

**Not read in either mode:** `scrollBehavior` and the `beforeResolve`/`afterEach` hooks. `lang="pug"` templates and `<template src>` / `<script src>` are not read: one info
diagnostic for unsupported template blocks per run, and the rest of the file is still read.

### 2.7 Nuxt

Source: `src/adapters/nuxt.ts` (component index in `nuxt-components.ts`, directories in
`src/core/nuxt-project.ts`). Nuxt 3 (`pages/`) and Nuxt 4 (`app/pages/`). Same optional `vue` peer for
template facts as vue-router.

#### Project directories

Read from literal fields of `nuxt.config.{ts,js,mjs,mts}` (`defineNuxtConfig({...})` or a plain export):
`srcDir`, `dir.pages`, `dir.layouts`, `dir.middleware`, `components` (a path, a `{ path, pathPrefix,
prefix }` object, or an array of them) and `extends`. Without them: `app/` when `app/pages` or `app/app.vue`
exists, else the project root. A field that is not a literal is listed as unreadable and the default is
used. When tsconfig has no `~`/`@`/`~~`/`@@` aliases they default to the source dir and the root; a
missing generated `.nuxt/tsconfig.json` is info (`generated by nuxi prepare; default aliases applied`)
instead of error `project/tsconfig-error`.

#### Pages

| Convention | Status |
| --- | --- |
| `pages/**/*.{vue,tsx,jsx,ts,js,mjs}` (`app/pages/` in Nuxt 4) | screens. Files named `-x`, `*.spec.*`, `*.test.*`, `*.stories.*`, `*.d.ts` and generated files are skipped |
| `index.vue`, `[id]`, `[[id]]` (optional), `[...slug]` (catch-all), `(group)` folders | `/`, `:id`, `:id?`, `*`, dropped from the URL. Nuxt has no dot-nesting rule: a dot stays literal |
| `parent.vue` + `parent/` folder | nested: `parent.vue` is an outlet ancestor (`NuxtPage`) of its children. A parent with a child `index.vue` is **not a screen** of its own (the child owns the URL); a parent without one is |
| `definePageMeta({ … })` with a literal object | `middleware` (a string or a literal array; an inline function is evidence only), `layout` (a name or `false`), `path` (a leading `/` replaces the file URL), `name`, `redirect` (a string sets `redirectTo`; anything else is evidence), boolean flags for `authMetaKeys`. Read from the virtual script of the `.vue` page |
| `definePageMeta({ alias })` | not mapped: one aggregated info `screens/unsupported-router-style` |
| `routeName` | the `definePageMeta` `name`, else Nuxt's generated name (segments joined by `-`, params unbracketed, trailing `-index` dropped, `index` for the root) |
| `app.vue` | the outermost ancestor: an outlet `NuxtLayout` when the file mentions the tag (checked by a splitter-level tag scan, no compiler needed), else an outlet `NuxtPage` |
| `layouts/<name>.vue` (default `default`, overridden by `definePageMeta({ layout })`, none for `layout: false`) | ancestor between `app.vue` and the parents; spliced at the default `<slot>` (`children`), or at `NuxtPage` when the layout renders it and has no slot. Skipped when `app.vue` exists without `<NuxtLayout>` |
| No pages directory but an `app.vue` | `app.vue` is the screen at `/` |
| `routeRules`, `pages:extend` hook, `router.options`, `nitro` routes, server `routes/` | not read |

#### Auth

Same lists as vue-router (`vueAuth`, §2.6). Nuxt reads them from `definePageMeta` `middleware` and the
boolean flags; the default protected names are `auth`, `authenticated`, `admin`, `permission`,
`moderator` and the public name is `guest`. The nearest verdict up the parent chain wins. Any
`middleware/*.global.*` file means a page with **no signal** is `unknown` with the evidence `N global route
middleware (…) decide access at runtime; auth is not asserted`.

#### Auto-imported components

Files under `components/` (or each configured `components:` directory) are indexed by Nuxt's naming rule:
the directory words and the filename joined in PascalCase (`components/base/Button.vue` →
`BaseButton`, a directory word the filename already starts with is not repeated), `index` taking the
folder name, `(group)` folders ignored, and `.client` / `.server` / `.global` suffixes stripped. `pathPrefix: false` and `prefix` on a
`components:` entry are honoured. The `Lazy` prefix resolves to the same file. Templates and the
`<NuxtLayout>` / `<NuxtPage>` outlet tags use this index for render edges.

| Situation | Result |
| --- | --- |
| A name claimed by two files | **no render edge**, plus info `facts/ambiguous-component-name` listing the files (up to five, then "(+N more)") — picking one would be a confident wrong edge |
| `extends` layers (`@org/ui-layer`) | their pages, layouts and components are **not read**; info `project/nuxt-layer-skipped` names each layer |
| Components contributed by modules (`@nuxt/ui`, `@nuxt/icon`) | not on disk, so no edge |
| `@nuxtjs/i18n` locale-prefixed routes | not mapped; only the default-locale pages exist as screens |
| `nuxt.config` unreadable | listed as unreadable; defaults apply |

---

### 2.8 Next.js Pages Router

Package: `next`. Source: `next-pages` (`src/adapters/next-pages.ts`, shared helpers in
`src/adapters/next-conventions.ts`, URL conversion `convertNextPagesPath` in `src/core/url.ts`). It
co-runs with `next-app` as the Next family (see [Detection and scoring](#1-detection-and-scoring)).
`discover` returns nothing without a `next` dependency, so a `src/pages/` folder in a non-Next
project invents no screens.

| Convention | Status |
| --- | --- |
| Active root | `pages/` when it exists, else `src/pages/`. With both, `src/pages/` is ignored and an info `screens/unsupported-next-convention` says so |
| Page files | `*.{tsx,ts,jsx,js}` under the root (`.d.ts` skipped, generated files skipped). With a literal `pageExtensions` in the root `next.config.*`, only those extensions count (script extensions only, e.g. `["page.tsx"]`); a non-literal `pageExtensions` falls back to the default with info `screens/dynamic-registry` |
| `index` | the parent URL (`pages/index.tsx` is `/`; `pages/a/index.tsx` is `/a`) |
| `[id]` | `:id` |
| `[...slug]`, `[[...slug]]` | `*` — the bare parent URL is not emitted as a second activation |
| `_x/` and `(x)/` segments | literal URL segments (`pages/org/_/[[...routeSlug]].tsx` is `/org/_/*`); unlike the App Router, nothing is dropped |
| Entry | the page's default export followed through re-exports (`export { default } from "@/features/x"`), so the entry is the feature file |
| Root specials `_app`, `_document`, `_error`, `404`, `500` | not screens (`_app` is the shell, below) |
| `pages/api/**` | screen tagged `kindTag: apiRoute` (`kind: api`), listed apart from human screens |
| `_app` | the outermost layout ancestor. With exactly one `<Component …/>` site (also `props.Component`, or a destructured `Component`) it is spliced there (`at`); with none or several it falls back to an outlet splice and the kernel reports `walk/no-splice-point` or `walk/ambiguous-splice` |
| `Page.getLayout = (page) => <A><B>{page}</B></A>` | layout ancestors `A` and `B` (children splice) inside `_app`, outermost first. Any other shape (a member-expression tag, a tag whose file is not resolved, several children carrying `page`) gives info `screens/unsupported-next-convention` and no layouts |
| `Page.skipAppLayout` | recorded as evidence only; `_app` stays in the chain |
| `getServerSideProps` | a redirect guards or redirects the page by the [loader-guard rule](#loader-guards) |
| A URL claimed by both `pages/` and `app/` | warning `screens/unsupported-next-convention` ("Next build error"); the `pages/` screen is kept |
| `middleware`, `getStaticProps`, `rewrites()`, `basePath`, `i18n` locale prefixes | not read |

Detection is 100 when a non-API page exists and 1 when only `pages/api/**` files exist; an API-only
project therefore runs `next-pages` only as the `next-app` companion. A re-exported page keeps its
URL convention for the catch-all rule (a `pages/docs/[...slug].tsx` re-export does not match
`/docs`).

### 2.9 React Router framework mode and Remix v2

Packages: `@react-router/dev` (React Router v7/v8 framework mode), `@remix-run/dev` (Remix v2).
Source: `react-router-framework` (`src/adapters/react-router-framework.ts`, route config reader
`src/adapters/route-config.ts`, file conventions `src/adapters/flat-routes.ts`, guards
`src/adapters/loader-guards.ts`). `discover` returns nothing without one of the two dependencies.

**App directory.** `app`, unless set by a literal `appDirectory` in the first of: `react-router.config.{ts,js,mjs}`,
the vite `remix({ … })` plugin options, `remix.config.{js,cjs,mjs,ts}`. A non-literal `appDirectory` falls back to
`app` with info `screens/dynamic-registry`. `ignoredRouteFiles` is read from Remix config when it is a literal
string array. The Remix `routes` option (routes defined in code) is not evaluated: warning
`screens/dynamic-registry`, and only the default `routes/` convention is read.

**Route tree.** `<appDirectory>/routes.{ts,mts,js,mjs}` wins; with none, the Remix v2 default flat-file
convention under `<appDirectory>/routes/` is read. `root.{tsx,jsx,ts,js}` is the outermost layout of every
route (without one: info `screens/unsupported-router-style`). Every parent is an outlet-splice layout ancestor.

| `routes.ts` form | Read as |
| --- | --- |
| `route(path, file, opts?, children?)` from `@react-router/dev/routes` | a route; `children` may be the third or fourth argument; relative paths join the parent's |
| `index(file)` | a screen at the parent's URL |
| `layout(file, children)` | a pathless layout: no URL segment, no screen |
| `prefix(path, routes)` | its routes nested under the path |
| `relative(dir)` | helpers whose file paths are relative to `dir` |
| `...(await flatRoutes(opts))` from `@react-router/fs-routes` | the file-system convention (below) |
| `remixRoutesOptionAdapter((defineRoutes) => flatRoutes(dir, defineRoutes, opts))` | remix-flat-routes (below) |
| A route with children and an index child | the index is the screen at the shared URL; the parent is its layout |
| Spreads and `const` arrays, local or imported | folded like other route lists |
| An unknown call whose arguments are all foldable route arrays (`mergeRoutes(core, extended)`) | read as the **union** of the arrays, deduped by `(file, path, parent)`; info `screens/dynamic-registry` per call and an evidence line per route. Over-reports when the call filters |
| An imperative `defineRoutes` builder, or anything else unreadable | warning `screens/dynamic-registry` (one per routes file counts the unreadable elements); nothing is read from it |

**File conventions** (`flat-routes.ts`). Names are route ids; the parent is the longest existing id prefix.

- **`flatRoutes()` (RR7) and the Remix v2 default**: `a.b.tsx` is `/a/b`; `$id` is `:id`, `$` is `*`, `($id)` is
  `:id?`; `_index` is the parent's index; a leading `_` token is pathless; a trailing `_` breaks the nesting;
  `[…]` escapes dots and special characters (`[_].$.ts` is `/_/*`); `folder/route.tsx` equals `folder` (`route`
  wins over `index` with an info). An optional static `(seg)` is mapped without the segment, with an info.
- **remix-flat-routes**: `+` folders flatten into the id (`_authenticated+/_layout.tsx` is the layout of
  `_authenticated+/*`), hybrid `route`/`index`/`layout` files in plain folders, `_layout` in `+` folders,
  and the literal `routeDir`, `basePath` and `ignoredRouteFiles` options.
- Two leaves resolving to one URL: the first id by code point is kept, info `screens/unsupported-router-style`.
- A non-default `paramPrefixChar`, `nestedDirectoryChar` or any `routeRegex`: warning
  `screens/unsupported-router-style`, and no route is read from that folder.

**Resource routes.** A route module with no default export has no UI: `kindTag: apiRoute` (`kind: api`),
listed apart from human screens.

<a id="loader-guards"></a>
**Loader guards.** A `loader` or `clientLoader` export (for `next-pages`, `getServerSideProps`; for TanStack,
`beforeLoad`) is read for redirects (`redirect(…)`, `throw redirect(…)`, `return redirect(…)`,
`redirectDocument`, TanStack `redirect({ to })`, and `return { redirect: { destination } }`):

| Redirect position | Result |
| --- | --- |
| Inside an `if`, `switch` or ternary, or after an earlier statement that can return or throw | **conditional**: the route is `auth: protected`, with evidence `<export> redirect to '<target>' (conditional: <condition text>)` |
| A top-level statement with no earlier exit | **unconditional**: the route is a redirect (`redirectTo`), not a guard |
| A call to a local or imported function whose body has a redirect | followed **one hop**; the evidence names the helper (`via requireUserId`). A helper called from a helper is not followed |
| Inside a callback passed straight to `.then` / `.catch` / `.finally`, or a `catch` clause | **conditional** (`in .catch callback`, `in catch clause`); other nested functions (handlers, local helpers) are not read |
| A target that is not a readable literal | `redirectTo` stays `null`; the evidence says the target is not readable. A template whose static head ends at `?` or `#` (`` `/login?${q}` ``) reads as that path |
| No redirect found | `auth` stays unset (unknown), never `public` |

A conditional guard on a layout protects every route below it (evidence names the ancestor); an unconditional
redirect on a layout is evidence on its descendants, not protection. The root module (`root.tsx`, TanStack's
root route) is the exception: its guard is not inherited, since it frames every page, the sign-in page included. With `redirects.unauthenticated` set in
`appgraph.config`, only conditional redirects aimed at that target protect a route (so a guest-only loader that
sends signed-in users away does not mark its page protected); other redirects stay as evidence. Without it,
every conditional redirect counts and the condition text in the evidence is the way to judge it. The reader
is a parser-only heuristic: it classifies redirect positions, it does not evaluate conditions.

### 2.10 Angular

Source: `src/adapters/angular/` (the adapter in `router.ts`, route records in `route-records.ts`, the NgModule
graph and bootstrap in `project.ts`, selectors in `selectors.ts`, templates in `template.ts`). Standalone (`provideRouter`) and NgModule
(`RouterModule.forRoot`/`forChild`) apps, Angular 14 and later. Component classes are read from `.ts` files with
no extra dependency; **template** facts need the optional `@angular/compiler` peer (`>=14`, resolved from the
project, then from appgraph's own install). Without it the run warns `project/template-compiler-missing`
naming Angular and still produces screens, auth, script facts and the `<router-outlet>` / `<ng-content>`
splices (a tag scan, no compiler needed). A loaded compiler below 14, or one that fails a structural check, is
`project/template-compiler-unsupported` and the appgraph fallback is used. The compiler's parse options follow
the project's declared `@angular/core` major (block syntax from 17, `@let` from 18), so an older project parses
with appgraph's compiler without misreading `@` and `{`.

Detection scores 90 as `angular` (§1). A project with only AngularJS (`angular` 1.x) scores 0. A project
that also declares `angular` 1.x or `@angular/upgrade` is mapped as usual and gets the info
`project/angularjs-hybrid`; AngularJS directives, controllers and templates are not read.

#### Route reading

| Form | Status |
| --- | --- |
| `provideRouter(routes)` (standalone) | supported; `routes` as an inline array, an identifier bound to a `const` (local or imported) or a `satisfies Routes` / `as Routes` wrapper |
| `RouterModule.forRoot(routes)` and `RouterModule.forChild(routes)` | supported. The bootstrapped module (or the module of `bootstrapApplication`) is the root; modules are walked depth-first over `@NgModule` `imports`, then `exports`, deduped by file and class and resolved by **import path**, so two classes with one name stay apart. A `forChild` table mounts at the level of the module that imports it |
| `loadChildren: () => import('./x.routes')` (a routes file, default export included) or `.then((m) => m.routes)` | supported; the child routes nest under the route that declares it |
| `loadChildren: () => import('./x.module').then((m) => m.XModule)` | supported; the module's `forChild` routes nest under the route |
| `loadComponent: () => import('./x').then((m) => m.X)` | supported; the entry is the component, with `via: "lazy"` |
| `component`, `children`, `path`, `pathMatch` | supported; relative paths join the parent's, `''` is a pass-through, `**` becomes `*`, `:id` is kept |
| Factory functions with literal arguments (`devicesRoute(true)`) | supported; arguments are bound to parameters and an `if (<bound literal>)` is evaluated; an `if` the literals do not decide gives a union with the condition as evidence |
| Object spreads (`{ ...commonConfig }`), array spreads, `routes.push({ ... })` and `X.a.push(...)` in straight-line code | supported |
| `for…of` that pushes routes | info `screens/dynamic-registry`; those routes are not mapped |
| `redirectTo` as a string | the route is a redirect; relative targets resolve against the parent |
| `redirectTo` as a function | evidence only |
| `data.redirectTo` on a componentless leaf with a guard in its chain | **conditional redirect rules**: one rule per string target, or one per authority key with the condition `authority = KEY`. No fake screen is created and links to the leaf resolve through the rules |
| `canMatch` siblings on one URL | merged into one screen: the entries are the union, the condition is evidence, and `auth` is `unknown` when the siblings disagree |
| `matcher` routes, `outlet:` (named outlet) routes | info `screens/unsupported-router-style`; the subtree is not mapped |
| A routes module import that resolves to no file | warning `screens/route-module-missing`, naming any same-stem sibling such as a `.mst` template (StreamPipes' generated `app.routes.ts`) |
| `title`, `resolve`, `runGuardsAndResolvers`, `providers`, `canDeactivate` | not read |

The display name of a component is its class name when its file declares exactly one `@Component`.

#### Auth

`angular` in `appgraph.config` adds names to the built-in lists (merged, never replaced):

| List | Default | Meaning |
| --- | --- | --- |
| `protectedGuards` | `AuthGuard`, `authGuard`, `LoginGuard`, `loginGuard`, `AuthenticatedGuard`, `AuthenticationGuard`, `isAuthenticatedGuard` | a guard here in the chain → `auth: protected` |
| `publicGuards` | `UnloggedGuard`, `GuestGuard`, `guestGuard`, `NoAuthGuard`, `noAuthGuard`, `AnonymousGuard` | → `auth: public` |
| `authDataKeys` | `auth`, `authorities`, `roles`, `permissions` | a `data` key here **together with any guard** → protected; the value is kept as evidence |
| `publicData` | `{ module: "public" }`, `{ public: true }`, `{ isPublic: true }` | a route whose `data` matches → public |
| `redirectDataKeys` | `redirectTo` | a `data` key here on a guarded componentless leaf → redirect rules |

Precedence: a `publicData` match is `public`; otherwise a protected guard in the chain gives `protected`; then
a public guard gives `public`; then an auth data key with any guard gives `protected`; only unrecognised
non-trivial guards give `unknown`; **no access guards at all is `public`**. `canActivate` and `canMatch` cover
the route and its descendants, `canActivateChild` covers descendants only, and `canDeactivate` is ignored. A guard
whose every access method (or arrow body) is `return true` is neutral: it neither protects nor blocks the
`public` verdict (PeerTube's `MetaGuard`). An unknown guard is never guessed: thingsboard's `AuthGuard`
branches on `data.module === 'public'`, which is why `publicData` outranks it.

#### Templates

| Situation | Result |
| --- | --- |
| One `TemplateDoc` per `@Component`, from `template:` (a string or a template literal with no `${…}`) or `templateUrl:` | supported; facts stay on the component's `.ts` file with an anchor to the real `.html` line (a `.html` file is never a source file of its own) |
| Compiler resolved | element tree, bound attributes, control-flow blocks, `routerLink`, test ids (`data-testid`, `data-test`, `data-cy`, `data-qa`, bound `[attr.x]`) |
| No compiler | **scan mode**: `<router-outlet>` and `<ng-content>` are found by a comment-aware tag scan, so layouts splice with no `walk/no-splice-point`; every other template fact is skipped |
| `@if` / `@else if` / `@else`, `*ngIf` (with `else` / `then`) | guard conditions, phrased like the Vue chain |
| `@for` / `*ngFor` | `repeated` |
| `@switch` / `@case` | guard conditions |
| `@defer` | `via: "lazy"` |
| `@let` | ignored |
| `templateUrl` to a missing file | `facts/unsupported-template` (`template-url-missing`), aggregated: up to 5 files, then a count |
| Inline template with `${…}` | `facts/unsupported-template` (`interpolated-inline-template`) |
| A parse error (for example `@let` on a project below 18) | `facts/unsupported-template` (`parse-error`); the facts from that file are partial |
| ICU expansion contents | not read |

#### Selector resolution

Every `@Component` is indexed by its `selector` (an element name, or an attribute selector for the tag it
decorates). A template tag resolves in this order:

1. **Scope.** For a standalone component, its `imports`; for a declared component, the `declarations` and
   `exports` chain of its NgModule and of the modules it imports (thingsboard: feature module, then
   `HomeComponentsModule`, then `SharedModule`). The edge carries `via: "selector"`.
2. **Global fallback.** When the scope cannot be read, a **unique** project-wide match gives `via: "selector-global"`.
3. **Ambiguity.** Two or more matches draw **no edge** and give info `facts/ambiguous-component-name`.

Tags that match nothing (`mat-*`, third-party libraries) are ignored. Matching reads element names and plain
attribute selectors; `:not()` and class selectors are ignored. Template-resolved edges bypass the JSX-class
filter that applies to React components.

An adapter can also resolve a tag itself: `Adapter.templateTagResolver` is consulted before the framework
producer and ambient resolution (see `docs/architecture.md` §7.1.1).

#### Facts

| Fact | Form |
| --- | --- |
| Navigation (`link`) | template `routerLink="/x"` and `[routerLink]="['/a', id]"` (non-literal parts become placeholders); **relative targets are skipped** and counted in `unresolvedNavigations` |
| Navigation (`navigate`) | `this.router.navigate([...])` and `this.router.navigateByUrl('/x')`, where the receiver (a constructor parameter property or an `inject(Router)` field) resolves to `Router` from `@angular/router`; commands are joined, relative targets are skipped and counted. A `const router = inject(Router)` local is not followed |
| HTTP | `HttpClient` from `@angular/common/http`: `get`, `post`, `put`, `patch`, `delete` and `request(method, url)` on a constructor-injected or `inject(HttpClient)` receiver; literal, template-literal and `const` URLs. A URL built from class statics may not flatten |
| i18n | ngx-translate (the `translate` pipe and directive, `TranslateService.instant/get/stream`) and `@angular/localize` (`$localize` tagged templates, template `i18n` attributes); **namespaces only** (`default`) |
| Stores | NgRx feature names from `createFeature({ name })`, `createFeatureSelector('x')` and `StoreModule.forFeature('x')`; a component that injects `Store` gets the features of the selectors it references, otherwise info `stores/name-fallback` |

#### Diagnostics

| Code | Level | When |
| --- | --- | --- |
| `project/template-compiler-missing` | warning | `@angular/compiler` is not loadable; scan mode only |
| `project/template-compiler-unsupported` | warning | the loaded compiler is below 14 or fails the structural check; the appgraph fallback is used |
| `facts/unsupported-template` | info | a template file that is only partly readable (parse error, missing `templateUrl`, interpolated inline template) |
| `screens/unsupported-router-style` | info | a `matcher` or `outlet:` route; its subtree is not mapped |
| `screens/dynamic-registry` | info | a `for…of` route push, or another route list that is not a literal |
| `screens/route-module-missing` | warning | a routes import resolves to no file (generated route file); a same-stem sibling is named |
| `project/angularjs-hybrid` | info | an `angular` 1.x or `@angular/upgrade` dependency |
| `facts/ambiguous-component-name` | info | two or more components match one tag in scope; no edge is drawn |

**Corpus.** Against hand-derived route lists, PeerTube (standalone, 121 screens, 72 endpoints) and thingsboard
(NgModule, 570 screens against a 637-URL list, 646 endpoints) both reach recall and precision of **1.00**.
StreamPipes gets one `screens/route-module-missing` naming `deployment/app.routes.mst`; Oppia (Angular 11
plus AngularJS) maps 79 screens.

### 2.11 Expo Router

Package: `expo-router`. Source: `expo-router` (`src/adapters/expo-router.ts`, the route planner in
`src/adapters/expo-routes.ts`, shared file-route helpers in `src/adapters/file-routes.ts`, URL conversion
`convertExpoRoutePath` in `src/core/url.ts`, platforms in `src/core/platform.ts`, auth rules in
`src/adapters/native-auth.ts`). Detection scores 100 with the `expo-router` dependency and at least one route
file in the routes directory; `discover` returns nothing without the dependency.

**Routes directory.** The first of these that holds route files: the literal `root` option of the `expo-router`
plugin (in `app.config.{ts,js,mjs,cjs}`, then `app.config.json`, then `app.json`; a top-level `expo` key is
unwrapped), `expoRouter.root` from `appgraph.config`, `app/`, `src/app/`. An `app.config.*` that is not a
literal object, or whose plugin options are not literal, gives info `project/expo-config-dynamic` and the next
candidate is used.

| Convention | Status |
| --- | --- |
| Route files | `*.{tsx,ts,jsx,js}` under the routes directory; `.d.ts`, `*.test.*`, `*.spec.*`, `__tests__/` and generated files are skipped |
| `index` | the parent URL |
| `[id]`, `[...rest]`, `[[...rest]]` | `:id`, `*` (required), `*` (optional) |
| `(group)` folders | dropped from the URL, kept in the route name |
| Group arrays `(a,b)` | **one** screen with a route name per group (`(a)/x`, `(b)/x`) |
| `_x` files and folders | literal segments: unlike the Next.js App Router, `_` is **not** private |
| `+not-found` | a catch-all `*` at its folder, `kindTag: notFound` |
| `name+api.ts` | `/name`, `kindTag: apiRoute` (`kind: api`), listed apart from human screens; no ancestors |
| `+html`, `+native-intent`, `+middleware`, `_sitemap` | not screens |
| `_layout` | a layout ancestor of every route below it, outermost first. Spliced at an outlet when the file renders an imported `Stack`, `Tabs`, `Drawer`, `Slot` or `NativeTabs` (from `expo-router`, `expo-router/stack`, `expo-router/tabs`, `expo-router/drawer` or `expo-router/unstable-native-tabs`) or a `withLayoutContext(...)` result (local or imported; preferred when both appear); otherwise at `children` |
| `<Stack.Screen name="x">` in a layout | options only, never a route. A name that matches no route file gives info `screens/unmatched-layout-screen` |
| Platform suffixes `.ios`, `.android`, `.native`, `.web` (plus `.tv` when `react-native-tvos`, an `@react-native-tvos/*` package or a `"react-native": "npm:react-native-tvos…"` alias is in `package.json`) | the base file and its variants are **one** screen: the base is the first entry and each variant an extra file entry with `platform` set. A variant with no base file still maps, with warning `screens/orphan-platform-variant` |
| Route names | every screen carries one `route` activation per group-qualified name (`(auth)/(tabs)/(search)/index`, bracket form kept), with `navigator` set to the project-relative folder of the nearest `_layout` that governs it (the routes directory when none does) |

**URL conflicts.** Candidates are grouped by URL shape (param names erased):

| Situation | Result |
| --- | --- |
| Two files with the same group path on one URL (`a.tsx` and `a/index.tsx`) | the first file by path wins; the other is **not mapped**, warning `screens/route-conflict` |
| An `+api` file on a page's URL | the page wins; warning `screens/route-conflict` |
| Files in different groups on one URL (Streamyfin's eight tab `index` files on `/`) | a **shared route**: the candidate whose first group-qualified name sorts first by code point owns the URL (Expo's documented cold-link rule, "the first alphabetical group match"); each other one keeps only its `route` activations, sits under `stateScreens` with the id `screen://expo-router/<encoded name>`, and gets info `screens/shared-route` |

**Auth.** Read from the layout chain, innermost layout first:

| Form | Result |
| --- | --- |
| `<Stack.Protected guard={expr}>` (any navigator's `.Protected`) around a `<Stack.Screen name>` that covers the route | `protected` or `public` when the guard's last segment matches `nativeAuth.signedIn` (negated: `public`); otherwise unset. The guard text is evidence |
| `useSegments()` from `expo-router` plus a `.replace(` call in a layout or the route file | evidence `useSegments() + router.replace hook guard; auth unknown` |
| A conditional `<Redirect>` from `expo-router` | evidence `conditional <Redirect> guard (…); auth unknown` |
| An `(auth)` group name | not a signal: it means "signed-in area" in some apps and "login pages" in others |

#### Diagnostics

| Code | Level | When |
| --- | --- | --- |
| `project/expo-config-dynamic` | info | `app.config.*` is not a literal object, so its plugin `root` is not read |
| `screens/shared-route` | info | a file loses its URL to another group's file and stays addressable by route name |
| `screens/route-conflict` | warning | two same-group files, or an API route and a page, on one URL; the loser is not mapped |
| `screens/orphan-platform-variant` | warning | a platform variant with no base file; it still maps |
| `screens/unmatched-layout-screen` | info | a layout's `Stack.Screen name` matches no route file |

### 2.12 React Navigation

Packages: `@react-navigation/*`. Source: `react-navigation` (`src/adapters/react-navigation.ts`, the navigator
reader in `src/adapters/react-navigation-registry.ts`, linking and path tables in
`src/adapters/route-tables.ts`, auth rules in `src/adapters/native-auth.ts`). Detection scores 90 with an
`@react-navigation/*` dependency and a `create…Navigator(` call in an app file, and **0 when `expo-router` is a
dependency** (Expo apps pull React Navigation in transitively); `discover` follows the same rule.

#### Registrations

| Form | Status |
| --- | --- |
| `const Stack = createXNavigator()` (any `create…Navigator…` call, custom factories such as `createNativeStackNavigatorWithAuth` included), local or imported | a navigator; its id is the bound name, else the config key holding it, else `<factory>@<line>` |
| `<Stack.Screen name="X" component={C}>` under `<Stack.Navigator>` / `<Stack.Group>` | a registration; the entry is `C` |
| `getComponent={() => require('./X').default}` or `() => C` | the returned component (a `require` through `lazyModuleEntry`); otherwise an opaque entry |
| `<Stack.Screen name="X">{() => <C/>}</Stack.Screen>` or `children` | the first component rendered |
| A helper that takes the navigator as a parameter (`commonScreens(Stack)`), local or imported | followed **one level**: its `<param.Screen>` elements register in the navigator passed at each call |
| Static `createXNavigator({ screens, groups })` | each key is a name; the value is a component, a nested navigator (a `create…Navigator` call or a bound one), `{ screen, linking, if, options }`, or `createXScreen({ … })`. `groups` entries' `if` applies to their screens |
| `options` | literal boolean keys (from an object or a function returning one) are read for `auth` |
| A non-literal name (`name={x}`, a computed key) | not mapped; one aggregated info `screens/dynamic-registry` |

**Identity.** One screen per name. A name registered in several navigators (Bluesky's `commonScreens`, six
times) is one screen with one `route` activation per navigator; the same name with different components keeps
every entry, with warning `screens/ambiguous-route-name`. The `localId` is `<first registering file>#route:<Name>`.
A screen with a path has `url` activations (its id is the first URL) plus its `route` activations; a screen with
none has the id `screen://react-navigation/<encoded name>` and sits under `stateScreens`.

#### Paths

| Source | Status |
| --- | --- |
| `<NavigationContainer linking={…}>`, or `linking` on a `createStaticNavigation` result | `config.screens` read recursively: nested paths join, `exact: true` restarts from the root, `screens`/`groups` of a nested navigator followed; a static root navigator's config is read the same way |
| A static screen's `linking: "path"` or `linking: { path }` | used for that name when no table or linking config declares it |
| `linking.enabled: "auto"` | names with no explicit path get their kebab-case name (`UserProfile` → `/user-profile`) |
| `reactNavigation.pathTables` (`{ callee, argument }`) | every call or `new` of `callee` (bare or a member name): the object at `argument` maps names to a path, an array of paths, or a ternary of them; spreads and `const` references are followed (up to 64 paths per name) |
| An entry that does not fold | warning `screens/path-table-unreadable` (aggregated, up to 5 sites then a count); the screen gets no URL from it |
| `prefixes`, `getStateFromPath`, `getPathFromState` | not read |

Paths convert like react-router paths (`:id`, `*`). Several names on one path: the first name by code point owns
it, and each other one gets info `screens/shared-route` and keeps only its name.

#### Auth

| Form | Result |
| --- | --- |
| A literal `options` key in `reactNavigation.authOptionKeys` (default `requireAuth`) | `true` protected, `false` public; both in one registration leave it unset |
| Static `if: useIsSignedIn` (screen or group) or a conditional JSX branch `{isSignedIn ? <Stack.Screen …/> : …}` | through `nativeAuth.signedIn`, as in §2.11 |
| Registrations of one name that disagree | unset |

Guard text and the option values are kept in each registration's evidence.

#### Diagnostics

| Code | Level | When |
| --- | --- | --- |
| `screens/dynamic-registry` | info | registrations with a non-literal name |
| `screens/ambiguous-route-name` | warning | one name registered with different components |
| `screens/shared-route` | info | a name loses a declared path to another name |
| `screens/path-table-unreadable` | warning | linking or path-table entries that do not fold |

## 3. Navigation menus

Source: `src/adapters/nav-config.ts`. Two nav sources always run.

**`nav-auto` (zero config).** Every array of object literals, and every record of object literals,
declared in a file is a candidate when an element carries a target field and a label or icon field,
and carries **none** of `element`, `Component`, `component`, `lazy`, `loader`, `action`,
`errorElement`, `handle`, `index` (those mark a route object, not a menu item). Arrays nested inside
an element (`items: [...]`) are flattened into sections. The kernel later drops candidates whose
targets resolve to too few screens. Test, mock and Storybook files (the same rule react-router uses),
generated files, files over 512 KB and files that look minified (average line length over 400
characters) are skipped and listed as near-misses, and so are files inside nested packages
(subdirectories with their own `package.json`).

In both nav sources, an entry whose target is external — any `scheme:` (`mailto:`, `https:`, `tel:`)
or a protocol-relative `//host` — or a `#anchor` is dropped rather than reported as a dead link.

In `nav-auto`, an object that carries a route-only field (`element`, `Component`, `component`, `lazy`,
`loader`, `action`, `errorElement`, `handle`, `index` — so a TanStack `createFileRoute` options object
with a `component` and `staticData` counts) is never a menu item, and neither it nor anything inside it is scanned for menus.

A record's **key** serves as the target of an entry with no target field only when it starts with `/`
or the menu has a non-empty `basePath` (`nav-config`); and never for a container entry that holds a
nested item array.

| Field role | Names tried, in order |
| --- | --- |
| target | `path`, `to`, `href`, `url`, `route`, `link` |
| label | `title`, `label`, `menuLabel`, `labelKey`, `name`, `text` |
| i18n label key | `labelKey`, `menuLabel`, `i18nKey`, `translationKey` |
| parent | `parentPath`, `parent`, `parentId` |
| feature flag | `featureFlag`, `flag`, `feature` |
| icon (recognition only) | `icon`, `iconName`, `Icon` |
| section of a container | `group`, `groupKey`, `section`, `heading`, `label`, `title`, `name` |
| section of a flat item | `group`, `groupKey`, `section`, `category` |

A label that does not fold to a literal (`t('menu.orders')`) is recorded as a label **key**, never
printed as prose.

**`nav-config` (named menus).** `menus: [{ file, export, name?, basePath?, fields? }]` in
`appgraph.config` reads one exported array or record without the shape test, with `fields`
overriding any of the names above and `basePath` prefixed to relative targets. A relative
child path (`orders` under a parent entry) is joined onto its parent's target; an absolute
one (`/orders`) is kept as written. An unreadable export
warns `nav/config-unreadable`; one with no readable target warns `nav/config-empty`.

---

## 4. Fact extractors

All built-in extractors run on every project, in this order: component tree, HTTP client,
server functions, navigation, query, Convex, store, i18n, forms, feature flags, messages, test ids
(`src/pipeline/registry.ts`). There is no automatic gating by installed library. `extractors` in
`appgraph.config` replaces the set with exactly the named ones (`component-tree`, `http-client`,
`server-fn`, `navigation`, `query`, `convex`, `store`, `i18n`, `forms`, `feature-flags`, `messages`,
`test-ids`); an unknown name is `config/unknown-extractor`. Module patterns and name lists inside each
extractor are fixed defaults; `testIdAttribute` is the one per-extractor setting in `appgraph.config`.

### 4.1 HTTP clients

Source: `src/extractors/http-client.ts`. Facts: `endpoints` with `transport: "http"`.

| Library / form | Status |
| --- | --- |
| Global `fetch('/api/x', { method: 'POST' })` | supported; method from the `method` option, default `GET`. A local or imported binding named `fetch` is **not** the global. |
| `axios`, `ky`, `got`, `node-fetch`, `superagent`, `undici` — `client.get/post/put/patch/delete('/x')` | supported (receiver must root in an import from one of these modules). One list (`HTTP_CLIENT_PACKAGES`) feeds both detection and extraction. |
| Direct call `axios('/x', { method })`, `ky('/x')`, `got('/x')`, `fetch('/x')` / `request('/x', { method })` imported from `undici` | supported |
| Instance in the same file: `const api = axios.create(); api.get('/x')` | supported |
| Project client module: `export const apiClient = axios.create(…)` / `ky.extend(…)` imported elsewhere, through barrels and up to 4 `const a = b` alias hops | supported |
| URL forms | must start with `/` or `http(s)://` after folding; templates keep a placeholder for dynamic parts |
| Methods `head`, `options`, `request` | not read |
| Config-object calls `axios({ url, method })`, `axios.request({ … })` | not read |
| Wrapper **functions** (`export const apiFetch = (url) => fetch(url)`) | not read — only `const x = <client factory call>` is followed |
| `ofetch` — `import { ofetch } from 'ofetch'` clients and calls (it is in `HTTP_CLIENT_PACKAGES`, so also a detection signal) | supported, like the other clients |
| Nuxt auto-imported `$fetch('/api/x', { method: 'POST' })`, `useFetch('/api/x')`, `useLazyFetch('/api/x')` with **no binding** for the name in the file | supported; method from a literal `method` option, default `GET`; the same URL rules as above. A local or imported binding of that name is not the Nuxt global. Not a detection signal (`nuxt` is not in the `http` group), like global `fetch` |
| `swr` / `swr/*` — `useSWR(key, fetcher)`, `useSWRImmutable(key, fetcher)` with a string key | supported as a `GET` endpoint with client `swr`; a key behind a guard (`id && \`/api/x\``) is read; a placeholder glued onto the last path segment (`/api/x${qs}`) is dropped as a query-string builder. Function keys, array keys and `useSWRMutation` are not endpoints (see the query-key section) |
| Angular `HttpClient` from `@angular/common/http` — `get`, `post`, `put`, `patch`, `delete`, `request(method, url)` on a constructor-injected or `inject(HttpClient)` receiver | supported; the receiver is matched by its type, not by an import binding of the call. `@angular/common/http` is a detection signal only, not an entry of `HTTP_CLIENT_PACKAGES`. A URL built from class statics may not flatten |
| `wretch` | not read |
| GraphQL clients (Apollo, urql, graphql-request), tRPC | not read |

### 4.2 RPC and server functions

Source: `src/extractors/server-fn.ts`. Only files containing `createServerFn`, `"use server"`, or
named `route.*` are visited.

| Form | Fact |
| --- | --- |
| `createServerFn({ method: 'POST' })` imported from `@tanstack/start` or `@tanstack/react-start` | `transport: "rpc"`, url `file#name`, method from the option (default `GET`) |
| Module-level `"use server"` | every exported function / arrow / function expression → `rpc`, `POST` |
| Function-level `"use server"` directive | that function → `rpc`, `POST` |
| Next.js `route.*` exporting `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS` | `transport: "http"` with the URL from the path (`@slot` segments stripped); a `route.*` outside an `app/` tree gets `file#name` |

RPC endpoints always carry `client: null`, and **call sites are never linked to them**: each file that
defines one gets info `facts/needs-typechecker`.

### 4.3 Navigation

Source: `src/extractors/navigation.ts`. Not restricted to one router package — any module that
provides `useNavigate` / `useRouter` counts, which covers react-router, TanStack Router and Next.js.

| Form | Trigger |
| --- | --- |
| `const navigate = useNavigate(); navigate('/x')` or `navigate({ to: '/x' })` | `navigate` |
| `const router = useRouter(); router.push('/x')` / `router.replace('/x')` | `navigate` / `replace` |
| `const { push, replace } = useRouter(); push('/x')` | `navigate` / `replace` |
| Imported `redirect('/x')`, `redirect({ to })`, `permanentRedirect('/x')` | `redirect` |
| `<Link to|href>`, `<NavLink to|href>` (resolved through aliased imports) | `link` |
| Vue templates: `<RouterLink to>`, `<router-link :to>`, `<NuxtLink to>` / `<nuxt-link>` (a static attribute, or a bound expression that folds), including a `{ path }` or `{ name }` object (names resolve to the screen's `routeName` in the kernel) | `link` |
| Vue: `navigateTo('/x')` (Nuxt auto-import), `$router.push('/x')` / `this.$router.push(...)` / `router.push(...)` from `useRouter()`, also inside template event handlers (`@click="…"`) | `navigate` / `replace` |
| Angular templates (needs the `@angular/compiler` peer): `routerLink="/x"`, `[routerLink]="['/a', id]"` (relative targets skipped and counted as `unresolvedNavigations`) | `link` |
| Angular: `this.router.navigate([...])`, `this.router.navigateByUrl('/x')` where the receiver resolves to `Router` from `@angular/router` | `navigate` |
| `<Navigate to>`, v5 `<Redirect to>` | `redirect` |
| v5 `const history = useHistory(); history.push('/x')` / `history.replace('/x')` | `navigate` / `replace` |
| wouter: `const [, navigate] = useLocation(); navigate('/x')` (tuple element 1), and an imported `navigate` from `wouter` | `navigate` |
| A target read from a static literal with a runtime key: `tabToPath[tab]`, `ROUTES[key]`, `ROUTES[key].path`, `item.to` inside `items.map((item) => <Link to={item.to}/>)` (also destructured params, `.filter`/`.slice`/`.sort` chains, `flatMap`/`forEach`, `for…of`), with the literal local or imported | every value the literal can yield becomes a navigation (up to 64; more is unresolved), marked `dynamic` when a runtime key was involved; values not starting with `/` are dropped. If any value is unknown, the whole target is unresolved |
| An imported `const` string (`navigate(HOME)` with `export const HOME = '/home'` elsewhere) | supported |
| A target that does not fold | kept as an `unresolvedNavigations` fact with the expression text |
| react-router's `useLocation()` (a location object, not a navigator; only wouter's tuple counts, matched by module) | not read as navigation |
| Plain `<a href>` in JSX, Vue and Angular templates (not `download` links); fragment (`#top`), scheme (`https:`, `mailto:`) and protocol-relative (`//cdn`) targets are dropped | `link` |
| Browser globals: `window.open(url)`, `location.assign(url)` / `location.replace(url)` (also on `window.location` / `document.location`), `location.href = url`, `window.location = url`; a local binding with one of those names never counts, external URLs are dropped | `navigate` / `replace` |
| Expo Router: the imported `router` singleton and `useRouter()` results (also destructured) from `expo-router`, `push` / `replace` / `navigate` / `dismissTo`, with a string or a `{ pathname, params }` object; `<Link href>` and `<Redirect href>` from `expo-router` | `navigate` / `replace` / `link` / `redirect`. A group-qualified or bracketed href (`/(tabs)/(home)/item/[id]`) becomes its URL (`/item/:id`) and keeps the group-qualified route name, which the kernel tries first |
| React Navigation (navigation by name): `useNavigation()` results from `@react-navigation/*` or `expo-router` (also destructured) and a screen's `navigation` parameter in a file importing `@react-navigation/*`: `navigate` / `push` / `replace` / `popTo` with `("Name")`, `("Parent", { screen: "Name" })` (nested `screen`/`params` followed to the innermost), `({ name })` or `({ screen })`; `StackActions.push` / `replace` / `popTo` and `CommonActions.navigate`; `<Link screen="Name">` and `<Link to={{ screen }}>` | `navigate` / `replace` / `link`, with `routeName` set and `to` empty. The kernel resolves the name to the screen whose `route` activation (or vue-router / Nuxt `routeName`) carries it, then to that screen's URL, else its id. An unknown name gives `to: name:<Name>` with no match and warning `nav/dead-link`; a name that does not fold is an `unresolvedNavigations` fact |
| `router.navigate({ to })`, `router.history.push`, `history.pushState` | not read |

### 4.4 Query libraries

Source: `src/extractors/query.ts`. Facts: `queryKeys`, `mutations`. Empty-section warning keyed on
`@tanstack/react-query`.

| Library / form | Status |
| --- | --- |
| `@tanstack/react-query`, `@tanstack/query-core` (and the `react-query` package name) — `useQuery`, `useInfiniteQuery`, `useSuspenseQuery`, `queryOptions`, `infiniteQueryOptions` with an inline `{ queryKey }` | supported; for an array key the **first** element is recorded (literal, folded, or the spread key-factory reference `...ordersKeys.all`); a key that is a key-factory member (`queryKey: ordersKeys.detail(id)`, `ordersKeys.all`) is recorded as that reference; clipped at 60 characters |
| `fetchQuery`, `prefetchQuery`, `ensureQueryData` and their `Infinite` variants on a **proven** `QueryClient`: `new QueryClient()` in the file, `useQueryClient()` (called inline or bound), or an imported `export const queryClient = new QueryClient()` | supported, same key rules |
| `useMutation` | counted as a mutation |
| `@tanstack/vue-query` — `useQuery`, `useMutation`, `queryOptions`, `useInfiniteQuery` (the same forms as react-query) | supported; `DEFAULT_QUERY_MODULE` matches `@tanstack/vue-query` and the package is a detection signal and an enabling dependency of the section |
| `swr` / `swr/*` — `useSWR(key)` | supported; string key or first element of an array key |
| `useSWRMutation(key)` | key recorded and counted as a mutation |
| `useQuery(ordersQuery)` with options passed by reference | the key is recorded where `ordersQuery` is built with `queryOptions(…)`, not at the call |
| `useQueries`, `useSuspenseInfiniteQuery`, client methods on an unproven receiver (`context.queryClient.prefetchQuery`), other `QueryClient` methods | not read |
| react-query v3 positional keys `useQuery('orders', fn)`, `useQuery(['orders', id], fn)` | supported for the query hooks — the string, or the first element of the array, is the key. Not applied to `queryOptions` / `infiniteQueryOptions`, which take the object form only |
| SWR function keys `useSWR(() => …)`, `useSWRInfinite` | not read |

### 4.5 State stores

Source: `src/extractors/store.ts`. Facts: `stores`. Empty-section warning keyed on `zustand`.

| Library / form | Status |
| --- | --- |
| `zustand` / `zustand/*` — `const useX = create(…)`, `create<T>()(…)`, `create(persist(…))` | supported; the store's name, then every call of it |
| A store hook imported from a module this pass does not resolve, named `use…Store` (`/^use\w*Store$/`) | name fallback with info `stores/name-fallback`. Imports from `react`, `react-dom`, `preact`, `preact/compat` and `use-sync-external-store` (so `useSyncExternalStore`) never take the fallback, and factories such as `configureStore` never match it. |
| `pinia` — `export const useX = defineStore(…)` (setup or options form) | supported; the store's name, then every call of `useX()` in other files (an imported hook is checked against its declaring module, so only a pinia-defined export counts). `vuex` is detected, not extracted |
| `@ngrx/store` — `createFeature({ name })`, `createFeatureSelector('x')`, `StoreModule.forFeature('x')`, and a component that injects `Store` | the feature name; a component's features are those of the selectors it references, otherwise info `stores/name-fallback` |
| `react-redux` — `useSelector`, `useDispatch`, `useStore` | recorded as one store named `redux` |
| Typed redux hooks — `useSelector.withTypes<S>()`, `const useAppSelector: TypedUseSelectorHook<S> = useSelector`, `() => useDispatch<D>()`, local or imported from the project's hooks module | recorded as `redux` |
| `@reduxjs/toolkit` `createSlice({ name: 'orders' })` | the slice name (`redux` when `name` does not fold) |
| `configureStore` (`@reduxjs/toolkit`), `createStore` / `legacy_createStore` (`redux` or `@reduxjs/toolkit`) | recorded as `redux` |
| `valtio` / `valtio/*` — `const state = proxy(…)`, `useSnapshot(state)` | the proxy's name, or `valtio` |
| `jotai` / `jotai/*` — `useAtom*(atom)` | the atom identifier, or `jotai` |
| `mobx` — `makeAutoObservable`, `makeObservable`, `observable` | the enclosing class name, or `mobx` |
| `mobx-react` / `mobx-react-lite` — `observer(Component)` | the wrapped identifier, or `mobx` |
| `zustand/vanilla` `createStore`, `createWithEqualityFn` | not read as creation sites |
| React context stores | not read |

### 4.6 i18n

Source: `src/extractors/i18n.ts`. Facts: `i18nNamespaces` — **namespaces only, never keys**.
Empty-section warning keyed on its enabling dependencies (§5), the `@lingui/*` packages included.

| Library / form | Status |
| --- | --- |
| `react-i18next` — `useTranslation('ns')`, `useTranslation(['a', 'b'])` | supported; `useTranslation()` with no argument records `default` |
| `i18next` core — `i18next.t('orders:title')` (default or namespace import), imported `t(…)` | the namespace before `:`; `{ ns: 'orders' }` in the options wins; a key with no `:` records `default`; a key that does not fold records nothing |
| `react-intl` — `useIntl`, `injectIntl`, `defineMessages`, `defineMessage`, `<FormattedMessage>` | recorded as `default` (react-intl has no namespaces) |
| `next-intl` / `next-intl/*` — `useTranslations('ns')`, `getTranslations('ns')` | supported |
| `vue-i18n` — `useI18n()` imported from `vue-i18n` | recorded as `default` (the library's namespace is runtime configuration). In a template: `$t(`, or `t(` when the file's script calls `useI18n`, in an interpolation or a bound / directive attribute expression → `default` |
| `@ngx-translate/core` — the `translate` pipe and directive, `TranslateService.instant/get/stream` | recorded as `default` (needs the `@angular/compiler` peer for templates) |
| `@angular/localize` — `$localize` tagged templates, template `i18n` attributes | recorded as `default` |
| Lingui (`@lingui/core`, `@lingui/react`, `@lingui/macro` and their subpaths) — `t` / `msg` / `defineMessage` called or as tagged templates, `useLingui()`, `<Trans>`, `i18n._(…)` on the imported `i18n` | recorded as `default`; message ids are not read |
| `@nuxtjs/i18n` | a detection signal and enabling dependency only: its auto-imported `useI18n` has no import binding and is not matched; the template `$t(` form is read; locale-prefixed routes are not mapped |
| Locale aggregator: a file named like `en.ts` / `en-US.ts` under a `locale/` directory whose relative imports (`./orders`) name the namespaces | supported |
| `getTranslations({ namespace })` object form, `withTranslation`, react-i18next's `<Trans>`, the `t` returned by `useTranslation` | not read |

### 4.7 Forms

Source: `src/extractors/forms.ts`. Facts: `formSchemas`, `formFields`. Empty-section warning keyed
on `react-hook-form`.

| Form | Status |
| --- | --- |
| `zodResolver(schema)`, `yupResolver(schema)`, `valibotResolver(schema)` imported from `@hookform/resolvers/{zod,yup,valibot}` | the schema identifier is recorded |
| JSX tag ending in `Field` (`TextField`, `SelectField`) or `Controller`, with a literal `name` | the field name is recorded — library-agnostic, by tag name |
| `formik` — `useFormik({ initialValues, validationSchema })`, `<Formik initialValues={…} validationSchema={…}>` | the keys of an inline `initialValues` object as fields; `validationSchema` as a schema when it is an identifier or `toFormikValidationSchema(schema)` from `zod-formik-adapter` |
| `formik` / `react-final-form` — `useField('email')` | the field name |
| `react-final-form` — `<Form initialValues={…}>` | the keys of an inline `initialValues` object as fields |
| `register('email')`, `useForm({ defaultValues })`, `useController` | not read |
| `zod`, `yup`, `valibot` | recorded as companions; a schema is recorded only where a form library consumes it (resolver or `validationSchema`) — a validator on its own never implies a form |

### 4.8 Feature flags

Source: `src/extractors/feature-flags.ts`. GrowthBook is the one flag SDK bound by import; every other
flag is recognised by name, so results depend on these conventions.

| Form | Status |
| --- | --- |
| Calls to `getConfiguration`, `useFlag`, `isEnabled`, `useFeatureFlag` (bare or as a method) with a literal first argument | supported |
| Calls to a name in `featureFlags.lookupFunctions` (`appgraph.config`, added to the four above; bare or as a method, so `enabled` matches `ax.features.enabled(…)`) | a literal first argument as above; a first argument that does not fold but is a member access (`Features.X`) records the member name. The four defaults require a literal |
| GrowthBook (`@growthbook/growthbook`, `@growthbook/growthbook-react`, by import): `useFeatureIsOn`, `useFeatureValue`, `useFeature`; `isOn` / `getFeatureValue` on a `new GrowthBook(…)` local or a `useGrowthBook()` result; `<IfFeatureEnabled feature>`, `<FeatureString feature>` | the key when it folds (enum and `const` members included), else the member name of a `X.key` access |
| Any JSX element with a literal `featureFlag` attribute | supported |
| `enum` or `const` whose name matches `/FEATURE.?FLAGS?/i`: enum members, object keys, array strings, or array objects' `key`/`name`/`id` | supported |
| LaunchDarkly (`useFlags`, `useLDClient`), Unleash, Statsig, Flagsmith, PostHog, ConfigCat | not supported unless the call happens to use one of the names above |

### 4.9 Messages (Chrome extension protocol)

Source: `src/extractors/messages.ts`.

| Form | Status |
| --- | --- |
| Message-type table: an `enum` or `as const` map whose name matches `/MessageType/i`, local or imported | supported |
| Handlers: `if (msg.type === X)` / `!==` / `==` / `!=`, combined with `&&` / `||`, and `switch (msg.type) { case X: }` | supported |
| Listener scope: `chrome.runtime.onMessage.addListener(fn)` (inline or a named function) — a raw string compared to `type` counts only inside such a listener, on its message parameter | supported |
| Senders: `chrome.*.sendMessage(…)` / `browser.*.sendMessage(…)` (payload is the first object-literal argument, so `chrome.tabs.sendMessage(tabId, msg)` works), bare global `postMessage(…)` | supported |
| `window.postMessage`, `port.postMessage` on `runtime.connect` ports, `webext-bridge` and similar | not read |

### 4.10 Test ids

Sources: `src/detect/conventions.ts` (probe), `src/extractors/test-ids.ts` (facts).

- Candidates: `data-testid`, `data-test`, `data-cy`, `data-qa`, `data-test-id`, and React Native's
  `testID`. The probe counts textual
  occurrences in up to 20,000 source files (512 KB each) and picks the most frequent; a tie between
  non-zero counts goes by preference order `data-testid`, `data-test`, `data-cy`, `data-qa`,
  `data-test-id`, `testID`. The probe's `data-test` count excludes `data-test-id` (a `-` after the name does not
  match), so the two are separate histogram rows. `testID` is last, so it never decides the choice in a
  web app, which has none.
- `testIdAttribute` in `appgraph.config` pins one attribute; the histogram still lists all six.
- Only JSX attributes whose value folds to a string become `testIds` facts; dynamic values are
  counted but not emitted. In `.vue` templates the same candidates are read as static attributes
  (`data-testid="x"`) and as bound ones (`:data-testid="…"`) whose expression folds; this needs the
  `vue` peer.
- When every count is zero, the index says so in prose instead of emitting an empty list.

### 4.11 Render tree

Source: `src/extractors/component-tree.ts`. A render edge exists for a capitalised JSX tag whose
binding is an import (static, destructured from `await import()`, or `require()`), resolved through
re-export barrels to its declaring file. Guards above each tag are recorded as text. An imported
project component referenced as a value (config objects, record maps, component props) also gets an
edge, marked `via: "reference"` and by its condition text: the tool cannot tell which entry runtime
selects, so it reports that each one can render. `via` is emitted on render edges and tree nodes in
the `full` and `detail` YAML and shown as a badge in the HTML report.

| Form | Status |
| --- | --- |
| `import X from './X'` / `import { X }` then `<X/>` | supported |
| `const { default: X } = await import('./X')` | supported |
| `const X = lazy(() => import('./X'))` (`lazy` / `React.lazy` from `react`), `dynamic(…)` from `next/dynamic` (options argument ignored), `loadable(…)` from `@loadable/component` | supported; edge to the module's default export, marked `via: "lazy"` |
| `const X = require('./X')`, `const { X } = require('./X')`, `const X = require('./X').X` | supported, like the equivalent import |
| Compound components `<Table.Body/>`: a namespace built with `Object.assign(Root, { Body })`, a top-level `Root.Body = Body`, an object literal `{ Body }`, `export * as Table from './parts'`, or `import * as Table from './parts'` | supported; edge to the file the member's value comes from. A member that cannot be read falls back to the namespace's own file; a namespace imported from a package (`<Dialog.Root/>` from a UI library) gets no edge |
| the same with `import('./X').then((m) => ({ default: m.Named }))` or `.then((m) => m.Named)` | supported; edge to `Named` |
| Vue templates (needs the `vue` peer): a component tag whose name matches an import (PascalCase or kebab-case, `<script setup>` imports included), a `components: {}` registration, an `app.component(...)` global or a Nuxt auto-import | supported; edge to the file, with the `v-if` / `v-else-if` / `v-else` / `v-show` / `v-for` conditions above the tag as guards. `<component :is>` is matched against the identifiers in its expression. Built-in tags (`RouterView`, `NuxtPage`, `NuxtLink`, `Transition`, `slot`, …) are not edges |
| Angular templates (needs the `@angular/compiler` peer): a tag resolved by selector through the component's scope (`via: "selector"`), or by a unique global match (`via: "selector-global"`); `@defer` gives `via: "lazy"`. Guards come from `@if` / `*ngIf` / `@switch`, and `@for` / `*ngFor` mark the node `repeated` | supported; see §2.10 |
| a factory body that is not a single `import()` (async block, `.then(pick)`, a locally defined `lazy`) | not followed |
| Components declared in the same file | not separate nodes |
| A component used as a **value**: an object property (`{ Panel: SummaryPanel }`, `{ SummaryPanel }`, `component: X`), an array element, a JSX attribute value (`component={X}`, `FallbackComponent={X}`), or a variable initializer, also through `as` / `satisfies` / `!`, ternary branches and `??` / `\|\|` / `&&` right operands | supported when the identifier is PascalCase, bound by an import that resolves to a project file, and that file's export is a component (function or arrow containing JSX, a `class … extends` containing JSX, or a call such as `memo(X)` / `forwardRef(…)` wrapping one). The edge has `alwaysRendered: false` and the single condition `referenced as a value, not JSX; renders only if selected at runtime`. A JSX usage of the same component in the file takes precedence |
| The same, for packages (`lucide-react` icons etc.), non-component exports, type positions, plain call arguments (`register(X)`) | not an edge |
| The parts of an `Object.assign(Root, { Body })` compound namespace | not value references of `Root`: the parts render where a consumer writes `<Root.Body/>` (see compound components above), never as `Root`'s children |

**Hooks.** Each file's `facts.hooks` lists the custom hooks it calls: any call to an identifier
matching `use` plus a capital that is not a React built-in (`useState`, `useEffect`, `useRef`, …),
once per name per file. Hook calls are recorded by name only; they do not create render edges.

### 4.12 Convex

Source: `src/extractors/convex.ts` (runs right after the query extractor). Only files whose text
contains `convex` or `_generated/api` are visited. Facts: `endpoints`, `queryKeys`, `mutations`.

**Function references.** A reference is a property chain `api.<path…>.<fn>` or `internal.<path…>.<fn>`
whose root is the `api` / `internal` export imported from a module ending in `_generated/api`
(relative or path-aliased; a renamed import such as `import { api as convexApi }` counts). A
top-level `const ref = api.tasks.list` in the same file is followed once. The chain maps to Convex's
function path: `api.tasks.tasks.updateStep` → `tasks/tasks:updateStep`.

**Call sites** (the reference must be the first argument):

| Module | Calls | Kind |
| --- | --- | --- |
| `convex/react`, `convex-helpers/react`, `convex-helpers/react/*` | `useQuery`, `usePaginatedQuery` / `useMutation` / `useAction` | query / mutation / action |
| `convex/nextjs` | `fetchQuery`, `preloadQuery` / `fetchMutation` / `fetchAction` | query / mutation / action |
| `@convex-dev/react-query`, `convex/react-query` | `convexQuery` / `useConvexMutation` / `convexAction`, `useConvexAction` | query / mutation / action |
| any receiver | `.query(ref)`, `.mutation(ref)`, `.action(ref)` (`useConvex()`, `ConvexHttpClient`, …) | by method name |
| any other call | a reference passed to an unrecognised function | the kind declared on the server, when it can be read (below); otherwise nothing is emitted |

**Facts emitted.** One endpoint per function: `{ method: "QUERY" | "MUTATION" | "ACTION", url:
"tasks/tasks:updateStep", transport: "rpc", client: "convex" }`. A query also adds its path as a query
key. Every mutation **and action** call site adds one to `mutations`.

**Server cross-check.** The reference is resolved to `convex/<path>.ts` (any of `.ts`, `.tsx`, `.js`,
`.jsx`, `.mts`, `.mjs`) next to `_generated/`. Its exports are read: a `const name = <builder>(…)`
whose builder name ends in `query`, `mutation` or `action` (case-insensitive, so custom builders such as
`authedMutation` count) gives the function's kind. A missing export or module produces info
`facts/convex-unknown-function` ("the reference may be stale") — only when the Convex directory itself
was located (`convex/schema.*` or some other referenced module resolves). A module with `export *` is
not checked.

**Confidence.** `convex` is the extractor's enabling dependency: an installed `convex` makes empty
`queryKeys`/`mutations` sections warn, and a Convex app whose extractor found nothing gets its own
`confidence/empty-section` warning even when other extractors filled `endpoints` (see
[§5](#5-detection-vs-extraction-matrix)).

**Not read:** `useQueries`, `usePreloadedQuery`, `makeFunctionReference`, `anyApi`, bracket access
(`api["tasks"]`), references passed through props or held in non-top-level variables, and server-side
calls (`ctx.runQuery`, `ctx.runMutation`, `ctx.scheduler`).

---

## 5. Detection-vs-extraction matrix

`appgraph doctor` prints a `library <group>:` line per group from the dependency union. This table
says what each detected package actually yields.

| Group | Package | Facts extracted? |
| --- | --- | --- |
| query | `@tanstack/react-query`, `@tanstack/query-core`, `react-query` | yes (object form, `queryOptions`, proven `QueryClient` methods) |
| query | `swr` | yes |
| query | `@tanstack/vue-query` | yes (same forms as react-query) |
| query | `convex`, `@convex-dev/react-query` | yes — through the [Convex extractor](#412-convex) |
| store | `zustand`, `jotai`, `mobx`, `valtio` | yes |
| store | `@reduxjs/toolkit`, `redux`, `react-redux` | yes (slice names, store creators, hooks incl. typed hooks) |
| store | `pinia` | yes (`defineStore` and the calls of the store hook) |
| store | `@ngrx/store` | yes (feature names from `createFeature`, `createFeatureSelector`, `StoreModule.forFeature`) |
| store | `vuex` | detected only |
| i18n | `react-i18next`, `next-intl`, `i18next`, `react-intl` | yes (namespaces; `default` where none is named) |
| i18n | `vue-i18n` | yes (`useI18n`, template `$t`; `default`) |
| i18n | `@ngx-translate/core`, `@angular/localize` | yes (namespaces; `default`) |
| i18n | `@nuxtjs/i18n` | detected; template `$t` read, auto-imported `useI18n` not |
| i18n | `@lingui/core`, `@lingui/react`, `@lingui/macro` | yes (`default` namespace; message ids not read) |
| forms | `react-hook-form`, `formik`, `react-final-form` | yes |
| http | `axios`, `ky`, `got`, `node-fetch`, `superagent`, `undici`, `ofetch` | yes — one list feeds both |
| http | `@angular/common/http` (`HttpClient`) | yes; a detection signal only, extracted by receiver type rather than import binding |
| — (not a detection signal) | Nuxt `$fetch` / `useFetch` / `useLazyFetch` | yes |
| — (not a detection signal) | global `fetch` | yes |
| — (not a detection signal) | `@growthbook/growthbook`, `@growthbook/growthbook-react` | yes — feature gates (§4.8); no empty-section warning |

`mobx-react` is extracted (`observer`) but not a detection signal.

**Confidence warnings.** A section's enabling dependencies are those of **every** extractor feeding
it: `queryKeys`/`mutations` ← `@tanstack/react-query`, `@tanstack/vue-query`, `convex`; `stores` ← `zustand`,
`pinia`, `@ngrx/store`; `i18nNamespaces` ← `react-i18next`, `vue-i18n`, `@nuxtjs/i18n`, `@ngx-translate/core`, `@angular/localize`, `@lingui/core`, `@lingui/react`, `@lingui/macro`; `formSchemas`/`formFields` ← `react-hook-form`; `endpoints` has an always-on
provider (`http-client`), so it never warns as a section. A section with zero facts while one of its
dependencies is installed warns `confidence/empty-section`. Separately, an extractor whose library is
installed but which produced nothing — hidden because sibling extractors filled every section it
shares, such as a Convex app whose endpoints all came from axios — gets its own
`confidence/empty-section` warning naming the extractor.

---

## 6. tsconfig shapes and module resolution

Sources: `src/core/tsconfig.ts`, `src/core/resolver.ts`. The tsconfig is parsed with TypeScript's own
config API, so its file format rules apply.

| Shape | Status |
| --- | --- |
| `tsconfig.json` at the project root | read; it is the only entry point (no flag selects another file) |
| No `tsconfig.json` | error `project/no-tsconfig`; only relative imports resolve |
| JSONC (comments, trailing commas) | supported |
| `extends`, multi-level | supported; `doctor` prints the chain |
| `extends` with a package specifier (`"@acme/tsconfig/react.json"`) | resolved through `node_modules`; when that misses (a workspace checkout without an install), from the workspace package of that name, found via `pnpm-workspace.yaml` or `package.json` `workspaces` (literal directories; `dir/*` one level deep; `dir/**` up to six levels; `!dir` patterns subtract; dot-directories and excluded build directories are skipped; a glob before the last segment matches nothing) |
| An `extends` that resolves nowhere | **warning** `project/tsconfig-error` (reported once), and the run continues with the options the config resolves without it; other tsconfig errors stay errors |
| `baseUrl` | supported |
| `paths` with `*` wildcards and exact keys; several targets per key, tried in order | supported; the longest matching prefix wins |
| `paths` declared in a base config in another directory **without** `baseUrl` | approximate — targets resolve against the entry config's directory, not the declaring file's |
| `include` | used to derive source roots |
| `references` (project references) | followed only from a solution-style config (`"files": []`, no `include`, as in the Vite template): the referenced config whose `include`/`files` cover the most source files under the root wins (ties keep reference order; coverage uses discovery's exclusion rules). Its `paths` are used; when it declares none, the root's `paths` are kept. Only one reference is used. Coverage matches an `include` pattern with `tsc` semantics: a final segment with no wildcard and no extension is a directory and matches everything under it; `*` (within a segment), `?` and `**` are the only wildcards, and `[` and `{` are literal characters |
| `moduleResolution: node16 / nodenext` | `.js` specifiers rewrite to `.ts`/`.tsx`, `.jsx` to `.tsx`, `.mjs` to `.mts`/`.ts`; directory imports try `/index.{ts,tsx,js}` |
| Other `moduleResolution` values | extensionless candidates: as written, `.tsx`, `.ts`, `/index.tsx`, `/index.ts` |
| Extensionless imports of `.js` / `.jsx` files | not probed by default — add `candidateSuffixes` in `appgraph.config` |
| `moduleSuffixes` (inherited through `extends`; from the chosen reference, else the solution config) | every candidate suffix is expanded per module suffix, in `moduleSuffixes` order: `["", ".ios"]` probes `./x`, `./x.tsx`, … and then `./x.ios.tsx`, `./x/index.ios.tsx`, …; the `""` entry keeps the plain candidates |
| A React Native project (a `react-native`, `expo`, `expo-router` or `@react-navigation/*` dependency) without `moduleSuffixes` | the same expansion with `["", ".native", ".ios", ".android"]`, so `import "./Button"` finds `Button.ios.tsx` when there is no `Button.tsx`. `.web` and `.tv` are not probed outside the Expo routes directory (§2.11) |

`extensionRewrites` and `candidateSuffixes` in `appgraph.config` merge over the derived defaults; the
platform expansion above is part of the derived `candidateSuffixes` (`src/detect/project.ts`,
`platformCandidateSuffixes` in `src/core/platform.ts`).
Re-export barrels (`export { X } from`, `export * from`) are chased up to six hops;
`export * as ns from` is not chased.

A relative or alias import (`./Gone`, `@/lost/Thing`) that resolves to no file gets info
`project/unresolved-import` on the importing file ("reachability stops there"). Packages, assets and
type-only imports are never reported, and an import that resolves to a file outside the source roots
is distinguished from one that does not exist at all.

**Source roots.** Derived from the first path segment of every `include` pattern, `baseUrl` and
`paths` target that is a real directory inside the root; `.` when none survive. `sourceRoots` in
`appgraph.config` replaces the derivation.

---

## 7. Repository layout: monorepos, exclusions, generated files

**Project root.** The nearest ancestor holding **both** `package.json` and `tsconfig.json`, or
`--root`.

**Monorepos and workspaces.** One run analyses one project.

- Imports resolve only to files **inside the source roots**. A bare workspace import
  (`@acme/ui`) resolves only when a tsconfig `paths` entry maps it to a directory inside them;
  `node_modules` is never read and symlinks — pnpm workspace links included — are never followed.
- Subdirectories with their own `package.json` are not scored for the root (see
  [Detection and scoring](#1-detection-and-scoring)); `doctor` names each with its `--root`.
- Pointed at a monorepo root whose apps share one manifest, detection reports every live source and
  refuses to pick. Run per package with `--root`, or choose with `--source` / `--all-sources`.
- Cross-package graphs in one run are a documented non-goal.

**Excluded directories** (applied before every glob and probe; `doctor` lists each rule with its
reason):

| Rule | Excludes |
| --- | --- |
| mandatory | `node_modules`, `.git` — never removable |
| default | `build`, `builds`, `coverage`, `dist`, `out`, `storybook-static` at any depth |
| dot-directory | every directory whose name starts with `.` (`.next`, `.cache`, `.turbo`, `.storybook`, …) |
| Next `distDir` | a string-literal `distDir` (both branches of a `cond ? 'a' : 'b'`) read from `next.config.{js,mjs,cjs,ts,mts}` at the project root; templates, calls and variables contribute nothing |
| `.gitignore` | `.git/info/exclude`, every `.gitignore` from the git root down to the project root, and nested `.gitignore` files inside it. Parsed without running git: comments, escapes, `!` negation, directory-only and anchored patterns, `*`, `?`, `[...]`, `**`. A **tracked** file that matches an ignore pattern is still treated as ignored. |
| config | `exclude` from `appgraph.config` |

An excluded directory excludes everything beneath it. There is no switch that turns the `.gitignore`
or dot-directory rules off.

**Always-excluded files:** `*.test.*`, `*.spec.*`, `*.stories.*`, `*.d.ts` (and `.d.mts`/`.d.cts`).

**Non-app paths** (test, mock and Storybook files, which the route and nav sources skip): a path with a
`test`, `tests`, `__tests__`, `__mocks__`, `mocks`, `test-utils`, `.storybook` or `storybook` directory
at any depth; `cypress`, `e2e` and `playwright` only as a top-level directory of the project root
(`src/e2e/` is app code).

**Generated files** are skipped by discovery: basenames `*.gen.*`, `*.generated.*`, `*.g.ts`; files
whose first five lines carry `@ts-nocheck` or `eslint-disable` **and** `generated` / `auto-generated`
/ `do not edit`; and the `generated` globs from `appgraph.config` or a preset.

---

## 8. String folding

Every "folded" value above goes through the same reader (`src/core/ast.ts`, `src/core/strings.ts`,
`src/adapters/values.ts`):

| Form | Folds to |
| --- | --- |
| `'x'`, `` `x` `` | the literal |
| `` `/orders/${id}` `` | the literal with a placeholder for the unknown part (marked dynamic) |
| `a + b` | concatenation; an unknown side becomes a placeholder |
| `cond ? 'a' : 'b'` | the first branch that folds (marked dynamic) |
| `'x'.replace(…)` | the receiver (marked dynamic) |
| `const BASE = '/admin'` (same file, up to three folding passes) | the value |
| `enum Paths { ORDERS = '/orders' }`, `const ROUTES = { … } as const`, `Object.freeze({ … })`, nested up to four levels | `Paths.ORDERS`, `ROUTES.orders.list` |
| A member table in another module | read from the declaring module when imported directly, or from any `stringSources` file (derived automatically: files declaring path-like member tables that a navigating file references; the probe reads at most 20,000 files and skips test, spec, stories, mock and Storybook files so they do not use up that budget) |
| Wrappers `( )`, `as`, `satisfies`, `!` | peeled before reading |
| An imported plain `const` string (`export const HOME = '/home'`) | folded for navigation targets and their lookups (§4.3); elsewhere not folded |
| Function calls (`buildPath('orders')`) | not folded |
