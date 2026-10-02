/**
 * Router-forms corpus — argument-wrapping form: `as const`.
 *
 * Covers the router array argument. `ts.isArrayLiteralExpression(argument)` on the raw
 * `createBrowserRouter` argument is FALSE here — the node is an `AsExpression` wrapping the array —
 * so discovery must go through `unwrap` (`src/core/ast.ts`) to see the array underneath. Must
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
] as const);
