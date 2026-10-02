import ts from "typescript"
import { describe, expect, it } from "vitest"
import { createMemoryHost } from "../../src/core/host.js"
import { resolveConfig } from "../../src/config/types.js"
import { createEnv, createProjectContext } from "../../src/pipeline/context.js"
import { createExpoRouterAdapter, createExpoRouterSource, detectExpoRouter } from "../../src/adapters/expo-router.js"
import { nextAppSource } from "../../src/adapters/next-app.js"
import { hasRequiredCatchAllEntry } from "../../src/core/graph/screens.js"
import { isRequiredNextCatchAll } from "../../src/core/url.js"
import type { Screen } from "../../src/core/model.js"
import { adapterFor, run as runFixture, type RunOptions } from "../pipeline/harness.js"

const ROOT = "/repo"

const EXPO_PACKAGE_JSON = JSON.stringify({
  name: "fixture",
  dependencies: { expo: "54.0.0", "expo-router": "6.0.0", react: "19.0.0", "react-native": "0.81.0" },
})

const TVOS_PACKAGE_JSON = JSON.stringify({
  name: "fixture",
  dependencies: {
    expo: "54.0.0",
    "expo-router": "6.0.0",
    react: "19.0.0",
    "react-native": "npm:react-native-tvos@0.81.0-0",
  },
})

const run = (options: RunOptions & { readonly packageJson?: string }) =>
  runFixture({
    adapters: [createExpoRouterAdapter()],
    ...options,
    files: { "package.json": options.packageJson ?? EXPO_PACKAGE_JSON, ...options.files },
  })

const screenBody = (name: string): string => `export default function ${name}() { return <View /> }\n`

const stackLayout = (screens: readonly string[] = []): string =>
  [
    'import { Stack } from "expo-router"',
    "export default function Layout() {",
    `  return <Stack>${screens.map((name) => `<Stack.Screen name="${name}" />`).join("")}</Stack>`,
    "}",
    "",
  ].join("\n")

const urlsOf = (screens: readonly Screen[]): readonly (string | null)[] => screens.map((screen) => screen.url)

const byFile = (screens: readonly Screen[], file: string): Screen | undefined =>
  screens.find((screen) => screen.entries.some((entry) => entry.kind === "file" && entry.file === file))

const detectWith = (files: Readonly<Record<string, string>>, source = createExpoRouterSource()) => {
  const host = createMemoryHost({
    files: Object.fromEntries(Object.entries(files).map(([file, text]) => [`${ROOT}/${file}`, text])),
  })
  const env = createEnv({ ts, config: resolveConfig({ root: ROOT, appgraphVersion: "0.1.0-test" }), host })
  return source.detect(createProjectContext(env))
}

describe("expo-router: detect", () => {
  it("scores 100 with the expo-router dependency and route files under app/", () => {
    const result = detectWith({ "package.json": EXPO_PACKAGE_JSON, "app/index.tsx": screenBody("Home") })

    expect(result.score).toBe(100)
    expect(result.evidence).toEqual([
      { what: "expo-router dependency with route files under app/", file: "app/index.tsx", line: 1 },
    ])
  })

  it("scores 0 without the expo-router dependency, even with an app/ tree", () => {
    const packageJson = JSON.stringify({ dependencies: { react: "19.0.0" } })
    expect(detectWith({ "package.json": packageJson, "app/index.tsx": screenBody("Home") }).score).toBe(0)
  })

  it("scores 0 with the dependency but no routes dir", () => {
    expect(detectWith({ "package.json": EXPO_PACKAGE_JSON, "components/Home.tsx": screenBody("Home") }).score).toBe(0)
  })

  it("falls back to src/app/ when app/ has no route files", () => {
    const result = detectWith({ "package.json": EXPO_PACKAGE_JSON, "src/app/index.tsx": screenBody("Home") })
    expect(result.evidence[0]?.file).toBe("src/app/index.tsx")
  })

  it("reads the configured expoRouter.root before the default dirs", () => {
    const files = {
      "package.json": EXPO_PACKAGE_JSON,
      "app/index.tsx": screenBody("Home"),
      "routes/index.tsx": screenBody("Routed"),
    }
    expect(detectWith(files, createExpoRouterSource({ root: "routes" })).evidence[0]?.file).toBe("routes/index.tsx")
    expect(detectExpoRouter(createProjectContext(createEnv({
      ts,
      config: resolveConfig({ root: ROOT, appgraphVersion: "0.1.0-test" }),
      host: createMemoryHost({
        files: Object.fromEntries(Object.entries(files).map(([file, text]) => [`${ROOT}/${file}`, text])),
      }),
    }))).evidence[0]?.file).toBe("app/index.tsx")
  })
})

