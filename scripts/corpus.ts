import { spawn, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { parseArgs } from "node:util"

const STACKS = {
  K1: "react-router JSX <Routes>",
  K2: "Next.js App Router",
  K3a: "TanStack Start",
  K3b: "TanStack Router SPA",
  K4: "Next.js Pages Router",
  K5: "react-router data mode",
  K6: "Angular",
  K7a: "Vue 3 + vue-router",
  K7b: "Nuxt",
  K8: "React Router framework / Remix",
  K9: "Expo Router / React Navigation",
  K10: "react-router v5 <Switch>",
  AI: "AI-built",
} as const

type StackId = keyof typeof STACKS

const AUTH_VERDICTS = ["protected", "public", "unknown"] as const

type AuthVerdict = (typeof AUTH_VERDICTS)[number]

type Expectation = {
  readonly minScreens?: number
  readonly maxErrors?: number
  readonly absentCodes?: readonly string[]
  readonly urlsInclude?: readonly string[]
  readonly expectedUrls?: string
  readonly minRecall?: number
  readonly minPrecision?: number
  readonly minTreeCoverage?: number
  readonly minTestIds?: number
  readonly presentCodes?: readonly string[]
  readonly expectAuth?: Readonly<Record<string, AuthVerdict>>
  readonly expectedNames?: string
  readonly minNameRecall?: number
  readonly minNameEdges?: number
  readonly urlSource?: UrlSource
}

type UrlSource = "url" | "activations"

type CorpusEntry = {
  readonly id: string
  readonly stack: StackId
  readonly repo: string
  readonly root: string
  readonly sparse?: readonly string[]
  readonly tier: "primary" | "secondary"
  readonly expect?: Expectation
  readonly args?: readonly string[]
  readonly config?: string
}

const CORPUS = [
  { id: "C1", stack: "K1", repo: "Unleash/unleash", root: "frontend", tier: "primary" },
  { id: "C2", stack: "K1", repo: "getlago/lago-front", root: ".", tier: "secondary" },
  { id: "N1", stack: "K2", repo: "dubinc/dub", root: "apps/web", tier: "primary" },
  { id: "N3", stack: "K2", repo: "umami-software/umami", root: ".", tier: "secondary", expect: { maxErrors: 0 } },
  {
    id: "T1",
    stack: "K3a", repo: "openstory-so/openstory", root: ".",
    tier: "primary",
    config: "scripts/corpus-configs/T1.config.mjs",
    expect: { expectAuth: { "/login": "unknown", "/verify": "unknown", "/settings/api-keys": "protected" } },
  },
  {
    id: "T2",
    stack: "K3a", repo: "chmonitor/chmonitor", root: "apps/dashboard",
    tier: "secondary",
    config: "scripts/corpus-configs/T2.config.mjs",
    expect: { expectAuth: { "/sign-in": "unknown", "/health": "unknown" } },
  },
  {
    id: "T5",
    stack: "K3b", repo: "Infisical/infisical", root: "frontend",
    tier: "primary",
    config: "scripts/corpus-configs/T5.config.mjs",
    expect: { expectAuth: { "/login": "unknown", "/personal-settings": "protected" } },
  },
  { id: "T6", stack: "K3b", repo: "linode/manager", root: "packages/manager", tier: "secondary" },
  {
    id: "X1",
    stack: "K4", repo: "supabase/supabase", root: "apps/studio",
    tier: "primary",
    args: ["--source", "tanstack-router"],
    config: "scripts/corpus-configs/X1.config.mjs",
    expect: { absentCodes: ["nav/dead-link"], expectAuth: { "/": "unknown", "/sign-in": "unknown" } },
  },
  {
    id: "X1P",
    stack: "K4", repo: "supabase/supabase", root: "apps/studio",
    tier: "primary",
    args: ["--source", "next-pages"],
    expect: { expectedUrls: "X1P.urls", minRecall: 0.95, minPrecision: 0.95 },
  },
  { id: "X2", stack: "K4", repo: "langfuse/langfuse", root: "web", tier: "secondary", expect: { expectedUrls: "X2.urls", minRecall: 0.95, minPrecision: 0.95 } },
  { id: "D1", stack: "K5", repo: "getsentry/sentry", root: ".", sparse: ["static", "config"], tier: "primary", expect: { minScreens: 300 } },
  { id: "D2", stack: "K5", repo: "apache/airflow", root: "airflow-core/src/airflow/ui", tier: "secondary" },
  {
    id: "A1",
    stack: "K6",
    repo: "Chocobozzz/PeerTube",
    root: "client",
    tier: "primary",
    expect: {
      expectedUrls: "A1.urls",
      minRecall: 0.95,
      minPrecision: 0.95,
      minTreeCoverage: 0.01,
      expectAuth: {
        "/login": "public",
        "/signup": "public",
        "/my-account/settings": "protected",
        "/remote-interaction": "protected",
        "/admin/overview/users/list": "unknown",
      },
    },
  },
  {
    id: "A3",
    stack: "K6",
    repo: "apache/streampipes",
    root: "ui",
    tier: "secondary",
    expect: { presentCodes: ["screens/route-module-missing"] },
  },
  {
    id: "A4",
    stack: "K6",
    repo: "thingsboard/thingsboard",
    root: "ui-ngx",
    tier: "secondary",
    expect: {
      expectedUrls: "A4.urls",
      minRecall: 0.95,
      minPrecision: 0.95,
      minTreeCoverage: 0.01,
      expectAuth: {
        "/login": "public",
        "/login/resetPasswordRequest": "public",
        "/login/mfa": "public",
        "/home": "protected",
        "/account/profile": "protected",
      },
    },
  },
  {
    id: "A7",
    stack: "K6",
    repo: "oppia/oppia",
    root: ".",
    sparse: ["core/templates", "extensions", "src", "typings", "assets/i18n"],
    tier: "secondary",
    expect: { minScreens: 1, absentCodes: ["plugin/threw"] },
  },
  {
    id: "V1",
    stack: "K7a",
    repo: "n8n-io/n8n",
    root: "packages/frontend/editor-ui",
    tier: "primary",
    expect: { expectedUrls: "V1.urls", minRecall: 0.95, minPrecision: 0.95, minTreeCoverage: 0.01, minTestIds: 1 },
  },
  {
    id: "V2",
    stack: "K7a",
    repo: "go-vikunja/vikunja",
    root: "frontend",
    tier: "secondary",
    expect: { expectedUrls: "V2.urls", minRecall: 0.95, minPrecision: 0.95, minTreeCoverage: 0.01 },
  },
  {
    id: "U1",
    stack: "K7b",
    repo: "KunMoe/kun-galgame-forum",
    root: "apps/web",
    tier: "primary",
    expect: { expectedUrls: "U1.urls", minRecall: 0.98, minPrecision: 1, minTreeCoverage: 0.01 },
  },
  {
    id: "U2",
    stack: "K7b",
    repo: "OpnForm/OpnForm",
    root: "client",
    tier: "secondary",
    expect: {
      expectedUrls: "U2.urls",
      minRecall: 0.98,
      minPrecision: 1,
      minTreeCoverage: 0.01,
      minTestIds: 1,
      maxErrors: 0,
    },
  },
  {
    id: "R1",
    stack: "K8", repo: "makeplane/plane", root: "apps/web",
    tier: "primary",
    config: "scripts/corpus-configs/R1.config.mjs",
    expect: {
      expectedUrls: "R1.urls",
      minRecall: 0.95,
      minPrecision: 0.95,
      expectAuth: { "/sign-up": "unknown", "/:workspaceSlug/projects/:projectId/issues/:issueId": "unknown" },
    },
  },
  {
    id: "R2",
    stack: "K8", repo: "triggerdotdev/trigger.dev", root: "apps/webapp",
    tier: "secondary",
    config: "scripts/corpus-configs/R2.config.mjs",
    expect: {
      expectedUrls: "R2.urls", minRecall: 0.95, minPrecision: 0.95,
      expectAuth: { "/login": "unknown", "/account": "protected" },
    },
  },
  {
    id: "R3",
    stack: "K8", repo: "documenso/documenso", root: "apps/remix",
    tier: "secondary",
    config: "scripts/corpus-configs/R3.config.mjs",
    expect: {
      expectedUrls: "R3.urls",
      minRecall: 0.95,
      minPrecision: 0.95,
      expectAuth: { "/signin": "unknown", "/inbox": "protected", "/dashboard": "protected" },
    },
  },
  {
    id: "E1",
    stack: "K9",
    repo: "streamyfin/streamyfin",
    root: ".",
    tier: "primary",
    expect: { expectedUrls: "E1.urls", minRecall: 0.98, minPrecision: 1, minTreeCoverage: 0.01 },
  },
  {
    id: "E2",
    stack: "K9",
    repo: "CherryHQ/cherry-studio-app",
    root: ".",
    tier: "primary",
    expect: { expectedUrls: "E2.urls", minRecall: 0.98, minPrecision: 1, minTreeCoverage: 0.01, minTestIds: 1 },
  },
  {
    id: "E4",
    stack: "K9",
    repo: "bluesky-social/social-app",
    root: ".",
    tier: "secondary",
    config: "scripts/corpus-configs/E4.config.mjs",
    expect: {
      expectedUrls: "E4.urls",
      minRecall: 0.95,
      urlSource: "activations",
      expectedNames: "E4.names",
      minNameRecall: 1,
      minNameEdges: 1,
      minTestIds: 1,
    },
  },
  { id: "W1", stack: "K10", repo: "SigNoz/signoz", root: "frontend", tier: "primary", expect: { expectedUrls: "W1.urls", minRecall: 0.95, minPrecision: 0.95 } },
  { id: "W2", stack: "K10", repo: "apache/superset", root: "superset-frontend", tier: "secondary", expect: { expectedUrls: "W2.urls", minRecall: 0.95, minPrecision: 0.95 } },
  { id: "L1", stack: "AI", repo: "alphavisionmethod/remix-of-sitav-companion", root: ".", tier: "primary" },
  {
    id: "L4",
    stack: "AI", repo: "geded/valladolidmx", root: ".",
    tier: "secondary",
    config: "scripts/corpus-configs/L4.config.mjs",
    expect: {
      expectAuth: { "/auth": "unknown", "/marketplace/*": "unknown", "/.lovable/oauth/consent": "protected" },
    },
  },
] as const satisfies readonly CorpusEntry[]

const SHARED_SPARSE = ["packages", "libs"] as const
const CLONE_CONCURRENCY = 4
const ANALYZE_TIMEOUT_MS = 10 * 60 * 1000
const TOP_CODES = 4
const DEFAULT_BENCH_RUNS = 3

type Diagnostic = { readonly severity: string; readonly code: string; readonly message?: string }

type AnalyzeJson = {
  readonly exitCode: number
  readonly refused?: unknown
  readonly emptyResult?: unknown
  readonly counts?: Readonly<Record<string, number>>
  readonly diagnostics?: readonly Diagnostic[]
  readonly timing?: Readonly<Record<string, number>>
}

type RunResult = {
  readonly entry: CorpusEntry
  readonly commit: string
  readonly durationMs: number
  readonly exitCode: number | null
  readonly screens: number | null
  readonly errors: number
  readonly warnings: number
  readonly topCodes: readonly string[]
  readonly counts: Readonly<Record<string, number>>
  readonly failure: string | null
  readonly urlDiff: string
  readonly authDiff: string
  readonly expectation: string
}

const repoRoot = path.resolve(import.meta.dirname, "..")

const cli = parseArgs({
  options: {
    only: { type: "string" },
    stack: { type: "string" },
    tier: { type: "string" },
    dir: { type: "string", default: path.join(repoRoot, ".scratch", "corpus") },
    refresh: { type: "boolean", default: false },
    "skip-clone": { type: "boolean", default: false },
    dist: { type: "boolean", default: false },
    baseline: { type: "string" },
    "snapshot-only": { type: "string" },
    bench: { type: "boolean", default: false },
    runs: { type: "string", default: String(DEFAULT_BENCH_RUNS) },
    "bench-baseline": { type: "string" },
  },
})

const csv = (value: string | undefined): readonly string[] | null =>
  value === undefined ? null : value.split(",").map((part) => part.trim()).filter(Boolean)

const matches = (allowed: readonly string[] | null, value: string): boolean => allowed === null || allowed.includes(value)

const selectEntries = (): readonly CorpusEntry[] => {
  const only = csv(cli.values.only)
  const stacks = csv(cli.values.stack)
  const tiers = csv(cli.values.tier)
  return CORPUS.filter(
    (entry) => matches(only, entry.id) && matches(stacks, entry.stack) && matches(tiers, entry.tier),
  )
}

const reposDir = path.join(cli.values.dir, "repos")
const outDir = path.join(cli.values.dir, "out")

const checkoutDir = (entry: CorpusEntry): string => path.join(reposDir, entry.repo.replace("/", "__"))

const projectRoot = (entry: CorpusEntry): string => path.join(checkoutDir(entry), entry.root)

const sparsePaths = (entry: CorpusEntry): readonly string[] =>
  entry.sparse ?? (entry.root === "." ? [] : [entry.root, ...SHARED_SPARSE])

const git = (args: readonly string[], cwd?: string): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

const gitAsync = (args: readonly string[], cwd?: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"] })
    const stderr: Buffer[] = []
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.on("error", reject)
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")}: ${Buffer.concat(stderr).toString().trim()}`)),
    )
  })

