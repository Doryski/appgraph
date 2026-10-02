import type { AuthState, Severity } from "../core/model.js"
import { DEFAULT_FORMATS, DEFAULT_OUT_DIR } from "../config/types.js"
import type { GlossaryTermId } from "../emit/glossary.js"
import { FINDING_SECTIONS } from "../emit/report-derive.js"
import type { ExitCode } from "../pipeline/exit-codes.js"
import {
  EXIT_CACHE_UNAVAILABLE,
  EXIT_DIAGNOSTIC_ERROR,
  EXIT_FAILURE,
  EXIT_NO_SCREENS,
  EXIT_OK,
  EXIT_STRICT_WARNING,
  EXIT_USAGE,
} from "../pipeline/exit-codes.js"
import type { CliOptions } from "./args.js"
import type { CliDeps } from "./index.js"
import type { Writer } from "./print.js"

export const FORMATS = ["index", "detail", "full", "html", "graph", "all"] as const

export const LOCALES = ["en", "pl"] as const

export const DEFAULT_LIMIT = 50

export const AUTH_STATES = ["protected", "public", "unknown"] as const satisfies readonly AuthState[]

export const SEVERITIES = ["error", "warning", "info"] as const satisfies readonly Severity[]

export const SCREEN_SECTIONS = [
  "activations",
  "entries",
  "ancestors",
  "tree",
  "navigation",
  "shell",
  "endpoints",
  "stores",
  "query-keys",
  "mutations",
  "i18n",
  "feature-gates",
  "forms",
  "test-ids",
  "messages",
  "extra",
  "params",
  "reachable",
] as const

export const USAGE_TYPES = ["component", "endpoint", "testid", "store", "query-key", "i18n"] as const

export const COMPONENT_SORTS = ["renders", "file"] as const

export const SEARCH_KINDS = ["screen", "component", "menu"] as const

export const LINK_DIRECTIONS = ["out", "in"] as const

export const LINK_EXCLUSIONS = ["no-url", "api-route"] as const

export const USAGE_KINDS = ["screen", "component"] as const

export const USAGE_VIAS = ["entry", "tree", "reachable", "shell", "facts", "renders", "uses"] as const

export const CONFIDENCE_LEVELS = ["high", "low", "suspect"] as const

export const CONFIDENCE_STATUSES = ["ok", "partial", "empty-unexpected", "empty-expected"] as const

export type OptionParserId = "format" | "count" | "positive" | "list"

export type OptionSpec = {
  readonly flags: string
  readonly description: string
  readonly choices?: readonly string[]
  readonly parser?: OptionParserId
  readonly defaultValue?: string | number | boolean
}

export type ArgSpec = {
  readonly key: string
  readonly display: string
  readonly required: boolean
  readonly description: string
}

export type FieldType = "string" | "integer" | "number" | "boolean" | "array" | "string[]" | "object" | "object[]"

export type FieldChoice = string | number

export type FieldSpec = {
  readonly name: string
  readonly type: FieldType | readonly FieldType[]
  readonly description: string
  readonly nullable?: boolean
  readonly optional?: boolean
  readonly choices?: readonly FieldChoice[]
  readonly term?: GlossaryTermId
  readonly fields?: readonly FieldSpec[]
}

export type FieldTraits = Omit<FieldSpec, "name" | "type" | "description">

export const SHARED_OPTIONS = {
  root: { flags: "--root <dir>", description: "Project root (default: nearest ancestor with package.json + tsconfig.json)" },
  config: { flags: "--config <file>", description: "Config file (default: <root>/appgraph.config.{ts,mts,js,mjs} if present)" },
  out: { flags: "--out <dir>", description: `Output directory, where the graph cache lives too (default: ${DEFAULT_OUT_DIR})` },
  source: { flags: "--source <name>", description: "Force one screen source, bypassing detection" },
  allSources: { flags: "--all-sources", description: "Run every detected screen source; screens namespaced by source" },
  depth: { flags: "--depth <n>", description: "Render tree depth (default: 3)", parser: "count" },
  format: {
    flags: "--format <format>",
    description: `Output format, repeatable: ${FORMATS.join(" | ")} (default: ${DEFAULT_FORMATS.join(" + ")}; the graph cache is always written)`,
    parser: "format",
  },
  screen: { flags: "--screen <id>", description: "Restrict output to one screen; requires --format detail, and is rejected with any other format" },
  locale: { flags: "--locale <locale>", description: `HTML report locale: ${LOCALES.join(" | ")}`, choices: LOCALES },
  timestamp: { flags: "--no-timestamp", description: "Omit the HTML generation timestamp" },
  allowEmpty: { flags: "--allow-empty", description: "On zero screens still exit non-zero, but write a marked screens: [] artifact" },
  ifStale: { flags: "--if-stale", description: "Skip the run when the fingerprint matches the previous run" },
  strict: { flags: "--strict", description: "Non-zero exit on any warning diagnostic" },
  cached: { flags: "--cached", description: "Answer from the existing graph cache only; never analyse (exit 6 when it is missing or stale)" },
  limit: { flags: "--limit <n>", description: "Maximum number of items to print", parser: "positive", defaultValue: DEFAULT_LIMIT },
  offset: { flags: "--offset <n>", description: "Number of items to skip before the first one printed", parser: "count", defaultValue: 0 },
  fields: { flags: "--fields <list>", description: "Comma-separated item fields to keep (see appgraph schema <command>)", parser: "list" },
  quiet: { flags: "--quiet", description: "Print errors only" },
  json: { flags: "--json", description: "Emit one machine-readable object on stdout; all prose goes to stderr" },
  timing: { flags: "--timing", description: "Print per-phase durations (ms) to stderr; analyze and doctor also add a 'timing' object to --json output" },
} as const satisfies Readonly<Record<string, OptionSpec>>