describe("expo-router: streamyfin-shaped tree", () => {
  const FILES = {
    "app/_layout.tsx": stackLayout(["(auth)/(tabs)"]),
    "app/+html.tsx": screenBody("Html"),
    "app/+not-found.tsx": screenBody("NotFound"),
    "app/login.tsx": screenBody("Login"),
    "app/(auth)/(tabs)/_layout.tsx": [
      'import { createNativeBottomTabNavigator } from "@bottom-tabs/react-navigation"',
      'import { Stack, withLayoutContext } from "expo-router"',
      "const { Navigator } = createNativeBottomTabNavigator()",
      "export const NativeTabs = withLayoutContext(Navigator)",
      "export default function TabLayout() {",
      "  if (isTV) return <Stack><Stack.Screen name='index' /></Stack>",
      "  return <NativeTabs><NativeTabs.Screen name='(home)' /><NativeTabs.Screen name='(search)' /></NativeTabs>",
      "}",
      "",
    ].join("\n"),
    "app/(auth)/(tabs)/index.tsx": screenBody("TabsIndex"),
    "app/(auth)/(tabs)/(home)/_layout.tsx": stackLayout(["index", "settings", "ghost"]),
    "app/(auth)/(tabs)/(home)/index.tsx": screenBody("HomeIndex"),
    "app/(auth)/(tabs)/(home)/settings.tsx": screenBody("Settings"),
    "app/(auth)/(tabs)/(home)/settings.tv.tsx": screenBody("SettingsTv"),
    "app/(auth)/(tabs)/(search)/index.tsx": screenBody("SearchIndex"),
    "app/(auth)/(tabs)/(home,search)/items/page.tsx": screenBody("Item"),
  }

  const result = run({ files: FILES, packageJson: TVOS_PACKAGE_JSON })
  const screens = result.graph.screens

  it("maps every route file to one screen, skipping +html and _layout", () => {
    expect(urlsOf(screens).filter((url) => url !== null)).toEqual(["/", "/*", "/items/page", "/login", "/settings"])
    expect(screens.some((screen) => screen.entries.some((entry) => entry.kind === "file" && entry.file.includes("+html")))).toBe(false)
  })

  it("merges settings.tv.tsx into the settings screen as a tv platform entry", () => {
    const settings = screens.find((screen) => screen.url === "/settings")
    expect(settings?.entries).toEqual([
      { kind: "file", file: "app/(auth)/(tabs)/(home)/settings.tsx", exportName: "default" },
      { kind: "file", file: "app/(auth)/(tabs)/(home)/settings.tv.tsx", exportName: "default", platform: "tv" },
    ])
  })

  it("gives a group-array file one screen with a route activation per group", () => {
    const item = screens.find((screen) => screen.url === "/items/page")
    expect(item?.activations.filter((activation) => activation.kind === "route")).toEqual([
      { kind: "route", name: "(auth)/(tabs)/(home)/items/page", navigator: "app/(auth)/(tabs)/(home)" },
      { kind: "route", name: "(auth)/(tabs)/(search)/items/page", navigator: "app/(auth)/(tabs)" },
    ])
  })

  it("splices through the withLayoutContext-bound name and the imported Stack", () => {
    const settings = screens.find((screen) => screen.url === "/settings")
    expect(settings?.ancestors.map((ancestor) => [ancestor.file, ancestor.role, ancestor.splice])).toEqual([
      ["app/_layout.tsx", "layout", { kind: "outlet", tag: "Stack" }],
      ["app/(auth)/(tabs)/_layout.tsx", "layout", { kind: "outlet", tag: "NativeTabs" }],
      ["app/(auth)/(tabs)/(home)/_layout.tsx", "layout", { kind: "outlet", tag: "Stack" }],
    ])
    expect(settings?.shell).toBe("app/(auth)/(tabs)/(home)/_layout.tsx")
  })

  it("keeps shared-route losers as route-only screens with an info each", () => {
    const routeOnly = screens.filter((screen) => screen.url === null)
    expect(routeOnly.map((screen) => screen.activations.map((activation) => activation.kind))).toEqual([
      ["route"],
      ["route"],
    ])
    const shared = result.diagnostics.filter((diagnostic) => diagnostic.code === "screens/shared-route")
    expect(shared.map((diagnostic) => [diagnostic.severity, diagnostic.file])).toEqual([
      ["info", "app/(auth)/(tabs)/(search)/index.tsx"],
      ["info", "app/(auth)/(tabs)/index.tsx"],
    ])
  })

  it("reports a Stack.Screen name with no route file once per layout", () => {
    const unmatched = result.diagnostics.filter((diagnostic) => diagnostic.code === "screens/unmatched-layout-screen")
    expect(unmatched).toHaveLength(1)
    expect(unmatched[0]?.file).toBe("app/(auth)/(tabs)/(home)/_layout.tsx")
    expect(unmatched[0]?.message).toContain("'ghost'")
    expect(unmatched[0]?.severity).toBe("info")
  })

  it("never infers auth from the (auth) group name", () => {
    expect(new Set(screens.map((screen) => screen.auth))).toEqual(new Set(["unknown"]))
  })

  it("keeps settings.tv.tsx a route of its own without the react-native-tvos alias", () => {
    const plain = run({ files: FILES })
    expect(urlsOf(plain.graph.screens)).toContain("/settings.tv")
  })
})

