/**
 * Router-forms corpus — `children:` property wrapping form: plain array literal.
 *
 * Covers the `children` array discovery site, which needs the same `unwrap` treatment as the router
 * argument. The outer router argument is always the plain-array baseline in this directory; only the `children`
 * value varies across the 01-08 files, so a test can attribute any divergence to the `children`
 * discovery site specifically. This file is the baseline: two screens, "/home" and "/about"
 * (nested under parent path "/").
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
    children: [
      { path: "home", element: null },
      { path: "about", element: null },
    ],
  },
]);
