import type ts from "typescript"
import { describe, expect, it } from "vitest"
import type { AngularElement, AngularFold, MemberList } from "../../src/adapters/angular/values.js"
import { createAngularValues } from "../../src/adapters/angular/values.js"
import { discoverBench } from "./discover-harness.js"

const DEVICE = "src/device-routing.module.ts"
const MISC = "src/misc.ts"
const APP = "src/app.routes.ts"
const SATISFIED = "src/satisfied.routes.ts"
const NAMED = "src/named.routes.ts"
const CYCLE = "src/cycle.ts"
const OVERVIEW_ROUTES = "src/admin/overview/overview.routes.ts"
const OVERVIEW_INDEX = "src/admin/overview/index.ts"
const ADMIN_ROUTES = "src/admin/routes.ts"
const EDGE = "src/edge-routing.module.ts"
const CUSTOMER = "src/customer-routing.module.ts"
const APP_CONFIG = "src/app.config.ts"
const MAIN = "src/main.ts"
const COMMON_CONSTANTS = "assets/constants.ts"
const APP_CONSTANTS = "src/app.constants.ts"
const ROUTING = "src/app.routing.module.ts"

const DEVICE_SOURCE = [
  `const deviceGroupsChildrenRoutesTemplate = (shared: boolean): Routes => [`,
  `  { path: '', component: EntitiesTableComponent, data: { title: entityGroupsTitle(EntityType.DEVICE, shared) } },`,
  `  { path: ':entityGroupId', children: [{ path: '', component: GroupEntitiesTableComponent }] }`,
  `];`,
  `export const deviceGroupsRoute: Route = { path: 'groups', children: deviceGroupsChildrenRoutesTemplate(false) };`,
  `const deviceSharedGroupsRoute: Route = { path: 'shared', children: deviceGroupsChildrenRoutesTemplate(true) };`,
  `export const devicesRoute = (root = false): Route => {`,
  `  const routeConfig: Route = {`,
  `    path: 'devices',`,
  `    component: RouterTabsComponent,`,
  `    children: [`,
  `      { path: '', children: [], data: { redirectTo: 'all' } },`,
  `      { path: 'all', children: [{ path: '', component: EntitiesTableComponent }] },`,
  `      deviceGroupsRoute`,
  `    ]`,
  `  };`,
  `  if (root) {`,
  `    routeConfig.children.push(deviceSharedGroupsRoute);`,
  `  }`,
  `  return routeConfig;`,
  `};`,
  `export const withShared = [devicesRoute(true)];`,
  `export const withoutShared = [devicesRoute()];`,
  "",
].join("\n")

const MISC_SOURCE = [
  `const flagged = () => {`,
  `  const route = { path: 'flagged', children: [{ path: 'a' }] };`,
  `  if (environment.beta) {`,
  `    route.children.push({ path: 'beta' });`,
  `  } else {`,
  `    route.children.push({ path: 'stable' });`,
  `  }`,
  `  return route;`,
  `};`,
  `export const flaggedRoutes = [flagged()];`,
  `const customersRoute = () => ({ path: 'customers', component: CustomersComponent });`,
  `export const merged = { ...customersRoute(), ...{ path: 'x' } };`,
  `const commonConfig = { path: 'common', canActivate: [AuthGuard] };`,
  `export const spreadConst = { ...commonConfig, path: 'a' };`,
  `export const unknownSpread = { ...load(), path: 'b' };`,
  "",
].join("\n")

const APP_SOURCE = [
  `const routes: Routes = [{ path: '' }, { path: 'home' }];`,
  `routes.push({ path: '**' });`,
  `for (const plugin of plugins) {`,
  `  routes.push(plugin.route);`,
  `}`,
  `export default routes;`,
  "",
].join("\n")

const SATISFIED_SOURCE = `export default [{ path: 'one' }] satisfies Routes;\n`

const NAMED_SOURCE = `export const NAMED_ROUTES: Routes = [{ path: 'named' }];\n`

const CYCLE_SOURCE = [
  `const a = [...b, { path: 'a' }];`,
  `const b = [...a];`,
  `export const loop = (): Routes => loop();`,
  `export const looped = [...loop()];`,
  `const objA = { ...objB, path: 'a' };`,
  `const objB = { ...objA };`,
  `export const cyclicObject = objA;`,
  "",
].join("\n")