const cloneArgs = (entry: CorpusEntry, target: string): readonly string[] => [
  "clone",
  "--depth=1",
  "--filter=blob:none",
  ...(sparsePaths(entry).length > 0 ? ["--sparse"] : []),
  `https://github.com/${entry.repo}.git`,
  target,
]

const clone = async (entry: CorpusEntry): Promise<void> => {
  const target = checkoutDir(entry)
  const sparse = sparsePaths(entry)
  await gitAsync(cloneArgs(entry, target))
  if (sparse.length > 0) await gitAsync(["sparse-checkout", "set", ...sparse], target)
}

const refresh = async (entry: CorpusEntry): Promise<void> => {
  const target = checkoutDir(entry)
  await gitAsync(["fetch", "--depth=1", "origin", "HEAD"], target)
  await gitAsync(["reset", "--hard", "FETCH_HEAD"], target)
}

const syncEntry = async (entry: CorpusEntry): Promise<string | null> => {
  const exists = fs.existsSync(path.join(checkoutDir(entry), ".git"))
  if (exists && !cli.values.refresh) return null
  const action = exists ? refresh : clone
  return action(entry).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
}

const runPool = async <T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = new Array(items.length)
  const worker = async (start: number): Promise<void> => {
    for (let index = start; index < items.length; index += limit) {
      const item = items[index]
      if (item !== undefined) results[index] = await task(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, (_, start) => worker(start)))
  return results
}

