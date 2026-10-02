/**
 * Router-forms corpus — `children:` property wrapping form: `as const satisfies RouteObject[]`.
 *
 * Covers the `children` array, compounding both operators on the `children` value
 * the same way 04-as-const-satisfies.tsx does for the router argument. Must produce the SAME two
 * screens as 01-plain-array.tsx: "/home" and "/about".
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
    ] as const satisfies RouteObject[],
  },
]);
