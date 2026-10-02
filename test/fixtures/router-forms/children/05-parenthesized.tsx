/**
 * Router-forms corpus — `children:` property wrapping form: parenthesized array.
 *
 * Covers the `children` array. The `children` value is wrapped in a
 * `ParenthesizedExpression`. Must produce the SAME two screens as 01-plain-array.tsx: "/home" and
 * "/about".
 */

type RouteObject = {
  readonly path: string;
  readonly element?: unknown;
  readonly children?: readonly RouteObject[];
};

declare function createBrowserRouter(routes: readonly RouteObject[]): unknown;

export const router = createBrowserRouter([
  {
    path: "/",
    children: ([
      { path: "home", element: null },
      { path: "about", element: null },
    ]),
  },
]);
