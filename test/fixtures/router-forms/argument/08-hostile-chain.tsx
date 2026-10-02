/**
 * Router-forms corpus — argument-wrapping form: non-null assertion / `as unknown as X` chain.
 *
 * Covers the router array argument in an adversarial-but-legal form: the array is first widened to `unknown`, then narrowed back with a second `as`, then
 * asserted non-null — three wrapper nodes stacked (`NonNullExpression` around an `AsExpression`
 * around another `AsExpression`), none of which is an `ArrayLiteralExpression` at the top. `unwrap`
 * must peel all three layers in sequence to reach the array. Must produce the SAME two screens as
 * 01-plain-array.tsx: "/home" and "/about".
 */

type RouteObject = {
  readonly path: string;
  readonly element?: unknown;
  readonly children?: readonly RouteObject[];
};

declare function createBrowserRouter(routes: readonly RouteObject[]): unknown;

const routesUnknown: unknown = [
  { path: "/home", element: null },
  { path: "/about", element: null },
];

export const router = createBrowserRouter(
  (routesUnknown as unknown as RouteObject[])!,
);
