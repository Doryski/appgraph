/**
 * Router-forms corpus — argument-wrapping form: `as const satisfies RouteObject[]`.
 *
 * Covers the router array argument. Compounds both wrapping operators in one
 * expression — the node under test is a `SatisfiesExpression` whose expression is itself an
 * `AsExpression` — so `unwrap` must be applied recursively/iteratively, not just once. Must
 * produce the SAME two screens as 01-plain-array.tsx: "/home" and "/about".
 */

type RouteObject = {
  readonly path: string;
  readonly element?: unknown;
  readonly children?: readonly RouteObject[];
};

declare function createBrowserRouter(routes: readonly RouteObject[]): unknown;

export const router = createBrowserRouter([
  { path: "/home", element: null },
  { path: "/about", element: null },
] as const satisfies RouteObject[]);
