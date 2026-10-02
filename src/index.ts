/**
 * The whole public surface of appgraph 0.1 (§5.0): `analyze`, `defineConfig`, and the types that
 * describe the artifact on disk. There is NO public plugin contract — no `apiVersion`, no stability
 * promise, no `./plugins/*` export map. Nothing from `core/` or `pipeline/` is exported.
 */
export { publicAnalyze as analyze } from "./pipeline/run.js"
export type { AnalyzeOptions, AnalyzeResult } from "./pipeline/run.js"

export { defineConfig } from "./config/define.js"

export { BUILTIN_KINDS } from "./core/model.js"

export type {
  Activation,
  AncestorRef,
  AppGraph,
  AppGraphMeta,
  AppgraphConfig,
  AuthState,
  Diagnostic,
  Endpoint,
  EntryRef,
  Evidence,
  FactChannel,
  FileFacts,
  GraphRedirect,
  NavEntry,
  NavGroup,
  Navigation,
  NavigationEdge,
  NodeKind,
  NodeLocator,
  Provenance,
  RenderEdge,
  ResolvedNavigation,
  Screen,
  ScreenFacts,
  ScreenId,
  SectionConfidence,
  Severity,
  ShellReport,
  SlotBranch,
  SpliceMode,
  TreeNode,
} from "./core/model.js"
