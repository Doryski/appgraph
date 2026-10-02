/**
 * Route-dialects corpus — TanStack file-route paths a naive filename reader misreads.
 *
 * Synthesized, not copied: each case is the smallest file/literal pair that reproduces one way of
 * misreading a route file name. `file` is the route file's path, `literal` the `createFileRoute(...)` argument TanStack's
 * generator writes for it, and `expected` the canonical URL both must agree on — so a case that
 * passes proves the filename side AND the literal side, and the absence of a stale-literal warning.
 */

export type FileRouteAgreementCase = {
  readonly description: string
  readonly file: string
  readonly literal: string
  readonly expected: string
}

export const tanstackEscapedFileRouteCases: readonly FileRouteAgreementCase[] = [
  {
    description: "a bracket-escaped dot stays inside its segment",
    file: "src/routes/sitemap[.]xml.ts",
    literal: "/sitemap.xml",
    expected: "/sitemap.xml",
  },
  {
    description: "an escaped dot in a nested dot-notation path",
    file: "src/routes/api/v1/spec[.]json.ts",
    literal: "/api/v1/spec.json",
    expected: "/api/v1/spec.json",
  },
  {
    description: "an escaped leading dot in a directory name, above a splat",
    file: "src/routes/[.]well-known/$.ts",
    literal: "/.well-known/$",
    expected: "/.well-known/*",
  },
  {
    description: "a whole escaped directory segment",
    file: "src/routes/[.tools]/list.ts",
    literal: "/.tools/list",
    expected: "/.tools/list",
  },
  {
    description: "an escaped underscore is a URL segment, not a pathless layer",
    file: "src/routes/team.[_].tsx",
    literal: "/team/_",
    expected: "/team/_",
  },
]

export const tanstackLiteralSegmentCases: readonly FileRouteAgreementCase[] = [
  {
    description: "a literal segment named `routes` is a URL segment, not the routes directory",
    file: "src/routes/api/jobs/routes.ts",
    literal: "/api/jobs/routes",
    expected: "/api/jobs/routes",
  },
  {
    description: "a literal ending in `route` is a URL segment, not the reserved tail",
    file: "src/routes/trips/[route].tsx",
    literal: "/trips/route",
    expected: "/trips/route",
  },
]