const OVERVIEW_ROUTES_SOURCE = `export const overviewRoutes: Routes = [{ path: 'overview' }];\n`

const OVERVIEW_INDEX_SOURCE = [`export * from './users';`, `export * from './overview.routes';`, ""].join("\n")

const ADMIN_ROUTES_SOURCE = [
  `import { overviewRoutes } from './overview';`,
  `export const adminChildren = [{ path: '', redirectTo: 'overview' }, ...overviewRoutes];`,
  "",
].join("\n")

const EDGE_SOURCE = [
  `export const edgesRoute = (root = false): Route => {`,
  `  const routeConfig: Route = { path: 'edgeManagement', children: [{ path: 'edges' }] };`,
  `  if (root) {`,
  `    routeConfig.children.push({ path: 'templates' });`,
  `  }`,
  `  return routeConfig;`,
  `};`,
  "",
].join("\n")

const CUSTOMER_SOURCE = [
  `import { edgesRoute } from './edge-routing.module';`,
  `export const customerChildren = [`,
  `  (() => {`,
  `    const edges = edgesRoute();`,
  `    return { ...edges, path: ':customerId/edgeManagement', children: [...edges.children, { path: 'agents' }] };`,
  `  })(),`,
  `];`,
  `export const missingMember = [...edgesRoute().unknown];`,
  "",
].join("\n")

const APP_CONFIG_SOURCE = [
  `export const appConfig: ApplicationConfig = {`,
  `  providers: [provideHttpClient(), provideRouter(routes, withHashLocation())]`,
  `};`,
  "",
].join("\n")

const MAIN_SOURCE = [
  `import { appConfig } from './app.config';`,
  `export const config = { ...appConfig, providers: [provideZoneChangeDetection(), ...appConfig.providers] };`,
  "",
].join("\n")

const COMMON_CONSTANTS_SOURCE = [
  `export default {`,
  `  "PAGES_REGISTERED_WITH_FRONTEND": {`,
  `    "SPLASH": { "ROUTE": "", "TITLE": "Oppia" },`,
  `    "ABOUT": { "ROUTE": "about" }`,
  `  }`,
  `};`,
  "",
].join("\n")

const APP_CONSTANTS_SOURCE = [
  `import commonConstants from 'assets/constants';`,
  `export const AppConstants = {`,
  `  ...commonConstants,`,
  `  STEWARDS: { ROUTES: ['parents', 'partners'] },`,
  `  LOCAL_ROUTE: 'local',`,
  `} as const;`,
  "",
].join("\n")

const ROUTING_SOURCE = [
  `import { AppConstants } from './app.constants';`,
  `const pick = (flag: boolean) => (flag ? { ROUTE: 'a' } : { ROUTE: 'b' });`,
  `export const splash = AppConstants.PAGES_REGISTERED_WITH_FRONTEND.SPLASH.ROUTE;`,
  `export const about = AppConstants.PAGES_REGISTERED_WITH_FRONTEND\n  .ABOUT.ROUTE;`,
  `export const local = AppConstants.LOCAL_ROUTE;`,
  `export const missing = AppConstants.PAGES_REGISTERED_WITH_FRONTEND.NOPE.ROUTE;`,
  `export const indexed = AppConstants.STEWARDS.ROUTES[0];`,
  `export const branched = pick(flag).ROUTE;`,
  "",
].join("\n")

const bench = discoverBench({
  [DEVICE]: DEVICE_SOURCE,
  [MISC]: MISC_SOURCE,
  [APP]: APP_SOURCE,
  [SATISFIED]: SATISFIED_SOURCE,
  [NAMED]: NAMED_SOURCE,
  [CYCLE]: CYCLE_SOURCE,
  [OVERVIEW_ROUTES]: OVERVIEW_ROUTES_SOURCE,
  [OVERVIEW_INDEX]: OVERVIEW_INDEX_SOURCE,
  [ADMIN_ROUTES]: ADMIN_ROUTES_SOURCE,
  [EDGE]: EDGE_SOURCE,
  [CUSTOMER]: CUSTOMER_SOURCE,
  [APP_CONFIG]: APP_CONFIG_SOURCE,
  [MAIN]: MAIN_SOURCE,
  [COMMON_CONSTANTS]: COMMON_CONSTANTS_SOURCE,
  [APP_CONSTANTS]: APP_CONSTANTS_SOURCE,
  [ROUTING]: ROUTING_SOURCE,
})
const { ctx } = bench
const values = createAngularValues(ctx)