const appgraphCommand = (): readonly string[] =>
  cli.values.dist
    ? [process.execPath, path.join(repoRoot, "dist", "cli", "bin.js")]
    : [path.join(repoRoot, "node_modules", ".bin", "tsx"), path.join(repoRoot, "src", "cli", "index.ts")]

const parseJson = (stdout: string): AnalyzeJson | null => {
  const line = stdout.trim().split("\n").at(-1)
  if (line === undefined || line === "") return null
  try {
    return JSON.parse(line) as AnalyzeJson
  } catch {
    return null
  }
}

const countSeverity = (diagnostics: readonly Diagnostic[], severity: string): number =>
  diagnostics.filter((diagnostic) => diagnostic.severity === severity).length

const topCodes = (diagnostics: readonly Diagnostic[]): readonly string[] => {
  const tally = new Map<string, number>()
  diagnostics
    .filter((diagnostic) => diagnostic.severity !== "info")
    .forEach((diagnostic) => tally.set(diagnostic.code, (tally.get(diagnostic.code) ?? 0) + 1))
  return [...tally.entries()]
    .sort(([codeA, a], [codeB, b]) => b - a || (codeA < codeB ? -1 : 1))
    .slice(0, TOP_CODES)
    .map(([code, count]) => `${code}×${String(count)}`)
}

const failedResult = (entry: CorpusEntry, failure: string, durationMs = 0): RunResult => ({
  entry,
  commit: "",
  durationMs,
  exitCode: null,
  screens: null,
  errors: 0,
  warnings: 0,
  topCodes: [],
  counts: {},
  failure,
  urlDiff: "—",
  authDiff: "—",
  expectation: entry.expect === undefined ? NO_VALUE : "FAIL run failed",
})

const NO_VALUE = "—"
const DEAD_LINK_CODE = "nav/dead-link"

const byCodePoint = (a: string, b: string): number => {
  if (a === b) return 0
  return a < b ? -1 : 1
}

const sortedUnique = (lines: readonly string[]): readonly string[] => [...new Set(lines)].sort(byCodePoint)