describe("expo-router: platform variants", () => {
  it("warns on a platform variant with no base file and still maps it", () => {
    const result = run({ files: { "app/camera.ios.tsx": screenBody("Camera") } })

    expect(urlsOf(result.graph.screens)).toEqual(["/camera"])
    expect(result.graph.screens[0]?.entries[0]).toMatchObject({ file: "app/camera.ios.tsx", platform: "ios" })
    expect(
      result.diagnostics
        .filter((diagnostic) => diagnostic.code === "screens/orphan-platform-variant")
        .map((diagnostic) => [diagnostic.severity, diagnostic.file]),
    ).toEqual([["warning", "app/camera.ios.tsx"]])
  })

  it("warns on a.tsx against a/index.tsx and keeps the first by codepoint", () => {
    const result = run({ files: { "app/a.tsx": screenBody("A"), "app/a/index.tsx": screenBody("AIndex") } })

    expect(urlsOf(result.graph.screens)).toEqual(["/a"])
    expect(
      result.diagnostics.filter((diagnostic) => diagnostic.code === "screens/route-conflict").map((d) => d.severity),
    ).toEqual(["warning"])
  })
})

describe("expo-router: platform-suffixed layouts", () => {
  it("uses a platform-only _layout as the shell and ancestor, saying so in its warning", () => {
    const result = run({
      files: {
        "app/index.tsx": screenBody("Home"),
        "app/tabs/_layout.ios.tsx": stackLayout(["home"]),
        "app/tabs/home.tsx": screenBody("TabsHome"),
      },
    })
    const home = result.graph.screens.find((screen) => screen.url === "/tabs/home")

    expect(home?.ancestors.map((ancestor) => [ancestor.file, ancestor.role, ancestor.splice])).toEqual([
      ["app/tabs/_layout.ios.tsx", "layout", { kind: "outlet", tag: "Stack" }],
    ])
    expect(home?.shell).toBe("app/tabs/_layout.ios.tsx")
    const orphan = result.diagnostics.filter((diagnostic) => diagnostic.code === "screens/orphan-platform-variant")
    expect(orphan.map((diagnostic) => [diagnostic.severity, diagnostic.file])).toEqual([
      ["warning", "app/tabs/_layout.ios.tsx"],
    ])
    expect(orphan[0]?.message).toContain("it is used as the layout")
  })

  it("picks the first native-order platform when a _layout has only variants", () => {
    const result = run({
      files: {
        "app/tabs/_layout.android.tsx": stackLayout(),
        "app/tabs/_layout.ios.tsx": stackLayout(),
        "app/tabs/home.tsx": screenBody("TabsHome"),
      },
    })

    expect(byFile(result.graph.screens, "app/tabs/home.tsx")?.ancestors.map((ancestor) => ancestor.file)).toEqual([
      "app/tabs/_layout.ios.tsx",
    ])
  })

  it("keeps the base _layout as the ancestor and records its web variant as evidence", () => {
    const result = run({
      files: {
        "app/_layout.tsx": stackLayout(),
        "app/_layout.web.tsx": stackLayout(),
        "app/index.tsx": screenBody("Home"),
      },
    })
    const index = result.graph.screens[0]

    expect(index?.ancestors.map((ancestor) => ancestor.file)).toEqual(["app/_layout.tsx"])
    expect(index?.provenance.evidence).toContainEqual(
      expect.objectContaining({
        what: "expo-router web platform variant of layout app/_layout.tsx",
        file: "app/_layout.web.tsx",
      }),
    )
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "screens/orphan-platform-variant")).toBe(false)
  })
})

