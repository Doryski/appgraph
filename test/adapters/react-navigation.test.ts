import ts from "typescript"
import { describe, expect, it } from "vitest"
import { createMemoryHost } from "../../src/core/host.js"
import { resolveConfig } from "../../src/config/types.js"
import { createEnv, createProjectContext } from "../../src/pipeline/context.js"
import {
  createReactNavigationAdapter,
  detectReactNavigation,
  type ReactNavigationOptions,
} from "../../src/adapters/react-navigation.js"
import type { Screen } from "../../src/core/model.js"
import { ROOT, codes, run as runFixture, type RunOptions } from "../pipeline/harness.js"

const PACKAGE_JSON = JSON.stringify({
  name: "fixture",
  dependencies: {
    react: "19.0.0",
    "react-native": "0.81.0",
    "@react-navigation/native": "7.1.0",
    "@react-navigation/native-stack": "7.3.0",
  },
})

const EXPO_PACKAGE_JSON = JSON.stringify({
  name: "fixture",
  dependencies: { "expo-router": "6.0.0", "@react-navigation/native": "7.1.0", "@react-navigation/native-stack": "7.3.0" },
})

const ROUTER_TABLE = { pathTables: [{ callee: "Router", argument: 0 }] }

const run = (options: RunOptions & { readonly adapter?: ReactNavigationOptions; readonly packageJson?: string }) =>
  runFixture({
    adapters: [createReactNavigationAdapter(options.adapter ?? {})],
    ...options,
    files: { "package.json": options.packageJson ?? PACKAGE_JSON, ...options.files },
  })

const screenFile = (name: string, body = "<View />"): string =>
  [
    'import { useNavigation, Link } from "@react-navigation/native"',
    `export function ${name}() {`,
    "  const navigation = useNavigation()",
    `  return ${body}`,
    "}",
    "",
  ].join("\n")

const stack = (local: string, screens: readonly string[]): string =>
  [
    `<${local}.Navigator>`,
    ...screens.map((screen) => `  ${screen}`),
    `</${local}.Navigator>`,
  ].join("\n")

const navigationFile = (body: readonly string[], imports: readonly string[] = []): string =>
  [
    'import { createNativeStackNavigator } from "@react-navigation/native-stack"',
    'import { HomeScreen } from "./screens/Home"',
    'import { SettingsScreen } from "./screens/Settings"',
    ...imports,
    ...body,
    "",
  ].join("\n")

const byName = (screens: readonly Screen[], name: string): Screen | undefined =>
  screens.find((screen) => screen.activations.some((activation) => activation.kind === "route" && activation.name === name))

const routeActivationsOf = (screen: Screen | undefined) =>
  (screen?.activations ?? []).filter((activation) => activation.kind === "route")

const urlTemplatesOf = (screen: Screen | undefined): readonly string[] =>
  (screen?.activations ?? []).flatMap((activation) => (activation.kind === "url" ? [activation.template] : []))

const edgesOf = (screen: Screen | undefined) =>
  (screen?.navigatesTo ?? []).map((edge) => [edge.to, edge.matchedRoute, edge.routeName ?? null])

const SCREENS = {
  "src/screens/Home.tsx": screenFile("HomeScreen", '<Link to="/download" />'),
  "src/screens/Settings.tsx": screenFile("SettingsScreen", '<Button onPress={() => navigation.navigate("Home")} />'),
}

