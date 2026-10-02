import type ts from "typescript"
import { describe, expect, it } from "vitest"
import { autoLinkingPaths, kebabCaseName, readLinking, readPathTables } from "../../src/adapters/route-tables.js"
import { discoverBench } from "./discover-harness.js"

const ROUTES = [
  `import {Router} from './router'`,
  `const SETTINGS = '/settings'`,
  `const extra = { Lists: '/lists' }`,
  `export const router = new Router<AllRoutes>({`,
  `  Home: ['/', '/download'],`,
  `  Profile: ['/profile/:name', '/profile/:name/rss'],`,
  `  Settings: SETTINGS,`,
  `  ...extra,`,
  `  Dynamic: getPath(),`,
  `  Post: \`/profile/\${name}/post\`,`,
  `})`,
  "",
].join("\n")

const LINKING = [
  `const nested = { Feed: 'feed', Post: 'post/:id' }`,
  `export const linking = {`,
  `  prefixes: ['app://'],`,
  `  subscribe(listener) { return () => {} },`,
  `  config: {`,
  `    screens: {`,
  `      Home: {`,
  `        path: 'home',`,
  `        screens: nested,`,
  `      },`,
  `      Tabs: {`,
  `        screens: { Inbox: 'inbox', Index: '' },`,
  `      },`,
  `      Modal: { path: 'modal', exact: true },`,
  `      Profile: 'u/:id?',`,
  `      Broken: makePath(),`,
  `      NotFound: '*',`,
  `    },`,
  `  },`,
  `}`,
  "",
].join("\n")

const STATIC = [
  `const HomeTabs = createBottomTabNavigator({`,
  `  screens: {`,
  `    Feed: { screen: FeedScreen, linking: 'feed' },`,
  `    Search: SearchScreen,`,
  `  },`,
  `})`,
  `export const Root = createNativeStackNavigator({`,
  `  screens: {`,
  `    Home: { screen: HomeTabs, linking: { path: 'home' } },`,
  `    User: { screen: UserScreen, linking: 'u/:id' },`,
  `  },`,
  `  groups: {`,
  `    Guest: { if: useIsGuest, screens: { Login: { screen: LoginScreen, linking: 'login' } } },`,
  `  },`,
  `})`,
  `export const auto = { enabled: 'auto', prefixes: [] }`,
  "",
].join("\n")

const bench = discoverBench({
  "src/routes.ts": ROUTES,
  "src/linking.ts": LINKING,
  "src/static.tsx": STATIC,
  "src/routes.test.ts": `new Router({ Hidden: '/hidden' })`,
})
const { ctx } = bench

const initializerOf = (file: string, name: string): ts.Expression => {
  const declaration = bench.find(
    file,
    (node): node is ts.VariableDeclaration =>
      ctx.ts.isVariableDeclaration(node) && ctx.ast.asIdentifier(node.name)?.text === name,
  )
  if (declaration.initializer === undefined) throw new Error(`no initializer for ${name}`)
  return declaration.initializer
}

describe("adapters/route-tables readPathTables", () => {
  const table = readPathTables(ctx, [{ callee: "Router", argument: 0 }])

  it("reads a bluesky-shaped table with multi-path names, consts and spreads", () => {
    expect([...table.paths]).toEqual([
      ["Home", ["/", "/download"]],
      ["Profile", ["/profile/:name", "/profile/:name/rss"]],
      ["Settings", ["/settings"]],
      ["Lists", ["/lists"]],
    ])
  })

  it("lists non-literal values as unreadable", () => {
    expect(table.unreadable).toEqual([
      { file: "src/routes.ts", line: 9, text: "getPath()" },
      { file: "src/routes.ts", line: 10, text: "`/profile/${name}/post`" },
    ])
  })

  it("returns nothing for a callee that does not match", () => {
    const other = readPathTables(ctx, [{ callee: "Navigator", argument: 0 }])

    expect([...other.paths]).toEqual([])
    expect(other.unreadable).toEqual([])
  })

  it("returns nothing when the argument index is absent", () => {
    expect([...readPathTables(ctx, [{ callee: "Router", argument: 1 }]).paths]).toEqual([])
  })
})

describe("adapters/route-tables readLinking", () => {
  it("joins nested config.screens, the {path, screens} form, '' and '*'", () => {
    const linking = readLinking(ctx, "src/linking.ts", initializerOf("src/linking.ts", "linking"))

    expect([...linking.paths]).toEqual([
      ["Home", ["/home"]],
      ["Feed", ["/home/feed"]],
      ["Post", ["/home/post/:id"]],
      ["Inbox", ["/inbox"]],
      ["Index", ["/"]],
      ["Modal", ["/modal"]],
      ["Profile", ["/u/:id?"]],
      ["NotFound", ["/*"]],
    ])
    expect(linking.unreadable).toEqual([{ file: "src/linking.ts", line: 16, text: "makePath()" }])
    expect(linking.auto).toBe(false)
  })

  it("reads static-API linking fields through nested navigators and groups", () => {
    const linking = readLinking(ctx, "src/static.tsx", initializerOf("src/static.tsx", "Root"))

    expect([...linking.paths]).toEqual([
      ["Home", ["/home"]],
      ["Feed", ["/home/feed"]],
      ["User", ["/u/:id"]],
      ["Login", ["/login"]],
    ])
    expect(linking.unreadable).toEqual([])
  })

  it("flags enabled: 'auto'", () => {
    const linking = readLinking(ctx, "src/static.tsx", initializerOf("src/static.tsx", "auto"))

    expect(linking.auto).toBe(true)
    expect([...linking.paths]).toEqual([])
  })
})

describe("adapters/route-tables auto linking", () => {
  it("kebab-cases screen names", () => {
    expect(["NewsFeed", "Home", "HTMLPage", "Profile2"].map(kebabCaseName)).toEqual([
      "news-feed",
      "home",
      "html-page",
      "profile2",
    ])
  })

  it("gives paths only to screens lacking an explicit one", () => {
    const paths = autoLinkingPaths(["NewsFeed", "Settings"], new Map([["Settings", ["/prefs"]]]))

    expect([...paths]).toEqual([["NewsFeed", ["/news-feed"]]])
  })
})
