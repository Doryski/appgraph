import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"

export const PEER_SOURCES = ["project", "appgraph"] as const

export type PeerSource = (typeof PEER_SOURCES)[number]

export type PeerModuleKind = "cjs" | "esm"

export type PeerPackage = {
  readonly specifier: string
  readonly manifest: string
}

export type PeerLoad = (specifier: string, base: string) => unknown

export type PeerLoaded = {
  readonly kind: "loaded"
  readonly module: unknown
  readonly version: string
  readonly from: PeerSource
}

export type PeerMissing = { readonly kind: "missing"; readonly detail: string }

export type PeerLoadResult = PeerLoaded | PeerMissing

export type LoadPeerOptions = {
  readonly root: string
  readonly packages: readonly PeerPackage[]
  readonly moduleKind: PeerModuleKind
  readonly load?: PeerLoad
  readonly sources?: readonly PeerSource[]
}

export type LoadPeerSyncOptions = Omit<LoadPeerOptions, "moduleKind">

export const UNKNOWN_PEER_VERSION = "unknown"

const APPGRAPH_BASE = import.meta.url

type Candidate = PeerPackage & {
  readonly base: string
  readonly from: PeerSource
}

type Attempt = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string }

const realpathOr = (dir: string): string => {
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

const ancestorsOf = (dir: string): readonly string[] => {
  const parent = path.dirname(dir)
  return parent === dir ? [dir] : [dir, ...ancestorsOf(parent)]
}

const nodeModulesRootsOf = (base: string): readonly string[] => {
  const dir = path.dirname(path.resolve(base))
  return [...new Set([dir, realpathOr(dir)])].flatMap(ancestorsOf).map((ancestor) => path.join(ancestor, "node_modules") + path.sep)
}

export const isProjectInstalled = (base: string, resolved: string): boolean =>
  nodeModulesRootsOf(base).some((nodeModules) => resolved.startsWith(nodeModules))

export const memberOf = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[name] : undefined

export const nonEmptyString = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)

const messageOf = (error: unknown): string => {
  if (error instanceof Error) return error.message
  return typeof error === "string" ? error : "unknown error"
}

const resolveIsolated = (specifier: string, base: string): string => {
  const resolved = createRequire(base).resolve(specifier)
  if (base !== APPGRAPH_BASE && !isProjectInstalled(base, resolved))
    throw new Error(`${specifier} resolved outside the project's node_modules: ${resolved}`)
  return resolved
}

const requireFrom: PeerLoad = (specifier, base) => createRequire(base)(resolveIsolated(specifier, base))

const importFrom: PeerLoad = (specifier, base) => import(pathToFileURL(resolveIsolated(specifier, base)).href)

const DEFAULT_LOADERS = { cjs: requireFrom, esm: importFrom } as const satisfies Record<PeerModuleKind, PeerLoad>

const BASES = [
  { from: "project", baseOf: (root: string) => path.join(root, "package.json") },
  { from: "appgraph", baseOf: () => APPGRAPH_BASE },
] as const

const candidatesFor = (options: LoadPeerSyncOptions): readonly Candidate[] => {
  const sources = options.sources ?? PEER_SOURCES
  return BASES.filter(({ from }) => sources.includes(from)).flatMap(({ from, baseOf }) =>
    options.packages.map((pkg) => ({ ...pkg, base: baseOf(options.root), from })),
  )
}

