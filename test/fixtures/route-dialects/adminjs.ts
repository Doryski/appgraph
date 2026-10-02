/**
 * Route-dialects corpus — AdminJS template expansion → canonical URL.
 *
 * AdminJS has no route table at all: the URL comes from a
 * plugin-declared TEMPLATE, `${rootPath}resources/${id}` or `${rootPath}pages/${slug}`, with
 * `rootPath` read from the same options object. These are not path-syntax conversions like the
 * other dialects — they are string-template substitutions — hence the separate `AdminJsTemplateCase`
 * shape in ./types.ts.
 */

import type { AdminJsTemplateCase } from "./types";

export const adminjsCases: readonly AdminJsTemplateCase[] = [
  {
    description: "resource template with a non-empty rootPath",
    rootPath: "/admin/",
    substitution: "users",
    templateKind: "resource",
    expected: "/admin/resources/users",
  },
  {
    description: "page template with a non-empty rootPath",
    rootPath: "/admin/",
    substitution: "dashboard",
    templateKind: "page",
    expected: "/admin/pages/dashboard",
  },
  {
    description: "resource template with rootPath '/' (the default, no custom mount point)",
    rootPath: "/",
    substitution: "orders",
    templateKind: "resource",
    expected: "/resources/orders",
  },
  {
    description: "page template with a nested rootPath",
    rootPath: "/internal/admin/",
    substitution: "reports",
    templateKind: "page",
    expected: "/internal/admin/pages/reports",
  },
];
