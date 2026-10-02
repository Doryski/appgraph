export const BUILTIN_KINDS = [
  "screen",
  "module",
  "layout",
  "ui",
  "hook",
  "service",
  "store",
  "shared",
  "other",
] as const

export type NodeKind = (typeof BUILTIN_KINDS)[number] | (string & {})

export type ScreenId = string

export type Activation =
  | { readonly kind: "url"; readonly template: string; readonly params: readonly string[] }
  | { readonly kind: "state"; readonly holder: string; readonly expr: string }
  | { readonly kind: "host"; readonly pattern: string }
  | { readonly kind: "message"; readonly messageType: string }
  | {
      readonly kind: "intercept"
      readonly from: string
      readonly slot: string | null
      readonly file: string
    }
  | { readonly kind: "route"; readonly name: string; readonly navigator: string | null }

export type NodeLocator = {
  readonly export: string
  readonly path: readonly number[]
}

export type SpliceMode =
  | { readonly kind: "children" }
  | { readonly kind: "outlet"; readonly tag: string; readonly name?: string }
  | { readonly kind: "at"; readonly locator: NodeLocator }
  | { readonly kind: "slot"; readonly name: string }

export type AncestorRole = "layout" | "guard" | "errorBoundary" | "transparent"

export type SlotBranch = {
  readonly file: string
  readonly exportName: string
  readonly splice: SpliceMode
  readonly conditions: readonly string[]
}

export type AncestorRef = {
  readonly file: string
  readonly exportName: string
  readonly splice: SpliceMode
  readonly role: AncestorRole
  readonly branches?: readonly SlotBranch[]
}

export type EntryRef =
  | {
      readonly kind: "file"
      readonly file: string
      readonly exportName: string
      readonly at?: NodeLocator
      readonly platform?: string
    }
  | { readonly kind: "opaque"; readonly expr: string; readonly file: string; readonly line: number }

export type Evidence = {
  readonly what: string
  readonly file: string
  readonly line: number
}

export type Provenance = {
  readonly sources: readonly string[]
  readonly evidence: readonly Evidence[]
  readonly mergedFrom: readonly { readonly source: string; readonly localId: string }[]
  readonly decisions: readonly string[]
}

export type AuthState = "protected" | "public" | "unknown"

export type Endpoint = {
  readonly method: string
  readonly url: string
  readonly transport: "http" | "rpc"
  readonly client: string | null
}

export type NavTrigger = "navigate" | "link" | "redirect" | (string & {})

export type Navigation = {
  readonly to: string
  readonly trigger: NavTrigger
  readonly dynamic: boolean
  readonly expr?: string
  readonly routeName?: string
}

/**
 * A navigation target that matched no screen directly but reached one through redirect rules.
 * `declaredAt` is the rule the target matched first; `condition` joins the branch conditions of every
 * rule on the way, so a deployment-specific answer says so.
 */
export type RedirectAlternative = {
  readonly to: string
  readonly condition: string
}

export type RedirectResolution = {
  readonly from: string
  readonly to: string
  readonly declaredAt?: string
  readonly condition?: string
  readonly alternatives?: readonly RedirectAlternative[]
}

export type ResolvedNavigation = {
  readonly to: string
  readonly matchedRoute: ScreenId | null
  readonly trigger: NavTrigger
  readonly dynamic: boolean
  readonly from: string
  readonly expr?: string
  readonly viaRedirect?: RedirectResolution
  readonly routeName?: string
}

export const routeNameField = (item: { readonly routeName?: string }) =>
  item.routeName === undefined ? {} : { routeName: item.routeName }

export const routeNameSuffix = (item: { readonly routeName?: string }): string =>
  item.routeName === undefined ? "" : `|${item.routeName}`

export type NavigationEdge = {
  readonly from: ScreenId
  readonly to: string
  readonly trigger: NavTrigger
  readonly dynamic: boolean
  readonly via: string
  readonly expr?: string
}

export type FactChannel =
  | "endpoints"
  | "navigations"
  | "stores"
  | "queryKeys"
  | "mutations"
  | "i18nNamespaces"
  | "testIds"
  | "formSchemas"
  | "formFields"
  | "featureGates"
  | "hooks"
  | "messages"
  | (string & {})

export type ScreenFacts = {
  readonly endpoints: readonly Endpoint[]
  readonly navigations: readonly Navigation[]
  readonly stores: readonly string[]
  readonly queryKeys: readonly string[]
  readonly mutations: number
  readonly i18nNamespaces: readonly string[]
  readonly testIds: readonly string[]
  readonly formSchemas: readonly string[]
  readonly formFields: readonly string[]
  readonly featureGates: readonly string[]
  readonly hooks: readonly string[]
  readonly messages: readonly string[]
  readonly extra: Readonly<Record<string, readonly unknown[]>>
}