export type SharedOptionId = keyof typeof SHARED_OPTIONS

export const OPTION_GROUPS = {
  project: ["root", "config", "out"],
  graph: ["source", "allSources", "depth"],
  emit: ["format", "screen", "locale", "timestamp"],
  run: ["allowEmpty", "ifStale", "strict"],
  query: ["cached", "limit", "offset", "fields"],
  output: ["quiet", "json", "timing"],
} as const satisfies Readonly<Record<string, readonly SharedOptionId[]>>

export type OptionGroupId = keyof typeof OPTION_GROUPS

export type CommandKind = "analyze" | "doctor" | "query"

export const ENVELOPE_KINDS = ["summary", "list", "item", "list-or-item", "document"] as const

export type EnvelopeKind = (typeof ENVELOPE_KINDS)[number]

export type CommandSpec = {
  readonly name: string
  readonly kind: CommandKind
  readonly isDefault?: boolean
  readonly summary: string
  readonly description: string
  readonly args: readonly ArgSpec[]
  readonly groups: readonly OptionGroupId[]
  readonly shared: readonly SharedOptionId[]
  readonly options: readonly OptionSpec[]
  readonly examples: readonly string[]
  readonly output: string
  readonly envelope: EnvelopeKind
  readonly fields: readonly FieldSpec[]
  readonly extra?: readonly FieldSpec[]
  readonly exitCodes: readonly ExitCode[]
  readonly load?: () => Promise<unknown>
}

const QUERY_GROUPS = ["project", "graph", "query", "output"] as const satisfies readonly OptionGroupId[]

const QUERY_EXIT_CODES = [
  EXIT_OK,
  EXIT_DIAGNOSTIC_ERROR,
  EXIT_USAGE,
  EXIT_NO_SCREENS,
  EXIT_FAILURE,
  EXIT_CACHE_UNAVAILABLE,
] as const satisfies readonly ExitCode[]

const STATIC_EXIT_CODES = [EXIT_OK, EXIT_USAGE] as const satisfies readonly ExitCode[]

export const field = (name: string, type: FieldSpec["type"], description: string, traits: FieldTraits = {}): FieldSpec => ({
  name,
  type,
  description,
  ...traits,
})

const NULLABLE = { nullable: true } as const satisfies FieldTraits

const OPTIONAL = { optional: true } as const satisfies FieldTraits

const MAYBE = { optional: true, nullable: true } as const satisfies FieldTraits

export const DIAGNOSTIC_FIELDS = [
  field("severity", "string", "Diagnostic severity", { choices: SEVERITIES }),
  field("code", "string", "Stable diagnostic code"),
  field("message", "string", "What happened"),
  field("plugin", "string", "Plugin that raised it", NULLABLE),
  field("file", "string", "Project-relative file", OPTIONAL),
  field("line", "integer", "Line in the file", OPTIONAL),
  field("screenId", "string", "Screen the diagnostic is about", OPTIONAL),
] as const

const COUNTS_FIELD = field("counts", "object", "Entity counts of the graph")

const DIAGNOSTICS_FIELD = field("diagnostics", "object[]", "Diagnostics of the run", { fields: DIAGNOSTIC_FIELDS })

const TIMING_FIELD = field("timing", "object", "Per-phase durations in ms; present with --timing", OPTIONAL)

