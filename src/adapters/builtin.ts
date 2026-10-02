import type {
  AdminJsConfig,
  ExpoRouterConfig,
  HolderSpec,
  MenuSpec,
  PathlessRole,
  ReactNavigationConfig,
  RouteDialect,
  WrapperRule,
} from "../core/model.js"
import { DEFAULT_WRAPPER_RULES } from "../core/model.js"
import { mergeByName } from "../config/merge.js"
import type { Adapter, ScreenSource } from "./types.js"
import { nextAppSource } from "./next-app.js"
import { createExpoRouterAdapter } from "./expo-router.js"
import { createReactNavigationAdapter } from "./react-navigation.js"
import { createNextPagesSource } from "./next-pages.js"
import { createReactRouterFrameworkAdapter } from "./react-router-framework.js"
import { nextConfigAdapter } from "./next-config.js"
import { createReactRouterAdapter, createWouterAdapter } from "./react-router.js"
import { createTanStackRouterAdapter } from "./tanstack-router.js"
import { createAdminJsAdapter } from "./adminjs.js"
import { createVueRouterAdapter } from "./vue-router.js"
import { createNuxtAdapter } from "./nuxt.js"
import type { AngularAuthRules } from "./angular/auth.js"
import { createAngularAdapter } from "./angular/router.js"
import type { VueAuthRules } from "./vue-auth.js"
import type { NativeAuthRules } from "./native-auth.js"
import { createStateScreensAdapter } from "./state-screens.js"
import { manifestActivationAdapter } from "./manifest-activation.js"
import { createNavAdapter } from "./nav-config.js"
import { byAdapterPrecedence } from "./precedence.js"

// ---------------------------------------------------------------------------
// Built-in adapters (§5.9's shipped screen sources). This list is the ONLY place a source is
// registered: `SOURCE_PRECEDENCE` orders it, `detect/index.ts` derives its probe table from it, and
// `analyze()` defaults to it — so a source cannot be detectable and unrunnable, or vice versa.
// ---------------------------------------------------------------------------

export type BuiltinAdapterOptions = {
  /** Merged by name over `DEFAULT_WRAPPER_RULES`, so a config rule never silently drops the defaults. */
  readonly wrapperRoles?: readonly WrapperRule[]
  /** Menu configs named by config or preset; auto-discovery runs whether or not any are named (§10.6). */
  readonly menus?: readonly MenuSpec[]
  /** Replaces the TanStack default roles; `ResolvedConfig.pathlessRoles` already carries them merged. */
  readonly pathlessRoles?: Readonly<Record<string, PathlessRole>>
  readonly entryComponents?: readonly HolderSpec[] | null
  readonly adminjs?: AdminJsConfig
  readonly routeDialect?: RouteDialect
  readonly vueAuthRules?: VueAuthRules
  readonly angularAuthRules?: AngularAuthRules
  readonly nativeAuthRules?: NativeAuthRules
  readonly expoRouter?: ExpoRouterConfig
  readonly reactNavigation?: Pick<ReactNavigationConfig, "pathTables">
  /** Config `redirects.unauthenticated`: scopes every loader/`beforeLoad` guard to redirects aimed at it. */
  readonly unauthenticatedTarget?: string | null
}

const guardOptionsOf = (options: BuiltinAdapterOptions) =>
  options.unauthenticatedTarget === undefined ? {} : { unauthenticatedTarget: options.unauthenticatedTarget }

export const createBuiltinAdapters = (options: BuiltinAdapterOptions = {}): readonly Adapter[] => [
  { name: "next-app", screens: [nextAppSource] },
  createExpoRouterAdapter({
    ...(options.expoRouter?.root === undefined ? {} : { root: options.expoRouter.root }),
    ...(options.nativeAuthRules === undefined ? {} : { authRules: options.nativeAuthRules }),
  }),
  { name: "next-pages", screens: [createNextPagesSource(guardOptionsOf(options))] },
  createReactRouterFrameworkAdapter(guardOptionsOf(options)),
  createNuxtAdapter(options.vueAuthRules === undefined ? {} : { authRules: options.vueAuthRules }),
  createTanStackRouterAdapter({
    ...(options.pathlessRoles === undefined ? {} : { pathless: options.pathlessRoles }),
    ...guardOptionsOf(options),
  }),
  createVueRouterAdapter(options.vueAuthRules === undefined ? {} : { authRules: options.vueAuthRules }),
  createAngularAdapter(options.angularAuthRules === undefined ? {} : { authRules: options.angularAuthRules }),
  createReactNavigationAdapter({
    ...(options.reactNavigation?.pathTables === undefined ? {} : { pathTables: options.reactNavigation.pathTables }),
    ...(options.nativeAuthRules === undefined ? {} : { authRules: options.nativeAuthRules }),
  }),
  createAdminJsAdapter(options.adminjs ?? {}),
  createReactRouterAdapter({
    wrappers: mergeByName(DEFAULT_WRAPPER_RULES, options.wrapperRoles),
    ...(options.routeDialect === undefined ? {} : { routeDialect: options.routeDialect }),
  }),
  createWouterAdapter({ wrappers: mergeByName(DEFAULT_WRAPPER_RULES, options.wrapperRoles) }),
  createStateScreensAdapter(
    options.entryComponents === undefined || options.entryComponents === null
      ? {}
      : { entryComponents: options.entryComponents },
  ),
  manifestActivationAdapter,
  nextConfigAdapter,
  createNavAdapter(options.menus === undefined || options.menus.length === 0 ? {} : { menus: options.menus }),
]

/** The built-in screen sources in `SOURCE_PRECEDENCE` order. */
export const builtinScreenSources = (): readonly ScreenSource[] =>
  [...createBuiltinAdapters()].sort(byAdapterPrecedence).flatMap((adapter) => adapter.screens ?? [])