const unquote = (value: string): string => value.trim().replace(/^(["'])(.*)\1$/, "$2")

const yamlSection = (lines: readonly string[], name: string): readonly string[] => {
  const start = lines.indexOf(`${name}:`)
  if (start === -1) return []
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^\S/.test(line))
  return end === -1 ? rest : rest.slice(0, end)
}

const valuesOf = (lines: readonly string[], prefix: string): readonly string[] =>
  lines.filter((line) => line.startsWith(prefix)).map((line) => unquote(line.slice(prefix.length)))

const screenUrls = (lines: readonly string[]): readonly string[] =>
  valuesOf(yamlSection(lines, "screens"), "    url: ").filter((url) => url !== "null")

const redirectLines = (lines: readonly string[]): readonly string[] => {
  const section = yamlSection(lines, "redirects")
  const tos = valuesOf(section, "    to: ")
  return valuesOf(section, "  - from: ").map((from, index) => `${from} -> ${tos[index] ?? ""}`)
}

const deadLines = (diagnostics: readonly Diagnostic[]): readonly string[] =>
  diagnostics
    .filter((diagnostic) => diagnostic.code === DEAD_LINK_CODE)
    .map((diagnostic) => `dead: ${(diagnostic.message ?? "").replaceAll("\n", " ")}`)

const readTextOrEmpty = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "")

const urlSnapshot = (dir: string): readonly string[] => {
  const yamlLines = readTextOrEmpty(path.join(dir, "appgraph.yaml")).split("\n")
  const diagnostics = parseJson(readTextOrEmpty(path.join(dir, "run.stdout.json")))?.diagnostics ?? []
  return [
    ...sortedUnique(screenUrls(yamlLines)),
    ...sortedUnique(redirectLines(yamlLines)),
    ...sortedUnique(deadLines(diagnostics)),
  ]
}

const authSnapshot = (dir: string): readonly string[] => {
  const yamlLines = readTextOrEmpty(path.join(dir, "appgraph.yaml")).split("\n")
  const rows = screenBlocks(yamlLines).flatMap((block) => {
    const [url = "null"] = valuesOf(block, "    url: ")
    if (url === "null") return []
    const [auth = "unknown"] = valuesOf(block, "    auth: ")
    const [redirectTo = "null"] = valuesOf(block, "    redirectTo: ")
    return [`${url}\t${auth}\t${redirectTo === "null" ? "-" : redirectTo}`]
  })
  return sortedUnique(rows)
}

const SNAPSHOTS = {
  urls: { file: "urls.txt", diff: "urls.diff", read: urlSnapshot },
  auth: { file: "auth.txt", diff: "auth.diff", read: authSnapshot },
} as const

type SnapshotName = keyof typeof SNAPSHOTS

const writeSnapshot = (dir: string, name: SnapshotName): readonly string[] => {
  const lines = SNAPSHOTS[name].read(dir)
  fs.writeFileSync(path.join(dir, SNAPSHOTS[name].file), lines.map((line) => `${line}\n`).join(""))
  return lines
}

const writeSnapshots = (dir: string): Readonly<Record<SnapshotName, readonly string[]>> => ({
  urls: writeSnapshot(dir, "urls"),
  auth: writeSnapshot(dir, "auth"),
})

const readLines = (file: string): readonly string[] | null =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : null

const diffLines = (before: readonly string[], after: readonly string[]) => ({
  added: after.filter((line) => !before.includes(line)),
  removed: before.filter((line) => !after.includes(line)),
})

const snapshotDiffFor = (name: SnapshotName, entry: CorpusEntry, lines: readonly string[], entryOut: string): string => {
  const baselineDir = cli.values.baseline
  if (baselineDir === undefined) return NO_VALUE
  const before = readLines(path.join(path.resolve(baselineDir), entry.id, SNAPSHOTS[name].file))
  if (before === null) return "n/a"
  const beforeSet = new Set(before)
  const afterSet = new Set(lines)
  const { added, removed } = diffLines([...beforeSet], [...afterSet])
  const body = [...added.sort(byCodePoint).map((line) => `+ ${line}`), ...removed.sort(byCodePoint).map((line) => `- ${line}`)]
  fs.writeFileSync(path.join(entryOut, SNAPSHOTS[name].diff), body.map((line) => `${line}\n`).join(""))
  return body.length === 0 ? "=" : `+${String(added.length)}/-${String(removed.length)}`
}

const EXPECTED_DIR = path.join(repoRoot, "scripts", "corpus-expected")
const CATCH_ALL_SEGMENT = /^(?:\*{1,2}|:[^/(]*\(\.\*\)[*+?]?|:[^/(]*[*+]|\[\.\.\.[^\]]*\])$/

const splitGluedParam = (segment: string): readonly string[] => {
  const index = segment.indexOf(":")
  return index > 0 ? [segment.slice(0, index), segment.slice(index)] : [segment]
}

const segmentShape = (segment: string): string => {
  if (CATCH_ALL_SEGMENT.test(segment)) return "*"
  if (!segment.startsWith(":")) return segment
  return segment.endsWith("?") ? ":?" : ":"
}

const shapeOf = (url: string): string =>
  `/${url.split("/").filter(Boolean).flatMap(splitGluedParam).map(segmentShape).join("/")}`

const ratio = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole)

const formatRatio = (value: number): string => value.toFixed(2)

const resolveExpectedFile = (file: string): string | null =>
  [path.join(EXPECTED_DIR, file), path.resolve(repoRoot, file)].find((candidate) => fs.existsSync(candidate)) ?? null

const readExpectedList = (file: string): readonly string[] | null => {
  const resolved = resolveExpectedFile(file)
  if (resolved === null) return null
  return (readLines(resolved) ?? []).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"))
}

type UrlComparison = {
  readonly missing: readonly string[]
  readonly extra: readonly string[]
  readonly recall: number
  readonly precision: number
}

const compareUrls = (expected: readonly string[], actual: readonly string[]): UrlComparison => {
  const expectedShapes = sortedUnique(expected.map(shapeOf))
  const actualShapes = sortedUnique(actual.map(shapeOf))
  const expectedSet = new Set(expectedShapes)
  const actualSet = new Set(actualShapes)
  const missing = expectedShapes.filter((shape) => !actualSet.has(shape))
  const extra = actualShapes.filter((shape) => !expectedSet.has(shape))
  return {
    missing,
    extra,
    recall: ratio(expectedShapes.length - missing.length, expectedShapes.length),
    precision: ratio(actualShapes.length - extra.length, actualShapes.length),
  }
}

const SCREEN_START = "  - id: "
const TREE_KEY = "    tree:"
const TREE_ITEM = "      - "
const TEST_IDS_KEY = "      testIds:"
const TEST_ID_ITEM = "        - "

const SCREEN_SECTIONS = ["screens", "stateScreens"] as const

const sectionBlocks = (section: readonly string[]): readonly (readonly string[])[] => {
  const starts = section.flatMap((line, index) => (line.startsWith(SCREEN_START) ? [index] : []))
  return starts.map((start, index) => section.slice(start, starts[index + 1] ?? section.length))
}

const screenBlocks = (yamlLines: readonly string[]): readonly (readonly string[])[] =>
  SCREEN_SECTIONS.flatMap((name) => sectionBlocks(yamlSection(yamlLines, name)))

const LIST_ITEM = "      - "
const ITEM_FIELD = "        "
const ACTIVATIONS_KEY = "    activations:"
const NAVIGATES_TO_KEY = "    navigatesTo:"
const ROUTE_NAME_FIELD = `${ITEM_FIELD}routeName: `
const UNRESOLVED_LINE = `${ITEM_FIELD}resolves: false`

const listItems = (block: readonly string[], key: string): readonly (readonly string[])[] => {
  const index = block.indexOf(key)
  if (index === -1) return []
  const rest = block.slice(index + 1)
  const end = rest.findIndex((line) => !line.startsWith(LIST_ITEM) && !line.startsWith(ITEM_FIELD))
  const body = end === -1 ? rest : rest.slice(0, end)
  const starts = body.flatMap((line, start) => (line.startsWith(LIST_ITEM) ? [start] : []))
  return starts.map((start, position) => {
    const [head = "", ...fields] = body.slice(start, starts[position + 1] ?? body.length)
    return [`${ITEM_FIELD}${head.slice(LIST_ITEM.length)}`, ...fields]
  })
}

const activationsOfKind = (block: readonly string[], kind: string): readonly (readonly string[])[] =>
  listItems(block, ACTIVATIONS_KEY).filter((item) => item[0] === `${ITEM_FIELD}kind: ${kind}`)

const activationUrlsOf = (block: readonly string[]): readonly string[] =>
  activationsOfKind(block, "url").flatMap((item) => valuesOf(item, `${ITEM_FIELD}template: `))

const routeNamesOf = (block: readonly string[]): readonly string[] =>
  activationsOfKind(block, "route").flatMap((item) => valuesOf(item, `${ITEM_FIELD}name: `))

const isNameEdge = (item: readonly string[]): boolean =>
  item.some((line) => line.startsWith(ROUTE_NAME_FIELD)) && !item.includes(UNRESOLVED_LINE)

const nameEdgesOf = (block: readonly string[]): readonly string[] =>
  listItems(block, NAVIGATES_TO_KEY)
    .filter(isNameEdge)
    .map((item) => item.join("\n"))

const hasTree = (block: readonly string[]): boolean => {
  const index = block.indexOf(TREE_KEY)
  return index !== -1 && (block[index + 1] ?? "").startsWith(TREE_ITEM)
}

const testIdsOf = (block: readonly string[]): readonly string[] => {
  const index = block.indexOf(TEST_IDS_KEY)
  if (index === -1) return []
  const rest = block.slice(index + 1)
  const end = rest.findIndex((line) => !line.startsWith(TEST_ID_ITEM))
  return (end === -1 ? rest : rest.slice(0, end)).map((line) => unquote(line.slice(TEST_ID_ITEM.length)))
}

const REDIRECT_START = "  - from: "

const redirectEntries = (yamlLines: readonly string[]): readonly (readonly string[])[] => {
  const section = yamlSection(yamlLines, "redirects")
  const starts = section.flatMap((line, index) => (line.startsWith(REDIRECT_START) ? [index] : []))
  return starts.map((start, index) => section.slice(start, starts[index + 1] ?? section.length))
}

const isRuleRedirect = (entry: readonly string[]): boolean => entry.some((line) => line.startsWith("    declaredAt: "))

const redirectSources = (yamlLines: readonly string[]): readonly string[] =>
  redirectEntries(yamlLines)
    .filter((entry) => !isRuleRedirect(entry))
    .flatMap((entry) => valuesOf(entry.slice(0, 1), REDIRECT_START))

type NameComparison = {
  readonly missing: readonly string[]
  readonly recall: number
}

type Quality = {
  readonly urls: UrlComparison | null
  readonly names: NameComparison | null
  readonly nameEdges: number | null
  readonly treeCoverage: number
  readonly testIds: number
}

const API_ROUTE_KIND_LINES: ReadonlySet<string> = new Set(["    kindTag: apiRoute", "    kindTag: api"])

const isApiRouteBlock = (block: readonly string[]): boolean => block.some((line) => API_ROUTE_KIND_LINES.has(line))

const pageUrlsOf = (block: readonly string[]): readonly string[] =>
  valuesOf(block, "    url: ").filter((url) => url !== "null")

const URL_READERS = {
  url: pageUrlsOf,
  activations: activationUrlsOf,
} as const satisfies Record<UrlSource, (block: readonly string[]) => readonly string[]>

const compareNames = (expected: readonly string[], actual: readonly string[]): NameComparison => {
  const expectedNames = sortedUnique(expected)
  const actualSet = new Set(actual)
  const missing = expectedNames.filter((name) => !actualSet.has(name))
  return { missing, recall: ratio(expectedNames.length - missing.length, expectedNames.length) }
}

const wantsNameEdges = (expect: Expectation): boolean =>
  expect.expectedNames !== undefined || expect.minNameEdges !== undefined

const qualityOf = (expect: Expectation, entryOut: string): Quality => {
  const yamlLines = readTextOrEmpty(path.join(entryOut, "appgraph.yaml")).split("\n")
  const blocks = screenBlocks(yamlLines).filter((block) => !isApiRouteBlock(block))
  const expected = expect.expectedUrls === undefined ? null : readExpectedList(expect.expectedUrls)
  const expectedNames = expect.expectedNames === undefined ? null : readExpectedList(expect.expectedNames)
  const actual = [...blocks.flatMap(URL_READERS[expect.urlSource ?? "url"]), ...redirectSources(yamlLines)]
  return {
    urls: expected === null ? null : compareUrls(expected, actual),
    names: expectedNames === null ? null : compareNames(expectedNames, blocks.flatMap(routeNamesOf)),
    nameEdges: wantsNameEdges(expect) ? new Set(blocks.flatMap(nameEdgesOf)).size : null,
    treeCoverage: ratio(blocks.filter(hasTree).length, blocks.length),
    testIds: new Set(blocks.flatMap(testIdsOf)).size,
  }
}

const expectedDiffLines = (quality: Quality): readonly string[] => [
  ...(quality.urls?.missing ?? []).map((shape) => `- ${shape}`),
  ...(quality.urls?.extra ?? []).map((shape) => `+ ${shape}`),
  ...(quality.names?.missing ?? []).map((name) => `- name ${name}`),
]

const writeExpectedDiff = (entryOut: string, quality: Quality | null): void => {
  if (quality === null || (quality.urls === null && quality.names === null)) return
  const body = expectedDiffLines(quality)
  fs.writeFileSync(path.join(entryOut, "expected.diff"), body.map((line) => `${line}\n`).join(""))
}

const below = (label: string, value: number, min: number | undefined, format = formatRatio): readonly string[] =>
  min !== undefined && value < min ? [`${label} ${format(value)}<${format(min)}`] : []

const missingList = (file: string | undefined, comparison: unknown): readonly string[] =>
  file !== undefined && comparison === null ? [`missing expected list ${file}`] : []

const qualityFailures = (expect: Expectation, quality: Quality): readonly string[] => {
  const { urls, names, nameEdges } = quality
  return [
    ...missingList(expect.expectedUrls, urls),
    ...missingList(expect.expectedNames, names),
    ...(urls === null ? [] : below("recall", urls.recall, expect.minRecall)),
    ...(urls === null ? [] : below("precision", urls.precision, expect.minPrecision)),
    ...(names === null ? [] : below("names", names.recall, expect.minNameRecall)),
    ...(nameEdges === null ? [] : below("nameEdges", nameEdges, expect.minNameEdges, String)),
    ...below("tree", quality.treeCoverage, expect.minTreeCoverage),
    ...below("testIds", quality.testIds, expect.minTestIds, String),
  ]
}

const qualitySummary = (quality: Quality): string => {
  const urls =
    quality.urls === null
      ? []
      : [`recall ${formatRatio(quality.urls.recall)}`, `precision ${formatRatio(quality.urls.precision)}`]
  const names = quality.names === null ? [] : [`names ${formatRatio(quality.names.recall)}`]
  const nameEdges = quality.nameEdges === null ? [] : [`nameEdges ${String(quality.nameEdges)}`]
  return [
    ...urls,
    ...names,
    ...nameEdges,
    `tree ${formatRatio(quality.treeCoverage)}`,
    `testIds ${String(quality.testIds)}`,
  ].join(", ")
}

const needsQuality = (expect: Expectation): boolean =>
  [
    expect.expectedUrls,
    expect.minRecall,
    expect.minPrecision,
    expect.minTreeCoverage,
    expect.minTestIds,
    expect.expectedNames,
    expect.minNameRecall,
    expect.minNameEdges,
  ].some((value) => value !== undefined)

const AUTH_ROW_SEPARATOR = "\t"

const verdictOf = (value: string): AuthVerdict => AUTH_VERDICTS.find((verdict) => verdict === value) ?? "unknown"

const authByShape = (authRows: readonly string[]): ReadonlyMap<string, readonly AuthVerdict[]> => {
  const byShape = new Map<string, readonly AuthVerdict[]>()
  authRows.forEach((row) => {
    const [url = "", auth = ""] = row.split(AUTH_ROW_SEPARATOR)
    const shape = shapeOf(url)
    byShape.set(shape, [...(byShape.get(shape) ?? []), verdictOf(auth)])
  })
  return byShape
}

const authFailure = (url: string, expected: AuthVerdict, actual: readonly AuthVerdict[] | undefined): readonly string[] => {
  if (actual === undefined) return [`auth missing ${url}`]
  const wrong = sortedUnique(actual).filter((auth) => auth !== expected)
  return wrong.length === 0 ? [] : [`auth ${url} ${wrong.join("|")}≠${expected}`]
}

const authFailures = (expect: Expectation, authRows: readonly string[]): readonly string[] => {
  if (expect.expectAuth === undefined) return []
  const byShape = authByShape(authRows)
  return Object.entries(expect.expectAuth).flatMap(([url, expected]) =>
    authFailure(url, expected, byShape.get(shapeOf(url))),
  )
}

const expectationFailures = (
  expect: Expectation,
  screens: number | null,
  errors: number,
  diagnostics: readonly Diagnostic[],
  snapshots: Readonly<Record<SnapshotName, readonly string[]>>,
  quality: Quality | null,
): readonly string[] => {
  const codes = new Set(diagnostics.map((diagnostic) => diagnostic.code))
  const present = (expect.absentCodes ?? []).filter((code) => codes.has(code))
  const absent = (expect.presentCodes ?? []).filter((code) => !codes.has(code))
  const missing = (expect.urlsInclude ?? []).filter((url) => !snapshots.urls.includes(url))
  return [
    ...(expect.minScreens !== undefined && (screens ?? 0) < expect.minScreens
      ? [`screens ${String(screens ?? 0)}<${String(expect.minScreens)}`]
      : []),
    ...(expect.maxErrors !== undefined && errors > expect.maxErrors
      ? [`errors ${String(errors)}>${String(expect.maxErrors)}`]
      : []),
    ...present.map((code) => `has ${code}`),
    ...absent.map((code) => `lacks ${code}`),
    ...missing.map((url) => `missing ${url}`),
    ...authFailures(expect, snapshots.auth),
    ...(quality === null ? [] : qualityFailures(expect, quality)),
  ]
}

const expectationFor = (entry: CorpusEntry, failures: readonly string[], quality: Quality | null): string => {
  if (entry.expect === undefined) return NO_VALUE
  const verdict = failures.length === 0 ? "PASS" : `FAIL ${failures.join("; ")}`
  return quality === null ? verdict : `${verdict} (${qualitySummary(quality)})`
}

const configArgs = (entry: CorpusEntry): readonly string[] =>
  entry.config === undefined ? [] : ["--config", path.resolve(repoRoot, entry.config)]

const analyzeEntry = (entry: CorpusEntry): RunResult => {
  const root = projectRoot(entry)
  if (!fs.existsSync(root)) return failedResult(entry, `missing root ${entry.root}`)
  const entryOut = path.join(outDir, entry.id)
  fs.rmSync(entryOut, { recursive: true, force: true })
  const [command = "", ...args] = appgraphCommand()
  const started = performance.now()
  const result = spawnSync(command, [...args, "--root", root, "--out", entryOut, "--json", "--no-timestamp", "--format", "full", ...(entry.args ?? []), ...configArgs(entry)], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: ANALYZE_TIMEOUT_MS,
  })
  const durationMs = Math.round(performance.now() - started)
  fs.mkdirSync(entryOut, { recursive: true })
  fs.writeFileSync(path.join(entryOut, "run.stdout.json"), result.stdout ?? "")
  fs.writeFileSync(path.join(entryOut, "run.stderr.txt"), result.stderr ?? "")
  const json = parseJson(result.stdout ?? "")
  if (json === null) {
    const reason = result.error?.message ?? (result.stderr ?? "").trim().split("\n").at(-1) ?? "no JSON output"
    return failedResult(entry, reason, durationMs)
  }
  const diagnostics = json.diagnostics ?? []
  const counts = json.counts ?? {}
  const snapshots = writeSnapshots(entryOut)
  const lines = snapshots.urls
  const errors = countSeverity(diagnostics, "error")
  const screens = counts["screens"] ?? null
  const quality = entry.expect !== undefined && needsQuality(entry.expect) ? qualityOf(entry.expect, entryOut) : null
  writeExpectedDiff(entryOut, quality)
  const failures =
    entry.expect === undefined ? [] : expectationFailures(entry.expect, screens, errors, diagnostics, snapshots, quality)
  return {
    entry,
    commit: git(["rev-parse", "--short", "HEAD"], checkoutDir(entry)),
    durationMs,
    exitCode: json.exitCode,
    screens,
    errors,
    warnings: countSeverity(diagnostics, "warning"),
    topCodes: topCodes(diagnostics),
    counts,
    failure: null,
    urlDiff: snapshotDiffFor("urls", entry, lines, entryOut),
    authDiff: snapshotDiffFor("auth", entry, snapshots.auth, entryOut),
    expectation: expectationFor(entry, failures, quality),
  }
}

