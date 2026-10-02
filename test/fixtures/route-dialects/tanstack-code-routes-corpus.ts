/**
 * Route-dialects corpus — TanStack code routes whose `getParentRoute` disagrees with the
 * `addChildren` tree (synthesized from shapes real apps use).
 *
 * At runtime TanStack builds a route's full path and its render branch from `getParentRoute`;
 * `addChildren` only mounts the route into the matching tree, continuing the registering parent's
 * segments. A disagreement is therefore harmless exactly when the registering parent's URL covers
 * the route's own (segment-wise prefix), and a real inconsistency otherwise.
 */

export type ParentMismatchCase = {
  readonly description: string;
  /** Route declarations and the `addChildren` tree, appended after `rootRoute` and `Page`. */
  readonly body: readonly string[];
  /** The URL the route gets from its `getParentRoute` chain. */
  readonly url: string;
  /** Whether `screens/route-parent-mismatch` must be reported. */
  readonly warns: boolean;
};

export const parentMismatchCases: readonly ParentMismatchCase[] = [
  {
    description: "a nested tab registered under its tab-shell sibling while getParentRoute names the section",
    body: [
      `const shopRoute = createRoute({ getParentRoute: () => rootRoute, path: "shop", component: Page })`,
      `const itemRoute = createRoute({ getParentRoute: () => shopRoute, path: "$itemId", component: Page })`,
      `const itemReviewsRoute = createRoute({ getParentRoute: () => shopRoute, path: "$itemId/reviews", component: Page })`,
      `const routeTree = rootRoute.addChildren([shopRoute.addChildren([itemRoute.addChildren([itemReviewsRoute])])])`,
    ],
    url: "/shop/:itemId/reviews",
    warns: false,
  },
  {
    description: "a sub-route registered under its grandparent instead of its declared parent",
    body: [
      `const shopRoute = createRoute({ getParentRoute: () => rootRoute, path: "shop", component: Page })`,
      `const cartRoute = createRoute({ getParentRoute: () => shopRoute, path: "cart", component: Page })`,
      `const cartCouponRoute = createRoute({ getParentRoute: () => cartRoute, path: "coupon", component: Page })`,
      `const routeTree = rootRoute.addChildren([shopRoute.addChildren([cartRoute, cartCouponRoute])])`,
    ],
    url: "/shop/cart/coupon",
    warns: false,
  },
  {
    description: "a full-screen route hung off the root with an absolute path, registered under a deep parent",
    body: [
      `const shopRoute = createRoute({ getParentRoute: () => rootRoute, path: "shop", component: Page })`,
      `const itemRoute = createRoute({ getParentRoute: () => shopRoute, path: "$itemId", component: Page })`,
      `const kioskRoute = createRoute({ getParentRoute: () => rootRoute, path: "/shop/$itemId/kiosk", component: Page })`,
      `const routeTree = rootRoute.addChildren([shopRoute.addChildren([itemRoute.addChildren([kioskRoute])])])`,
    ],
    url: "/shop/:itemId/kiosk",
    warns: false,
  },
  {
    description: "a root-level route registered under an unrelated section",
    body: [
      `const helpRoute = createRoute({ getParentRoute: () => rootRoute, path: "help", component: Page })`,
      `const welcomeRoute = createRoute({ getParentRoute: () => rootRoute, path: "welcome", component: Page })`,
      `const routeTree = rootRoute.addChildren([helpRoute.addChildren([welcomeRoute])])`,
    ],
    url: "/welcome",
    warns: true,
  },
  {
    description: "a registering parent whose URL is a string prefix but not a segment prefix",
    body: [
      `const aRoute = createRoute({ getParentRoute: () => rootRoute, path: "a", component: Page })`,
      `const abRoute = createRoute({ getParentRoute: () => rootRoute, path: "ab", component: Page })`,
      `const routeTree = rootRoute.addChildren([aRoute.addChildren([abRoute])])`,
    ],
    url: "/ab",
    warns: true,
  },
];