describe("expo-router: catch-all beside +not-found", () => {
  const result = run({
    files: {
      "app/index.tsx": screenBody("Home"),
      "app/[...rest].tsx": screenBody("Rest"),
      "app/+not-found.tsx": screenBody("NotFound"),
      "app/docs/[...slug].tsx": screenBody("Docs"),
      "app/docs/+not-found.tsx": screenBody("DocsNotFound"),
    },
  })

  it("keeps the explicit catch-all on each URL without a notFound tag", () => {
    expect(
      result.graph.screens.map((screen) => [screen.url, screen.entries[0]?.kind === "file" ? screen.entries[0].file : null]),
    ).toEqual([
      ["/", "app/index.tsx"],
      ["/*", "app/[...rest].tsx"],
      ["/docs/*", "app/docs/[...slug].tsx"],
    ])
    expect(result.graph.screens.some((screen) => screen.kindTag === "notFound")).toBe(false)
  })

  it("drops each +not-found with an info route-conflict naming both files", () => {
    const conflicts = result.diagnostics.filter((diagnostic) => diagnostic.code === "screens/route-conflict")
    expect(conflicts.map((diagnostic) => [diagnostic.severity, diagnostic.file])).toEqual([
      ["info", "app/+not-found.tsx"],
      ["info", "app/docs/+not-found.tsx"],
    ])
    expect(conflicts[0]?.message).toContain("'[...rest].tsx'")
    expect(conflicts[0]?.message).toContain("'+not-found.tsx'")
  })
})

