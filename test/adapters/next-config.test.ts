import { describe, expect, it } from "vitest"
import type { NavGroupDraft } from "../../src/core/graph.js"
import type { Adapter, ScreenDraft } from "../../src/adapters/types.js"
import { nextConfigAdapter, unreadableMessage } from "../../src/adapters/next-config.js"
import { negateCondition } from "../../src/adapters/array-values.js"
import { adapterFor, run, staticSource } from "../pipeline/harness.js"

/**
 * A SYNTHETIC reproduction of Supabase studio's `next.config.ts:72-91` and `redirects.shared.ts`: an
 * imported `isPlatform ? PLATFORM : SELF_HOSTED` spread, a `...SHARED` spread, an env-conditional entry,
 * a function returning a ternary of arrays (one branch a regex source) and a `has` entry, behind two HOCs.
 */

const NEXT_CONFIG = `import bundleAnalyzer from '@next/bundle-analyzer'
import { withSentryConfig } from '@sentry/nextjs'
import { isPlatform } from './src/constants'
import {
  getMaintenanceRedirects,
  PLATFORM_REDIRECTS,
  SELF_HOSTED_REDIRECTS,
  SHARED_REDIRECTS,
} from './redirects.shared'

const withBundleAnalyzer = bundleAnalyzer({ enabled: false })

const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    const maintenance = process.env.MAINTENANCE_MODE === 'true'
    return [
      ...(isPlatform ? PLATFORM_REDIRECTS : SELF_HOSTED_REDIRECTS),
      ...SHARED_REDIRECTS,
      ...(process.env.NEXT_PUBLIC_BASE_PATH?.length
        ? [{ source: '/', destination: process.env.NEXT_PUBLIC_BASE_PATH, permanent: false }]
        : []),
      ...getMaintenanceRedirects(maintenance),
    ]
  },
}

export default withSentryConfig(withBundleAnalyzer(nextConfig), { silent: true })
`

const REDIRECTS_SHARED = `export const PLATFORM_REDIRECTS = [
  {
    source: '/',
    has: [{ type: 'query', key: 'next', value: 'new-project' }],
    destination: '/new/new-project',
    permanent: false,
  },
  { source: '/login', destination: '/sign-in', permanent: false },
]

export const SELF_HOSTED_REDIRECTS = [{ source: '/register', destination: '/project/default', permanent: false }]

export const SHARED_REDIRECTS = [{ source: '/org/:slug/projects', destination: '/org/:slug', permanent: true }]

export function getMaintenanceRedirects(maintenanceMode: boolean) {
  return maintenanceMode
    ? [{ source: '/((?!maintenance|img).*)', destination: '/maintenance', permanent: false }]
    : [{ source: '/maintenance', destination: '/', permanent: false }]
}
`

const FILES = {
  "next.config.ts": NEXT_CONFIG,
  "redirects.shared.ts": REDIRECTS_SHARED,
  "src/constants.ts": `export const isPlatform = process.env.NEXT_PUBLIC_IS_PLATFORM === 'true'\n`,
  "src/pages/SignIn.tsx": `export default function SignIn() { return <form /> }\n`,
  "src/pages/Org.tsx": `export default function Org() { return <main /> }\n`,
  "src/pages/NewProject.tsx": `export default function NewProject() { return <main /> }\n`,
}

const WITHOUT_CONFIG = Object.fromEntries(Object.entries(FILES).filter(([file]) => file !== "next.config.ts"))

const screen = (template: string, file: string): ScreenDraft => ({
  localId: file,
  activations: [{ kind: "url", template, params: [] }],
  entries: [{ kind: "file", file, exportName: "default" }],
  evidence: [],
})

const SCREENS = staticSource("test-screens", [
  screen("/sign-in", "src/pages/SignIn.tsx"),
  screen("/org/:slug", "src/pages/Org.tsx"),
  screen("/new/new-project", "src/pages/NewProject.tsx"),
])

const navEntry = (path: string, line: number) => ({
  path,
  parentPath: null,
  label: null,
  labelKey: null,
  featureFlag: null,
  source: "test-nav",
  file: "src/nav.ts",
  line,
})

const NAV_GROUP: NavGroupDraft = {
  name: "main",
  source: "test-nav",
  entries: [navEntry("/login", 1), navEntry("/org/acme/projects", 2), navEntry("/", 3)],
}

const NAV: Adapter = { name: "test-nav", nav: [{ name: "test-nav", discover: () => [NAV_GROUP] }] }

const analyze = (files: Readonly<Record<string, string>>) =>
  run({ files, adapters: [adapterFor(SCREENS), NAV, nextConfigAdapter] })