export type RenderEdge = {
  readonly file: string
  readonly conditions: readonly string[]
  readonly alwaysRendered: boolean
  readonly repeated: boolean
  readonly via?: "lazy" | "reference" | "selector" | "selector-global"
}

export type FileFacts = {
  readonly file: string
  readonly component: string
  readonly kind: NodeKind
  readonly renders: readonly RenderEdge[]
  readonly nullGuards: readonly string[]
  readonly uses: readonly string[]
  readonly hooks: readonly string[]
  readonly stores: readonly string[]
  readonly queryKeys: readonly string[]
  readonly mutations: number
  readonly endpoints: readonly Endpoint[]
  readonly navigations: readonly Navigation[]
  readonly i18nNamespaces: readonly string[]
  readonly testIds: readonly string[]
  readonly formSchemas: readonly string[]
  readonly formFields: readonly string[]
  readonly featureGates: readonly string[]
  readonly messages: readonly string[]
  /** Every channel an extractor emitted that is not named above — `messageHandlers`, `messageSends`, … */
  readonly extra: Readonly<Record<string, readonly unknown[]>>
}

export type TreeNode = {
  readonly file: string
  readonly component: string
  readonly kind: NodeKind
  readonly conditions: readonly string[]
  readonly alwaysRendered: boolean
  readonly repeated: boolean
  readonly via?: RenderEdge["via"]
  readonly nullGuards: readonly string[]
  readonly children: readonly TreeNode[]
  readonly truncated: boolean
  readonly repeat: boolean
}

export type ScreenDraft = {
  readonly localId: string
  readonly activations: readonly Activation[]
  readonly entries: readonly EntryRef[]
  readonly ancestors?: readonly AncestorRef[]
  readonly title?: string | null
  readonly kindTag?: string | null
  readonly shell?: string | null
  readonly auth?: "protected" | "public" | null
  readonly featureFlag?: string | null
  readonly redirectTo?: string | null
  readonly devOnly?: boolean
  readonly routeName?: string
  readonly routeNameAliases?: readonly string[]
  readonly evidence: readonly Evidence[]
}

export type Screen = {
  readonly id: ScreenId
  readonly localId: string
  readonly source: string
  readonly activations: readonly Activation[]
  readonly url: string | null
  readonly params: readonly string[]
  readonly title: string | null
  readonly kindTag: string | null
  readonly entries: readonly EntryRef[]
  readonly ancestors: readonly AncestorRef[]
  readonly shell: string | null
  readonly auth: AuthState
  readonly featureFlag: string | null
  readonly redirectTo: string | null
  readonly devOnly: boolean
  readonly addressable: boolean
  readonly tree: readonly TreeNode[]
  readonly reachable: readonly string[]
  readonly facts: ScreenFacts
  readonly navigatesTo: readonly ResolvedNavigation[]
  readonly provenance: Provenance
  readonly routeName?: string
  /**
   * Ancestor files whose splice sites disagree on where the next level goes (or wrap it in a component
   * that never renders `children`); the tree places the level directly under the ancestor instead.
   */
  readonly placementAmbiguous?: readonly string[]
}

export type ShellReport = {
  readonly file: string
  readonly layouts: readonly string[]
  readonly tree: readonly TreeNode[]
  readonly navigatesTo: readonly ResolvedNavigation[]
  readonly endpoints: readonly Endpoint[]
  readonly stores: readonly string[]
  readonly i18nNamespaces: readonly string[]
  readonly testIds: readonly string[]
}

export type NavEntry = {
  readonly path: string
  readonly parentPath: string | null
  readonly label: string | null
  readonly labelKey: string | null
  readonly featureFlag: string | null
  readonly source: string
  readonly file: string
  readonly line: number
  readonly resolvedScreen: ScreenId | null
  readonly viaRedirect?: RedirectResolution
}

export type NavGroup = {
  readonly name: string
  readonly source: string
  readonly score: number
  readonly availableOnShells: readonly string[]
  readonly entries: readonly NavEntry[]
}

export type Severity = "error" | "warning" | "info"

export type Diagnostic = {
  readonly severity: Severity
  readonly code: string
  readonly message: string
  readonly plugin: string | null
  readonly file?: string
  readonly line?: number
  readonly screenId?: ScreenId
}

