/**
 * Router-forms corpus — argument-wrapping form: plain array literal.
 *
 * Covers the router array argument, and is the baseline every other file in this directory must
 * match: two screens, "/home" and "/about". It is the only form a raw
 * `ts.isArrayLiteralExpression(argument)` test recognises, because the argument is a bare array
 * literal with no wrapper.
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
]);
