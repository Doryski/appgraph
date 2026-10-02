import type { FileFacts, RenderEdge, ResolvedNavigation, ScreenFacts, TreeNode } from "../model.js"
import { routeNameField } from "../model.js"
import { by, sortBy, sortStrings, sortedUnique, sortedUniqueBy, uniqueBy } from "../order.js"
import { USES_DEPTH_BONUS } from "./constants.js"
import type { GraphContext } from "./context.js"
import { EMPTY_SCREEN_FACTS, mergeExtraChannels } from "./facts.js"
import { endpointKey, endpointOrder, navigationKey } from "./keys.js"
import type { ChainLink, Placed, ResolvedBranch, ResolvedRoot } from "./model.js"
import { wrapperOf } from "./model.js"
import { namedFirst } from "./route-names.js"
import type { createTargetResolver } from "./targets.js"
import { appendChildren, graft, placeInto } from "./tree.js"
import { withVia } from "./via.js"

export type Analysis = {
  readonly tree: readonly TreeNode[]
  readonly reachable: readonly string[]
  readonly navigations: readonly ResolvedNavigation[]
  readonly facts: ScreenFacts
}

export const EMPTY_ANALYSIS: Analysis = {
  tree: [],
  reachable: [],
  navigations: [],
  facts: EMPTY_SCREEN_FACTS,
}