describe("react-navigation: detect", () => {
  const detectWith = (files: Readonly<Record<string, string>>) => {
    const host = createMemoryHost({
      files: Object.fromEntries(Object.entries(files).map(([file, text]) => [`${ROOT}/${file}`, text])),
    })
    const env = createEnv({ ts, config: resolveConfig({ root: ROOT, appgraphVersion: "0.1.0-test" }), host })
    return detectReactNavigation(createProjectContext(env))
  }

  const navigator = navigationFile(["export const Stack = createNativeStackNavigator()"])

  it("scores 90 with a @react-navigation dependency and a navigator factory call", () => {
    const result = detectWith({ "package.json": PACKAGE_JSON, "src/Navigation.tsx": navigator })

    expect(result.score).toBe(90)
    expect(result.evidence).toEqual([{ what: "createNativeStackNavigator call", file: "src/Navigation.tsx", line: 4 }])
  })

  it("detects a custom factory called with type arguments", () => {
    const custom = "const HomeTab = createNativeStackNavigatorWithAuth<HomeTabParams>()\n"

    expect(detectWith({ "package.json": PACKAGE_JSON, "src/Navigation.tsx": custom }).evidence).toEqual([
      { what: "createNativeStackNavigatorWithAuth call", file: "src/Navigation.tsx", line: 1 },
    ])
  })

  it("scores 0 when expo-router is a dependency", () => {
    expect(detectWith({ "package.json": EXPO_PACKAGE_JSON, "src/Navigation.tsx": navigator }).score).toBe(0)
  })

  it("discovers nothing when expo-router is a dependency", () => {
    const result = run({
      packageJson: EXPO_PACKAGE_JSON,
      files: { ...SCREENS, "src/Navigation.tsx": navigationFile(["const Stack = createNativeStackNavigator()", "export const App = () => " + stack("Stack", ['<Stack.Screen name="Home" component={HomeScreen} />'])]) },
    })

    expect(result.graph.screens).toEqual([])
  })
})

describe("react-navigation: name identity", () => {
  const threeStacks = navigationFile([
    "const HomeTab = createNativeStackNavigator()",
    "const SearchTab = createNativeStackNavigator()",
    "const Flat = createNativeStackNavigator()",
    "function commonScreens(Stack: typeof Flat) {",
    '  return <><Stack.Screen name="Settings" component={SettingsScreen} /></>',
    "}",
    "export const HomeNav = () => (",
    stack("HomeTab", ['<HomeTab.Screen name="Home" component={HomeScreen} />', "{commonScreens(HomeTab)}"]),
    ")",
    `export const SearchNav = () => (${stack("SearchTab", ["{commonScreens(SearchTab)}"])})`,
    `export const FlatNav = () => (${stack("Flat", ["{commonScreens(Flat)}"])})`,
  ])

  it("maps one name registered in three navigators to one screen with three route activations", () => {
    const result = run({ files: { ...SCREENS, "src/Navigation.tsx": threeStacks } })
    const settings = byName(result.graph.screens, "Settings")

    expect(result.graph.screens.map((screen) => screen.id)).toEqual([
      "screen://react-navigation/Home",
      "screen://react-navigation/Settings",
    ])
    expect(settings?.localId).toBe("src/Navigation.tsx#route:Settings")
    expect(routeActivationsOf(settings)).toEqual([
      { kind: "route", name: "Settings", navigator: "Flat" },
      { kind: "route", name: "Settings", navigator: "HomeTab" },
      { kind: "route", name: "Settings", navigator: "SearchTab" },
    ])
    expect(settings?.entries).toHaveLength(1)
    expect(settings?.ancestors).toEqual([])
    expect(codes(result)).not.toContain("screens/ambiguous-route-name")
    expect(codes(result)).not.toContain("screens/conflict-dropped")
  })

  it("resolves a navigate('Name') edge to the named screen", () => {
    const result = run({ files: { ...SCREENS, "src/Navigation.tsx": threeStacks } })

    expect(edgesOf(byName(result.graph.screens, "Settings"))).toEqual([
      ["screen://react-navigation/Home", "screen://react-navigation/Home", "Home"],
    ])
  })

  it("keeps an unknown name as a name: target with a dead link", () => {
    const result = run({
      files: {
        ...SCREENS,
        "src/screens/Settings.tsx": screenFile("SettingsScreen", '<Button onPress={() => navigation.navigate("Nowhere")} />'),
        "src/Navigation.tsx": threeStacks,
      },
    })

    expect(edgesOf(byName(result.graph.screens, "Settings"))).toEqual([["name:Nowhere", null, "Nowhere"]])
    expect(codes(result)).toContain("nav/dead-link")
  })

  it("keeps every entry of one name registered with different components, with a warning naming both files", () => {
    const result = run({
      files: {
        ...SCREENS,
        "src/screens/Other.tsx": screenFile("OtherScreen"),
        "src/Navigation.tsx": navigationFile([
          "const Stack = createNativeStackNavigator()",
          `export const App = () => (${stack("Stack", ['<Stack.Screen name="Settings" component={SettingsScreen} />'])})`,
        ]),
        "src/Modal.tsx": navigationFile(
          [
            "const Modal = createNativeStackNavigator()",
            `export const ModalNav = () => (${stack("Modal", ['<Modal.Screen name="Settings" component={OtherScreen} />'])})`,
          ],
          ['import { OtherScreen } from "./screens/Other"'],
        ),
      },
    })
    const settings = byName(result.graph.screens, "Settings")
    const warning = result.diagnostics.find((diagnostic) => diagnostic.code === "screens/ambiguous-route-name")

    expect(result.graph.screens).toHaveLength(1)
    expect(settings?.localId).toBe("src/Modal.tsx#route:Settings")
    expect(settings?.entries).toHaveLength(2)
    expect(warning?.severity).toBe("warning")
    expect(warning?.message).toContain("'src/Modal.tsx'")
    expect(warning?.message).toContain("'src/Navigation.tsx'")
    expect(warning?.message).toContain("'src/screens/Other.tsx#OtherScreen'")
    expect(warning?.message).toContain("'src/screens/Settings.tsx#SettingsScreen'")
  })

  it("reports non-literal names once as screens/dynamic-registry", () => {
    const result = run({
      files: {
        ...SCREENS,
        "src/Navigation.tsx": navigationFile([
          "const Stack = createNativeStackNavigator()",
          "export const App = ({ extra, other }) => (",
          stack("Stack", [
            '<Stack.Screen name="Home" component={HomeScreen} />',
            "<Stack.Screen name={extra} component={HomeScreen} />",
            "<Stack.Screen name={other} component={SettingsScreen} />",
          ]),
          ")",
        ]),
      },
    })
    const dynamic = result.diagnostics.filter((diagnostic) => diagnostic.code === "screens/dynamic-registry")

    expect(result.graph.screens.map((screen) => screen.id)).toEqual(["screen://react-navigation/Home"])
    expect(dynamic).toHaveLength(1)
    expect(dynamic[0]?.severity).toBe("info")
    expect(dynamic[0]?.message).toContain("2 React Navigation screen registration(s)")
  })
})