describe("expo-router: cherry-shaped src/app tree", () => {
  const result = run({
    files: {
      "src/app/_layout.tsx": stackLayout(["(drawer)", "settings"]),
      "src/app/(drawer)/_layout.tsx": [
        'import { Drawer } from "expo-router/drawer"',
        "export default function DrawerLayout() { return <Drawer screenOptions={{ headerShown: false }} /> }",
        "",
      ].join("\n"),
      "src/app/(drawer)/home/index.tsx": screenBody("Home"),
      "src/app/(drawer)/home/chat/[topicId].tsx": screenBody("Chat"),
      "src/app/settings/index.tsx": screenBody("Settings"),
      "src/app/settings/index.test.tsx": screenBody("SettingsTest"),
      "src/app/api/health+api.ts": "export function GET() { return Response.json({}) }\n",
    },
  })

  it("reads src/app and skips test files", () => {
    expect(urlsOf(result.graph.screens)).toEqual(["/api/health", "/home", "/home/chat/:topicId", "/settings"])
  })

  it("splices drawer screens at the Drawer imported from expo-router/drawer", () => {
    const chat = result.graph.screens.find((screen) => screen.url === "/home/chat/:topicId")
    expect(chat?.ancestors.map((ancestor) => [ancestor.file, ancestor.splice])).toEqual([
      ["src/app/_layout.tsx", { kind: "outlet", tag: "Stack" }],
      ["src/app/(drawer)/_layout.tsx", { kind: "outlet", tag: "Drawer" }],
    ])
    expect(chat?.params).toEqual(["topicId"])
  })

  it("tags +api files apiRoute and gives them no layout chain", () => {
    const api = result.graph.screens.find((screen) => screen.url === "/api/health")
    expect(api?.kindTag).toBe("apiRoute")
    expect(api?.ancestors).toEqual([])
  })

  it("matches Stack.Screen names to route directories without an unmatched info", () => {
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("screens/unmatched-layout-screen")
  })
})

describe("expo-router: layouts without a navigator", () => {
  it("splices at children when the layout renders no known navigator", () => {
    const result = run({
      files: {
        "app/_layout.tsx": "export default function Root({ children }) { return <main>{children}</main> }\n",
        "app/index.tsx": screenBody("Home"),
      },
    })

    expect(result.graph.screens[0]?.ancestors[0]?.splice).toEqual({ kind: "children" })
  })

  it("follows a withLayoutContext navigator imported from another file", () => {
    const result = run({
      files: {
        "components/JsStack.tsx": [
          'import { withLayoutContext } from "expo-router"',
          'import { createStackNavigator } from "@react-navigation/stack"',
          "const { Navigator } = createStackNavigator()",
          "export const JsStack = withLayoutContext(Navigator)",
          "",
        ].join("\n"),
        "app/_layout.tsx": [
          'import { JsStack } from "../components/JsStack"',
          "export default function Root() { return <JsStack /> }",
          "",
        ].join("\n"),
        "app/index.tsx": screenBody("Home"),
      },
    })

    expect(result.graph.screens[0]?.ancestors[0]?.splice).toEqual({ kind: "outlet", tag: "JsStack" })
  })
})