export type SectionConfidence = {
  readonly section: FactChannel | "screens" | "nav"
  readonly count: number
  readonly enablingDependency: string | null
  readonly dependencyInstalled: boolean
  readonly level: "high" | "low" | "suspect"
}

export type AppGraphMeta = {
  readonly schemaVersion: 2
  readonly appgraphVersion: string
  readonly root: string
  /** The analysed project's own name (`package.json` `name`, else the root directory name). */
  readonly appName: string | null
  readonly sourceRoots: readonly string[]
  readonly screenSources: readonly string[]
  readonly maxDepth: number
  readonly fingerprint: string
  readonly emptyResult?: true
  readonly emptyReason?: string
  readonly counts: Readonly<Record<string, number>>
  readonly confidence: readonly SectionConfidence[]
  readonly limitations: readonly string[]
}

export type RedirectRuleSpec = {
  readonly source: string
  readonly destination: string
}

/**
 * One redirect rule in Next.js `source`/`destination` syntax. A `conditional` rule (`has`/`missing`) is
 * listed but never used to resolve a link; `condition` is the text of the branch it was declared under.
 */
export type RedirectRule = RedirectRuleSpec & {
  readonly declaredAt: string
  readonly condition: string | null
  readonly conditional: boolean
}

/** A listed redirect; `conditional` (only ever `true`) marks a `has`/`missing` rule that never resolves a link. */
export type GraphRedirect = {
  readonly from: string
  readonly to: string
  readonly declaredAt?: string
  readonly condition?: string
  readonly conditional?: true
}

export type AppGraph = {
  readonly meta: AppGraphMeta
  readonly screens: readonly Screen[]
  readonly redirects: readonly GraphRedirect[]
  readonly shells: Readonly<Record<string, ShellReport>>
  readonly components: Readonly<Record<string, FileFacts>>
  readonly navGroups: readonly NavGroup[]
  readonly navigation: readonly NavigationEdge[]
  readonly deadNavLinks: readonly NavEntry[]
  readonly orphanScreens: readonly ScreenId[]
  readonly diagnostics: readonly Diagnostic[]
}

export type KindRule = {
  readonly match: {
    readonly pathPrefix?: string
    readonly pathRegex?: string
    readonly fileRegex?: string
  }
  readonly kind: NodeKind
  readonly traversable: boolean
  readonly screenEntry: boolean
  readonly priority?: number
}

export type WrapperRoleKind = "layout" | "guard" | "errorBoundary" | "redirect" | "transparent"

export type WrapperRole = {
  readonly tagRegex: string
  readonly role: WrapperRoleKind
  readonly reads?: string
}

export type ExtensionRewrite = {
  readonly from: string
  readonly to: readonly string[]
}

/**
 * Which property of one menu-config element carries which `NavEntry` field. Every field is optional: an
 * omitted one falls back to the §10.6 auto-discovery name list. `title` and `label` are aliases for the
 * human label (`label` wins); `labelKey` is the i18n-key field, kept apart so a key is never printed as
 * if it were prose. `icon` is not emitted — it is a recognition signal that an element is a menu item
 * rather than a route object.
 */
export type NavFieldMap = {
  readonly target?: string
  readonly title?: string
  readonly label?: string
  readonly labelKey?: string
  readonly group?: string
  readonly parent?: string
  readonly flag?: string
  readonly icon?: string
}

/** One menu config named explicitly, for an app whose menu no scoring pass should have to guess. */
export type MenuSpec = {
  readonly file: string
  /** The exported binding holding the array or record. `''` addresses the file's own default export. */
  readonly export: string
  /** The group name in the report; defaults to the export name. */
  readonly name?: string
  /** Joined in front of every target — for a record keyed by resource name rather than by URL. */
  readonly basePath?: string
  readonly fields?: NavFieldMap
}

export type ModuleResolutionOptions = {
  readonly candidateSuffixes: readonly string[]
  readonly extensionRewrites: readonly ExtensionRewrite[]
  readonly sourceRoots: readonly string[]
}

export type TsconfigChain = {
  readonly files: readonly string[]
  readonly baseUrl: string | null
  readonly paths: Readonly<Record<string, readonly string[]>>
  readonly include: readonly string[]
  readonly moduleResolution: string | null
  readonly jsx: string | null
  readonly moduleSuffixes?: readonly string[]
}

export type FlatString = {
  readonly value: string
  readonly dynamic: boolean
  readonly truncated?: true
}

