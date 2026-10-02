/**
 * Router-forms corpus — `children:` property wrapping form: cross-file indirection (module 2 of 2).
 *
 * See 07-cross-file-children.ts for the shared context. `children` here is an identifier imported
 * from a sibling module, so the discovery site must cross a file boundary to find the array.
 */

import { childRoutes } from "./07-cross-file-children";

type RouteObject = {
  readonly path: string;
  readonly element?: unknown;
  readonly children?: readonly RouteObject[];
};

declare function createBrowserRouter(routes: readonly RouteObject[]): unknown;

export const router = createBrowserRouter([
  {
    path: "/",
    children: childRoutes,
  },
]);