const initializerOf = (file: string, name: string): ts.Expression => {
  const declaration = bench.find(
    file,
    (node): node is ts.VariableDeclaration =>
      ctx.ts.isVariableDeclaration(node) && ctx.ast.asIdentifier(node.name)?.text === name,
  )
  if (declaration.initializer === undefined) throw new Error(`no initializer for ${name}`)
  return declaration.initializer
}

const membersAt = (element: AngularElement | undefined): MemberList => {
  if (element === undefined) throw new Error("no element")
  return values.membersOf(element.node, element.file, element.env)
}

const memberNamed = (list: MemberList, name: string) => {
  const found = list.members.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`no member ${name}`)
  return found
}

const childrenOf = (element: AngularElement | undefined): AngularFold => {
  const children = memberNamed(membersAt(element), "children")
  return values.arrayOf(children.value.node, children.value.file, children.env)
}

const textsOf = (fold: AngularFold): readonly string[] => fold.elements.map((item) => item.node.getText())

const pathsOf = (fold: AngularFold): readonly string[] =>
  fold.elements.map((item) => {
    const path = memberNamed(membersAt(item), "path").value.node
    return ctx.ast.asStringLiteralLike(path)?.text ?? path.getText()
  })

describe("adapters/angular/values", () => {
  it("binds devicesRoute(true) so the shared child is pushed", () => {
    const fold = values.arrayOf(initializerOf(DEVICE, "withShared"), DEVICE)

    expect(textsOf(fold)).toEqual(["devicesRoute(true)"])
    expect(pathsOf(childrenOf(fold.elements[0]))).toEqual(["", "all", "groups", "shared"])
  })

  it("applies the parameter default so devicesRoute() excludes the shared child", () => {
    const fold = values.arrayOf(initializerOf(DEVICE, "withoutShared"), DEVICE)
    const children = childrenOf(fold.elements[0])

    expect(pathsOf(children)).toEqual(["", "all", "groups"])
    expect(children.unreadable).toEqual([])
  })

  it("folds a template call bound to a literal argument", () => {
    const groups = values.objectOf(initializerOf(DEVICE, "deviceGroupsRoute"), DEVICE)
    if (groups === null) throw new Error("no object")
    const children = memberNamed(values.membersOf(groups.node, groups.file, groups.env), "children")
    const fold = values.arrayOf(children.value.node, children.value.file, children.env)

    expect(pathsOf(fold)).toEqual(["", ":entityGroupId"])
  })

  it("tags pushes under a non-literal if with its condition and negation", () => {
    const fold = values.arrayOf(initializerOf(MISC, "flaggedRoutes"), MISC)
    const children = childrenOf(fold.elements[0])

    expect(pathsOf(children)).toEqual(["a", "beta", "stable"])
    expect(children.elements.map((item) => item.conditions)).toEqual([
      [],
      ["environment.beta"],
      ["!environment.beta"],
    ])
  })

  it("lets a later spread member override an earlier one", () => {
    const list = values.membersOf(initializerOf(MISC, "merged"), MISC)

    expect(list.members.map((item) => [item.name, item.value.node.getText()])).toEqual([
      ["path", "'x'"],
      ["component", "CustomersComponent"],
    ])
  })

  it("merges a spread const before an explicit member", () => {
    const list = values.membersOf(initializerOf(MISC, "spreadConst"), MISC)

    expect(list.members.map((item) => [item.name, item.value.node.getText()])).toEqual([
      ["path", "'a'"],
      ["canActivate", "[AuthGuard]"],
    ])
  })

  it("reports an unresolvable spread as unreadable", () => {
    const list = values.membersOf(initializerOf(MISC, "unknownSpread"), MISC)

    expect(list.members.map((item) => item.name)).toEqual(["path"])
    expect(list.unreadable.map((item) => item.text)).toEqual(["load()"])
  })

  it("appends module-level pushes and flags a for-of push as dynamic", () => {
    const start = values.exportedValue(APP, "default")
    if (start === null) throw new Error("no default export")
    const fold = values.arrayOf(start.node, start.file)

    expect(textsOf(fold)).toEqual(["{ path: '' }", "{ path: 'home' }", "{ path: '**' }"])
    expect(fold.unreadable).toEqual([{ file: APP, line: 4, text: "routes.push(plugin.route)", dynamic: true }])
  })

  it("finds pushes through pushesInto directly", () => {
    const source = ctx.sourceFile(APP)
    if (source === null) throw new Error("no source")
    const fold = values.pushesInto("routes", [], source, APP)

    expect(textsOf(fold)).toEqual(["{ path: '**' }"])
    expect(fold.unreadable.map((item) => item.dynamic)).toEqual([true])
  })

  it("starts from export default satisfies, export default identifier and export const", () => {
    const starts = [
      values.exportedValue(SATISFIED, "default"),
      values.exportedValue(APP, "default"),
      values.exportedValue(NAMED, "NAMED_ROUTES"),
    ]

    expect(starts.map((start) => start?.node.getText())).toEqual([
      "[{ path: 'one' }]",
      "[{ path: '' }, { path: 'home' }]",
      "[{ path: 'named' }]",
    ])
    expect(starts.map((start) => start?.file)).toEqual([SATISFIED, APP, NAMED])
  })

  it("terminates on array, call and object cycles", () => {
    const arrays = values.arrayOf(initializerOf(CYCLE, "a"), CYCLE)
    const calls = values.arrayOf(initializerOf(CYCLE, "looped"), CYCLE)
    const objects = values.membersOf(initializerOf(CYCLE, "cyclicObject"), CYCLE)

    expect(textsOf(arrays)).toEqual(["{ path: 'a' }"])
    expect(arrays.unreadable.length).toBeGreaterThan(0)
    expect(calls.elements).toEqual([])
    expect(calls.unreadable.length).toBeGreaterThan(0)
    expect(objects.members.map((item) => item.name)).toEqual(["path"])
    expect(objects.unreadable.length).toBeGreaterThan(0)
  })

  it("follows an imported routes const through an export-star barrel", () => {
    const fold = values.arrayOf(initializerOf(ADMIN_ROUTES, "adminChildren"), ADMIN_ROUTES)

    expect(pathsOf(fold)).toEqual(["", "overview"])
    expect(fold.elements[1]?.file).toBe(OVERVIEW_ROUTES)
    expect(fold.unreadable).toEqual([])
  })

  it("folds a member access on a local const bound to a factory call inside an IIFE", () => {
    const fold = values.arrayOf(initializerOf(CUSTOMER, "customerChildren"), CUSTOMER)
    const list = membersAt(fold.elements[0])

    expect(memberNamed(list, "path").value.node.getText()).toBe("':customerId/edgeManagement'")
    expect(pathsOf(childrenOf(fold.elements[0]))).toEqual(["edges", "agents"])
    expect(childrenOf(fold.elements[0]).unreadable).toEqual([])
  })

  it("reports a member access naming no member as unreadable", () => {
    const fold = values.arrayOf(initializerOf(CUSTOMER, "missingMember"), CUSTOMER)

    expect(fold.elements).toEqual([])
    expect(fold.unreadable.map((item) => item.text)).toEqual(["edgesRoute().unknown"])
  })

  it("folds a spread of an imported config's providers member", () => {
    const providers = memberNamed(values.membersOf(initializerOf(MAIN, "config"), MAIN), "providers")
    const fold = values.arrayOf(providers.value.node, providers.value.file, providers.env)

    expect(textsOf(fold)).toEqual([
      "provideZoneChangeDetection()",
      "provideHttpClient()",
      "provideRouter(routes, withHashLocation())",
    ])
    expect(fold.elements.map((item) => item.file)).toEqual([MAIN, APP_CONFIG, APP_CONFIG])
  })

  it("reads string constants through member chains, spreads and a default-imported object", () => {
    const read = (name: string): string | null => values.stringOf(initializerOf(ROUTING, name), ROUTING)

    expect(["splash", "about", "local"].map(read)).toEqual(["", "about", "local"])
  })

  it("keeps a missing member, an element access and a branch-dependent member unread", () => {
    const read = (name: string): string | null => values.stringOf(initializerOf(ROUTING, name), ROUTING)

    expect(["missing", "indexed", "branched"].map(read)).toEqual([null, null, null])
  })
})
