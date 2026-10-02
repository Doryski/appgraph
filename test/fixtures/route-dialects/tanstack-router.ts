/**
 * Route-dialects corpus — TanStack Router path syntax → canonical `:param` / `*` form.
 *
 * Covers the file-route conventions: `$param`, a bare `$` (catch-all), dot-notation segments, `.index`, the
 * leading-underscore pathless convention (`_authed`), and combinations of the above.
 */

import type { PathConversionCase } from "./types";

export const tanstackRouterCases: readonly PathConversionCase[] = [
  {
    description: "$param dynamic segment",
    input: "src/routes/users.$userId.tsx",
    expected: "/users/:userId",
  },
  {
    description: "bare $ segment is a catch-all",
    input: "src/routes/files.$.tsx",
    expected: "/files/*",
  },
  {
    description: "dot-notation nested segments split into a multi-segment path",
    input: "src/routes/orders.$orderUuid.edit.tsx",
    expected: "/orders/:orderUuid/edit",
  },
  {
    description: ".index resolves to the parent path with no extra segment",
    input: "src/routes/posts.index.tsx",
    expected: "/posts",
  },
  {
    description: "leading-underscore pathless segment (_authed) leaves the URL but carries auth semantics",
    input: "src/routes/_authed/dashboard.tsx",
    expected: "/dashboard",
    notes: "_authed itself contributes auth:'protected' on the screen, not a URL segment.",
  },
  {
    description: "combination: pathless prefix + dot-notation dynamic segment + trailing static segment",
    input: "src/routes/_authed.orders.$orderId.edit.tsx",
    expected: "/orders/:orderId/edit",
  },
  {
    description: "combination: pathless prefix + .index",
    input: "src/routes/_authed.orders.index.tsx",
    expected: "/orders",
  },
  {
    description: "trailing-underscore segment is un-nested from its parent, not renamed",
    input: "src/routes/workspace/$workspaceId/reports_.$reportId.tsx",
    expected: "/workspace/:workspaceId/reports/:reportId",
  },
  {
    description: "(group) directory contributes no URL segment",
    input: "src/routes/(marketing)/pricing.tsx",
    expected: "/pricing",
  },
  {
    description: "directory route file route.tsx configures its own directory's segment",
    input: "src/routes/workspace/$workspaceId/route.tsx",
    expected: "/workspace/:workspaceId",
  },
  {
    description: ".lazy companion resolves to the same path as its critical file",
    input: "src/routes/_authed/calendar.lazy.tsx",
    expected: "/calendar",
  },
  {
    description: "lazy index file resolves to the parent path",
    input: "src/routes/projects/index.lazy.tsx",
    expected: "/projects",
  },
];
