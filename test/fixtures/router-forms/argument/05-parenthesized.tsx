/**
 * Router-forms corpus — argument-wrapping form: parenthesized array.
 *
 * Covers the router array argument. `unwrap` (`src/core/ast.ts`) is documented as handling
 * `ParenthesizedExpression` — this fixture is the direct test of that branch in isolation, with no
 * other operator involved. Must produce the SAME two screens as 01-plain-array.tsx: "/home" and
 * "/about".
 */

type RouteObject = {
  readonly path: string;
  readonly element?: unknown;
  readonly children?: readonly RouteObject[];
};

declare function createBrowserRouter(routes: readonly RouteObject[]): unknown;

export const router = createBrowserRouter(([
  { path: "/home", element: null },
  { path: "/about", element: null },
]));
