/**
 * Router-forms corpus — argument-wrapping form: cross-file indirection (module 2 of 2).
 *
 * See 07-cross-file-routes.ts for the shared context. `createBrowserRouter` is called here with an
 * identifier imported from a sibling module, so the argument node is neither an
 * `ArrayLiteralExpression` nor a locally-declared identifier — the discovery site must cross a file
 * boundary to find the initializer.
 */

import { routes } from "./07-cross-file-routes";

type RouteObject = {
  readonly path: string;
  readonly element?: unknown;
  readonly children?: readonly RouteObject[];
};

declare function createBrowserRouter(routes: readonly RouteObject[]): unknown;

export const router = createBrowserRouter(routes);