export const createWalk = (
  { maxDepth, factsOf, traversableUses }: GraphContext,
  { navigationTarget }: Pick<ReturnType<typeof createTargetResolver>, "navigationTarget">,
  routeEntries: ReadonlySet<string> = new Set(),
) => {
  /** A screen's page referenced as a value (`component: Page` in a route table) is a registration, not a render. */
  const isRouteRegistration = (edge: RenderEdge): boolean => edge.via === "reference" && routeEntries.has(edge.file)

  const rendersCache = new WeakMap<FileFacts, readonly RenderEdge[]>()
  const rendersOf = (facts: FileFacts): readonly RenderEdge[] => {
    const cached = rendersCache.get(facts)
    if (cached !== undefined) return cached
    const renders = facts.renders.filter((edge) => !isRouteRegistration(edge))
    rendersCache.set(facts, renders)
    return renders
  }

  const deepNextCache = new WeakMap<FileFacts, readonly string[]>()
  const deepNext = (facts: FileFacts): readonly string[] => {
    const cached = deepNextCache.get(facts)
    if (cached !== undefined) return cached
    const next = [...traversableUses(facts), ...rendersOf(facts).map((edge) => edge.file)]
    deepNextCache.set(facts, next)
    return next
  }

  const analyze = (
    roots: readonly ResolvedRoot[],
    ancestors: readonly ChainLink[],
    transparent: readonly string[],
  ): Analysis => {
    const expanded = new Set<string>()
    const reachable = new Set<string>()
    const overrides = new Map<string, FileFacts>()

    const branchRoots = ancestors.flatMap((link) => (link.branches ?? []).map((branch) => branch.root))
    for (const root of [...roots, ...branchRoots])
      if (root.facts !== null) overrides.set(root.file, root.facts)

    const factsFor = (file: string): FileFacts => overrides.get(file) ?? factsOf(file)

    const bestDepth = new Map<string, number>()

    const collectDeep = (file: string, depth: number): void => {
      if (depth > maxDepth + USES_DEPTH_BONUS) return
      const best = bestDepth.get(file)
      if (best !== undefined && best <= depth) return
      bestDepth.set(file, depth)
      reachable.add(file)

      for (const next of deepNext(factsFor(file))) collectDeep(next, depth + 1)
    }

    const buildNode = (edge: RenderEdge, depth: number, root?: ResolvedRoot): TreeNode => {
      const file = edge.file
      const facts = root?.facts ?? factsFor(file)
      const expandKey = root?.expandKey ?? file
      reachable.add(file)
      for (const used of traversableUses(facts)) collectDeep(used, depth + 1)

      const base = withVia(
        {
          file,
          component: root?.label ?? facts.component,
          kind: facts.kind,
          conditions: edge.conditions,
          alwaysRendered: edge.alwaysRendered,
          repeated: edge.repeated,
          nullGuards: facts.nullGuards,
        },
        edge.via,
      )

      if (expanded.has(expandKey)) return { ...base, children: [], truncated: false, repeat: true }
      expanded.add(expandKey)

      const renders = rendersOf(facts)
      if (depth >= maxDepth) {
        for (const child of renders) collectDeep(child.file, depth + 1)
        return {
          ...base,
          children: [],
          truncated: renders.length > 0,
          repeat: false,
        }
      }

      return {
        ...base,
        children: renders.map((child) => buildNode(child, depth + 1)),
        truncated: false,
        repeat: false,
      }
    }

    const rootEdge = (file: string): RenderEdge => ({
      file,
      conditions: [],
      alwaysRendered: true,
      repeated: false,
    })

    const buildBranch = ({ branch, root }: ResolvedBranch): TreeNode =>
      buildNode(
        {
          file: root.file,
          conditions: branch.conditions,
          alwaysRendered: false,
          repeated: false,
        },
        0,
        root,
      )

    // §6.3.1 depth accounting: ancestors do NOT consume the screen's budget. Each ancestor tree and
    // the spliced subtree start at depth 0, so a three-level layout chain cannot exhaust maxDepth
    // before the page — the thing the user asked about — is reached.
    //
    // Built outermost-inward so `repeat` marks the SECOND occurrence in reading order: a component
    // rendered by both the layout and the page expands under the layout and repeats under the page.
    /** An ancestor's route list renders every page it mounts; this screen's own branch is spliced in at the host. */
    const withoutMounted = (link: ChainLink): ResolvedRoot => {
      const mounted = link.mountedFiles
      if (mounted === undefined || mounted.size === 0) return link.root
      const facts = link.root.facts ?? factsFor(link.root.file)
      return { ...link.root, facts: { ...facts, renders: facts.renders.filter((edge) => !mounted.has(edge.file)) } }
    }

    const spliceInto = (index: number): readonly TreeNode[] => {
      const link = ancestors[index]
      if (link === undefined) return roots.map((root) => buildNode(rootEdge(root.file), 0, root))

      const node = buildNode(rootEdge(link.root.file), 0, withoutMounted(link))
      const placed: readonly Placed[] = [
        ...spliceInto(index + 1).map((child) => ({
          node: child,
          ...wrapperOf(link),
        })),
        ...(link.branches ?? []).map((branch) => ({
          node: buildBranch(branch),
          ...wrapperOf(branch),
        })),
      ]
      return [
        graft(node, link.host, (hostNode) => placeInto(hostNode, placed)) ??
          appendChildren(
            node,
            placed.map((item) => item.node),
          ),
      ]
    }

    const tree = spliceInto(0)
    for (const file of transparent) collectDeep(file, 0)
    const reachableFiles = sortStrings(reachable)
    const allFacts = reachableFiles.map(factsFor)

    const navigations = sortedUniqueBy(
      namedFirst(
        allFacts.flatMap((facts) =>
          facts.navigations.map((navigation): ResolvedNavigation => ({
            ...navigationTarget(navigation),
            trigger: navigation.trigger,
            dynamic: navigation.dynamic,
            from: facts.file,
            ...(navigation.expr === undefined ? {} : { expr: navigation.expr }),
            ...routeNameField(navigation),
          })),
        ),
      ),
      (edge) => `${edge.to}|${edge.trigger}|${edge.from}`,
    ).sort(by((edge) => `${edge.to}|${edge.from}|${edge.trigger}`))

    return {
      tree,
      reachable: reachableFiles,
      navigations,
      facts: {
        endpoints: sortBy(
          uniqueBy(
            allFacts.flatMap((facts) => facts.endpoints),
            endpointKey,
          ),
          endpointOrder,
        ),
        navigations: sortedUniqueBy(
          allFacts.flatMap((facts) => facts.navigations),
          navigationKey,
        ),
        stores: sortedUnique(allFacts.flatMap((facts) => facts.stores)),
        queryKeys: sortedUnique(allFacts.flatMap((facts) => facts.queryKeys)),
        mutations: allFacts.reduce((total, facts) => total + facts.mutations, 0),
        i18nNamespaces: sortedUnique(allFacts.flatMap((facts) => facts.i18nNamespaces)),
        testIds: sortedUnique(allFacts.flatMap((facts) => facts.testIds)),
        formSchemas: sortedUnique(allFacts.flatMap((facts) => facts.formSchemas)),
        formFields: sortedUnique(allFacts.flatMap((facts) => facts.formFields)),
        featureGates: sortedUnique(allFacts.flatMap((facts) => facts.featureGates)),
        hooks: sortedUnique(allFacts.flatMap((facts) => facts.hooks)),
        messages: sortedUnique(allFacts.flatMap((facts) => facts.messages)),
        extra: mergeExtraChannels(allFacts),
      },
    }
  }

  return analyze
}
