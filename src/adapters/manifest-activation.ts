import type ts from "typescript"
import type { Activation, Evidence } from "../core/model.js"
import type { TypeScriptApi } from "../core/tsconfig.js"
import { sortedUnique, stableUnique } from "../core/order.js"
import type {
  Adapter,
  DetectResult,
  DiscoverContext,
  EntryRef,
  ProjectContext,
  ScreenDraft,
  ScreenSource,
} from "./types.js"
import { SCRIPT_EXTENSIONS } from "../core/extensions.js"

export const SOURCE_NAME = "manifest-activation"

export const MANIFEST_GLOB = "**/manifest.json"

/**
 * Same last-resort tier as `state-screens` (§10.1). A manifest scores the MV3 BONUS nowhere: on a bare
 * run `state-screens` is the one live source on an MV3 repo, and this source arrives with it because the
 * `browser-extension` preset selects both. Scoring the manifest 50 here would make every extension trip
 * the multi-source refusal against `state-screens`' 51 on the same file.
 */
export const DETECT_SCORE_LAST_RESORT = 1

export const MV3_VERSION = 3

const MODULE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"] as const

const HTML_SCRIPT_SRC = /<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/g

// ---------------------------------------------------------------------------
// Reading the manifest — `unknown` in, type guards all the way down
// ---------------------------------------------------------------------------

type JsonRecord = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const recordAt = (record: JsonRecord, key: string): JsonRecord | null => {
  const value = record[key]
  return isRecord(value) ? value : null
}

const stringAt = (record: JsonRecord, key: string): string | null => {
  const value = record[key]
  return typeof value === "string" && value !== "" ? value : null
}