const SCREEN_ROW_FIELDS = [
  field("id", "string", "Stable screen id; pass it to appgraph screen <id>"),
  field("url", "string", "Route URL pattern; null for an unaddressable screen", NULLABLE),
  field("title", "string", "Static title, when one was found", NULLABLE),
  field("primaryLabel", "string", "The label the report lists the screen under"),
  field("source", "string", "Screen source that produced the screen"),
  field("kindTag", "string", "Screen kind tag", NULLABLE),
  field("auth", "string", "Auth state", { choices: AUTH_STATES, term: "auth" }),
  field("featureFlag", "string", "Feature flag gating the screen", NULLABLE),
  field("devOnly", "boolean", "Only reachable in development builds"),
  field("addressable", "boolean", "Has a URL a user can navigate to"),
  field("redirectTo", "string", "Redirect target URL for a redirect screen", NULLABLE),
  field("shell", "string", "Id of the shell (layout chain) the screen renders inside", { nullable: true, term: "shell" }),
  field("isApi", "boolean", "An API route rather than a page; listed after the pages", { term: "apiRoutes" }),
  field("badges", "string[]", "Badges the report shows next to the screen, as id or id:value"),
] as const

type ScreenSectionId = (typeof SCREEN_SECTIONS)[number]

const SECTION_SHAPES = {
  activations: { type: "object[]", description: "How the screen is reached: route, state or event activations", term: "activation" },
  entries: { type: "object[]", description: "Entry files and wrappers the screen starts from" },
  ancestors: { type: "object[]", description: "Layouts, guards and providers above the screen", term: "ancestors" },
  tree: { type: "object[]", description: "Render tree, cut at --tree-depth", term: "renderTree" },
  navigation: { type: "object[]", description: "Outgoing navigation chips: to, matchedRoute, trigger, dynamic, sources" },
  shell: { type: "object", description: "Shell section", term: "shell" },
  endpoints: { type: "object", description: "Endpoints keyed by transport", term: "endpoints" },
  stores: { type: "string[]", description: "Stores the screen reads", term: "stores" },
  "query-keys": { type: "array", description: "Query keys; long keys are truncated objects", term: "queryKeys" },
  mutations: { type: "integer", description: "Number of mutations the screen triggers" },
  i18n: { type: "string[]", description: "i18n namespaces", term: "i18n" },
  "feature-gates": { type: "string[]", description: "Feature gates checked inside the screen", term: "featureGates" },
  forms: { type: "object", description: "Form schemas and fields", term: "formSchemas" },
  "test-ids": { type: "string[]", description: "Test ids", term: "testIds" },
  messages: { type: "string[]", description: "User-facing messages", term: "messages" },
  extra: { type: "object", description: "Plugin fact channels, keyed by channel" },
  params: { type: "string[]", description: "Route params" },
  reachable: { type: "string[]", description: "Component files reachable from the screen", term: "reach" },
} as const satisfies Readonly<Record<ScreenSectionId, Omit<FieldSpec, "name">>>

const SCREEN_SHELL_FIELD = field(
  "shell",
  ["string", "object"],
  "Shell id, or the shell section object when the shell section is selected",
  { nullable: true, term: "shell" },
)

const sectionField = (section: ScreenSectionId): FieldSpec => ({
  name: section,
  ...SECTION_SHAPES[section],
  description: `${SECTION_SHAPES[section].description}; omitted when empty`,
  optional: true,
})

const SCREEN_DETAIL_FIELDS = [
  ...SCREEN_ROW_FIELDS.map((row) => (row.name === "shell" ? SCREEN_SHELL_FIELD : row)),
  field("redirectTarget", "string", "Id of the screen a redirect lands on", NULLABLE),
  field("htmlLink", "string", "Deep link into appgraph.html (relative to --out) that opens this screen"),
  ...SCREEN_SECTIONS.filter((section) => section !== "shell").map(sectionField),
]

const STAT_FIELDS = [
  field("appName", "string", "Analysed app name"),
  field("appgraphVersion", "string", "Version of appgraph that built the graph"),
  field("screens", "integer", "Screens, API routes excluded", { term: "screens" }),
  field("components", "integer", "Components", { term: "components" }),
  field("endpoints", "integer", "Distinct endpoints", { term: "endpoints" }),
  field("deadLinks", "integer", "Dead navigation links", { term: "deadLinks" }),
  field("apiRoutes", "integer", "API routes", { term: "apiRoutes" }),
  field("redirects", "integer", "Redirects", { term: "redirects" }),
  field("renderEdges", "integer", "Render edges", { term: "renderEdges" }),
  field("navEdges", "integer", "Navigation edges", { term: "navEdges" }),
  field("maxDepth", "integer", "Render tree depth the graph was built with", { term: "depth" }),
  field("errors", "integer", "Error diagnostics"),
  field("warnings", "integer", "Warning diagnostics"),
  field("infos", "integer", "Info diagnostics"),
  field("emptyResult", "boolean", "True when no screens were found"),
  field("emptyReason", "string", "Why no screens were found", NULLABLE),
] as const