export type Binding =
  | {
      readonly kind: "import"
      readonly module: string
      readonly imported: string
      readonly file: string | null
    }
  | {
      readonly kind: "dynamic-import"
      readonly module: string
      readonly imported: string
      readonly file: string | null
    }
  | { readonly kind: "hook-result"; readonly hook: string; readonly module: string | null }
  | { readonly kind: "local"; readonly declaredAt: number }

export type BindingTable = {
  readonly get: (local: string) => Binding | null
  readonly rootsInModule: (local: string, modulePattern: string | RegExp) => boolean
  readonly isHookResult: (local: string, hook: string, module?: string) => boolean
  readonly moduleOf: (local: string) => string | null
}

export type AppgraphConfig = {
  readonly root?: string
  readonly sourceRoots?: readonly string[]
  readonly screenSource?: string
  readonly screenSources?: readonly string[]
  readonly depth?: number
  readonly out?: string
  readonly formats?: readonly string[]
  readonly conflicts?: "merge" | "first" | "error"
  readonly kindRules?: readonly KindRule[]
  /** Nav sources to run, by name. Empty or omitted keeps every registered one. */
  readonly navSources?: readonly string[]
  /** Menu configs named explicitly; auto-discovery still runs alongside them. */
  readonly menus?: readonly MenuSpec[]
  readonly stringSources?: readonly string[]
  readonly testIdAttribute?: string
  readonly redirects?: { readonly unauthenticated?: string; readonly flagOff?: string }
  /** Extra redirect rules (`source` → `destination`, Next.js syntax) used to resolve otherwise dead links. */
  readonly redirectRules?: readonly RedirectRuleSpec[]
  readonly strict?: boolean
  readonly allowEmpty?: boolean
  readonly extensionRewrites?: readonly ExtensionRewrite[]
  readonly candidateSuffixes?: readonly string[]
  readonly exclude?: readonly string[]
  readonly generated?: readonly string[]
  /** react-router wrapper classification. Merged by `name` over the stack's defaults; a same-named rule replaces one. */
  readonly wrapperRoles?: readonly WrapperRule[]
  /** TanStack pathless segment (`_authed`) meanings. Merged by key over the default `{ _authed: { auth: "protected" } }`. */
  readonly pathlessRoles?: Readonly<Record<string, PathlessRole>>
  /** state-screens holder components. Supplied, they replace the MV3-manifest derivation. */
  readonly entryComponents?: readonly HolderSpec[]
  readonly adminjs?: AdminJsConfig
  readonly reactRouter?: ReactRouterConfig
  readonly vueAuth?: VueAuthConfig
  readonly angular?: AngularConfig
  readonly expoRouter?: ExpoRouterConfig
  readonly reactNavigation?: ReactNavigationConfig
  readonly nativeAuth?: NativeAuthConfig
  readonly featureFlags?: FeatureFlagsConfig
  /** Fact extractors to run, by name. Omitted runs every registered extractor. */
  readonly extractors?: readonly string[]
}

export const ROUTE_DIALECT_FIELDS = ["path", "element", "component", "children", "redirect", "index", "lazy"] as const

export type RouteDialectField = (typeof ROUTE_DIALECT_FIELDS)[number]

/** A route flagged by `flag` is mounted under `prefix`; `keepPlain` also keeps the unprefixed route. */
export type RoutePrefixRule = {
  readonly flag: string
  readonly prefix: string
  readonly keepPlain: boolean
}

/**
 * The property names a route-object dialect uses. With `translators` set, the names apply only inside
 * those calls' arguments; `unwrapCalls` are wrappers whose argument is the real route or component.
 */
export type RouteDialect = {
  readonly name?: string
  readonly fields?: Partial<Readonly<Record<RouteDialectField, string>>>
  readonly translators?: readonly string[]
  readonly unwrapCalls?: readonly string[]
  readonly prefixRules?: readonly RoutePrefixRule[]
}

export type ReactRouterConfig = {
  readonly routeDialect?: RouteDialect
}

export type VueAuthConfig = {
  /** Route middleware names that mark a page as protected; unioned with the defaults. */
  readonly protectedMiddleware?: readonly string[]
  /** Route middleware names that mark a page as public; unioned with the defaults. */
  readonly publicMiddleware?: readonly string[]
  /** Route `meta` keys read as auth flags (`true` protects, `false` is public); unioned with the defaults. */
  readonly authMetaKeys?: readonly string[]
}

export type AngularPublicData = {
  readonly key: string
  readonly value: string | boolean
}

