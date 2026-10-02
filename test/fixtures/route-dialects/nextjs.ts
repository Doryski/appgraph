/**
 * Route-dialects corpus — Next.js App Router path syntax → canonical `:param` / `*` form.
 *
 * Covers the App Router file conventions: `[id]`, `[...slug]`, `[[...slug]]`, `(group)`, nested
 * groups, and the `page.tsx` vs `route.ts` distinction (the latter becomes `kindTag: 'apiRoute'`,
 * not a plain screen — captured here via `notes` since the conversion table itself only
 * asserts the URL template, not the kindTag).
 */

import type { PathConversionCase } from "./types";

export const nextjsCases: readonly PathConversionCase[] = [
  {
    description: "dynamic segment [id]",
    input: "src/app/users/[id]/page.tsx",
    expected: "/users/:id",
  },
  {
    description: "catch-all [...slug]",
    input: "src/app/docs/[...slug]/page.tsx",
    expected: "/docs/*",
  },
  {
    description: "optional catch-all [[...slug]]",
    input: "src/app/shop/[[...slug]]/page.tsx",
    expected: "/shop/*",
    notes:
      "Optional catch-all matches both '/shop' and '/shop/*'. The single canonical template keeps " +
      "that: the param is marked optional, and catch-all matching lets '/shop/*' match the bare '/shop'.",
  },
  {
    description: "route group (group) contributes no URL segment",
    input: "src/app/(marketing)/about/page.tsx",
    expected: "/about",
  },
  {
    description: "nested route groups all contribute no URL segment",
    input: "src/app/(app)/(authenticated)/dashboard/page.tsx",
    expected: "/dashboard",
  },
  {
    description: "route.ts handler — addressable, but tagged kindTag:'apiRoute', kind:'api' (not a page)",
    input: "src/app/api/users/route.ts",
    expected: "/api/users",
    notes: "Emitted as a screen tagged kindTag:'apiRoute', listed separately from human pages.",
  },
  {
    description: "page.tsx at the same path as a sibling route.ts still resolves independently",
    input: "src/app/flows/[flowId]/page.tsx",
    expected: "/flows/:flowId",
  },
];
