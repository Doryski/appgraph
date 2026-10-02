import type { AppGraph, Screen, ShellReport, TreeNode } from "../../core/model.js"
import { sortedEntries, sortedUnique } from "../../core/order.js"
import { createRouteMatcher, normalizeUrl } from "../../core/url.js"
import { groupNavEdges, resolveRedirectTarget } from "../../emit/report-derive.js"
import { orderedScreens } from "../../emit/report-payload.js"
import { detailDocument } from "../../emit/view-detail.js"
import { viaRedirectField } from "../../emit/view-index.js"
import { EXIT_OK, EXIT_USAGE } from "../../pipeline/exit-codes.js"
import type { QueryContext, QueryRun } from "../commands.js"
import { SCREEN_SECTIONS } from "../commands.js"
import { CliError } from "../index.js"
import type { Row } from "./output.js"
import { unknownTargetError, writeItem } from "./output.js"
import { loadGraph } from "./runtime.js"
import { listedScreen } from "./screens.js"

type SectionId = (typeof SCREEN_SECTIONS)[number]

const HTML_REPORT_FILE = "appgraph.html"

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const at = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined)

const isEmptyValue = (value: unknown): boolean => {
  if (value === null || value === undefined || value === 0) return true
  if (Array.isArray(value)) return value.length === 0
  return isRecord(value) && Object.keys(value).length === 0
}

const screenByUrl = (screens: readonly Screen[], url: string | null): Screen | undefined =>
  url === null ? undefined : screens.find((screen) => screen.url === url)

const routedScreen = (screens: readonly Screen[], target: string): Screen | undefined => {
  const routes = screens.flatMap((screen) => (screen.url === null ? [] : [{ url: screen.url }]))
  return screenByUrl(screens, createRouteMatcher(routes)(normalizeUrl(target)))
}

const targetCandidates = (screens: readonly Screen[]): readonly string[] => [
  ...screens.map((screen) => screen.id),
  ...screens.flatMap((screen) => (screen.url === null ? [] : [screen.url])),
]

export const findScreen = (graph: AppGraph, target: string): Screen | undefined => {
  const screens = orderedScreens(graph.screens)
  return (
    screens.find((screen) => screen.id === target) ?? screenByUrl(screens, target) ?? routedScreen(screens, target)
  )
}

export const resolveScreen = (graph: AppGraph, target: string): Screen => {
  const screen = findScreen(graph, target)
  if (screen !== undefined) return screen
  throw unknownTargetError({ kind: "screen", target, candidates: targetCandidates(orderedScreens(graph.screens)) })
}

export const targetOf = (context: QueryContext): string => context.args["target"] ?? ""

const encodeScreenId = (id: string): string => encodeURIComponent(id).replace(/%2F/gi, "/").replace(/%3A/gi, ":")

export const htmlLinkOf = (id: string): string => `${HTML_REPORT_FILE}#tab=screens&screen=${encodeScreenId(id)}`

const cutTree = (nodes: readonly TreeNode[], depth: number): readonly TreeNode[] => {
  if (depth <= 0) return []
  return nodes.map((node) =>
    depth === 1 && node.children.length > 0
      ? { ...node, children: [], truncated: true }
      : { ...node, children: cutTree(node.children, depth - 1) },
  )
}

const cutShell = (shell: ShellReport, depth: number): ShellReport => ({ ...shell, tree: cutTree(shell.tree, depth) })

const withTreeDepth = (graph: AppGraph, screen: Screen, depth: number | null): AppGraph => {
  if (depth === null) return graph
  const shell = screen.shell === null ? undefined : graph.shells[screen.shell]
  return {
    ...graph,
    screens: graph.screens.map((candidate) =>
      candidate.id === screen.id ? { ...candidate, tree: cutTree(candidate.tree, depth) } : candidate,
    ),
    shells: shell === undefined || screen.shell === null ? graph.shells : { ...graph.shells, [screen.shell]: cutShell(shell, depth) },
  }
}