const attempt = (load: PeerLoad, specifier: string, base: string): Attempt => {
  try {
    return { ok: true, value: load(specifier, base) }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

const attemptAsync = async (load: PeerLoad, specifier: string, base: string): Promise<Attempt> => {
  try {
    return { ok: true, value: await load(specifier, base) }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

const versionOfManifest = (manifest: Attempt): string | null =>
  manifest.ok ? nonEmptyString(memberOf(manifest.value, "version")) : null

const ownVersion = (module: unknown): string | null => nonEmptyString(memberOf(module, "version"))

const failureOf = (candidate: Candidate, error: string): string => `${candidate.specifier} (${candidate.from}): ${error}`

const loadedOf = (candidate: Candidate, module: unknown, version: string | null): PeerLoaded => ({
  kind: "loaded",
  module,
  version: version ?? UNKNOWN_PEER_VERSION,
  from: candidate.from,
})

const missingOf = (failures: readonly string[]): PeerMissing => ({ kind: "missing", detail: failures.join("; ") })

export const loadPeerSync = (options: LoadPeerSyncOptions): PeerLoadResult => {
  const load = options.load ?? requireFrom
  const failures: string[] = []
  for (const candidate of candidatesFor(options)) {
    const loaded = attempt(load, candidate.specifier, candidate.base)
    if (loaded.ok)
      return loadedOf(
        candidate,
        loaded.value,
        ownVersion(loaded.value) ?? versionOfManifest(attempt(load, candidate.manifest, candidate.base)),
      )
    failures.push(failureOf(candidate, loaded.error))
  }
  return missingOf(failures)
}

export const loadPeer = async (options: LoadPeerOptions): Promise<PeerLoadResult> => {
  const load = options.load ?? DEFAULT_LOADERS[options.moduleKind]
  const manifestLoad = options.load ?? requireFrom
  const failures: string[] = []
  for (const candidate of candidatesFor(options)) {
    const loaded = await attemptAsync(load, candidate.specifier, candidate.base)
    if (loaded.ok)
      return loadedOf(
        candidate,
        loaded.value,
        ownVersion(loaded.value) ??
          versionOfManifest(await attemptAsync(manifestLoad, candidate.manifest, candidate.base)),
      )
    failures.push(failureOf(candidate, loaded.error))
  }
  return missingOf(failures)
}

export type PeerResolved = {
  readonly kind: "resolved"
  readonly specifier: string
  readonly version: string
  readonly from: PeerSource
}

export type PeerResolveResult = PeerResolved | PeerMissing

export type ResolvePeerOptions = Omit<LoadPeerSyncOptions, "load">

const resolveFrom = (specifier: string, base: string): Attempt => {
  try {
    return { ok: true, value: resolveIsolated(specifier, base) }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

const readManifestAt = (file: string): Attempt => {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, "utf8")) }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

const manifestVersionAt = (candidate: Candidate): string | null => {
  const manifest = resolveFrom(candidate.manifest, candidate.base)
  const file = manifest.ok ? nonEmptyString(manifest.value) : null
  return file === null ? null : versionOfManifest(readManifestAt(file))
}

export const resolvePeer = (options: ResolvePeerOptions): PeerResolveResult => {
  const failures: string[] = []
  for (const candidate of candidatesFor(options)) {
    const resolved = resolveFrom(candidate.specifier, candidate.base)
    if (resolved.ok)
      return {
        kind: "resolved",
        specifier: candidate.specifier,
        version: manifestVersionAt(candidate) ?? UNKNOWN_PEER_VERSION,
        from: candidate.from,
      }
    failures.push(failureOf(candidate, resolved.error))
  }
  return missingOf(failures)
}

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies"] as const

const MAJOR_PATTERN = /^(?:npm:(?:@[^@\s/]+\/)?[^@\s/]+@)?[\^~>=<\s]*v?(\d+)/

export const majorOfRange = (range: string): number | null => {
  const match = MAJOR_PATTERN.exec(range.trim())
  return match ? Number(match[1]) : null
}

const parseManifest = (manifestText: string): unknown => {
  try {
    return JSON.parse(manifestText)
  } catch {
    return null
  }
}

export const dependencyRange = (manifestText: string, packageName: string): string | null => {
  const manifest = parseManifest(manifestText)
  return (
    DEPENDENCY_FIELDS.map((field) => nonEmptyString(memberOf(memberOf(manifest, field), packageName))).find(
      (value) => value !== null,
    ) ?? null
  )
}

export const projectMajorOf = (manifestText: string, packageName: string): number | null => {
  const range = dependencyRange(manifestText, packageName)
  return range === null ? null : majorOfRange(range)
}