describe("expo-router: auth", () => {
  const PROTECTED_LAYOUT = [
    'import { Stack } from "expo-router"',
    "export default function Root() {",
    "  const { isLoggedIn } = useAuth()",
    "  return (",
    "    <Stack>",
    "      <Stack.Protected guard={isLoggedIn}>",
    '        <Stack.Screen name="(app)" />',
    "      </Stack.Protected>",
    "      <Stack.Protected guard={!isLoggedIn}>",
    '        <Stack.Screen name="sign-in" />',
    "      </Stack.Protected>",
    '      <Stack.Screen name="about" />',
    "    </Stack>",
    "  )",
    "}",
    "",
  ].join("\n")

  const result = run({
    files: {
      "app/_layout.tsx": PROTECTED_LAYOUT,
      "app/(app)/index.tsx": screenBody("Home"),
      "app/(app)/profile/[id].tsx": screenBody("Profile"),
      "app/sign-in.tsx": screenBody("SignIn"),
      "app/about.tsx": screenBody("About"),
    },
  })
  const authOf = (url: string) => result.graph.screens.find((screen) => screen.url === url)?.auth

  it("protects screens declared inside a non-negated Stack.Protected guard", () => {
    expect(authOf("/")).toBe("protected")
    expect(authOf("/profile/:id")).toBe("protected")
  })

  it("makes screens inside a negated guard public", () => {
    expect(authOf("/sign-in")).toBe("public")
  })

  it("leaves screens outside any Protected block unknown", () => {
    expect(authOf("/about")).toBe("unknown")
  })

  it("records the guard text as evidence", () => {
    const home = result.graph.screens.find((screen) => screen.url === "/")
    expect(home?.provenance.evidence.map((entry) => entry.what)).toContain("Stack.Protected guard={isLoggedIn}")
  })

  it("keeps a guard outside the signed-in pattern unknown, with evidence", () => {
    const custom = run({
      files: {
        "app/_layout.tsx": PROTECTED_LAYOUT.replaceAll("isLoggedIn", "featureEnabled"),
        "app/(app)/index.tsx": screenBody("Home"),
      },
    })
    const home = custom.graph.screens[0]
    expect(home?.auth).toBe("unknown")
    expect(home?.provenance.evidence.map((entry) => entry.what)).toContain("Stack.Protected guard={featureEnabled}")
  })

  it("leaves a conditional <Redirect> guard unknown, with evidence", () => {
    const redirect = run({
      files: {
        "app/index.tsx": [
          'import { Redirect } from "expo-router"',
          "export default function Index() {",
          "  const { session } = useSession()",
          '  return session ? <View /> : <Redirect href="/sign-in" />',
          "}",
          "",
        ].join("\n"),
      },
    })
    const index = redirect.graph.screens[0]
    expect(index?.auth).toBe("unknown")
    expect(index?.provenance.evidence.some((entry) => entry.what.startsWith("conditional <Redirect> guard"))).toBe(true)
  })

  it.each([
    ["an early return", '  if (!session) return <Redirect href="/sign-in" />', "!session"],
    ["an early return in a block", '  if (!session) {\n    return <Redirect href="/sign-in" />\n  }', "!session"],
    [
      "an else branch",
      '  if (session) {\n    return <View />\n  } else {\n    return <Redirect href="/sign-in" />\n  }',
      "!(session)",
    ],
    [
      "a fall-through after a returning if",
      '  if (session) return <Stack />\n  return <Redirect href="/sign-in" />',
      "!(session)",
    ],
    [
      "a fall-through after a returning if block",
      '  if (session) {\n    return <Stack />\n  }\n  return <Redirect href="/sign-in" />',
      "!(session)",
    ],
  ])("records the if condition of a <Redirect> reached by %s as evidence", (_, body, condition) => {
    const redirect = run({
      files: {
        "app/index.tsx": [
          'import { Redirect } from "expo-router"',
          "export default function Index() {",
          "  const { session } = useSession()",
          body,
          "  return <View />",
          "}",
          "",
        ].join("\n"),
      },
    })
    const index = redirect.graph.screens[0]
    expect(index?.auth).toBe("unknown")
    expect(index?.provenance.evidence.map((entry) => entry.what)).toContain(
      `conditional <Redirect> guard (${condition}); auth unknown`,
    )
  })

  it.each([
    ["a non-returning if", '  if (session) track()\n  return <Redirect href="/sign-in" />'],
    ["an if with an else", '  if (session) return <Stack />\n  else track()\n  return <Redirect href="/sign-in" />'],
  ])("records no guard for a <Redirect> after %s", (_, body) => {
    const redirect = run({
      files: {
        "app/index.tsx": [
          'import { Redirect } from "expo-router"',
          "export default function Index() {",
          "  const { session } = useSession()",
          body,
          "}",
          "",
        ].join("\n"),
      },
    })
    const evidence = redirect.graph.screens[0]?.provenance.evidence ?? []
    expect(evidence.some((entry) => entry.what.startsWith("conditional <Redirect> guard"))).toBe(false)
  })

  it("leaves a useSegments + router.replace hook guard in a layout unknown, with evidence", () => {
    const hook = run({
      files: {
        "app/_layout.tsx": [
          'import { Slot, useRouter, useSegments } from "expo-router"',
          "export default function Root() {",
          "  const segments = useSegments()",
          "  const router = useRouter()",
          '  useEffect(() => { if (!user && segments[0] !== "(auth)") router.replace("/login") }, [user, segments])',
          "  return <Slot />",
          "}",
          "",
        ].join("\n"),
        "app/(auth)/dashboard.tsx": screenBody("Dashboard"),
      },
    })
    const dashboard = hook.graph.screens[0]
    expect(dashboard?.auth).toBe("unknown")
    expect(dashboard?.ancestors[0]?.splice).toEqual({ kind: "outlet", tag: "Slot" })
    expect(dashboard?.provenance.evidence.map((entry) => entry.what)).toContain(
      "useSegments() + router.replace hook guard; auth unknown",
    )
  })
})

