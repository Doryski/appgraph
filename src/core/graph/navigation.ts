import type { DiagnosticCollector } from "../diagnostics.js"
import type { NavGroup, NavigationEdge, ResolvedNavigation, Screen, ScreenId } from "../model.js"
import { by, sortStrings, uniqueBy } from "../order.js"
import { countsAsScreen } from "./screens.js"

export const navigationOf = (
  screens: readonly Screen[],
  navGroups: readonly NavGroup[],
  diagnostics: DiagnosticCollector,
) => {
  const navigation = uniqueBy(
    screens.flatMap((screen) =>
      screen.navigatesTo
        .filter((edge): edge is ResolvedNavigation & { matchedRoute: ScreenId } => edge.matchedRoute !== null)
        .filter((edge) => edge.matchedRoute !== screen.id)
        .map((edge): NavigationEdge => ({
          from: screen.id,
          to: edge.matchedRoute,
          trigger: edge.trigger,
          dynamic: edge.dynamic,
          via: edge.from,
          ...(edge.expr === undefined ? {} : { expr: edge.expr }),
        })),
    ),
    // `via` is part of the identity: two reachable files can navigate one screen to the same target,
    // and collapsing them keeps only whichever file sorts first — a shell's edge would erase the
    // page's own.
    (edge) => `${edge.from}|${edge.to}|${edge.trigger}|${edge.via}`,
  ).sort(by((edge) => `${edge.from}|${edge.to}|${edge.trigger}|${edge.via}`))

  const inbound = new Set<ScreenId>([
    ...navigation.map((edge) => edge.to),
    ...navGroups.flatMap((group) =>
      group.entries.map((entry) => entry.resolvedScreen).filter((id): id is ScreenId => id !== null),
    ),
  ])

  const orphanScreens = sortStrings(
    screens.filter((screen) => screen.addressable && countsAsScreen(screen) && !inbound.has(screen.id)).map((screen) => screen.id),
  )

  for (const id of orphanScreens)
    diagnostics.info("screens/orphan", `screen '${id}' has no inbound navigation or menu edge`, {
      screenId: id,
    })

  return { navigation, orphanScreens }
}