const stringsAt = (record: JsonRecord, key: string): readonly string[] => {
  const value = record[key]
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

const recordsAt = (record: JsonRecord, key: string): readonly JsonRecord[] => {
  const value = record[key]
  return Array.isArray(value) ? value.filter(isRecord) : []
}

const parseJson = (text: string | null): unknown => {
  if (text === null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export type ContentScriptEntry = {
  readonly ordinal: number
  readonly js: readonly string[]
  readonly matches: readonly string[]
}

export type Mv3Manifest = {
  readonly file: string
  readonly text: string
  readonly popup: string | null
  readonly serviceWorker: string | null
  readonly contentScripts: readonly ContentScriptEntry[]
  /**
   * The offscreen document is a fourth MV3 surface, and the manifest declares it only obliquely: the
   * `"offscreen"` permission is what makes `chrome.offscreen.createDocument({ url })` legal, and the
   * URL it names is an extension page — usually listed under `web_accessible_resources`. So the
   * permission is the assertion that the surface EXISTS, and these are the HTML documents it could be.
   */
  readonly offscreenDocuments: readonly string[]
}

export const lineOfLiteral = (text: string, needle: string): number => {
  const index = text.indexOf(needle)
  return index === -1 ? 1 : text.slice(0, index).split("\n").length
}

/**
 * MV3-ness keys on the FIELD `manifest_version: 3`, never on the filename: a repo may carry a PWA
 * `manifest.json` (no `manifest_version` at all) beside a real extension manifest, and the two mean
 * nothing alike.
 */
export const OFFSCREEN_PERMISSION = "offscreen"

/** What `chrome.offscreen.createDocument` is called with in every MV3 app that has one. */
export const OFFSCREEN_DOCUMENT_CONVENTION = "offscreen.html"

const offscreenDocumentsOf = (parsed: JsonRecord, popup: string | null): readonly string[] => {
  const permissions = [...stringsAt(parsed, "permissions"), ...stringsAt(parsed, "optional_permissions")]
  if (!permissions.includes(OFFSCREEN_PERMISSION)) return []

  const declared = recordsAt(parsed, "web_accessible_resources")
    .flatMap((entry) => stringsAt(entry, "resources"))
    .filter((resource) => resource.endsWith(".html") && resource !== popup)

  return stableUnique([...declared, OFFSCREEN_DOCUMENT_CONVENTION])
}

export const readMv3Manifest = (ctx: ProjectContext, file: string): Mv3Manifest | null => {
  const text = ctx.readFile(file)
  const parsed = parseJson(text)
  if (text === null || !isRecord(parsed)) return null
  if (parsed["manifest_version"] !== MV3_VERSION) return null

  const action = recordAt(parsed, "action")
  const background = recordAt(parsed, "background")
  const popup = action === null ? null : stringAt(action, "default_popup")

  return {
    file,
    text,
    popup,
    serviceWorker: background === null ? null : stringAt(background, "service_worker"),
    contentScripts: recordsAt(parsed, "content_scripts").map((entry, ordinal) => ({
      ordinal,
      js: stringsAt(entry, "js"),
      matches: sortedUnique(stringsAt(entry, "matches")),
    })),
    offscreenDocuments: offscreenDocumentsOf(parsed, popup),
  }
}

export const hasSurface = (manifest: Mv3Manifest): boolean =>
  manifest.popup !== null ||
  manifest.serviceWorker !== null ||
  manifest.contentScripts.length > 0 ||
  manifest.offscreenDocuments.length > 0

/** Exclusion-applied (`ctx.glob`), so manifests under build output never reach a caller. */
export const findMv3Manifests = (ctx: ProjectContext): readonly Mv3Manifest[] =>
  ctx.glob(MANIFEST_GLOB).flatMap((file) => {
    const manifest = readMv3Manifest(ctx, file)
    return manifest === null || !hasSurface(manifest) ? [] : [manifest]
  })

export const bundlerEvidence = (entry: BundlerEntry): Evidence => ({
  what: `bundler input '${entry.name}'`,
  file: entry.config,
  line: entry.line,
})

export const mv3Evidence = (manifest: Mv3Manifest): Evidence => ({
  what: `"manifest_version": ${String(MV3_VERSION)}`,
  file: manifest.file,
  line: lineOfLiteral(manifest.text, "\"manifest_version\""),
})

// ---------------------------------------------------------------------------
// Manifest paths → project files
// ---------------------------------------------------------------------------

const dirOf = (file: string): string => {
  const slash = file.lastIndexOf("/")
  return slash === -1 ? "" : file.slice(0, slash)
}

const baseOf = (file: string): string => {
  const slash = file.lastIndexOf("/")
  return slash === -1 ? file : file.slice(slash + 1)
}

const joinPath = (dir: string, rest: string): string => (dir === "" ? rest : `${dir}/${rest}`)

const normalizePath = (value: string): string => {
  const segments: string[] = []
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === ".." && segments.length > 0) {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.join("/")
}

const stripExtension = (value: string): string => {
  const dot = value.lastIndexOf(".")
  const slash = value.lastIndexOf("/")
  return dot > slash ? value.slice(0, dot) : value
}

/** Every path a manifest/HTML reference could mean, in probe order. Root-relative and manifest-relative. */
const pathCandidates = (fromDir: string, reference: string): readonly string[] => {
  const cleaned = reference.split("?")[0]?.split("#")[0] ?? reference
  const bases = stableUnique([
    normalizePath(cleaned),
    normalizePath(joinPath(fromDir, cleaned)),
    normalizePath(joinPath(dirOf(fromDir), cleaned)),
  ])
  const stems = stableUnique(bases.flatMap((base) => [base, stripExtension(base)]))
  return stableUnique(stems.flatMap((stem) => MODULE_SUFFIXES.map((suffix) => `${stem}${suffix}`)))
}

// ---------------------------------------------------------------------------
// Built asset name → source entry, read off the bundler's own input map
// ---------------------------------------------------------------------------

export const BUNDLER_CONFIG_GLOB = "**/{vite,rollup}.config.{ts,mts,cts,js,mjs,cjs}"

/** One `rollupOptions.input` / `input` entry: the name the bundler emits under, and its source file. */
export type BundlerEntry = {
  readonly name: string
  readonly file: string
  readonly config: string
  readonly line: number
}

/** `null` marks a name two configs disagree about — never resolved, the same rule as an ambiguous glob. */
export type BundlerEntries = ReadonlyMap<string, BundlerEntry | null>

export const NO_BUNDLER_ENTRIES: BundlerEntries = new Map()

const inputObjectsIn = (api: TypeScriptApi, source: ts.SourceFile): readonly ts.ObjectLiteralExpression[] => {
  const found: ts.ObjectLiteralExpression[] = []

  const visit = (node: ts.Node): void => {
    if (
      api.isPropertyAssignment(node) &&
      (api.isIdentifier(node.name) || api.isStringLiteral(node.name)) &&
      node.name.text === "input" &&
      api.isObjectLiteralExpression(node.initializer)
    )
      found.push(node.initializer)
    api.forEachChild(node, visit)
  }

  visit(source)
  return found
}

/** `resolve(__dirname, 'src/x.ts')`, `join(dir, 'src/x.ts')` or a bare `'src/x.ts'` — the LAST literal wins. */
const referenceOf = (api: TypeScriptApi, node: ts.Expression): string | null => {
  if (api.isStringLiteral(node)) return node.text
  if (!api.isCallExpression(node)) return null

  const literals = node.arguments.filter((argument) => api.isStringLiteral(argument))
  const last = literals[literals.length - 1]
  return last === undefined || !api.isStringLiteral(last) ? null : last.text
}

/**
 * An MV3 manifest names BUILT assets (`assets/content.js`), and for an entry whose source file is not
 * `content.ts` — `src/content/index.tsx`, say — no path probe and no basename glob can find it. The
 * bundler config is where that mapping is DECLARED, so it is read rather than guessed: the emitted
 * name is the `input` key, and the entry is the file its value names.
 */
export const readBundlerEntries = (ctx: ProjectContext): BundlerEntries => {
  const api = ctx.ts
  const entries = new Map<string, BundlerEntry | null>()

  for (const config of ctx.glob(BUNDLER_CONFIG_GLOB)) {
    const text = ctx.readFile(config)
    if (text === null) continue

    const source = api.createSourceFile(config, text, api.ScriptTarget.Latest, true, api.ScriptKind.TS)

    for (const object of inputObjectsIn(api, source))
      for (const property of object.properties) {
        if (!api.isPropertyAssignment(property)) continue
        if (!api.isIdentifier(property.name) && !api.isStringLiteral(property.name)) continue

        const name = property.name.text
        const reference = referenceOf(api, property.initializer)
        if (reference === null) continue

        const file =
          pathCandidates(dirOf(config), reference).find(
            (candidate) => candidate !== "" && !candidate.endsWith(".html") && ctx.exists(candidate),
          ) ?? null
        if (file === null) continue

        const existing = entries.get(name)
        if (existing === undefined) {
          entries.set(name, { name, file, config, line: lineOfLiteral(text, reference) })
          continue
        }
        if (existing !== null && existing.file !== file) entries.set(name, null)
      }
  }

  return entries
}

export type ScriptResolution = {
  readonly file: string | null
  readonly probed: readonly string[]
  readonly ambiguous: readonly string[]
  /** Set when the built name was resolved through the bundler config, so the screen can cite it. */
  readonly entry: BundlerEntry | null
}

/**
 * A manifest names BUILT assets (`assets/content-run.js`), so the literal path usually does not exist
 * in source. Probe order is declared-then-guessed: the real path, then the bundler's own input map,
 * then the basename. The basename fallback is a guess and says so: two candidates resolve to nothing
 * rather than to the first one.
 */
const resolveScriptReference = (
  ctx: ProjectContext,
  fromDir: string,
  reference: string,
  entries: BundlerEntries,
): ScriptResolution => {
  const probed = pathCandidates(fromDir, reference)
  const direct =
    probed.find((candidate) => candidate !== "" && !candidate.endsWith(".html") && ctx.exists(candidate)) ?? null
  if (direct !== null) return { file: direct, probed, ambiguous: [], entry: null }

  const base = baseOf(stripExtension(reference))
  if (base === "") return { file: null, probed, ambiguous: [], entry: null }

  const entry = entries.get(base)
  if (entry !== undefined && entry !== null) return { file: entry.file, probed, ambiguous: [], entry }

  const matches = ctx.glob(`**/${base}.{${SCRIPT_EXTENSIONS.map((item) => item.slice(1)).join(",")}}`)
  if (matches.length === 1) return { file: matches[0] ?? null, probed, ambiguous: [], entry: null }
  return { file: null, probed, ambiguous: matches, entry: null }
}

export const resolveManifestScript = (
  ctx: ProjectContext,
  manifest: Mv3Manifest,
  reference: string,
  entries: BundlerEntries = NO_BUNDLER_ENTRIES,
): ScriptResolution => resolveScriptReference(ctx, dirOf(manifest.file), reference, entries)

export type DocumentChain = {
  readonly html: string | null
  readonly module: string | null
  /** Which link of HTML → script → module broke. `null` when the chain was followed. */
  readonly brokeAt: "reference" | "html" | "script" | null
  readonly entry: BundlerEntry | null
}

/**
 * `action.default_popup` (or an offscreen document's URL) → the HTML file → its `<script src>` → the
 * module the page runs. Every link is probed against real files; a broken link is reported, never
 * guessed past. The popup and the offscreen document are reached the SAME way, which is why one
 * function walks both.
 */
export const followDocumentChain = (
  ctx: ProjectContext,
  manifest: Mv3Manifest,
  reference: string | null,
  entries: BundlerEntries = NO_BUNDLER_ENTRIES,
): DocumentChain => {
  if (reference === null) return { html: null, module: null, brokeAt: "reference", entry: null }

  const html =
    pathCandidates(dirOf(manifest.file), reference).find(
      (candidate) => candidate.endsWith(".html") && ctx.exists(candidate),
    ) ?? null
  if (html === null) return { html: null, module: null, brokeAt: "html", entry: null }

  const text = ctx.readFile(html)
  if (text === null) return { html, module: null, brokeAt: "html", entry: null }

  const sources = [...text.matchAll(HTML_SCRIPT_SRC)].flatMap((match) => {
    const src = match[1]
    return src === undefined ? [] : [src]
  })

  for (const src of sources) {
    const resolution = resolveScriptReference(ctx, dirOf(html), src, entries)
    if (resolution.file !== null) return { html, module: resolution.file, brokeAt: null, entry: resolution.entry }
  }

  return { html, module: null, brokeAt: "script", entry: null }
}

export const followPopupChain = (
  ctx: ProjectContext,
  manifest: Mv3Manifest,
  entries: BundlerEntries = NO_BUNDLER_ENTRIES,
): DocumentChain => followDocumentChain(ctx, manifest, manifest.popup, entries)

// ---------------------------------------------------------------------------
// The MV3 loader stub: a content script that imports the real module at runtime
// ---------------------------------------------------------------------------

export const LOADER_URL_METHOD = "getURL"

const EXTENSION_GLOBALS: readonly string[] = ["chrome", "browser"]

export type LoaderTarget = {
  readonly asset: string
  readonly entry: BundlerEntry
  readonly line: number
}

/**
 * `unresolved` is the honest half: a stub WAS found and the module it loads was not, so the surface's
 * whole subtree is missing from the artifact. That must be said out loud — a half-visible surface
 * looks complete.
 */
export type LoaderProbe = {
  readonly target: LoaderTarget | null
  readonly unresolved: readonly string[]
}

/**
 * A classic content script is not an ES module, so an extension that wants one ships a two-line stub:
 * `import(chrome.runtime.getURL('assets/content.js'))`. The manifest names the STUB, so following the
 * manifest alone stops one hop short of the entire content-script UI — every component, hook and
 * message it handles. The runtime URL is a built asset name, which the bundler's input map turns back
 * into a source file; both halves are required, so a `getURL` for an icon is not mistaken for a loader.
 */
export const followLoaderStub = (
  ctx: DiscoverContext,
  file: string,
  entries: BundlerEntries,
): LoaderProbe => {
  const source = ctx.sourceFile(file)
  if (source === null) return { target: null, unresolved: [] }

  const api = ctx.ts
  let dynamicImport = false
  const assets: { readonly asset: string; readonly node: ts.Node }[] = []

  const visit = (node: ts.Node): void => {
    const call = ctx.ast.asCallExpression(node)
    if (call !== null && call === node) {
      if (call.expression.kind === api.SyntaxKind.ImportKeyword) dynamicImport = true

      const callee = ctx.ast.asPropertyAccess(call.expression)
      const owner = callee === null ? null : ctx.ast.asPropertyAccess(callee.expression)
      const literal = ctx.ast.asStringLiteralLike(call.arguments[0])

      if (
        callee !== null &&
        owner !== null &&
        callee.name.text === LOADER_URL_METHOD &&
        EXTENSION_GLOBALS.includes(ctx.ast.asIdentifier(owner.expression)?.text ?? "") &&
        literal !== null
      )
        assets.push({ asset: literal.text, node: call })
    }
    api.forEachChild(node, visit)
  }

  visit(source)
  if (!dynamicImport) return { target: null, unresolved: [] }

  const unresolved: string[] = []

  for (const { asset, node } of assets) {
    const entry = entries.get(baseOf(stripExtension(asset)))
    if (entry !== undefined && entry !== null && entry.file !== file)
      return { target: { asset, entry, line: ctx.lineOf(file, node) }, unresolved: [] }
    if (entry === undefined || entry === null) unresolved.push(asset)
  }

  return { target: null, unresolved: stableUnique(unresolved) }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export const detectManifestActivation = (ctx: ProjectContext): DetectResult => {
  const manifests = findMv3Manifests(ctx)
  if (manifests.length === 0) return { score: 0, evidence: [] }
  return { score: DETECT_SCORE_LAST_RESORT, evidence: manifests.map(mv3Evidence) }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

type Surface = {
  readonly kindTag: string
  readonly reference: string
  readonly what: string
  /** The manifest literal whose line this surface's evidence points at. */
  readonly needle: string
  readonly activations: readonly Activation[]
  /** True for a surface reached as an HTML page → `<script src>` → module, like the popup. */
  readonly document: boolean
}

/**
 * Appended AFTER the content scripts on purpose: a surface's `localId` is its identity, and it is the
 * manifest's ordinal, so a newly modelled surface must never renumber the ones already emitted.
 */
const offscreenSurfacesOf = (ctx: ProjectContext, manifest: Mv3Manifest): readonly Surface[] => {
  if (manifest.offscreenDocuments.length === 0) return []

  const existing = manifest.offscreenDocuments.find((reference) =>
    pathCandidates(dirOf(manifest.file), reference).some(
      (candidate) => candidate.endsWith(".html") && ctx.exists(candidate),
    ),
  )
  const reference = existing ?? manifest.offscreenDocuments[0] ?? OFFSCREEN_DOCUMENT_CONVENTION

  return [
    {
      kindTag: "offscreen",
      reference,
      what: `manifest permissions ["${OFFSCREEN_PERMISSION}"] document '${reference}'`,
      needle: manifest.text.includes(`"${reference}"`) ? `"${reference}"` : `"${OFFSCREEN_PERMISSION}"`,
      activations: [],
      document: true,
    },
  ]
}

const surfacesOf = (ctx: ProjectContext, manifest: Mv3Manifest): readonly Surface[] => [
  ...(manifest.popup === null
    ? []
    : [
        {
          kindTag: "popup",
          reference: manifest.popup,
          what: "manifest action.default_popup",
          needle: `"${manifest.popup}"`,
          activations: [],
          document: true,
        },
      ]),
  ...(manifest.serviceWorker === null
    ? []
    : [
        {
          kindTag: "background",
          reference: manifest.serviceWorker,
          what: "manifest background.service_worker",
          needle: `"${manifest.serviceWorker}"`,
          activations: [],
          document: false,
        },
      ]),
  ...manifest.contentScripts.flatMap((script) =>
    script.js.map((js, index) => ({
      kindTag: "contentScript",
      reference: js,
      what: `manifest content_scripts[${String(script.ordinal)}].js[${String(index)}]`,
      needle: `"${js}"`,
      activations: script.matches.map((pattern): Activation => ({ kind: "host", pattern })),
      document: false,
    })),
  ),
  ...offscreenSurfacesOf(ctx, manifest),
]

const discoverManifestActivation = (ctx: DiscoverContext): readonly ScreenDraft[] => {
  const drafts: ScreenDraft[] = []
  const bundlerEntries = readBundlerEntries(ctx)

  for (const manifest of findMv3Manifests(ctx)) {
    let ordinal = 0

    for (const surface of surfacesOf(ctx, manifest)) {
      const evidence: Evidence = {
        what: surface.what,
        file: manifest.file,
        line: lineOfLiteral(manifest.text, surface.needle),
      }
      const cited: Evidence[] = []

      const surfaceEntry = ((): EntryRef => {
        if (surface.document) {
          const chain = followDocumentChain(ctx, manifest, surface.reference, bundlerEntries)
          if (chain.module !== null) {
            if (chain.entry !== null) cited.push(bundlerEvidence(chain.entry))
            return { kind: "file", file: chain.module, exportName: "" }
          }
          ctx.diagnostic({
            severity: "warning",
            code: "screens/unresolvable-script",
            message: `${surface.kindTag} '${surface.reference}' could not be followed to a module (broke at the ${chain.brokeAt ?? "module"} link)`,
            file: manifest.file,
            line: evidence.line,
          })
          return { kind: "opaque", expr: surface.reference, file: manifest.file, line: evidence.line }
        }

        const resolution = resolveManifestScript(ctx, manifest, surface.reference, bundlerEntries)
        if (resolution.file !== null) {
          if (resolution.entry !== null) cited.push(bundlerEvidence(resolution.entry))
          return { kind: "file", file: resolution.file, exportName: "" }
        }

        ctx.diagnostic({
          severity: "warning",
          code: "screens/unresolvable-script",
          message:
            resolution.ambiguous.length > 1
              ? `manifest script '${surface.reference}' matches ${String(resolution.ambiguous.length)} source files (${resolution.ambiguous.join(", ")}); none was chosen`
              : `manifest script '${surface.reference}' has no source file; probed ${resolution.probed.join(", ")}`,
          file: manifest.file,
          line: evidence.line,
        })
        return { kind: "opaque", expr: surface.reference, file: manifest.file, line: evidence.line }
      })()

      const loaded = ((): readonly EntryRef[] => {
        if (surfaceEntry.kind !== "file") return []
        const { target, unresolved } = followLoaderStub(ctx, surfaceEntry.file, bundlerEntries)

        if (target === null) {
          if (unresolved.length > 0)
            ctx.diagnostic({
              severity: "warning",
              code: "screens/unresolvable-script",
              message: `'${surfaceEntry.file}' loads its real module at runtime (${unresolved.join(", ")}) and no bundler input maps that name to a source file; everything that surface renders and handles is missing from this screen`,
              file: surfaceEntry.file,
              line: 1,
            })
          return []
        }

        cited.push({
          what: `runtime.${LOADER_URL_METHOD}('${target.asset}') -> bundler input '${target.entry.name}'`,
          file: surfaceEntry.file,
          line: target.line,
        })
        return [{ kind: "file", file: target.entry.file, exportName: "" }]
      })()

      drafts.push({
        localId: ctx.localId(manifest.file, { ordinal }),
        activations: surface.activations,
        entries: [surfaceEntry, ...loaded],
        kindTag: surface.kindTag,
        evidence: [mv3Evidence(manifest), evidence, ...cited],
      })
      ordinal += 1
    }
  }

  return drafts
}

export const manifestActivationSource: ScreenSource = {
  name: SOURCE_NAME,
  detect: detectManifestActivation,
  discover: discoverManifestActivation,
}

export const manifestActivationAdapter: Adapter = {
  name: SOURCE_NAME,
  screens: [manifestActivationSource],
}
