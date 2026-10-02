/**
 * Router-forms corpus — `children:` property wrapping form: cross-file indirection (module 1 of 2).
 *
 * Covers the `children` array. The child routes array is declared here and
 * imported by 07-cross-file-router.tsx, which assigns it to `children:` on the top-level route.
 * Together with that file this must produce the SAME two screens as 01-plain-array.tsx: "/home"
 * and "/about".
 */

export type RouteObject = {
  readonly path: string;
  readonly element?: unknown;
  readonly children?: readonly RouteObject[];
};

export const childRoutes: RouteObject[] = [
  { path: "home", element: null },
  { path: "about", element: null },
];
