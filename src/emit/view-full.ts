import type { AppGraph, Diagnostic, FileFacts, RenderEdge, Screen, ShellReport } from "../core/model.js"
import { routeNameField } from "../core/model.js"
import { sortBy, sortedEntries, sortedUnique } from "../core/order.js"
import type { EncodedTreeNode, TreeRef } from "./tree-intern.js"
import { internForests, TREE_INTERN_THRESHOLDS } from "./tree-intern.js"
import type { EmittedValue, ViewOptions } from "./view-index.js"
import {
  activationView,
  ancestorView,
  compact,
  conditionScalar,
  deadNavLinksView,
  endpointsByTransport,
  entryView,
  goesTo,
  isAddressable,
  metaView,
  navigationView,
  placementAmbiguousField,
  queryKeyScalar,
  redirectsView,
  selectorPolicy,
  sortedScreens,
  viaRedirectField,
} from "./view-index.js"
import { toYaml } from "./yaml.js"

const exprOf = (item: { readonly expr?: string }) => (item.expr === undefined ? {} : { expr: item.expr })

const FULL_PURPOSE =
  "Complete static map: every screen with its render tree and facts, every shell, the per-file facts dictionary, navigation, dead links and all diagnostics."

const viaView = (via: RenderEdge["via"]): Record<string, EmittedValue> => (via === undefined ? {} : { via })

const SUBTREE_PREFIX = "t"

const subtreeKey = (id: number): string => `${SUBTREE_PREFIX}${id}`

const optionalField = <V>(key: string, value: V | undefined, view: (present: V) => EmittedValue) =>
  value === undefined ? {} : { [key]: view(value) }

const identity = <V extends EmittedValue>(value: V): V => value

const scalars = (values: readonly string[]): EmittedValue => values.map(conditionScalar)

const treeNodeView = (node: EncodedTreeNode): Record<string, EmittedValue> => ({
  component: node.component,
  file: node.file,
  kind: node.kind,
  ...optionalField("conditions", node.conditions, scalars),
  ...optionalField("alwaysRendered", node.alwaysRendered, identity),
  ...optionalField("repeated", node.repeated, identity),
  ...optionalField("via", node.via, identity),
  ...optionalField("nullGuards", node.nullGuards, scalars),
  ...optionalField("truncated", node.truncated, identity),
  ...optionalField("repeat", node.repeat, identity),
  ...optionalField("children", node.children, forestView),
})

const treeRefView = (ref: TreeRef): Record<string, EmittedValue> =>
  typeof ref === "number" ? { ref: subtreeKey(ref) } : treeNodeView(ref)

const forestView = (forest: readonly TreeRef[]): EmittedValue => forest.map(treeRefView)

const subtreesView = (subtrees: readonly EncodedTreeNode[]): Record<string, EmittedValue> =>
  Object.fromEntries(subtrees.map((node, id) => [subtreeKey(id), treeNodeView(node)]))

const factsView = (screen: Screen): Record<string, EmittedValue> => {
  const facts = screen.facts
  return {
    endpoints: endpointsByTransport(facts.endpoints),
    navigations: sortBy(facts.navigations, (item) => `${item.to} ${item.trigger}`).map((item) => ({
      to: item.to,
      trigger: item.trigger,
      dynamic: item.dynamic,
      ...exprOf(item),
      ...routeNameField(item),
    })),
    stores: sortedUnique(facts.stores),
    queryKeys: sortedUnique(facts.queryKeys).map(queryKeyScalar),
    mutations: facts.mutations,
    i18nNamespaces: sortedUnique(facts.i18nNamespaces),
    testIds: sortedUnique(facts.testIds),
    formSchemas: sortedUnique(facts.formSchemas),
    formFields: sortedUnique(facts.formFields),
    featureGates: sortedUnique(facts.featureGates),
    hooks: sortedUnique(facts.hooks),
    messages: sortedUnique(facts.messages),
    extra: Object.fromEntries(sortedEntries(facts.extra).map(([key, values]) => [key, [...values]])),
  }
}

const screenView = (screen: Screen, tree: readonly TreeRef[]): Record<string, EmittedValue> => ({
  id: screen.id,
  localId: screen.localId,
  source: screen.source,
  url: screen.url,
  addressable: screen.addressable,
  title: screen.title,
  kindTag: screen.kindTag,
  ...routeNameField(screen),
  activations: screen.activations.map(activationView),
  params: [...screen.params],
  auth: screen.auth,
  featureFlag: screen.featureFlag,
  redirectTo: screen.redirectTo,
  devOnly: screen.devOnly,
  shell: screen.shell,
  entries: screen.entries.map(entryView),
  ancestors: screen.ancestors.map(ancestorView),
  ...placementAmbiguousField(screen),
  tree: forestView(tree),
  reachable: sortedUnique(screen.reachable),
  facts: factsView(screen),
  goesTo: goesTo(screen),
  navigatesTo: navigationView(screen),
  provenance: {
    sources: [...screen.provenance.sources],
    evidence: sortBy(screen.provenance.evidence, (item) => `${item.file} ${item.line} ${item.what}`).map(
      (item) => ({ what: item.what, file: item.file, line: item.line }),
    ),
    mergedFrom: screen.provenance.mergedFrom.map((item) => ({ source: item.source, localId: item.localId })),
    decisions: [...screen.provenance.decisions],
  },
})