const TIME_WRAPPERS = {
  darwin: { command: "/usr/bin/time", flag: "-l", rss: /(\d+)\s+maximum resident set size/, bytesPerUnit: 1 },
  linux: { command: "/usr/bin/time", flag: "-v", rss: /Maximum resident set size \(kbytes\):\s*(\d+)/, bytesPerUnit: 1024 },
} as const

const BYTES_PER_MB = 1024 * 1024
const BENCH_ARGS = ["--timing", "--json", "--no-timestamp"] as const

type BenchSample = {
  readonly wallMs: number
  readonly rssMb: number | null
  readonly phases: Readonly<Record<string, number>>
}

type BenchResult = {
  readonly id: string
  readonly runs: number
  readonly wallMs: number | null
  readonly rssMb: number | null
  readonly phases: Readonly<Record<string, number>>
  readonly queryP50Ms: number | null
  readonly failure: string | null
}

type BenchFile = {
  readonly generatedAt: string
  readonly runs: number
  readonly results: readonly BenchResult[]
}

const timeWrapper = () => (process.platform === "darwin" ? TIME_WRAPPERS.darwin : TIME_WRAPPERS.linux)

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle] ?? 0
  if (sorted.length % 2 === 1) return upper
  return ((sorted[middle - 1] ?? upper) + upper) / 2
}

