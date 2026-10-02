import type { Evidence } from "../core/model.js"
import { byCodepoint, byNumber, sortedUnique, thenBy } from "../core/order.js"
import { isNonAppFile } from "../core/project.js"
import { collectStringMembers } from "../core/strings.js"
import { ROUTER_FACTORIES } from "../adapters/react-router.js"
import type { ProjectProbe } from "./project.js"
import { SCRIPT_FILE } from "../core/extensions.js"


/**
 * §7.3 / §10.5: which files feed the shared `StringTable`, derived instead of configured.
 * Without a derivation `navigate(Paths.ORDERS)` never folds to a URL and every constant-keyed navigation edge silently disappears.
 */
export const STRING_SOURCE_SCAN_LIMITS = {
  /** App files whose text is read for the cheap prefilter — tests, specs and stories never spend it. */
  maxFiles: 20_000,
  /** A file larger than this is neither prefiltered nor parsed. */
  maxBytes: 512_000,
  /** Files that survive the prefilter and are actually parsed. */
  maxParsed: 200,
} as const

/**
 * A member table only counts when its members are REFERENCED from somewhere that navigates — the router
 * itself, a `useNavigate` call site, a `<Link>`/`<Navigate>`. Textual markers on purpose: this is a
 * phase-0 budget-bounded probe, and a false positive costs an unused `StringTable` entry, not an edge.
 */
export const NAVIGATION_MARKERS: readonly string[] = [
  ...ROUTER_FACTORIES,
  "useNavigate",
  "useRouter",
  "<Link",
  "<NavLink",
  "<Navigate",
  "redirect(",
  "permanentRedirect(",
]

/** A member table qualifies on the SHARE of path-like values, or on an absolute count of them. */
export const MIN_PATH_MEMBERS = 1

export const MIN_PATH_MEMBER_SHARE = 0.5

export const STRONG_PATH_MEMBERS = 3

