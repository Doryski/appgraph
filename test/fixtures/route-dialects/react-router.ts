/**
 * Route-dialects corpus — react-router path syntax → canonical `:param` / `*` form.
 *
 * react-router already speaks the canonical dialect for the common cases (`:param`, `*`), so most
 * cases here are identity conversions; the interesting ones are the syntax the canonical form does
 * NOT have an opinion on yet — optional params, index routes, and pathless layout routes — which
 * this table states honestly rather than inventing a resolution for.
 */

import type { PathConversionCase } from "./types";

export const reactRouterCases: readonly PathConversionCase[] = [
  {
    description: ":param is already canonical (identity conversion)",
    input: "/users/:id",
    expected: "/users/:id",
  },
  {
    description: "* splat is already canonical (identity conversion)",
    input: "/files/*",
    expected: "/files/*",
  },
  {
    description: "optional param with trailing ? keeps its marker",
    input: "/users/:id?",
    expected: "/users/:id?",
    notes:
      "The '?' survives into the canonical template as the optional-param marker (shared with " +
      "TanStack's {-$id}); params derivation via /:([A-Za-z0-9_]+)/g still yields 'id'.",
  },
  {
    description: "segments after an optional param are kept",
    input: "/users/:id?/edit",
    expected: "/users/:id?/edit",
  },
  {
    description: "index route inherits the parent path with no own segment",
    input: "{ index: true } under parent path /dashboard",
    expected: "/dashboard",
  },
  {
    description: "pathless layout route (no path, no index) contributes no segment to its children",
    input: "{ element: <Layout/> } (no path) wrapping child path /settings",
    expected: "/settings",
  },
];
