import type { AncestorRef, Evidence } from "../../core/model.js"
import { uniqueBy } from "../../core/order.js"
import { joinUrl, paramsOf } from "../../core/url.js"
import { redirectUrl } from "../route-dialects.js"
import type { ScreenDraft, TsNode } from "../types.js"
import { OUTLET_SPLICE, PER_ITEM_GUARD, RUNTIME_GATE } from "./constants.js"
import type { DescendantsApi } from "./descendants.js"
import type { ElementsApi } from "./elements.js"
import type { ElementInfo, GuardAuth, ItemScope, MergeScope, RouteContext, RouteItem, RouteList, RouteRoot, RouteSpec } from "./model.js"
import { ancestorKey, entryKey } from "./model.js"
import type { ResolveApi } from "./resolve.js"
import type { RouteListsApi } from "./route-lists.js"
import type { SpecsApi } from "./specs.js"
import type { DiscoveryState } from "./state.js"

export const createParse = (deps: DiscoveryState & ResolveApi & ElementsApi & SpecsApi & RouteListsApi & DescendantsApi) => {
  const { ctx, drafts, ancestors, openLists, openRoots, parsedRoots, nextOrdinal, flags, report, echoed, exactString, propEntryEvidence, infoOf, ownPathOf, pathQueryOf, rawPathOf, unreadablePath, excerpt, itemsOf, hasIndexChild, splatBase, descendantsOf } = deps

  /**
   * The chain a route hands DOWN to its children: everything its own element renders, with the
   * innermost link spliced at `<Outlet/>` because that is where react-router puts the child route.
   */
  const childChain = (parent: RouteContext, info: ElementInfo): readonly AncestorRef[] => {
    const own = uniqueBy([...info.wrappers, ...info.entryAncestors], ancestorKey)
    if (own.length === 0) return parent.ancestors

    const spliced = own.map((ancestor, index) =>
      index === own.length - 1 ? { ...ancestor, splice: OUTLET_SPLICE } : ancestor,
    )
    return uniqueBy([...parent.ancestors, ...spliced], ancestorKey)
  }

  const urlsOf = (draft: ScreenDraft): readonly string[] =>
    draft.activations.flatMap((activation) => (activation.kind === "url" ? [activation.template] : []))

  /** Two sibling lists rendering one url: ONE screen whose entries and evidence are the union. */
  const mergeDrafts = (kept: ScreenDraft, other: ScreenDraft): ScreenDraft => {
    const entries = uniqueBy([...kept.entries, ...other.entries], entryKey)
    const redirectTo = kept.redirectTo ?? other.redirectTo ?? null
    const { kindTag, ...rest } = kept
    const entryless = entries.length === 0 && redirectTo === null
    return {
      ...rest,
      entries,
      evidence: [...kept.evidence, ...other.evidence],
      ...(entryless && kindTag !== undefined ? { kindTag } : {}),
      ...(redirectTo === null ? {} : { redirectTo }),
      ...(kept.auth === "protected" || other.auth === "protected" ? { auth: "protected" as const } : {}),
    }
  }

  /**
   * Returns false when the draft is not a screen of its own: folded into a sibling list's screen at the
   * same url, or shadowed by an earlier declaration of that url in its OWN list — react-router ranks
   * equal paths by declaration order, so the later one never renders.
   */
  const commitDraft = (draft: ScreenDraft, parent: RouteContext, node: TsNode): boolean => {
    const url = urlsOf(draft)[0]
    const root = parent.root
    const sibling = url === undefined ? undefined : parent.merge?.get(url)
    const kept = sibling === undefined ? undefined : drafts[sibling.index]
    if (sibling !== undefined && kept !== undefined && sibling.root !== root) {
      drafts[sibling.index] = mergeDrafts(kept, draft)
      return false
    }
    if (sibling !== undefined && kept !== undefined) {
      report({
        severity: "warning",
        code: "screens/conflict-dropped",
        message: `route '${url ?? ""}' is declared again in the same route list; react-router renders the first declaration (${kept.localId}), so this one is never reached`,
        file: parent.file,
        line: ctx.lineOf(parent.file, node),
      })
      return false
    }
    if (url !== undefined && parent.merge !== null && root !== null)
      parent.merge.set(url, { index: drafts.length, root })
    drafts.push(draft)
    return true
  }

  /** A per-item guard can only ADD protection: under a protected parent the screen stays protected. */
  const routeAuth = (own: GuardAuth | null, inherited: RouteContext["auth"]): RouteContext["auth"] => {
    if (own === null) return inherited
    if (own === "protected" || inherited === "protected") return "protected"
    return null
  }

  /** A route registered only while a runtime condition holds is never asserted public. */
  const gatedAuth = (scope: ItemScope | null, auth: RouteContext["auth"]): RouteContext["auth"] =>
    scope !== null && scope.gate !== null && auth === "public" ? null : auth

  /** Under a flavour with base-relative targets (wouter), a target joins the enclosing base unless marked absolute. */
  const flavourTargetOf = (spec: RouteSpec, target: string, base: string | null): string => {
    const marker = spec.flavour.absoluteTargetMarker
    if (marker === null) return target
    if (target.startsWith(marker)) return target.slice(marker.length)
    return `${base ?? ""}/${target}`
  }

  const redirectOf = (spec: RouteSpec, target: string, site: { own: string | null; parent: string | null }): string | null =>
    redirectUrl(flavourTargetOf(spec, target, site.parent), { ...site, isIndex: spec.isIndex })

  /** A dialect `redirect` field, resolved the way the translated `<Navigate>` resolves it. */
  const dialectRedirectOf = (spec: RouteSpec, own: string | null, parent: string | null): string | null => {
    const target = spec.redirect === null ? null : exactString(spec.redirect.value, spec.redirect.file)
    return target === null ? null : redirectOf(spec, target, { own, parent })
  }

  /** A redirect element inside the route's element: base-relative under its flavour, its own url the base of a `nest` route. */
  const elementRedirectOf = (spec: RouteSpec, target: string | null, own: string | null, parent: string | null): string | null => {
    if (target === null || spec.flavour.absoluteTargetMarker === null) return target
    return redirectOf(spec, target, { own, parent: spec.prefixMatch ? (own ?? parent) : parent })
  }

  const reportedBases = new Set<RouteRoot>()

  /** wouter resolves `navigate`/`<Link>` targets against the base; navigation facts carry them as written. */
  const reportBase = (root: RouteRoot): void => {
    if (root.base === null || flags.dryRun || flags.echo || reportedBases.has(root)) return
    reportedBases.add(root)
    report({
      severity: "info",
      code: "screens/unsupported-router-style",
      message: `navigation targets under <Router base="/${root.base}"> are base-relative at runtime and are not prefixed; links and navigate() calls in these routes may show as unresolved`,
      file: root.file,
      line: ctx.lineOf(root.file, root.node),
    })
  }

  const reportUnreadRedirect = (spec: RouteSpec, file: string): void => {
    if (spec.redirect === null) return
    report({
      severity: "warning",
      code: "screens/unsupported-router-style",
      message: `redirect target {${excerpt(spec.redirect.node)}} is not a target this source can read; the route is kept with no entry and no redirect`,
      file,
      line: ctx.lineOf(file, spec.redirect.node),
    })
  }

  /** Reported at the path's value: in the mapped item's file when the item supplies it. */
  const reportPathQuery = (spec: RouteSpec): void => {
    const query = pathQueryOf(spec)
    const written = spec.path?.value
    if (query === null || spec.path === null || written === undefined) return
    report({
      severity: "info",
      code: "screens/unsupported-router-style",
      message: `route path '${query.raw}' carries a query string; react-router matches the pathname only, so the route is read at '${query.path}'`,
      file: spec.path.file,
      line: ctx.lineOf(spec.path.file, written),
    })
  }

  const prefixEvidenceOf = (spec: RouteSpec, file: string): readonly Evidence[] =>
    spec.prefixes.length > 0 && ownPathOf(spec) !== null ? [ctx.evidence(prefixEvidence(spec), file, spec.node)] : []

  const prefixEvidence = (spec: RouteSpec): string => {
    const flags = spec.prefixes.map((rule) => rule.flag).join(", ")
    return spec.prefixes.every((rule) => rule.keepPlain) ? `dual route (${flags})` : `prefixed route (${flags})`
  }

  /** A route flagged by prefix rules is read plain (when every rule keeps it), then once per prefix. */
  const variantsOf = (spec: RouteSpec): readonly RouteSpec[] => {
    if (spec.prefixes.length === 0 || ownPathOf(spec) === null) return [spec]
    const plain = spec.prefixes.every((rule) => rule.keepPlain) ? [spec] : []
    return [...plain, ...spec.prefixes.map((prefix) => ({ ...spec, prefix }))]
  }

  const parseRoute = (spec: RouteSpec, parent: RouteContext): void => {
    const file = parent.file
    if (unreadablePath(spec)) {
      report({
        severity: "warning",
        code: "screens/unsupported-router-style",
        message: `route path {${excerpt(spec.path?.node ?? spec.node)}} is not a string this source can read; the route and its children are not discovered`,
        file,
        line: ctx.lineOf(file, spec.node),
      })
      return
    }
    reportPathQuery(spec)
    variantsOf(spec).forEach((variant, index) => {
      if (index === 0) parseVariant(variant, parent)
      else echoed(() => {
        parseVariant(variant, parent)
      })
    })
  }

  const parseVariant = (spec: RouteSpec, parent: RouteContext): void => {
    const file = parent.file
    // The ordinal is claimed BEFORE recursing into `children`, so localIds follow `node.pos` order
    // (§4.1) instead of the post-order in which the recursion happens to unwind.
    const ordinal = nextOrdinal(file)
    const pinned = spec.scope === null && spec.prefix === null
    const localId = flags.dryRun ? "" : ctx.localId(file, { ordinal, ...(pinned ? { node: spec.node } : {}) })

    const declaredPath = rawPathOf(spec)
    const relative = parent.descendantList === true && spec.flavour.splatNests
    const rawPath = relative && declaredPath?.startsWith("/") ? declaredPath.slice(1) : declaredPath
    const info = infoOf(spec)

    const pathUrl = rawPath !== null ? joinUrl(parent.url, rawPath) : spec.isIndex ? parent.url : null
    const dialectRedirect = dialectRedirectOf(spec, pathUrl ?? parent.url, parent.url)
    if (dialectRedirect === null) reportUnreadRedirect(spec, file)
    const redirectTo = dialectRedirect ?? elementRedirectOf(spec, info.redirectTo, pathUrl ?? parent.url, parent.url)
    const dual = prefixEvidenceOf(spec, file)
    const inheritedUrl = rawPath !== null ? pathUrl : parent.url
    // An index child IS the screen at this url; the parent only frames it, so it must not claim it too.
    const indexOwned = spec.children !== null && hasIndexChild(spec.children, new Set())
    const auth = gatedAuth(spec.scope, routeAuth(info.auth, parent.auth))
    const featureFlag = info.featureFlag ?? parent.featureFlag
    const title = info.title ?? parent.title

    const childContext: RouteContext = {
      ...parent,
      file,
      url: inheritedUrl,
      descendantList: false,
      lineage: [...parent.lineage, ...dual],
      auth,
      featureFlag,
      title,
      ancestors: childChain(parent, info),
    }

    const before = drafts.length
    if (spec.children !== null) parseList(spec.children, childContext)

    const base = splatBase(spec, parent.url, relative)
    if (base !== undefined) {
      const merge: MergeScope = new Map()
      for (const { root, mount, guards } of descendantsOf(spec))
        parseRoot(root, {
          ...childContext,
          url: base,
          descendantList: true,
          merge,
          auth: gatedAuth(spec.scope, routeAuth(guards.auth, parent.auth)),
          featureFlag: guards.featureFlag ?? parent.featureFlag,
          title: guards.title ?? parent.title,
          ancestors: uniqueBy([...parent.ancestors, ...mount], ancestorKey),
        })
    }

    // Likewise a splat route whose descendant list renders a route at its very url only frames it.
    const nestedOwned =
      pathUrl !== null && drafts.slice(before).some((draft) => urlsOf(draft).includes(pathUrl))
    const ownUrl = indexOwned || nestedOwned ? null : pathUrl

    const entryless = info.entries.length === 0 && redirectTo === null
    const kindTag = entryless ? (spec.children === null ? "entryless" : "layout") : null

    const evidence: Evidence[] = [ctx.evidence(spec.what, file, spec.node)]
    if (spec.scope !== null) evidence.push(ctx.evidence("route data item", spec.scope.file, spec.scope.item))
    if (spec.path !== null) evidence.push(ctx.evidence("route path", file, spec.path.node))
    evidence.push(...spec.notes.map((note) => ctx.evidence(note.what, note.file, note.node)))
    evidence.push(...dual, ...parent.lineage)
    if (info.routeName !== null)
      evidence.push(ctx.evidence(`route name '${info.routeName}'`, file, spec.element?.node ?? spec.node))
    if (info.auth === "per-item" && info.itemGuard !== null)
      evidence.push(ctx.evidence(PER_ITEM_GUARD, file, info.itemGuard))
    const propEvidence = propEntryEvidence(info.propEntry, file)
    if (propEvidence !== null) evidence.push(propEvidence)
    const gate = spec.scope?.gate ?? null
    if (gate !== null) evidence.push(ctx.evidence(RUNTIME_GATE, gate.file, gate.node))

    const committed = commitDraft(
      {
        localId,
        activations:
          ownUrl === null ? [] : [{ kind: "url", template: ownUrl, params: [...paramsOf(ownUrl)] }],
        entries: info.entries,
        auth,
        evidence,
        ...(kindTag === null ? {} : { kindTag }),
        ...(title === null ? {} : { title }),
        ...(featureFlag === null ? {} : { featureFlag }),
        ...(redirectTo === null ? {} : { redirectTo }),
        ...(parent.devOnly ? { devOnly: true } : {}),
      },
      parent,
      spec.node,
    )
    if (!committed) return

    // With an entry, the innermost wrapper holds it as `children`. WITHOUT one, nothing renders inside
    // this route's own element except its child routes, so the innermost wrapper splices at `<Outlet/>`
    // exactly as it does for the children — the same wrapper must not claim two splice modes.
    ancestors.set(
      localId,
      info.entries.length > 0
        ? uniqueBy([...parent.ancestors, ...info.wrappers], ancestorKey)
        : childContext.ancestors,
    )
  }

  const parseItem = (item: RouteItem, parent: RouteContext): void => {
    if (item.kind === "unreadable") {
      report({
        severity: "warning",
        code: "screens/unsupported-router-style",
        message: item.reason,
        file: item.file,
        line: ctx.lineOf(item.file, item.node),
      })
      return
    }

    const context = { ...parent, devOnly: parent.devOnly || item.devOnly }
    if (item.kind === "list") {
      parseList(item.list, context)
      return
    }
    parseRoute(item.spec, { ...context, file: item.file })
  }

  const parseList = (list: RouteList, parent: RouteContext): void => {
    if (openLists.has(list.anchor)) return
    openLists.add(list.anchor)
    for (const item of itemsOf(list)) parseItem(item, { ...parent, file: list.file })
    openLists.delete(list.anchor)
  }

  const parseRoot = (root: RouteRoot, parent: RouteContext): void => {
    if (openRoots.has(root)) return
    parsedRoots.add(root)

    if (root.list === null) {
      report({
        severity: "warning",
        code: "screens/dynamic-registry",
        message: `${root.label}(...) argument is not a route array literal this source can read`,
        file: root.file,
        line: ctx.lineOf(root.file, root.node),
      })
      return
    }

    openRoots.add(root)
    reportBase(root)
    const url = root.base === null ? parent.url : joinUrl(parent.url, root.base)
    parseList(root.list, { ...parent, file: root.list.file, root, url })
    openRoots.delete(root)
  }

  return { urlsOf, parseRoot }
}

export type ParseApi = ReturnType<typeof createParse>
