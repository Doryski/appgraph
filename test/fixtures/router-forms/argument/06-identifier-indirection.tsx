/**
 * Router-forms corpus — argument-wrapping form: identifier indirection.
 *
 * Covers the router array argument. The array literal is bound to `routes` first, and
 * `createBrowserRouter` is called with the identifier. A discovery site that only recognises an
 * inline `ArrayLiteralExpression` argument (rather than resolving the argument through the binding
 * table to its initializer) fails here even though `unwrap` alone would not help — this exercises
 * the "resolve through a local const" path, not the "unwrap an operator" path. Must produce the
 * SAME two screens as 01-plain-array.tsx: "/home" and "/about".
 */

type RouteObject = {
  readonly path: string;
  readonly element?: unknown;
  readonly children?: readonly RouteObject[];
};

declare function createBrowserRouter(routes: readonly RouteObject[]): unknown;

const routes: RouteObject[] = [
  { path: "/home", element: null },
  { path: "/about", element: null },
];

export const router = createBrowserRouter(routes);