const parseRssMb = (stderr: string): number | null => {
  const wrapper = timeWrapper()
  const match = wrapper.rss.exec(stderr)
  if (match === null) return null
  return (Number(match[1]) * wrapper.bytesPerUnit) / BYTES_PER_MB
}

const entryCliArgs = (entry: CorpusEntry, out: string): readonly string[] => [
  "--root",
  projectRoot(entry),
  "--out",
  out,
  ...(entry.args ?? []),
  ...configArgs(entry),
]

const spawnOptions = (entry: CorpusEntry) => ({
  cwd: projectRoot(entry),
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
  timeout: ANALYZE_TIMEOUT_MS,
}) as const

const benchSample = (entry: CorpusEntry, out: string): BenchSample | string => {
  const [command = "", ...args] = appgraphCommand()
  const wrapper = timeWrapper()
  const started = performance.now()
  const result = spawnSync(
    wrapper.command,
    [wrapper.flag, command, ...args, ...entryCliArgs(entry, out), ...BENCH_ARGS],
    spawnOptions(entry),
  )
  const wallMs = performance.now() - started
  const json = parseJson(result.stdout)
  if (json === null) return result.error?.message ?? result.stderr.trim().split("\n").at(-1) ?? "no JSON output"
  return { wallMs, rssMb: parseRssMb(result.stderr), phases: json.timing ?? {} }
}

