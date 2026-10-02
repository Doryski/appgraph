# Test fixtures

This directory is fixture data only. Nothing here is implementation code, and nothing here may be
weakened to make a test pass — a fixture proves a specific measured behaviour from
`docs/architecture.md`; if a test against it fails, the fix belongs in `src/`, never in the
fixture. `eslint.config.js` ignores `test/fixtures/**` (see the `ignores` array), so the
`.tsx` files below are exempt from lint; the non-fixture `.ts` table/README files in this tree are
not exempt and carry no `any`.

## `router-forms/` — the `unwrap` invariant corpus

Guards architecture.md §6.2 and the measured regression in §0.2: the prototype's
`ts.isArrayLiteralExpression(argument)` type-tests the raw `createBrowserRouter` argument directly,
so `routes as const` or `routes satisfies RouteObject[]` — a purely type-level annotation — takes
discovery from every screen to zero. The prototype's own `unwrap` (`ast.ts:16-27`) handles both forms,
but its discovery sites do not call it. The identical defect sits at the `children:` property
(prototype `router.ts:213-218`).

- `argument/` — 8 wrapping forms applied to the `createBrowserRouter(...)` argument itself:
  `01`–`08` = plain array literal, `as const`, `satisfies RouteObject[]`,
  `as const satisfies RouteObject[]`, parenthesized array, identifier indirection, cross-file
  indirection (two files, `07-cross-file-routes.tsx` + `07-cross-file-router.tsx`), and a hostile
  `as unknown as X` + non-null-assertion chain. Every file declares an equivalent two-route router
  (`/home`, `/about`) so a test can assert all 8 forms produce identical screen output.
- `children/` — the same 8 forms, applied to the `children:` array of a nested route, with
  the outer argument held constant as a plain array literal so any divergence is attributable to
  the `children` discovery site specifically. Same two-screen equivalence (`/home`, `/about`,
  nested under `/`).

Total: **8 wrapping-form variants × 2 discovery sites = 16 logical cases across 18 files** (2 of
the 8 forms are 2-file cross-file pairs, one pair per directory).

## `route-dialects/` — path syntax conversion cases

Table-style `.ts` files, each exporting an array of `{ description, input, expected }` (or the
AdminJS-specific `{ rootPath, substitution, templateKind, expected }` shape) pairs. They guard the
conversion INTO the canonical `:param` / `*` template format described in architecture.md §4.1.

- `nextjs.ts` — `[id]`, `[...slug]`, `[[...slug]]`, `(group)`, nested groups, `page.tsx` vs
  `route.ts` (§16.2).
- `tanstack-router.ts` — `$param`, bare `$`, dot-notation segments, `.index`, leading-underscore
  pathless (`_authed`), and combinations (§16.3).
- `react-router.ts` — `:param`, `*`, optional `?`, index routes, pathless layout routes. The
  optional `?` survives into the canonical template as the optional-param marker (`/users/:id?`).
- `adminjs.ts` — the two template-expansion forms from §16.4:
  `${rootPath}resources/${id}` and `${rootPath}pages/${slug}`.
- `adversarial.ts` — segments a naive converter misreads: a segment literally named `index`
  (must not be confused with TanStack's `.index` filename convention), a param named `param`, a dot
  inside a segment that is not a TanStack filename separator, an empty segment from a doubled
  slash, and a trailing slash.
- `expo-router.ts` — two tables. `expoRouteCases` maps Expo Router file paths to URL, params,
  route names and groups: `index` routes, nested and comma-expanded `(a,b)` groups, `[id]` and
  `[...rest]` params, platform suffixes (`.ios`, `.tv`) stripped only for declared platforms,
  `+not-found` as a directory catch-all, and the dropped `+api` suffix. `expoHrefCases` resolves
  `href` strings (group-qualified, group-terminal, bracket params, query and hash) to URLs and
  route names.
- `tanstack-file-routes-corpus.ts` — file/`createFileRoute(...)` literal pairs a naive filename
  reader misreads: bracket-escaped dots and underscores (`sitemap[.]xml`, `[.]well-known`,
  `team.[_]`) and literal segments named `routes` or ending in `route`. Each case asserts the
  filename and the literal agree on one canonical URL, with no stale-literal warning.
- `tanstack-code-routes-corpus.ts` — code routes whose `getParentRoute` disagrees with the
  `addChildren` tree. Each case states the URL from the `getParentRoute` chain and whether
  `screens/route-parent-mismatch` must be reported: harmless when the registering parent's URL is a
  segment-wise prefix of the route's own, a real inconsistency otherwise.

## The rule

A fixture may be **added** to widen coverage. A fixture may **never be weakened or deleted** to
make a failing test pass — if a test against these fixtures fails, the bug is in the code under
test, not in the fixture. This mirrors architecture.md's own discipline: every case here traces to
either a specific measured defect (§0.1–§0.9) or a documented conversion requirement, and is
annotated with that trace in a comment or a `guards`/`notes` field.