export const COMMAND_SPECS = [
  {
    name: "analyze",
    kind: "analyze",
    isDefault: true,
    summary: "Analyse the project and write the artifacts (default command)",
    description:
      "Detect the screen sources, walk every screen's component tree and write the requested artifacts plus the graph cache (appgraph.graph.json) to --out.",
    args: [],
    groups: ["project", "graph", "emit", "run", "output"],
    shared: [],
    options: [],
    examples: [
      "appgraph",
      "appgraph --root ./frontend --out docs/appgraph --format index --format html",
      "appgraph --format detail --screen /invoices/:id",
      "appgraph --if-stale --quiet",
      "appgraph --json > appgraph-run.json",
    ],
    output:
      "A summary, the diagnostics and the written files. With --json: one object with the counts, the written files, the diagnostics and the exit code.",
    envelope: "summary",
    fields: [
      field("command", "string", "Always analyze", { choices: ["analyze"] }),
      field("appgraphVersion", "string", "Version of appgraph that ran"),
      field("root", "string", "Absolute project root"),
      field("out", "string", "Output directory, relative to the root"),
      field("formats", "string[]", "Formats written, including graph"),
      field("skipped", "boolean", "True when --if-stale found nothing to do"),
      field("fingerprint", "string", "Run fingerprint"),
      field("emptyResult", "boolean", "True when no screens were found"),
      field("refused", "boolean", "True when appgraph refused to choose between live screen sources"),
      COUNTS_FIELD,
      field("wrote", "object[]", "Written files", {
        fields: [field("path", "string", "Path relative to --out"), field("bytes", "integer", "Size in bytes")],
      }),
      DIAGNOSTICS_FIELD,
      field("exitCode", "integer", "The process exit code"),
      field("trace", "string", "Analysis trace; present when the analysis produced one", OPTIONAL),
      TIMING_FIELD,
    ],
    exitCodes: [EXIT_OK, EXIT_DIAGNOSTIC_ERROR, EXIT_USAGE, EXIT_NO_SCREENS, EXIT_STRICT_WARNING, EXIT_FAILURE],
  },
  {
    name: "doctor",
    kind: "doctor",
    summary: "Print the full detection trace and write nothing",
    description:
      "Explain every guess: root and config resolution, the tsconfig chain, per-source detection scores with evidence, globs, exclusions, counts, confidence and the staleness fingerprint. Writes nothing.",
    args: [],
    groups: ["project", "graph"],
    shared: ["json", "timing"],
    options: [],
    examples: ["appgraph doctor", "appgraph doctor --root ./frontend --json"],
    output: "The detection report as text sections. With --json: the same report as one object. Always exits 0 once the flags parsed.",
    envelope: "summary",
    fields: [
      field("command", "string", "Always doctor", { choices: ["doctor"] }),
      field("appgraphVersion", "string", "Version of appgraph that ran"),
      field("root", "string", "Absolute project root"),
      field("rootReason", "string", "Why this root was chosen"),
      field("cwd", "string", "Working directory appgraph ran in"),
      field("configFile", "string", "Absolute config file path", NULLABLE),
      field("sourceRoots", "string[]", "Source roots the analysis walked"),
      field("tsconfig", "object", "Resolved tsconfig chain: files, baseUrl, paths, include, moduleResolution, jsx", NULLABLE),
      field("templateCompilers", "object[]", "Template compilers and whether they are installed"),
      field("screenSources", "string[]", "Screen sources that produced screens"),
      field("sourcesRun", "string[]", "Every screen source that ran"),
      COUNTS_FIELD,
      field("confidence", "object[]", "Per-section confidence", { term: "confidence" }),
      field("navGroups", "object[]", "Detected navigation groups"),
      field("detections", "object[]", "Per-source detection scores with evidence"),
      field("globs", "object[]", "Glob attempts"),
      field("nearMisses", "object[]", "Files that almost matched a screen source"),
      field("exclusions", "object[]", "Excluded files and why"),
      field("nestedPackages", "object[]", "Nested packages under the root"),
      field("testIdAttributes", "object[]", "Test id attributes and how often each was seen"),
      field("limitations", "string[]", "Known limitations of the analysis"),
      field("diagnostics", "object[]", "Diagnostics of the analysis", { fields: DIAGNOSTIC_FIELDS }),
      field("trace", "string", "Analysis trace"),
      field("fingerprint", "string", "Graph fingerprint", NULLABLE),
      field("fingerprintParts", "string[]", "Inputs the fingerprint hashes"),
      field("failure", "string", "Why the analysis failed", NULLABLE),
      field("notes", "string[]", "Notes on reading the report"),
      field("exitCode", "integer", "Always 0"),
      TIMING_FIELD,
    ],
    exitCodes: [EXIT_OK, EXIT_USAGE, EXIT_FAILURE],
  },
  {
    name: "screens",
    kind: "query",
    summary: "List screens, filtered and searched like the report's screen list",
    description: "List the screens in report order (pages first, API routes last) with their labels and badges.",
    args: [],
    groups: QUERY_GROUPS,
    shared: [],
    options: [
      {
        flags: "--search <query>",
        description:
          "Keep screens whose search text (url, title, id, flag, route name, route activations, entries) contains the query (case-insensitive substring)",
      },
      { flags: "--auth <state>", description: "Keep screens with this auth state", choices: AUTH_STATES },
      { flags: "--api", description: "Keep only API routes" },
      { flags: "--no-api", description: "Drop API routes" },
      { flags: "--flag [name]", description: "Keep screens gated by a feature flag, or by this flag" },
      { flags: "--kind <kind>", description: "Keep screens with this kind tag" },
      { flags: "--from <source>", description: "Keep screens produced by this screen source" },
    ],
    examples: ["appgraph screens", "appgraph screens --search invoice --auth protected", "appgraph screens --no-api --json --fields id,url"],
    output: "One aligned row per screen and a footer with the next page. With --json: { total, offset, limit, truncated, items }.",
    envelope: "list",
    fields: SCREEN_ROW_FIELDS,
    exitCodes: QUERY_EXIT_CODES,
    load: () => import("./query/screens.js"),
  },
  {
    name: "screen",
    kind: "query",
    summary: "Show one screen's detail: tree, navigation, endpoints, stores and more",
    description: "Resolve a screen by id, then by url, then by route match, and print its detail document. Empty sections are omitted.",
    args: [{ key: "target", display: "id|url", required: true, description: "Screen id, url or a concrete path the route matches" }],
    groups: QUERY_GROUPS,
    shared: [],
    options: [
      { flags: "--sections <list>", description: `Comma-separated sections to print: ${SCREEN_SECTIONS.join(", ")}`, parser: "list" },
      { flags: "--tree-depth <n>", description: "Cut the printed render tree at this depth", parser: "count" },
    ],
    examples: ["appgraph screen /invoices/:id", "appgraph screen /invoices/42 --sections endpoints,navigation", "appgraph screen app:/settings --json"],
    output: "The screen's detail as YAML-like text. With --json: { item } holding the screen row, redirect target, HTML deep link and the non-empty sections.",
    envelope: "item",
    fields: SCREEN_DETAIL_FIELDS,
    exitCodes: QUERY_EXIT_CODES,
    load: () => import("./query/screen.js"),
  },
  {
    name: "links",
    kind: "query",
    summary: "List a screen's navigation neighbours, as on the report's map",
    description: "List the collapsed navigation edges into and out of one screen, with weights and in/out degree. Null-url and API screens are excluded, as on the map.",
    args: [{ key: "target", display: "id|url", required: true, description: "Screen id or url" }],
    groups: QUERY_GROUPS,
    shared: [],
    options: [
      { flags: "--incoming", description: "Only edges into the screen" },
      { flags: "--outgoing", description: "Only edges out of the screen" },
    ],
    examples: ["appgraph links /invoices", "appgraph links /invoices --incoming --json"],
    output:
      "A summary line and one row per neighbour with direction, weight, dynamic marker and triggers. With --json: { item: { id, url, degree, inDegree, outDegree, excluded }, total, offset, limit, truncated, items }.",
    envelope: "list",
    fields: [
      field("direction", "string", "Edge direction relative to the screen", { choices: LINK_DIRECTIONS }),
      field("id", "string", "Neighbour screen id"),
      field("url", "string", "Neighbour url"),
      field("weight", "integer", "Number of navigation edges collapsed into this link", { term: "navEdges" }),
      field("dynamic", "boolean", "At least one edge has a computed target"),
      field("triggers", "string[]", "Distinct triggers of the collapsed edges"),
    ],
    extra: [
      field("item", "object", "The screen the links belong to", {
        fields: [
          field("id", "string", "Screen id"),
          field("url", "string", "Screen url", NULLABLE),
          field("degree", "integer", "Number of map edges touching the screen"),
          field("inDegree", "integer", "Neighbours linking in"),
          field("outDegree", "integer", "Neighbours linked to"),
          field("excluded", "string", "Why the screen is not on the map", { nullable: true, choices: LINK_EXCLUSIONS }),
        ],
      }),
    ],
    exitCodes: QUERY_EXIT_CODES,
    load: () => import("./query/links.js"),
  },
  {
    name: "search",
    kind: "query",
    summary: "Search screens, components and menu entries at once",
    description:
      "The report's command palette: every word of the query must match. Results are grouped screens, components, menu; --limit and --offset apply per group.",
    args: [{ key: "query", display: "query", required: true, description: "Words to match" }],
    groups: QUERY_GROUPS,
    shared: [],
    options: [],
    examples: ["appgraph search invoice", "appgraph search 'user settings' --json"],
    output:
      "One row per hit with its kind and label, plus a '… N more' line per truncated group. With --json: { query, groups[{kind,total,shown,truncated}], total, offset, limit, truncated, items }; --limit/--offset apply per group.",
    envelope: "list",
    fields: [
      field("kind", "string", "Hit kind", { choices: SEARCH_KINDS }),
      field("id", "string", "Screen id, component file or menu path"),
      field("label", "string", "What the report shows for the hit"),
      field("detail", "string", "Secondary text: screen title, component route or file, menu group", NULLABLE),
    ],
    extra: [
      field("query", "string", "The query as given"),
      field("groups", "object[]", "Per-kind totals, in result order", {
        fields: [
          field("kind", "string", "Hit kind", { choices: SEARCH_KINDS }),
          field("total", "integer", "Hits of this kind"),
          field("shown", "integer", "Hits of this kind in items"),
          field("truncated", "boolean", "More hits of this kind exist past this page"),
        ],
      }),
    ],
    exitCodes: QUERY_EXIT_CODES,
    load: () => import("./query/search.js"),
  },
  {
    name: "components",
    kind: "query",
    summary: "List components with their route, renders, endpoints and stores",
    description: "The report's components table: every analysed component file, sorted by render count by default.",
    args: [],
    groups: QUERY_GROUPS,
    shared: [],
    options: [
      { flags: "--kind <kind>", description: "Keep components of this kind" },
      { flags: "--sort <key>", description: `Sort order: ${COMPONENT_SORTS.join(" | ")}`, choices: COMPONENT_SORTS, defaultValue: "renders" },
      { flags: "--search <query>", description: "Keep components whose file, name, kind or route matches every word" },
    ],
    examples: ["appgraph components", "appgraph components --sort file --limit 20", "appgraph components --search Invoice --json"],
    output: "One aligned row per component. With --json: { total, offset, limit, truncated, items }.",
    envelope: "list",
    fields: [
      field("file", "string", "Project-relative file"),
      field("component", "string", "Component name"),
      field("kind", "string", "Component kind", { term: "kind" }),
      field("route", "string", "Route the component most likely belongs to", NULLABLE),
      field("renders", "integer", "Number of components it renders", { term: "renderEdges" }),
      field("endpoints", "integer", "Number of endpoints it calls", { term: "endpoints" }),
      field("mutations", "integer", "Number of mutations it triggers"),
      field("stores", "string[]", "Stores it reads", { term: "stores" }),
    ],
    exitCodes: QUERY_EXIT_CODES,
    load: () => import("./query/components.js"),
  },
  {
    name: "menu",
    kind: "query",
    summary: "List navigation menu entries and whether the router knows their path",
    description: "The report's menu table: every entry of every detected navigation group.",
    args: [],
    groups: QUERY_GROUPS,
    shared: [],
    options: [
      { flags: "--group <name>", description: "Keep entries of this navigation group" },
      { flags: "--missing", description: "Keep only entries whose path no screen matches" },
      { flags: "--search <query>", description: "Keep entries whose label, key or path matches every word" },
    ],
    examples: ["appgraph menu", "appgraph menu --missing", "appgraph menu --group sidebar --json"],
    output: "One aligned row per entry. With --json: { total, offset, limit, truncated, items }.",
    envelope: "list",
    fields: [
      field("group", "string", "Navigation group name"),
      field("label", "string", "Entry label", NULLABLE),
      field("labelKey", "string", "i18n key of the label", NULLABLE),
      field("path", "string", "Target path"),
      field("featureFlag", "string", "Feature flag gating the entry", NULLABLE),
      field("parentPath", "string", "Path of the parent entry", NULLABLE),
      field("linkedScreen", "string", "Id of the screen the path resolves to", NULLABLE),
      field("missing", "boolean", "No screen matches the path"),
      field("source", "string", "Navigation source that found the entry"),
      field("file", "string", "Project-relative file declaring the entry"),
      field("line", "integer", "Line in the file"),
    ],
    exitCodes: QUERY_EXIT_CODES,
    load: () => import("./query/menu.js"),
  },
  {
    name: "findings",
    kind: "query",
    summary: "List limitations, dead links, orphan screens, confidence and diagnostics",
    description: "The report's findings tab, section by section in report order. --severity and --code imply the diagnostics section.",
    args: [],
    groups: QUERY_GROUPS,
    shared: [],
    options: [
      { flags: "--section <name>", description: `Only this section: ${FINDING_SECTIONS.join(" | ")}`, choices: FINDING_SECTIONS },
      { flags: "--severity <level>", description: `Only diagnostics of this severity: ${SEVERITIES.join(" | ")}; implies the diagnostics section`, choices: SEVERITIES },
      { flags: "--code <code>", description: "Only diagnostics with this code; implies the diagnostics section" },
    ],
    examples: ["appgraph findings", "appgraph findings --section dead-links", "appgraph findings --section diagnostics --severity error --json"],
    output:
      "Each section with its count and rows. With --json: { sections, severityCounts, total, offset, limit, truncated, items } where every item carries its section; --severity/--code imply the diagnostics section.",
    envelope: "list",
    fields: [
      field("section", "string", "Section the row belongs to", { choices: FINDING_SECTIONS }),
      field("severity", "string", "Diagnostic severity", { optional: true, choices: SEVERITIES }),
      field("code", "string", "Diagnostic code", OPTIONAL),
      field("message", "string", "Limitation or diagnostic text", OPTIONAL),
      field("plugin", "string", "Plugin that raised the diagnostic", MAYBE),
      field("screenId", "string", "Screen the diagnostic is about", MAYBE),
      field("path", "string", "Dead link path", OPTIONAL),
      field("label", "string", "Dead link or orphan label", MAYBE),
      field("source", "string", "Navigation source of a dead link", OPTIONAL),
      field("id", "string", "Orphan screen id, or confidence area", OPTIONAL),
      field("count", "integer", "Facts found in the confidence area", OPTIONAL),
      field("enablingDependency", "string", "Dependency the confidence area relies on", MAYBE),
      field("dependencyInstalled", "boolean", "The enabling dependency is installed", OPTIONAL),
      field("level", "string", "Confidence level", { optional: true, choices: CONFIDENCE_LEVELS, term: "confidence" }),
      field("status", "string", "Confidence status", { optional: true, choices: CONFIDENCE_STATUSES }),
      field("file", "string", "Project-relative file", MAYBE),
      field("line", "integer", "Line in the file", MAYBE),
    ],
    extra: [
      field("sections", "object", "Row count per selected section, before paging", {
        fields: FINDING_SECTIONS.map((section) => field(section, "integer", `Rows in ${section}`, OPTIONAL)),
      }),
      field("severityCounts", "object", "Diagnostics per severity across the whole graph, unfiltered", {
        fields: [
          field("all", "integer", "All diagnostics"),
          ...SEVERITIES.map((severity) => field(severity, "integer", `${severity} diagnostics`)),
        ],
      }),
    ],
    exitCodes: QUERY_EXIT_CODES,
    load: () => import("./query/findings.js"),
  },
  {
    name: "stats",
    kind: "query",
    summary: "Print the report header counts and the cache state",
    description: "Screens, components, endpoints, dead links and the secondary counts, plus app name, versions and the empty-result reason.",
    args: [],
    groups: QUERY_GROUPS,
    shared: [],
    options: [],
    examples: ["appgraph stats", "appgraph stats --cached --json"],
    output:
      "key: value lines ending with a 'cache: <status> <path>' line; apiRoutes is hidden when 0. With --json: { item } with every count, apiRoutes included.",
    envelope: "item",
    fields: STAT_FIELDS,
    exitCodes: QUERY_EXIT_CODES,
    load: () => import("./query/stats.js"),
  },
  {
    name: "usages",
    kind: "query",
    summary: "Find the screens that use a component, endpoint, test id, store, query key or i18n namespace",
    description: `Reverse lookup the report has no tab for: the screens and components that use the term. Type detection: --type wins; else the first type in ${USAGE_TYPES.join(", ")} order whose index holds the term exactly (a component name aliases to its files, a bare url to every "METHOD url" key); else by shape: a source-file extension means component, a leading HTTP method, "/" or http(s):// means endpoint, anything else matches nothing.`,
    args: [{ key: "term", display: "term", required: true, description: "Component file or name, endpoint, test id, store, query key or i18n namespace" }],
    groups: QUERY_GROUPS,
    shared: [],
    options: [{ flags: "--type <type>", description: `Term type: ${USAGE_TYPES.join(" | ")}`, choices: USAGE_TYPES }],
    examples: ["appgraph usages src/components/InvoiceTable.tsx", "appgraph usages 'GET /api/invoices' --type endpoint --json"],
    output:
      "One row per screen or component using the term. With --json: { item: { term, type, detected, matched, suggestions }, total, offset, limit, truncated, items }.",
    envelope: "list",
    fields: [
      field("kind", "string", "What uses the term", { choices: USAGE_KINDS }),
      field("id", "string", "Screen id or component file"),
      field("url", "string", "Screen url, or the route a component belongs to", NULLABLE),
      field("type", "string", "Term type", { choices: USAGE_TYPES }),
      field("via", "string", "Where the use was found", { choices: USAGE_VIAS }),
      field("match", "string", "The index key that matched the term"),
    ],
    extra: [
      field("item", "object", "How the term was resolved", {
        fields: [
          field("term", "string", "The term as given"),
          field("type", "string", "Resolved term type; null when nothing matched by index or shape", {
            nullable: true,
            choices: USAGE_TYPES,
          }),
          field("detected", "boolean", "The type was detected rather than forced with --type"),
          field("matched", "string[]", "Index keys the term resolved to"),
          field("suggestions", "string[]", "Nearest keys when nothing matched"),
        ],
      }),
    ],
    exitCodes: QUERY_EXIT_CODES,
    load: () => import("./query/usages.js"),
  },
  {
    name: "glossary",
    kind: "query",
    summary: "Explain the report's terms",
    description: "Print the glossary the report shows in its info tips, or one term of it.",
    args: [{ key: "term", display: "term", required: false, description: "Term id or label to explain" }],
    groups: ["output"],
    shared: ["limit", "offset", "fields"],
    options: [],
    examples: ["appgraph glossary", "appgraph glossary shell"],
    output:
      "Aligned id/term/description rows; with a term, that term's id, term and description. With --json: { total, offset, limit, truncated, items }, or { item } with a term.",
    envelope: "list-or-item",
    fields: [
      field("id", "string", "Term id; pass it to appgraph glossary <term>"),
      field("term", "string", "Term as the report labels it"),
      field("description", "string", "What the term means"),
    ],
    exitCodes: STATIC_EXIT_CODES,
    load: () => import("./query/glossary.js"),
  },
  {
    name: "schema",
    kind: "query",
    summary: "Print the JSON Schema of a command's --json output",
    description:
      "Machine-readable output contracts, generated from this registry. Without a command: one document whose $defs holds every command's schema keyed by command name, plus error. Pass error for the --json error object every command prints on failure.",
    args: [{ key: "command", display: "command", required: false, description: "Command whose schema to print, or error; all when omitted" }],
    groups: ["output"],
    shared: [],
    options: [],
    examples: ["appgraph schema", "appgraph schema screens", "appgraph schema error"],
    output: "A JSON Schema (2020-12 subset) document.",
    envelope: "document",
    fields: [],
    exitCodes: STATIC_EXIT_CODES,
    load: () => import("./query/schema.js"),
  },
] as const satisfies readonly CommandSpec[]