describe("react-navigation: URLs", () => {
  const app = navigationFile([
    "const Stack = createNativeStackNavigator()",
    "export const App = () => (",
    stack("Stack", [
      '<Stack.Screen name="Home" component={HomeScreen} />',
      '<Stack.Screen name="Settings" component={SettingsScreen} />',
    ]),
    ")",
  ])

  const routes = (table: string): string => `export const router = new Router(${table})\n`

  it("gives a multi-path table entry one url activation per path, with the first as its id", () => {
    const result = run({
      adapter: ROUTER_TABLE,
      files: {
        ...SCREENS,
        "src/screens/Settings.tsx": screenFile("SettingsScreen", '<Link to="/download" />'),
        "src/Navigation.tsx": app,
        "src/routes.ts": routes("{ Home: ['/', '/download'], Settings: '/settings' }"),
      },
    })
    const home = byName(result.graph.screens, "Home")

    expect(home?.id).toBe("/")
    expect(urlTemplatesOf(home)).toEqual(["/", "/download"])
    expect(routeActivationsOf(home)).toEqual([{ kind: "route", name: "Home", navigator: "Stack" }])
    expect(edgesOf(byName(result.graph.screens, "Settings"))).toEqual([["/download", "/", null]])
  })

  it("resolves navigate('Home') to the URL-identified screen", () => {
    const result = run({
      adapter: ROUTER_TABLE,
      files: {
        ...SCREENS,
        "src/Navigation.tsx": app,
        "src/routes.ts": routes("{ Home: ['/', '/download'], Settings: '/settings' }"),
      },
    })

    expect(edgesOf(byName(result.graph.screens, "Settings"))).toEqual([["/", "/", "Home"]])
  })

  it("keeps a shared path with the first name by code point; the other becomes route-only with an info", () => {
    const result = run({
      adapter: ROUTER_TABLE,
      files: { ...SCREENS, "src/Navigation.tsx": app, "src/routes.ts": routes("{ Settings: '/', Home: '/' }") },
    })
    const shared = result.diagnostics.filter((diagnostic) => diagnostic.code === "screens/shared-route")

    expect(byName(result.graph.screens, "Home")?.id).toBe("/")
    expect(byName(result.graph.screens, "Settings")?.id).toBe("screen://react-navigation/Settings")
    expect(urlTemplatesOf(byName(result.graph.screens, "Settings"))).toEqual([])
    expect(shared).toHaveLength(1)
    expect(shared[0]?.message).toContain("'Settings'")
    expect(codes(result)).not.toContain("screens/conflict-dropped")
  })

  it("aggregates unreadable table entries into one screens/path-table-unreadable warning", () => {
    const result = run({
      adapter: ROUTER_TABLE,
      files: {
        ...SCREENS,
        "src/Navigation.tsx": app,
        "src/routes.ts": `declare const dynamic: string\nexport const router = new Router({ Home: '/', Settings: dynamic })\n`,
      },
    })
    const unreadable = result.diagnostics.filter((diagnostic) => diagnostic.code === "screens/path-table-unreadable")

    expect(unreadable).toHaveLength(1)
    expect(unreadable[0]?.severity).toBe("warning")
    expect(unreadable[0]?.message).toContain("src/routes.ts:2")
    expect(byName(result.graph.screens, "Settings")?.id).toBe("screen://react-navigation/Settings")
  })

  it("reads linking.config.screens passed to NavigationContainer", () => {
    const result = run({
      files: {
        ...SCREENS,
        "src/Navigation.tsx": navigationFile(
          [
            "const Stack = createNativeStackNavigator()",
            "const LINKING = { prefixes: ['app://'], config: { screens: { Home: '', Settings: 'settings/:tab' } } }",
            "export const App = () => (",
            "<NavigationContainer linking={LINKING}>",
            stack("Stack", [
              '<Stack.Screen name="Home" component={HomeScreen} />',
              '<Stack.Screen name="Settings" component={SettingsScreen} />',
            ]),
            "</NavigationContainer>",
            ")",
          ],
          ['import { NavigationContainer } from "@react-navigation/native"'],
        ),
      },
    })
    const settings = byName(result.graph.screens, "Settings")

    expect(byName(result.graph.screens, "Home")?.id).toBe("/")
    expect(settings?.id).toBe("/settings/:tab")
    expect(settings?.params).toEqual(["tab"])
  })

  it("reads static linking fields and auto kebab-case paths", () => {
    const result = run({
      files: {
        ...SCREENS,
        "src/Navigation.tsx": navigationFile(
          [
            "const RootStack = createNativeStackNavigator({",
            "  screens: { Home: { screen: HomeScreen, linking: { path: '' } }, AccountSettings: SettingsScreen },",
            "})",
            "const Navigation = createStaticNavigation(RootStack)",
            "export const App = () => <Navigation linking={{ enabled: 'auto', prefixes: ['app://'] }} />",
          ],
          ['import { createStaticNavigation } from "@react-navigation/native"'],
        ),
      },
    })

    expect(result.graph.screens.map((screen) => screen.id)).toEqual(["/", "/account-settings"])
  })
})