describe("next-config redirect reader: a Supabase-shaped config behind two HOCs", () => {
  const result = analyze(FILES)
  const redirects = result.graph.redirects

  it("reads every literal rule from both ternary branches, the shared spread and the called function", () => {
    expect(redirects.map((redirect) => `${redirect.from} -> ${redirect.to}`)).toEqual([
      "/login -> /sign-in",
      "/maintenance -> /",
      "/org/:slug/projects -> /org/:slug",
      "/register -> /project/default",
      "/ -> /new/new-project",
    ])
  })

  it("tags each ternary branch with its condition and leaves an unconditional spread untagged", () => {
    const conditionOf = (from: string) => redirects.find((redirect) => redirect.from === from)?.condition
    expect(conditionOf("/login")).toBe("isPlatform")
    expect(conditionOf("/register")).toBe(negateCondition("isPlatform"))
    expect(conditionOf("/maintenance")).toBe("!maintenanceMode")
    expect(conditionOf("/org/:slug/projects")).toBeUndefined()
  })

  it("records where each rule is declared", () => {
    expect(redirects.find((redirect) => redirect.from === "/login")?.declaredAt).toBe("redirects.shared.ts:8")
    expect(redirects.find((redirect) => redirect.from === "/maintenance")?.declaredAt).toBe(
      "redirects.shared.ts:18",
    )
  })

  it("resolves a nav link through a read rule and says so", () => {
    const entries = result.graph.navGroups.flatMap((group) => group.entries)
    const login = entries.find((entry) => entry.path === "/login")
    const projects = entries.find((entry) => entry.path === "/org/acme/projects")
    expect(login?.resolvedScreen).not.toBeNull()
    expect(login?.viaRedirect).toMatchObject({ from: "/login", to: "/sign-in", condition: "isPlatform" })
    expect(login?.viaRedirect?.declaredAt).toMatch(/^redirects\.shared\.ts:\d+$/)
    expect(projects?.viaRedirect).toMatchObject({ from: "/org/acme/projects", to: "/org/acme" })
  })

  it("never resolves a link through a `has` rule", () => {
    const root = result.graph.navGroups.flatMap((group) => group.entries).find((entry) => entry.path === "/")
    expect(root?.resolvedScreen).toBeNull()
    expect(root?.viaRedirect).toBeUndefined()
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "nav/dead-link")).toHaveLength(1)
  })

  it("emits one warning naming the env-conditional entry and the regex source", () => {
    const warnings = result.diagnostics.filter((diagnostic) => diagnostic.code === "nav/redirect-unreadable")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.severity).toBe("warning")
    expect(warnings[0]?.file).toBe("next.config.ts")
    expect(warnings[0]?.message).toBe(
      "2 redirect entries in next.config.ts could not be read statically and never resolve a link: next.config.ts:21, redirects.shared.ts:17.",
    )
  })
})

describe("next-config redirect reader: config shapes", () => {
  const redirectsOf = (config: string, file = "next.config.mjs") =>
    analyze({ ...WITHOUT_CONFIG, [file]: config }).graph.redirects.map(
      (redirect) => `${redirect.from} -> ${redirect.to}`,
    )

  it("produces nothing and no diagnostic for a project without a next.config", () => {
    const result = analyze(WITHOUT_CONFIG)
    expect(result.graph.redirects).toEqual([])
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "nav/redirect-unreadable")).toEqual([])
  })

  it("reads `module.exports` with an arrow `redirects` property", () => {
    const config = `module.exports = {
  redirects: async () => [{ source: '/old', destination: '/sign-in', permanent: true }],
}
`
    expect(redirectsOf(config, "next.config.js")).toEqual(["/old -> /sign-in"])
  })

  it("marks a `missing` rule conditional so it never resolves a link", () => {
    const config = `export default {
  async redirects() {
    return [{ source: '/login', destination: '/sign-in', missing: [{ type: 'cookie', key: 'session' }], permanent: false }]
  },
}
`
    const result = analyze({ ...FILES, "next.config.ts": config })
    const login = result.graph.navGroups.flatMap((group) => group.entries).find((entry) => entry.path === "/login")
    expect(login?.resolvedScreen).toBeNull()
    expect(login?.viaRedirect).toBeUndefined()
  })

  it("counts a `redirects` method with two returns as unreadable", () => {
    const config = `export default {
  async redirects() {
    if (process.env.X) return []
    return [{ source: '/a', destination: '/b', permanent: false }]
  },
}
`
    const result = analyze({ ...FILES, "next.config.ts": config })
    expect(result.graph.redirects).toEqual([])
    expect(result.diagnostics.find((diagnostic) => diagnostic.code === "nav/redirect-unreadable")?.message).toBe(
      "1 redirect entry in next.config.ts could not be read statically and never resolve a link: next.config.ts:2.",
    )
  })
})

describe("next-config redirect reader: a Langfuse-shaped `.mjs` config outside the source roots", () => {
  const CONFIG = `await import("./src/env.mjs");
import { withSentryConfig } from "@sentry/nextjs";
import { renamedRouteRedirects } from "./redirects.mjs";

const nextConfig = {
  async redirects() {
    return renamedRouteRedirects;
  },
};

export default withSentryConfig(nextConfig, { silent: true });
`

  const REDIRECTS = `export const renamedRouteRedirects = [
  { source: "/monitors/:path*", destination: "/alerts/:path*", permanent: true },
  { source: "/old-org", destination: "/org/:slug", permanent: false },
];
`

  const result = run({
    files: {
      ...WITHOUT_CONFIG,
      "next.config.mjs": CONFIG,
      "redirects.mjs": REDIRECTS,
      "src/env.mjs": `export const env = {}\n`,
    },
    adapters: [adapterFor(SCREENS), NAV, nextConfigAdapter],
    config: { sourceRoots: ["src"] },
  })

  it("reads the imported array declared next to the config", () => {
    expect(result.graph.redirects.map((redirect) => `${redirect.from} -> ${redirect.to}`)).toEqual([
      "/monitors/:path* -> /alerts/:path*",
      "/old-org -> /org/:slug",
    ])
    expect(result.graph.redirects[0]?.declaredAt).toBe("redirects.mjs:2")
  })

  it("emits no unreadable warning", () => {
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "nav/redirect-unreadable")).toEqual([])
  })
})

describe("unreadableMessage", () => {
  it("lists at most five sites in file:line order, then the remainder", () => {
    const items = [9, 3, 7, 1, 5, 2, 8].map((line) => ({ file: "next.config.ts", line, text: "x" }))
    expect(unreadableMessage("next.config.ts", items)).toBe(
      "7 redirect entries in next.config.ts could not be read statically and never resolve a link: next.config.ts:1, next.config.ts:2, next.config.ts:3, next.config.ts:5, next.config.ts:7 and 2 more.",
    )
  })
})