/** `enum Paths {`, `as const`, `Object.freeze({` — the three member-table forms `strings.ts` reads. */
const MEMBER_TABLE_HINT = /\benum\s+[A-Za-z_$]|as\s+const|Object\s*\.\s*freeze\s*\(/

/** A quoted value that starts a path. Cheap gate that keeps the parse budget for plausible files. */
const PATH_VALUE_HINT = /['"`]\//

const MAX_REFERENCES = 3

const isPathLike = (value: string): boolean => value.startsWith("/") && !value.startsWith("//")

const containerOf = (key: string): string => key.slice(0, key.indexOf("."))

const lineOfDeclaration = (text: string, name: string): number => {
  const matcher = new RegExp(`(?:enum|const|let|var)\\s+${name}\\b`)
  const match = matcher.exec(text)
  const index = match === null ? text.indexOf(name) : match.index
  return index < 0 ? 1 : text.slice(0, index).split("\n").length
}

const referencesContainer = (text: string, name: string): boolean =>
  new RegExp(`\\b${name}\\s*(?:\\.|\\[)`).test(text)

export type StringSourceContainer = {
  /** The enum or object name, as declared. */
  readonly name: string
  readonly pathMembers: number
  readonly members: number
  /** Path-like share, the candidate's score — visible in the trace, as §10.6 requires of nav candidates. */
  readonly score: number
  /** Navigation sites that reference the container, first `MAX_REFERENCES` in codepoint order. */
  readonly referencedBy: readonly string[]
}

export type StringSourceCandidate = {
  readonly file: string
  readonly containers: readonly StringSourceContainer[]
  readonly pathMembers: number
  readonly score: number
  readonly evidence: readonly Evidence[]
}

/**
 * The probe HAVING RUN. An empty `files` with a non-zero `filesScanned` is the legible "this repository
 * declares no referenced path constants"; "the probe never ran" is the absence of this object.
 */
export type StringSourceProbe = {
  /** Every qualifying file, codepoint-sorted — a SUPERSET on purpose (§10.6: keep every candidate). */
  readonly files: readonly string[]
  readonly candidates: readonly StringSourceCandidate[]
  readonly navigationSites: readonly string[]
  readonly filesScanned: number
  readonly filesParsed: number
  readonly filesSkipped: number
  readonly bytesRead: number
}

export type StringSourceProbeOptions = {
  readonly maxFiles?: number
  readonly maxBytes?: number
  readonly maxParsed?: number
}

const byCandidateOrder = thenBy<StringSourceCandidate>(
  (a, b) => byNumber(b.score, a.score),
  (a, b) => byNumber(b.pathMembers, a.pathMembers),
  (a, b) => byCodepoint(a.file, b.file),
)

const byContainerOrder = thenBy<StringSourceContainer>(
  (a, b) => byNumber(b.score, a.score),
  (a, b) => byCodepoint(a.name, b.name),
)

const qualifies = (pathMembers: number, members: number): boolean => {
  if (pathMembers < MIN_PATH_MEMBERS) return false
  return pathMembers >= STRONG_PATH_MEMBERS || pathMembers / members >= MIN_PATH_MEMBER_SHARE
}

/**
 * Bounded by file count, per-file bytes and parse count, because it runs before anything has decided the
 * run is worth doing. It never picks ONE candidate: a missing member silently drops a navigation edge, so
 * every qualifying file is reported and every qualifying file is used.
 */
export const probeStringSources = (
  probe: ProjectProbe,
  options: StringSourceProbeOptions = {},
): StringSourceProbe => {
  const maxFiles = options.maxFiles ?? STRING_SOURCE_SCAN_LIMITS.maxFiles
  const maxBytes = options.maxBytes ?? STRING_SOURCE_SCAN_LIMITS.maxBytes
  const maxParsed = options.maxParsed ?? STRING_SOURCE_SCAN_LIMITS.maxParsed

  const navigationSites: string[] = []
  const parseQueue: string[] = []
  let scanned = 0
  let skipped = 0
  let bytesRead = 0

  for (const file of probe.probeFiles()) {
    if (!SCRIPT_FILE.test(file) || isNonAppFile(file)) continue
    if (scanned >= maxFiles) {
      skipped += 1
      continue
    }

    const text = probe.readFile(file)
    if (text === null) continue
    if (text.length > maxBytes) {
      skipped += 1
      continue
    }
    scanned += 1
    bytesRead += text.length

    if (NAVIGATION_MARKERS.some((marker) => text.includes(marker))) navigationSites.push(file)
    if (!MEMBER_TABLE_HINT.test(text) || !PATH_VALUE_HINT.test(text)) continue
    if (parseQueue.length >= maxParsed) {
      skipped += 1
      continue
    }
    parseQueue.push(file)
  }

  const tables = new Map<string, readonly { name: string; pathMembers: number; members: number }[]>()
  let parsed = 0

  for (const file of parseQueue) {
    const source = probe.parse(file)
    if (source === null) continue
    parsed += 1

    const counts = new Map<string, { pathMembers: number; members: number }>()
    for (const [key, value] of collectStringMembers(probe.ts, source)) {
      const name = containerOf(key)
      if (name === "") continue
      const entry = counts.get(name) ?? { pathMembers: 0, members: 0 }
      entry.members += 1
      if (isPathLike(value)) entry.pathMembers += 1
      counts.set(name, entry)
    }

    const kept = [...counts.entries()]
      .filter(([, entry]) => qualifies(entry.pathMembers, entry.members))
      .map(([name, entry]) => ({ name, pathMembers: entry.pathMembers, members: entry.members }))
    if (kept.length > 0) tables.set(file, kept)
  }

  const candidates: StringSourceCandidate[] = []

  for (const [file, entries] of tables) {
    const text = probe.readFile(file) ?? ""
    const containers: StringSourceContainer[] = []

    for (const entry of entries) {
      const referencedBy = navigationSites
        .filter((site) => referencesContainer(probe.readFile(site) ?? "", entry.name))
        .slice(0, MAX_REFERENCES)
      if (referencedBy.length === 0) continue

      containers.push({
        name: entry.name,
        pathMembers: entry.pathMembers,
        members: entry.members,
        score: entry.pathMembers / entry.members,
        referencedBy,
      })
    }

    if (containers.length === 0) continue
    containers.sort(byContainerOrder)

    const pathMembers = containers.reduce((sum, container) => sum + container.pathMembers, 0)
    const members = containers.reduce((sum, container) => sum + container.members, 0)

    candidates.push({
      file,
      containers,
      pathMembers,
      score: pathMembers / members,
      evidence: containers.map((container) => ({
        what: `${container.name}: ${String(container.pathMembers)}/${String(container.members)} path-like member(s), referenced by ${container.referencedBy.join(", ")}`,
        file,
        line: lineOfDeclaration(text, container.name),
      })),
    })
  }

  candidates.sort(byCandidateOrder)

  return {
    files: sortedUnique(candidates.map((candidate) => candidate.file)),
    candidates,
    navigationSites: sortedUnique(navigationSites),
    filesScanned: scanned,
    filesParsed: parsed,
    filesSkipped: skipped,
    bytesRead,
  }
}

/** The trace lines `doctor` prints for the derivation (§10.4), candidates and their scores included. */
export const formatStringSourceTrace = (probe: StringSourceProbe | null): readonly string[] => {
  if (probe === null) return ["string sources: not derived"]

  const lines = [
    `string sources: ${probe.files.join(", ") || "(none)"}  (${String(probe.filesScanned)} file(s) scanned, ${String(probe.filesParsed)} parsed, ${String(probe.filesSkipped)} skipped, ${String(probe.bytesRead)} byte(s) read)`,
  ]

  for (const candidate of probe.candidates)
    for (const evidence of candidate.evidence)
      lines.push(`  ${evidence.file}:${String(evidence.line)}  ${evidence.what}`)

  return lines
}
