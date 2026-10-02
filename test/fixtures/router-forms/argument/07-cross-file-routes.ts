/**
 * Router-forms corpus — argument-wrapping form: cross-file indirection (module 1 of 2).
 *
 * Covers the router array argument. The routes array is declared in this module and
 * imported by 07-cross-file-router.tsx, which is the file that actually calls
 * `createBrowserRouter`. A discovery site that resolves a local binding but does not follow an
 * imported binding to its declaring module (barrel/re-export chasing) fails on this pair even
 * though it passes 06-identifier-indirection.tsx. Together with 07-cross-file-router.tsx this must
 * produce the SAME two screens as 01-plain-array.tsx: "/home" and "/about".
 */

export type RouteObject = {
  readonly path: string;
  readonly element?: unknown;
  readonly children?: readonly RouteObject[];
};

export const routes: RouteObject[] = [
  { path: "/home", element: null },
  { path: "/about", element: null },
];