export type CommandName = (typeof COMMAND_SPECS)[number]["name"]

export type QueryCommandName = Extract<(typeof COMMAND_SPECS)[number], { readonly kind: "query" }>["name"]

export type RegisteredCommand = CommandSpec & { readonly name: CommandName }

export const REGISTERED_COMMANDS: readonly RegisteredCommand[] = COMMAND_SPECS

export const COMMAND_NAMES: readonly CommandName[] = REGISTERED_COMMANDS.map((spec) => spec.name)

export const isCommandName = (value: string): value is CommandName => COMMAND_NAMES.some((name) => name === value)

export const commandSpec = (name: CommandName): RegisteredCommand =>
  REGISTERED_COMMANDS.find((spec) => spec.name === name) ?? COMMAND_SPECS[0]

export const isQueryCommandName = (name: CommandName): name is QueryCommandName => commandSpec(name).kind === "query"

export const sharedOptionIds = (spec: CommandSpec): readonly SharedOptionId[] => [
  ...spec.groups.flatMap((group) => OPTION_GROUPS[group]),
  ...spec.shared,
]

export type OptionValue = string | number | boolean | readonly string[]

export type QueryOptions = {
  readonly cached: boolean
  readonly limit: number
  readonly offset: number
  readonly fields: readonly string[] | null
}

export type QueryContext = {
  readonly command: QueryCommandName
  readonly spec: CommandSpec
  readonly args: Readonly<Record<string, string>>
  readonly options: CliOptions
  readonly query: QueryOptions
  readonly own: Readonly<Record<string, OptionValue | undefined>>
  readonly writer: Writer
  readonly deps: CliDeps
  readonly cwd: string
  readonly version: string
  readonly clock: () => number
}

export type QueryRun = (context: QueryContext) => Promise<number>

export type QueryModule = {
  readonly default: QueryRun
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null

export const isQueryModule = (value: unknown): value is QueryModule =>
  isRecord(value) && typeof value["default"] === "function"
