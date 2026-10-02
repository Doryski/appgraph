/**
 * Router-forms corpus — `children:` property wrapping form: non-null assertion /
 * `as unknown as X` chain.
 *
 * Covers the `children` array; it is the `children`-side counterpart of
 * 08-hostile-chain.tsx in ../argument/. Must produce the SAME two screens as 01-plain-array.tsx:
 * "/home" and "/about".
 */

type RouteObject = {
  readonly path: string;
  readonly element?: unknown;
  readonly children?: readonly RouteObject[];
};

declare function createBrowserRouter(routes: readonly RouteObject[]): unknown;

const childRoutesUnknown: unknown = [
  { path: "home", element: null },
  { path: "about", element: null },
];

export const router = createBrowserRouter([
  {
    path: "/",
    children: (childRoutesUnknown as unknown as RouteObject[])!,
  },
]);
