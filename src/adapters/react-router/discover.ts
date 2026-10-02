import type { DiscoverContext } from "../types.js"
import { appFiles } from "./constants.js"
import { createDescendants } from "./descendants.js"
import { createDiscoverJsx } from "./discover-jsx.js"
import { createDiscoverObjects } from "./discover-objects.js"
import { createElements } from "./elements.js"
import { createItemScope } from "./item-scope.js"
import { createLazy } from "./lazy.js"
import { createMappedRoutes } from "./mapped-routes.js"
import type { Discovery } from "./model.js"
import { createParse } from "./parse.js"
import type { RouterProfile } from "./profile.js"
import { createResolve } from "./resolve.js"
import { createRoots } from "./roots.js"
import { createRouteData } from "./route-data.js"
import { createRouteLists } from "./route-lists.js"
import { createSpecs } from "./specs.js"
import { createDiscoveryState } from "./state.js"
import { createTopLevel } from "./top-level.js"
import { createV5Paths } from "./v5-paths.js"
import type { ReactRouterOptions } from "./wrappers.js"

export const runDiscovery = (ctx: DiscoverContext, options: ReactRouterOptions, profile: RouterProfile): Discovery => {
  const state = createDiscoveryState(ctx, options, profile)
  const withResolve = { ...state, ...createResolve(state) }
  const withItemScope = { ...withResolve, ...createItemScope(withResolve) }
  const withElements = { ...withItemScope, ...createElements(withItemScope) }
  const withLazy = { ...withElements, ...createLazy(withElements) }
  const withV5Paths = { ...withLazy, ...createV5Paths(withLazy) }
  const withSpecs = { ...withV5Paths, ...createSpecs(withV5Paths) }
  const withDiscoverObjects = { ...withSpecs, ...createDiscoverObjects(withSpecs) }
  const withRouteData = { ...withDiscoverObjects, ...createRouteData(withDiscoverObjects) }
  const withMappedRoutes = { ...withRouteData, ...createMappedRoutes(withRouteData) }
  const withDiscoverJsx = { ...withMappedRoutes, ...createDiscoverJsx(withMappedRoutes) }
  const withRouteLists = { ...withDiscoverJsx, ...createRouteLists(withDiscoverJsx) }
  const withRoots = { ...withRouteLists, ...createRoots(withRouteLists) }
  const withDescendants = { ...withRoots, ...createDescendants(withRoots) }
  const withParse = { ...withDescendants, ...createParse(withDescendants) }
  const withTopLevel = { ...withParse, ...createTopLevel(withParse) }
  const { drafts, ancestors, parsedRoots, rootsIn, claimedRoots, withdrawn, routerRenderedIn, renderClosure, parseTopLevels } = withTopLevel

  const roots = appFiles(ctx).flatMap(rootsIn)
  const claimed = claimedRoots(roots)
  const ordered = [
    ...roots.filter((root) => root.kind === "factory"),
    ...roots.filter((root) => root.kind !== "factory"),
  ]
  const rendered = renderClosure(appFiles(ctx).flatMap(routerRenderedIn))

  parseTopLevels(
    ordered.filter((root) => !claimed.has(root)),
    rendered,
    true,
  )
  // A claimed root whose claiming route was never reached is read top-level only when that is provable.
  parseTopLevels(
    ordered.filter((root) => !parsedRoots.has(root) && !withdrawn.has(root)),
    rendered,
    false,
  )

  for (const diagnostic of profile.setupDiagnostics(ctx, roots.length)) ctx.diagnostic(diagnostic)

  return { drafts, ancestors }
}