describe("expo-router: routes dir from the Expo config", () => {
  it("reads the literal plugin root from app.json", () => {
    const result = run({
      files: {
        "app.json": JSON.stringify({ expo: { plugins: [["expo-router", { root: "./src/screens" }]] } }),
        "app/index.tsx": screenBody("Ignored"),
        "src/screens/index.tsx": screenBody("Home"),
        "src/screens/about.tsx": screenBody("About"),
      },
    })

    expect(result.graph.screens.map((screen) => [screen.url, screen.entries[0]])).toEqual([
      ["/", { kind: "file", file: "src/screens/index.tsx", exportName: "default" }],
      ["/about", { kind: "file", file: "src/screens/about.tsx", exportName: "default" }],
    ])
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("project/expo-config-dynamic")
  })

  it("reads the plugin root from a literal app.config.ts", () => {
    const result = run({
      files: {
        "app.config.ts": 'export default { expo: { name: "x", plugins: ["expo-font", ["expo-router", { root: "screens" }]] } }\n',
        "screens/index.tsx": screenBody("Home"),
      },
    })

    expect(byFile(result.graph.screens, "screens/index.tsx")?.url).toBe("/")
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("project/expo-config-dynamic")
  })

  it("falls back to the default dirs with an info for a non-literal app.config.ts", () => {
    const result = run({
      files: {
        "app.config.ts": "export default ({ config }) => ({ ...config, plugins: [...config.plugins] })\n",
        "app/index.tsx": screenBody("Home"),
      },
    })

    expect(urlsOf(result.graph.screens)).toEqual(["/"])
    const dynamic = result.diagnostics.filter((diagnostic) => diagnostic.code === "project/expo-config-dynamic")
    expect(dynamic.map((diagnostic) => [diagnostic.severity, diagnostic.file])).toEqual([["info", "app.config.ts"]])
  })
})

describe("expo-router: the next-app gate", () => {
  it("gives next-app 0 screens on an Expo project without the next dependency", () => {
    const result = run({
      adapters: [adapterFor(nextAppSource)],
      files: { "app/items/page.tsx": screenBody("Item"), "app/index.tsx": screenBody("Home") },
    })

    expect(result.graph.screens).toEqual([])
  })

  it("gives expo-router 0 screens without the expo-router dependency", () => {
    const result = run({
      packageJson: JSON.stringify({ dependencies: { react: "19.0.0" } }),
      files: { "app/index.tsx": screenBody("Home") },
    })

    expect(result.graph.screens).toEqual([])
  })
})

describe("expo-router: required catch-all pin", () => {
  it("does not treat an Expo [...rest].tsx leaf as a Next required catch-all", () => {
    const file = "app/docs/[...rest].tsx"
    expect(isRequiredNextCatchAll("/docs/*", file)).toBe(false)
    expect(hasRequiredCatchAllEntry({ localId: file, entries: [{ kind: "file", file, exportName: "default" }] }, "/docs/*")).toBe(false)
  })

  it("keeps [...rest]/index.tsx required, which matches Expo's own semantics", () => {
    expect(isRequiredNextCatchAll("/docs/*", "app/docs/[...rest]/index.tsx")).toBe(true)
  })

  it("maps the Expo leaf to a catch-all screen", () => {
    const result = run({ files: { "app/docs/[...rest].tsx": screenBody("Docs") } })
    expect(urlsOf(result.graph.screens)).toEqual(["/docs/*"])
  })
})