const queryMs = (entry: CorpusEntry, out: string): number | null => {
  const [command = "", ...args] = appgraphCommand()
  const started = performance.now()
  const result = spawnSync(command, [...args, "stats", "--cached", "--json", ...entryCliArgs(entry, out)], spawnOptions(entry))
  const elapsed = performance.now() - started
  return result.status === 0 ? elapsed : null
}

const collect = <T>(count: number, task: () => T): readonly T[] => Array.from({ length: count }, task)

const medianPhases = (samples: readonly BenchSample[]): Readonly<Record<string, number>> => {
  const names = [...new Set(samples.flatMap((sample) => Object.keys(sample.phases)))]
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = median(samples.flatMap((sample) => sample.phases[name] ?? []))
      return value === null ? [] : [[name, value]]
    }),
  )
}

const failedBench = (entry: CorpusEntry, runs: number, failure: string): BenchResult => ({
  id: entry.id,
  runs,
  wallMs: null,
  rssMb: null,
  phases: {},
  queryP50Ms: null,
  failure,
})

const benchEntry = (entry: CorpusEntry, runs: number): BenchResult => {
  if (!fs.existsSync(projectRoot(entry))) return failedBench(entry, runs, `missing root ${entry.root}`)
  const out = path.join(cli.values.dir, "bench", entry.id)
  fs.rmSync(out, { recursive: true, force: true })
  const attempts = collect(runs, () => benchSample(entry, out))
  const failure = attempts.find((attempt) => typeof attempt === "string")
  if (typeof failure === "string") return failedBench(entry, runs, failure)
  const samples = attempts.flatMap((attempt) => (typeof attempt === "string" ? [] : [attempt]))
  return {
    id: entry.id,
    runs,
    wallMs: median(samples.map((sample) => sample.wallMs)),
    rssMb: median(samples.flatMap((sample) => sample.rssMb ?? [])),
    phases: medianPhases(samples),
    queryP50Ms: median(collect(runs, () => queryMs(entry, out)).flatMap((value) => value ?? [])),
    failure: null,
  }
}

