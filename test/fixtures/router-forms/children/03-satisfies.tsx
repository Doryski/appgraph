/**
 * Router-forms corpus — `children:` property wrapping form: `satisfies RouteObject[]`.
 *
 * Covers the `children` array. Only the `children` value carries the `satisfies`
 * annotation. Must produce the SAME two screens as 01-plain-array.tsx: "/home" and "/about".
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
    ] satisfies RouteObject[],
  },
]);
