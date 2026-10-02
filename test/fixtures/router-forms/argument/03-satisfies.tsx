/**
 * Router-forms corpus — argument-wrapping form: `satisfies RouteObject[]`.
 *
 * Covers the router array argument. The raw argument node is a `SatisfiesExpression`, not an
 * `ArrayLiteralExpression`, so a type test that skips `unwrap` fails and discovery silently yields
 * zero screens from a type-only annotation that changes no runtime behaviour. Must produce the SAME
 * two screens as 01-plain-array.tsx: "/home" and "/about".
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
] satisfies RouteObject[]);
