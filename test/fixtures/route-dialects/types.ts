/**
 * Shared types for the route-dialects table fixtures.
 *
 * Every screen source converts its native path syntax into the
 * canonical internal form — `:param` for a dynamic segment, `*` for a catch-all — and `params` is
 * derived from `template` by the core (`paramsOf` matches `/:([A-Za-z0-9_]+)/g`). These tables are
 * plain input→expected data, not test assertions themselves, so a test file can iterate them
 * against whichever conversion function it is exercising.
 */

export type PathConversionCase = {
  /** Human-readable description of what this case exercises. */
  readonly description: string;
  /** The native, dialect-specific input (a file path, or an already-native route path string). */
  readonly input: string;
  /** The expected canonical `:param` / `*` template after conversion. */
  readonly expected: string;
  /** Optional free-text note on how an edge case resolves. */
  readonly notes?: string;
};

export type AdminJsTemplateCase = {
  readonly description: string;
  readonly rootPath: string;
  /** The literal identifier substituted into the template (a resource id or a page slug). */
  readonly substitution: string;
  /** Which of the two AdminJS templates this case exercises. */
  readonly templateKind: "resource" | "page";
  readonly expected: string;
};