describe("react-navigation: auth", () => {
  it("marks options.requireAuth: true as protected and a signed-in static if as protected", () => {
    const result = run({
      files: {
        ...SCREENS,
        "src/Navigation.tsx": navigationFile([
          "const Stack = createNativeStackNavigator()",
          "export const App = () => (",
          stack("Stack", ['<Stack.Screen name="Settings" component={SettingsScreen} options={{ requireAuth: true }} />']),
          ")",
          "export const Root = createNativeStackNavigator({",
          "  screens: { Home: { screen: HomeScreen, if: useIsSignedIn }, Open: { screen: HomeScreen, if: useIsSignedOut } },",
          "})",
        ]),
      },
    })
    const authOf = (name: string) => byName(result.graph.screens, name)?.auth

    expect(authOf("Settings")).toBe("protected")
    expect(authOf("Home")).toBe("protected")
    expect(authOf("Open")).toBe("unknown")
  })

  it("leaves a name with conflicting verdicts across navigators unknown", () => {
    const result = run({
      files: {
        ...SCREENS,
        "src/Navigation.tsx": navigationFile([
          "const A = createNativeStackNavigator()",
          "const B = createNativeStackNavigator()",
          `export const NavA = () => (${stack("A", ['<A.Screen name="Settings" component={SettingsScreen} options={{ requireAuth: true }} />'])})`,
          `export const NavB = () => (${stack("B", ['<B.Screen name="Settings" component={SettingsScreen} options={{ requireAuth: false }} />'])})`,
        ]),
      },
    })

    expect(byName(result.graph.screens, "Settings")?.auth).toBe("unknown")
  })
})