const navChips = (screen: Screen) =>
  groupNavEdges(screen.navigatesTo).map(({ edge, sources }) => ({
    to: edge.to,
    matchedRoute: edge.matchedRoute,
    trigger: edge.trigger,
    dynamic: edge.dynamic,
    sources,
    ...viaRedirectField(edge),
  }))

type SectionInput = {
  readonly screen: Screen
  readonly doc: Readonly<Record<string, unknown>>
}

const fact = (key: string) => (input: SectionInput) => at(input.doc["facts"], key)

const docField = (key: string) => (input: SectionInput) => input.doc[key]

const shellSection = (input: SectionInput) =>
  isRecord(input.doc["shell"]) ? { id: input.screen.shell, ...input.doc["shell"] } : null

const formsSection = (input: SectionInput) => {
  const forms = { schemas: fact("formSchemas")(input), fields: fact("formFields")(input) }
  return Object.fromEntries(Object.entries(forms).filter(([, value]) => !isEmptyValue(value)))
}

const extraSection = (input: SectionInput) =>
  Object.fromEntries(sortedEntries(input.screen.facts.extra).map(([channel, values]) => [channel, [...values]]))

const SECTION_VALUES = {
  activations: docField("activation"),
  entries: docField("entries"),
  ancestors: docField("ancestors"),
  tree: docField("tree"),
  navigation: (input) => navChips(input.screen),
  shell: shellSection,
  endpoints: fact("endpoints"),
  stores: fact("stores"),
  "query-keys": fact("queryKeys"),
  mutations: fact("mutations"),
  i18n: fact("i18nNamespaces"),
  "feature-gates": fact("featureGates"),
  forms: formsSection,
  "test-ids": (input) => sortedUnique(input.screen.facts.testIds),
  messages: fact("messages"),
  extra: extraSection,
  params: docField("params"),
  reachable: docField("reachable"),
} as const satisfies Readonly<Record<SectionId, (input: SectionInput) => unknown>>

const isSectionId = (value: string): value is SectionId => SCREEN_SECTIONS.some((section) => section === value)

const unknownSectionError = (unknown: readonly string[]): CliError =>
  new CliError(`unknown section${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`, EXIT_USAGE, {
    code: "usage/unknown-section",
    hint: `valid sections: ${SCREEN_SECTIONS.join(", ")}`,
  })

export const selectedSections = (requested: unknown): readonly SectionId[] => {
  if (!Array.isArray(requested)) return SCREEN_SECTIONS
  const names = requested.filter((name): name is string => typeof name === "string")
  const unknown = names.filter((name) => !isSectionId(name))
  if (unknown.length > 0) throw unknownSectionError(unknown)
  return SCREEN_SECTIONS.filter((section) => names.includes(section))
}

const sectionEntries = (input: SectionInput, sections: readonly SectionId[]) =>
  sections.flatMap((section) => {
    const value = SECTION_VALUES[section](input)
    return isEmptyValue(value) ? [] : [[section, value] as const]
  })

const redirectTargetOf = (graph: AppGraph, screen: Screen): string | null =>
  screen.redirectTo === null ? null : (resolveRedirectTarget(orderedScreens(graph.screens), screen.redirectTo)?.id ?? null)

const headerOf = (graph: AppGraph, screen: Screen) => ({
  ...listedScreen(screen),
  redirectTarget: redirectTargetOf(graph, screen),
  htmlLink: htmlLinkOf(screen.id),
})

const treeDepthOf = (context: QueryContext): number | null => {
  const depth = context.own["treeDepth"]
  return typeof depth === "number" ? depth : null
}

export const screenItem = (graph: AppGraph, screen: Screen, context: QueryContext): Row => {
  const sections = selectedSections(context.own["sections"])
  const doc = detailDocument(withTreeDepth(graph, screen, treeDepthOf(context)), screen.id)
  return { ...headerOf(graph, screen), ...Object.fromEntries(sectionEntries({ screen, doc }, sections)) }
}

const run: QueryRun = async (context) => {
  selectedSections(context.own["sections"])
  const loaded = await loadGraph(context)
  const screen = resolveScreen(loaded.graph, targetOf(context))
  writeItem(context, { loaded, item: screenItem(loaded.graph, screen, context) })
  return EXIT_OK
}

export default run
