/**
 * Router-forms corpus — `children:` property wrapping form: identifier indirection.
 *
 * Covers the `children` array. The `children` array is bound to a local const
 * first, and the route object references the identifier. Must produce the SAME two screens as
 * 01-plain-array.tsx: "/home" and "/about".
 */

type RouteObject = {
  readonly path: string;
  readonly element?: unknown;
  readonly children?: readonly RouteObject[];
};

declare function createBrowserRouter(routes: readonly RouteObject[]): unknown;

const childRoutes: RouteObject[] = [
  { path: "home", element: null },
  { path: "about", element: null },
];

export const router = createBrowserRouter([
  {
    path: "/",
    children: childRoutes,
  },
]);