export type AngularConfig = {
  /** Route guard names that mark a route as protected; unioned with the defaults. */
  readonly protectedGuards?: readonly string[]
  /** Route guard names that mark a route as public; unioned with the defaults. */
  readonly publicGuards?: readonly string[]
  /** Route `data` keys that mark a guarded route as protected; unioned with the defaults. */
  readonly authDataKeys?: readonly string[]
  /** Literal route `data` entries that mark a route as public; unioned with the defaults. */
  readonly publicData?: readonly AngularPublicData[]
  /** Route `data` keys that name a redirect target; unioned with the defaults. */
  readonly redirectDataKeys?: readonly string[]
}

export type ExpoRouterConfig = {
  readonly root?: string
}

export type PathTableSpec = {
  readonly callee: string
  readonly argument: number
}

export type ReactNavigationConfig = {
  readonly pathTables?: readonly PathTableSpec[]
  readonly authOptionKeys?: readonly string[]
}

export type NativeAuthConfig = {
  readonly signedIn?: readonly string[]
}

export type FeatureFlagsConfig = {
  readonly lookupFunctions?: readonly string[]
}

export type AdminJsConfig = {
  /** Project-relative path of the `AdminJSOptions` file; skips the content probe. */
  readonly optionsFile?: string
  /** Project-relative path of the `componentLoader` file, when no import reaches it. */
  readonly componentLoaderFile?: string
}

export const REACT_ROUTER_MODULE = "^react-router(-dom)?(-v5-compat)?$"

/**
 * A rule matches by IMPORTED BINDING first (`exported` + `importedFrom`) so an aliased
 * `import { ProtectedRoute as Protected }` still matches, and falls back to `tagRegex` for a
 * wrapper declared in the same file. `reads` names the JSX attribute the role carries; `entryFrom` names
 * the member of a mapped route item that holds its page component.
 */
export type WrapperRule = {
  readonly name: string
  readonly role: WrapperRoleKind
  readonly tagRegex?: string
  readonly exported?: string
  readonly importedFrom?: string
  readonly reads?: string
  readonly entryFrom?: string
}

/**
 * CONVENTION-BASED DEFAULTS, not any one app's component names.
 *
 * `Navigate`, `Redirect`, `Suspense`, `Fragment`, `StrictMode` and `Profiler` are library exports and are matched by
 * origin. The other three are naming conventions widespread in the react-router ecosystem — a guard
 * component called `ProtectedRoute` or `PrivateRoute`, an `errorElement` component called `RouteErrorBoundary`, and layout
 * components whose names end in `Layout` or `LayoutWrapper`. They are DEFAULTS in the ordinary sense:
 * a repo that names its guard something else declares it through `wrapperRoles` (§16.1) and these stop
 * applying. Nothing here is required for the adapter to work; an unmatched wrapper is simply an opaque
 * ancestor rather than a classified one.
 */
export const DEFAULT_WRAPPER_RULES: readonly WrapperRule[] = [
  {
    name: "protected-route",
    role: "guard",
    tagRegex: "^(Protected|Private)Route$",
    exported: "ProtectedRoute",
    reads: "featureFlag",
    entryFrom: "component",
  },
  {
    name: "route-error-boundary",
    role: "errorBoundary",
    tagRegex: "^RouteErrorBoundary$",
    exported: "RouteErrorBoundary",
    reads: "routeName",
  },
  {
    name: "navigate",
    role: "redirect",
    tagRegex: "^Navigate$",
    exported: "Navigate",
    importedFrom: REACT_ROUTER_MODULE,
    reads: "to",
  },
  {
    name: "redirect",
    role: "redirect",
    tagRegex: "^Redirect$",
    exported: "Redirect",
    importedFrom: REACT_ROUTER_MODULE,
    reads: "to",
  },
  { name: "layout", role: "layout", tagRegex: "Layout(Wrapper)?$", reads: "title" },
  { name: "react-router-element", role: "transparent", importedFrom: REACT_ROUTER_MODULE },
  { name: "react-element", role: "transparent", tagRegex: "^(Suspense|Fragment|StrictMode|Profiler)$" },
]

/** A component whose top-level JSX selects between states. `exportName` defaults to the file's own. */
export type HolderSpec = {
  readonly file: string
  readonly exportName?: string
}

/** What a `_`-prefixed segment (or a code route's `id`) means. It never contributes a URL segment. */
export type PathlessRole = {
  readonly auth?: Exclude<AuthState, "unknown">
}

export type PathlessRoles = Readonly<Record<string, PathlessRole>>

export const DEFAULT_PATHLESS_ROLES: PathlessRoles = {
  _authed: { auth: "protected" },
}
