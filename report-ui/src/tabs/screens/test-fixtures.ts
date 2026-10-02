import type { AppGraph, Screen, ShellReport, TreeNode } from "@appgraph/core/model.js"
import { emptyScreenFacts, makeGraph } from "../../../test/render"

export const makeScreen = (id: string, overrides: Partial<Screen> = {}): Screen => ({
  id,
  localId: id,
  source: "react-router",
  activations: [],
  url: `/${id}`,
  params: [],
  title: null,
  kindTag: null,
  entries: [],
  ancestors: [],
  shell: null,
  auth: "public",
  featureFlag: null,
  redirectTo: null,
  devOnly: false,
  addressable: true,
  tree: [],
  reachable: [],
  facts: emptyScreenFacts,
  navigatesTo: [],
  provenance: { sources: [], evidence: [], mergedFrom: [], decisions: [] },
  ...overrides,
})

export const makeNode = (component: string, overrides: Partial<TreeNode> = {}): TreeNode => ({
  file: `src/components/${component}.tsx`,
  component,
  kind: "component",
  conditions: [],
  alwaysRendered: true,
  repeated: false,
  nullGuards: [],
  children: [],
  truncated: false,
  repeat: false,
  ...overrides,
})

export const HOSTILE_GUARD = "<script>window.__pwned = true</script>"

export const RICH_SHELL: ShellReport = {
  file: "src/layouts/AppShell.tsx",
  layouts: ["AppShell"],
  tree: [makeNode("TopBar")],
  navigatesTo: [{ to: "/plain", matchedRoute: "plain", trigger: "link", dynamic: false, from: "src/layouts/AppShell.tsx" }],
  endpoints: [],
  stores: [],
  i18nNamespaces: [],
  testIds: [],
}

export const richScreen = makeScreen("rich", {
  url: "/rich",
  title: "Rich screen",
  auth: "unknown",
  shell: "app",
  featureFlag: "betaRich",
  params: ["id"],
  activations: [{ kind: "url", template: "/rich", params: [] }],
  entries: [{ kind: "file", file: "src/pages/Rich.tsx", exportName: "Rich" }],
  ancestors: [{ file: "src/layouts/Guard.tsx", exportName: "Guard", splice: { kind: "children" }, role: "guard" }],
  reachable: ["a.ts", "b.ts", "c.ts"],
  navigatesTo: [
    { to: "/plain", matchedRoute: "plain", trigger: "link", dynamic: false, from: "src/pages/Rich.tsx" },
    { to: "/plain", matchedRoute: "plain", trigger: "navigate", dynamic: false, from: "src/pages/RichMenu.tsx" },
    { to: "/old", matchedRoute: "plain", trigger: "link", dynamic: false, from: "src/pages/Rich.tsx", viaRedirect: { from: "/old", to: "/plain" } },
    { to: "/items/${id}", matchedRoute: null, trigger: "navigate", dynamic: true, from: "src/pages/Rich.tsx" },
  ],
  tree: [
    makeNode("RichPage", {
      kind: "page",
      children: [
        makeNode("LazyChart", { via: "lazy" }),
        makeNode("RefPanel", { via: "reference", conditions: ["isOpen"] }),
        makeNode("CardItem", { via: "selector" }),
        makeNode("ChipItem", { via: "selector-global" }),
        makeNode("Banner", { conditions: ["user.isAdmin", "flags.beta"], alwaysRendered: false }),
        makeNode("Row", { repeated: true }),
        makeNode("Guarded", { nullGuards: [HOSTILE_GUARD] }),
      ],
    }),
  ],
  facts: {
    ...emptyScreenFacts,
    endpoints: [
      { method: "GET", url: "/api/rich", transport: "http", client: "fetch" },
      { method: "rpc", url: "rich.load", transport: "rpc", client: null },
    ],
    stores: ["richStore"],
    queryKeys: ["rich-list"],
    i18nNamespaces: ["rich"],
    featureGates: ["richGate"],
    formSchemas: ["RichSchema"],
    formFields: ["email"],
    testIds: ["rich-submit"],
    messages: ["RICH_PING"],
    extra: { analytics: ["page_view"] },
  },
})

export const plainScreen = makeScreen("plain", { url: "/plain", title: "Plain screen" })

export const redirectScreen = makeScreen("legacy", { url: "/legacy", redirectTo: "/plain", reachable: ["x.ts"] })

export const queryRedirectScreen = makeScreen("tabbed", { url: "/tabbed", redirectTo: "/plain?tab=snapshots" })

export const detailGraph = (): AppGraph =>
  makeGraph({ screens: [richScreen, plainScreen, redirectScreen, queryRedirectScreen], shells: { app: RICH_SHELL } })