const shellView = (shell: ShellReport, tree: readonly TreeRef[]): Record<string, EmittedValue> => ({
  file: shell.file,
  layouts: [...shell.layouts],
  tree: forestView(tree),
  navigatesTo: sortBy(shell.navigatesTo, (edge) => `${edge.to} ${edge.from} ${edge.trigger}`).map((edge) => ({
    to: edge.to,
    matchedRoute: edge.matchedRoute,
    trigger: edge.trigger,
    dynamic: edge.dynamic,
    from: edge.from,
    ...exprOf(edge),
    ...viaRedirectField(edge),
    ...routeNameField(edge),
  })),
  endpoints: endpointsByTransport(shell.endpoints),
  stores: sortedUnique(shell.stores),
  i18nNamespaces: sortedUnique(shell.i18nNamespaces),
  testIds: sortedUnique(shell.testIds),
})

const componentView = (component: FileFacts): Record<string, EmittedValue> => ({
  file: component.file,
  component: component.component,
  kind: component.kind,
  renders: sortBy(component.renders, (edge) => edge.file).map((edge) => ({
    file: edge.file,
    conditions: edge.conditions.map(conditionScalar),
    alwaysRendered: edge.alwaysRendered,
    repeated: edge.repeated,
    ...viaView(edge.via),
  })),
  nullGuards: component.nullGuards.map(conditionScalar),
  uses: sortedUnique(component.uses),
  hooks: sortedUnique(component.hooks),
  stores: sortedUnique(component.stores),
  queryKeys: sortedUnique(component.queryKeys).map(queryKeyScalar),
  mutations: component.mutations,
  endpoints: endpointsByTransport(component.endpoints),
  navigations: sortBy(component.navigations, (item) => `${item.to} ${item.trigger}`).map((item) => ({
    to: item.to,
    trigger: item.trigger,
    dynamic: item.dynamic,
    ...exprOf(item),
    ...routeNameField(item),
  })),
  i18nNamespaces: sortedUnique(component.i18nNamespaces),
  testIds: sortedUnique(component.testIds),
  formSchemas: sortedUnique(component.formSchemas),
  formFields: sortedUnique(component.formFields),
  featureGates: sortedUnique(component.featureGates),
  messages: sortedUnique(component.messages),
  extra: Object.fromEntries(sortedEntries(component.extra).map(([key, values]) => [key, [...values]])),
})

const diagnosticView = (diagnostic: Diagnostic): Record<string, EmittedValue> =>
  compact({
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message,
    plugin: diagnostic.plugin,
    file: diagnostic.file ?? null,
    line: diagnostic.line ?? null,
    screenId: diagnostic.screenId ?? null,
  })

const forestAt = (forests: readonly (readonly TreeRef[])[], index: number): readonly TreeRef[] => forests[index] ?? []

export const fullDocument = (graph: AppGraph, options: ViewOptions = {}): Record<string, EmittedValue> => {
  const policy = selectorPolicy(graph, options)
  const screens = sortedScreens(graph.screens)
  const addressable = screens.filter(isAddressable)
  const stateScreens = screens.filter((screen) => !isAddressable(screen))
  const shells = sortedEntries(graph.shells)
  const ordered = [...addressable, ...stateScreens]
  const interned = internForests(
    [...ordered.map((screen) => screen.tree), ...shells.map(([, shell]) => shell.tree)],
    TREE_INTERN_THRESHOLDS.yaml,
  )
  const screenTree = (index: number) => forestAt(interned.forests, index)
  const shellTree = (index: number) => forestAt(interned.forests, ordered.length + index)
  return {
    meta: {
      ...metaView(graph, options, policy, FULL_PURPOSE),
      sourceRoots: sortedUnique(graph.meta.sourceRoots),
      fingerprint: graph.meta.fingerprint,
      limitations: [...graph.meta.limitations],
    },
    selectors: policy.block,
    // §10.2: `screens: []` stays present on a zero-screen artifact; state-activated screens are kept
    // in their own block so nothing under `screens:` is unreachable by URL.
    screens: addressable.map((screen, index) => screenView(screen, screenTree(index))),
    stateScreens: stateScreens.map((screen, index) => screenView(screen, screenTree(addressable.length + index))),
    redirects: redirectsView(graph),
    shells: Object.fromEntries(shells.map(([key, shell], index) => [key, shellView(shell, shellTree(index))])),
    subtrees: subtreesView(interned.subtrees),
    components: Object.fromEntries(
      sortedEntries(graph.components).map(([key, component]) => [key, componentView(component)]),
    ),
    navGroups: sortBy(graph.navGroups, (group) => `${group.name} ${group.source}`).map((group) => ({
      name: group.name,
      source: group.source,
      score: group.score,
      availableOnShells: sortedUnique(group.availableOnShells),
      entries: sortBy(group.entries, (entry) => `${entry.path} ${entry.file} ${entry.line}`).map((entry) => ({
        path: entry.path,
        parentPath: entry.parentPath,
        label: entry.label,
        labelKey: entry.labelKey,
        featureFlag: entry.featureFlag,
        source: entry.source,
        file: entry.file,
        line: entry.line,
        resolvedScreen: entry.resolvedScreen,
        ...viaRedirectField(entry),
      })),
    })),
    navigation: sortBy(graph.navigation, (edge) => `${edge.from} ${edge.to} ${edge.via} ${edge.trigger}`).map(
      (edge) => ({
        from: edge.from,
        to: edge.to,
        trigger: edge.trigger,
        dynamic: edge.dynamic,
        via: edge.via,
        ...exprOf(edge),
      }),
    ),
    deadNavLinks: deadNavLinksView(graph),
    orphanScreens: sortedUnique(graph.orphanScreens),
    diagnostics: sortBy(
      graph.diagnostics,
      (diagnostic) =>
        `${diagnostic.code} ${diagnostic.file ?? ""} ${diagnostic.line ?? 0} ${diagnostic.screenId ?? ""}`,
    ).map(diagnosticView),
  }
}

export const emitFullView = (graph: AppGraph, options: ViewOptions = {}): string =>
  toYaml(fullDocument(graph, options))
