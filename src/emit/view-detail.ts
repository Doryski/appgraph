import type { AppGraph, Diagnostic, Screen, ShellReport, TreeNode } from "../core/model.js"
import { sortBy, sortedUnique } from "../core/order.js"
import type { EmittedValue, ViewOptions } from "./view-index.js"
import {
  activationView,
  ancestorView,
  authNote,
  compact,
  conditionScalar,
  endpointsByTransport,
  entryView,
  flagNote,
  goesTo,
  metaView,
  navigationView,
  placementAmbiguousField,
  queryKeyScalar,
  selectorPolicy,
} from "./view-index.js"
import { toYaml } from "./yaml.js"

export class UnknownScreenError extends Error {
  constructor(screenId: string) {
    super(`emit/unknown-screen: no screen with id ${screenId}`)
    this.name = "UnknownScreenError"
  }
}

const DETAIL_PURPOSE =
  "Single-screen detail: how the screen is reached, what can render inside it, what it calls and how to select within it."

const treeNodeView = (node: TreeNode): Record<string, EmittedValue> =>
  compact({
    component: node.component,
    file: node.file,
    kind: node.kind,
    conditions: node.conditions.map(conditionScalar),
    alwaysRendered: node.alwaysRendered,
    repeated: node.repeated,
    via: node.via ?? null,
    nullGuards: node.nullGuards.map(conditionScalar),
    truncated: node.truncated ? true : null,
    repeat: node.repeat ? true : null,
    children: node.children.map(treeNodeView),
  })

const conditionalRendering = (nodes: readonly TreeNode[]): readonly Record<string, EmittedValue>[] =>
  nodes.flatMap((node) => [
    ...(node.conditions.length > 0
      ? [
          compact({
            component: node.component,
            file: node.file,
            onlyWhen: node.conditions.map(conditionScalar),
            alsoRenderedUnconditionally: node.alwaysRendered ? true : null,
            repeated: node.repeated ? true : null,
            nullGuards: node.nullGuards.map(conditionScalar),
          }),
        ]
      : []),
    ...conditionalRendering(node.children),
  ])

const authView = (screen: Screen, options: ViewOptions): Record<string, EmittedValue> =>
  compact({
    state: screen.auth,
    gatedBy: sortedUnique(
      screen.ancestors.filter((ancestor) => ancestor.role === "guard").map((ancestor) => ancestor.file),
    ),
    note: screen.auth === "protected" ? authNote(options) : null,
  })

const flagView = (screen: Screen, options: ViewOptions): Record<string, EmittedValue> | null =>
  screen.featureFlag === null ? null : { name: screen.featureFlag, note: flagNote(options) }

const shellView = (shell: ShellReport): Record<string, EmittedValue> =>
  compact({
    file: shell.file,
    layouts: [...shell.layouts],
    tree: shell.tree.map(treeNodeView),
    navigatesTo: sortBy(shell.navigatesTo, (edge) => `${edge.to} ${edge.from} ${edge.trigger}`).map((edge) =>
      compact({
        to: edge.to,
        matchedRoute: edge.matchedRoute,
        trigger: edge.trigger,
        dynamic: edge.dynamic,
        from: edge.from,
        expr: edge.expr,
        routeName: edge.routeName,
      }),
    ),
    endpoints: endpointsByTransport(shell.endpoints),
    stores: sortedUnique(shell.stores),
    i18nNamespaces: sortedUnique(shell.i18nNamespaces),
    testIds: sortedUnique(shell.testIds),
  })

const diagnosticView = (diagnostic: Diagnostic): Record<string, EmittedValue> =>
  compact({
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message,
    plugin: diagnostic.plugin,
    file: diagnostic.file ?? null,
    line: diagnostic.line ?? null,
  })

const factsView = (screen: Screen): Record<string, EmittedValue> => {
  const facts = screen.facts
  return compact({
    endpoints: endpointsByTransport(facts.endpoints),
    stores: sortedUnique(facts.stores),
    queryKeys: sortedUnique(facts.queryKeys).map(queryKeyScalar),
    mutations: facts.mutations,
    i18nNamespaces: sortedUnique(facts.i18nNamespaces),
    formSchemas: sortedUnique(facts.formSchemas),
    formFields: sortedUnique(facts.formFields),
    featureGates: sortedUnique(facts.featureGates),
    hooks: sortedUnique(facts.hooks),
    messages: sortedUnique(facts.messages),
    ...Object.fromEntries(sortBy(Object.entries(facts.extra), ([key]) => key).map(([key, values]) => [key, [...values]])),
  })
}

export const detailDocument = (
  graph: AppGraph,
  screenId: string,
  options: ViewOptions = {},
): Record<string, EmittedValue> => {
  const screen = graph.screens.find((candidate) => candidate.id === screenId)
  if (screen === undefined) throw new UnknownScreenError(screenId)

  const policy = selectorPolicy(graph, options)
  const shell = screen.shell === null ? undefined : graph.shells[screen.shell]

  return compact({
    meta: {
      ...metaView(graph, options, policy, DETAIL_PURPOSE),
      limitations: [...graph.meta.limitations],
    },
    id: screen.id,
    localId: screen.localId,
    source: screen.source,
    url: screen.url,
    addressable: screen.addressable,
    title: screen.title,
    kindTag: screen.kindTag,
    routeName: screen.routeName,
    activation: screen.activations.map(activationView),
    auth: authView(screen, options),
    flag: flagView(screen, options),
    devOnly: screen.devOnly ? true : null,
    params: [...screen.params],
    redirectTo: screen.redirectTo,
    entries: screen.entries.map(entryView),
    ancestors: screen.ancestors.map(ancestorView),
    ...placementAmbiguousField(screen),
    shell: shell === undefined ? null : shellView(shell),
    selectors: {
      ...policy.block,
      ...(policy.present ? { testIds: sortedUnique(screen.facts.testIds) } : {}),
    },
    facts: factsView(screen),
    conditionalRendering: conditionalRendering(screen.tree),
    tree: screen.tree.map(treeNodeView),
    reachable: sortedUnique(screen.reachable),
    goesTo: goesTo(screen),
    navigatesTo: navigationView(screen),
    provenance: compact({
      sources: [...screen.provenance.sources],
      evidence: sortBy(screen.provenance.evidence, (item) => `${item.file} ${item.line} ${item.what}`).map(
        (item) => ({ what: item.what, file: item.file, line: item.line }),
      ),
      mergedFrom: screen.provenance.mergedFrom.map((item) => ({ source: item.source, localId: item.localId })),
      decisions: [...screen.provenance.decisions],
    }),
    diagnostics: sortBy(
      graph.diagnostics.filter((diagnostic) => diagnostic.screenId === screen.id),
      (diagnostic) => `${diagnostic.code} ${diagnostic.file ?? ""} ${diagnostic.line ?? 0}`,
    ).map(diagnosticView),
  })
}

export const emitDetailView = (graph: AppGraph, screenId: string, options: ViewOptions = {}): string =>
  toYaml(detailDocument(graph, screenId, options))