const formatMs = (value: number | null): string => (value === null ? NO_VALUE : `${value.toFixed(1)}ms`)

const formatMb = (value: number | null): string => (value === null ? NO_VALUE : `${value.toFixed(0)}MB`)

const formatDelta = (before: number | null | undefined, after: number | null | undefined): string => {
  if (before === null || before === undefined || after === null || after === undefined || before === 0) return ""
  const percent = ((after - before) / before) * 100
  return ` (${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%)`
}

const benchLines = (result: BenchResult, before: BenchResult | undefined): readonly string[] => {
  if (result.failure !== null) return [`${result.id}  FAIL ${result.failure}`]
  const phaseRows = Object.entries(result.phases).map(
    ([name, ms]) => `    ${name.padEnd(24)} ${formatMs(ms)}${formatDelta(before?.phases[name], ms)}`,
  )
  return [
    `${result.id}  runs=${String(result.runs)}`,
    `    ${"wall (median)".padEnd(24)} ${formatMs(result.wallMs)}${formatDelta(before?.wallMs, result.wallMs)}`,
    `    ${"max RSS (median)".padEnd(24)} ${formatMb(result.rssMb)}${formatDelta(before?.rssMb, result.rssMb)}`,
    ...phaseRows,
    `    ${"query stats --cached p50".padEnd(24)} ${formatMs(result.queryP50Ms)}${formatDelta(before?.queryP50Ms, result.queryP50Ms)}`,
  ]
}

const readBenchFile = (file: string): BenchFile | null => {
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, "utf8")) as BenchFile
}

const parseRuns = (value: string | undefined): number => {
  const runs = Number.parseInt(value ?? "", 10)
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a positive integer, got ${value ?? ""}`)
  return runs
}

const runBench = (entries: readonly CorpusEntry[]): void => {
  const runs = parseRuns(cli.values.runs)
  const baselineFile = cli.values["bench-baseline"]
  const baseline = baselineFile === undefined ? null : readBenchFile(path.resolve(baselineFile))
  if (baselineFile !== undefined && baseline === null) throw new Error(`bench baseline not found: ${baselineFile}`)
  const results = entries.map((entry) => {
    console.error(`bench ${entry.id} ${entry.repo}/${entry.root} x${String(runs)}`)
    const result = benchEntry(entry, runs)
    console.log(benchLines(result, baseline?.results.find((item) => item.id === entry.id)).join("\n"))
    return result
  })
  const file: BenchFile = { generatedAt: new Date().toISOString(), runs, results }
  fs.mkdirSync(cli.values.dir, { recursive: true })
  fs.writeFileSync(path.join(cli.values.dir, "bench.json"), JSON.stringify(file, null, 2))
}

const status = (result: RunResult): string => {
  if (result.failure !== null) return "FAIL"
  if (result.screens === null || result.screens === 0) return "EMPTY"
  if (result.errors > 0) return "ERR"
  return result.warnings > 0 ? "WARN" : "OK"
}

const markdownRow = (result: RunResult): string =>
  [
    result.entry.id,
    `${result.entry.stack} ${STACKS[result.entry.stack]}`,
    result.entry.repo,
    result.entry.root,
    status(result),
    String(result.exitCode ?? "—"),
    String(result.screens ?? "—"),
    String(result.errors),
    String(result.warnings),
    `${(result.durationMs / 1000).toFixed(1)}s`,
    result.failure ?? result.topCodes.join(", "),
    result.urlDiff,
    result.authDiff,
    result.expectation,
  ]
    .map((cell) => cell.replaceAll("|", "\\|"))
    .join(" | ")

const MARKDOWN_HEADER = [
  "| ID | Stack | Repo | Root | Status | Exit | Screens | Errors | Warnings | Time | Top codes / failure | URL diff | Auth diff | Expect |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
] as const

const toMarkdown = (results: readonly RunResult[], generatedAt: string): string =>
  [
    `# appgraph corpus run`,
    "",
    `Generated: ${generatedAt}`,
    "",
    ...MARKDOWN_HEADER,
    ...results.map((result) => `| ${markdownRow(result)} |`),
    "",
  ].join("\n")

const snapshotOnly = (dir: string): void => {
  const root = path.resolve(dir)
  const ids = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((item) => item.isDirectory() && fs.existsSync(path.join(root, item.name, "run.stdout.json")))
    .map((item) => item.name)
    .sort(byCodePoint)
  ids.forEach((id) => {
    const snapshots = writeSnapshots(path.join(root, id))
    console.log(`${id} ${String(snapshots.urls.length)} ${String(snapshots.auth.length)}`)
  })
  console.log(`wrote ${String(ids.length)} urls.txt and auth.txt`)
}

const main = async (): Promise<void> => {
  const snapshotDir = cli.values["snapshot-only"]
  if (snapshotDir !== undefined) return snapshotOnly(snapshotDir)
  const entries = selectEntries()
  if (entries.length === 0) throw new Error("no corpus entries match the filters")
  fs.mkdirSync(reposDir, { recursive: true })
  fs.mkdirSync(outDir, { recursive: true })

  const cloneFailures = cli.values["skip-clone"]
    ? entries.map(() => null)
    : await runPool(entries, CLONE_CONCURRENCY, async (entry) => {
        console.error(`sync ${entry.id} ${entry.repo}`)
        return syncEntry(entry)
      })

  if (cli.values.bench) return runBench(entries.filter((_, index) => cloneFailures[index] === null))

  const results = entries.map((entry, index) => {
    const cloneFailure = cloneFailures[index] ?? null
    if (cloneFailure !== null) return failedResult(entry, cloneFailure)
    console.error(`analyze ${entry.id} ${entry.repo}/${entry.root}`)
    const result = analyzeEntry(entry)
    console.error(`  ${status(result)} screens=${String(result.screens ?? "—")} ${String(result.durationMs)}ms`)
    return result
  })

  const generatedAt = new Date().toISOString()
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({ generatedAt, results }, null, 2))
  const markdown = toMarkdown(results, generatedAt)
  fs.writeFileSync(path.join(outDir, "summary.md"), markdown)
  console.log(markdown)
}

await main()
