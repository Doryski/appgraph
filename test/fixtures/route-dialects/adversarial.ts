/**
 * Route-dialects corpus — adversarial path cases.
 *
 * Each case below targets one specific way a naive converter confuses a literal path segment with
 * a dialect's syntactic marker, or mishandles a degenerate path shape.
 */

import type { PathConversionCase } from "./types";

export const adversarialCases: readonly PathConversionCase[] = [
  {
    description: "a segment literally named 'index' (react-router path, NOT the TanStack .index convention)",
    input: "/reports/index",
    expected: "/reports/index",
    notes: "Must not be collapsed the way TanStack's *.index.tsx filename convention is.",
  },
  {
    description: "a param literally named 'param' — the word must not be mistaken for a placeholder token",
    input: "/things/:param",
    expected: "/things/:param",
  },
  {
    description: "a dot in a path segment that is NOT a TanStack filename separator (this is a runtime URL, not a filename)",
    input: "/files/v1.2/report",
    expected: "/files/v1.2/report",
    notes: "The dot here is inside a segment's literal text; only filename-level dots (in TanStack's *.tsx naming) are segment separators.",
  },
  {
    description: "an empty segment from a doubled slash",
    input: "/users//profile",
    expected: "/users/profile",
    notes: "The canonical form collapses the empty segment.",
  },
  {
    description: "a trailing slash",
    input: "/users/",
    expected: "/users",
    notes: "The trailing slash is canonicalised away, so both variants of the same route share one ScreenId.",
  },
];
