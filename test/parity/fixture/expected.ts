import type { ScreenContract, ScreenCoverage } from "../model.js"

/**
 * HAND-DERIVED from `mini-app.ts` by reading the router, NOT captured from a run.
 *
 * That distinction is the whole value of this file. A captured snapshot passes by construction and
 * detects only change; a hand-derived one can be WRONG, and when it disagrees with the tool one of the
 * two is a bug worth finding. Every row below can be checked against `src/routes/router.tsx` in the
 * fixture in about a minute — the same review property §12.3 claims for gate 1's rows.
 */
export const FIXTURE_CONTRACTS: readonly ScreenContract[] = [
  // `element: <RouteErrorBoundary><ProtectedRoute><AppLayout><FeedList/>`
  { url: "/", entry0: "src/modules/FeedList/FeedList.tsx", params: [], auth: "protected", redirectTo: null },
  // The catch-all renders a bare <div>, so it has no module entry at all.
  { url: "/*", entry0: null, params: [], auth: "public", redirectTo: null },
  // `element: <Navigate to={RoutePath.INSIGHTS_TAGS} replace />` — a pure redirect, no entry.
  { url: "/insights", entry0: null, params: [], auth: "public", redirectTo: "/insights/tags" },
  {
    url: "/insights/tags",
    entry0: "src/modules/TagInsights/TagInsights.tsx",
    params: [],
    auth: "protected",
    redirectTo: null,
  },
  {
    url: "/authors",
    entry0: "src/modules/AuthorsList/AuthorsList.tsx",
    params: [],
    auth: "protected",
    redirectTo: null,
  },
  // Inside the `...(isDevelopment() ? [ … ] : [])` spread: discovered, and marked devOnly.
  {
    url: "/dev/sandbox",
    entry0: "src/modules/DevSandbox/DevSandbox.tsx",
    params: [],
    auth: "protected",
    redirectTo: null,
  },
  // §8.3: a `path:` with neither element, lazy nor redirect. Retained, with nothing to render.
  { url: "/entryless", entry0: null, params: [], auth: "public", redirectTo: null },
  // TWO entries; `entries[0]` is the CODEPOINT-first one ('P' 0x50 < 'c' 0x63), where `localeCompare`
  // would put `components/PostsHeader.tsx` first (§8.9).
  {
    url: "/posts",
    entry0: "src/modules/PostsList/PostsList.tsx",
    params: [],
    auth: "protected",
    redirectTo: null,
  },
  {
    url: "/posts/:id",
    entry0: "src/modules/PostEditor/PostEditor.tsx",
    params: ["id"],
    auth: "protected",
    redirectTo: null,
  },
  // Wrapped in AuthLayout, not ProtectedRoute.
  { url: "/sign-in", entry0: "src/modules/SignIn/SignIn.tsx", params: [], auth: "public", redirectTo: null },
]

/**
 * Gate-2 floors for the fixture, derived by counting what each screen's entry can reach through the
 * three `traversable` directories and how many `data-testid` attributes live in those files. They are
 * deliberately CONSERVATIVE — a floor's job is to fail on a collapse, not to pin an exact number, and
 * an exact number here would break on every legitimate coverage improvement.
 *
 * The endpoint floors are real: they are the counts the traversable closure yields through the
 * client-identity factory chain, so a collapse of `facts.endpoints` fails here instead of passing
 * vacuously. The phantom `GET /` and `GET /insights` from `usePrefetchMap.ts` are excluded — that is
 * A1's separate claim, not a floor.
 */
export const FIXTURE_FLOORS: readonly ScreenCoverage[] = [
  { url: "/", reachable: 6, endpoints: 5, testIds: 2, stores: 1, queryKeys: 0, i18nNamespaces: 1, formSchemas: 0, formFields: 0, featureGates: 0 },
  { url: "/*", reachable: 2, endpoints: 0, testIds: 2, stores: 0, queryKeys: 0, i18nNamespaces: 0, formSchemas: 0, formFields: 0, featureGates: 0 },
  { url: "/insights", reachable: 0, endpoints: 0, testIds: 0, stores: 0, queryKeys: 0, i18nNamespaces: 0, formSchemas: 0, formFields: 0, featureGates: 0 },
  { url: "/insights/tags", reachable: 5, endpoints: 1, testIds: 2, stores: 1, queryKeys: 1, i18nNamespaces: 0, formSchemas: 0, formFields: 0, featureGates: 0 },
  { url: "/authors", reachable: 5, endpoints: 1, testIds: 2, stores: 1, queryKeys: 1, i18nNamespaces: 0, formSchemas: 0, formFields: 0, featureGates: 0 },
  { url: "/dev/sandbox", reachable: 4, endpoints: 0, testIds: 2, stores: 1, queryKeys: 0, i18nNamespaces: 0, formSchemas: 0, formFields: 0, featureGates: 0 },
  { url: "/entryless", reachable: 0, endpoints: 0, testIds: 0, stores: 0, queryKeys: 0, i18nNamespaces: 0, formSchemas: 0, formFields: 0, featureGates: 0 },
  { url: "/posts", reachable: 7, endpoints: 4, testIds: 3, stores: 1, queryKeys: 1, i18nNamespaces: 1, formSchemas: 0, formFields: 0, featureGates: 0 },
  { url: "/posts/:id", reachable: 5, endpoints: 4, testIds: 2, stores: 1, queryKeys: 1, i18nNamespaces: 0, formSchemas: 0, formFields: 0, featureGates: 0 },
  { url: "/sign-in", reachable: 3, endpoints: 0, testIds: 1, stores: 0, queryKeys: 0, i18nNamespaces: 1, formSchemas: 0, formFields: 0, featureGates: 0 },
]

/**
 * `meta.counts.renderEdges` on the fixture. Four edges: three out of `FeedList` (unconditional,
 * conditional, repeated) and one out of `FeedToolbar`. Asserted as an EXACT number rather than
 * `> 0`, because the shapes are enumerated in `MINI_APP_RENDER_EDGES` — a `> 0` check would pass with
 * three of the four shapes silently gone.
 */
export const FIXTURE_EXPECTED_RENDER_EDGES = 4

/** `src/services/api/**` is reached only through the three traversable directories. */
export const FIXTURE_EXPECTED_ENDPOINTS: readonly string[] = [
  "DELETE /posts/:param",
  "GET /authors",
  "GET /metrics/tags",
  "GET /posts",
  "GET /posts/:param",
  "POST /posts",
]

/**
 * `navigate(RoutePath.X)` in SignIn.tsx and PostsHeader.tsx. Both need the `RoutePath` enum folded.
 * Detection derives `src/shared/routing/routePaths.ts` on its own, so BOTH the pinned and the zero-config run
 * produce exactly this list — which is what `config-ablation.test.ts` asserts.
 *
 * `via` and `trigger` are part of the key so a lost edge cannot hide behind a surviving twin: without
 * `via`, a shell component's edge to `/` would shadow every page's own edge to `/`.
 */
export const FIXTURE_EXPECTED_NAV_EDGES: readonly string[] = [
  "/posts -> /posts/:id via src/modules/PostsList/components/PostsHeader.tsx (navigate)",
  "/sign-in -> / via src/modules/SignIn/SignIn.tsx (navigate)",
]
