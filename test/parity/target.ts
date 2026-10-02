import * as fs from "node:fs"
import * as path from "node:path"
import { validateConfig } from "../../src/config/load.js"
import type { AppgraphConfig } from "../../src/core/model.js"

export const TARGET_ENV_VAR = "APPGRAPH_PARITY_FIXTURE"

/**
 * What the target pointer names: the application checkout, the commit the golden describes, and the
 * target-specific half of the pinned config (`pinned.ts` holds the generic half). The commit and the
 * config describe the private application, so they live on the untracked side, next to the path.
 */
export type TargetPointer = {
  readonly root: string
  readonly commit: string | null
  readonly config: AppgraphConfig | null
}

const POINTER_SHAPE = `{ "root": "/abs/path", "commit": "<sha>", "config": { "stringSources": [...], "kindRules": [...] } }`

const pointerError = (what: string): never => {
  throw new Error(`${TARGET_ENV_VAR} / test/parity/target.local: ${what}. Expected a bare path or ${POINTER_SHAPE}`)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const optionalString = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key]
  if (value === undefined) return null
  if (typeof value !== "string" || value.trim() === "") return pointerError(`"${key}" must be a non-empty string`)
  return value.trim()
}

const pointerConfig = (raw: unknown): AppgraphConfig | null => {
  if (raw === undefined) return null
  const validated = validateConfig(raw)
  const problems = [
    ...validated.issues.map((issue) => `config.${issue.field}: ${issue.message}`),
    ...validated.unknownFields.map((field) => `config.${field}: unknown field`),
  ]
  if (problems.length > 0) return pointerError(problems.join("; "))
  return validated.config
}

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch (error) {
    return pointerError(`not valid JSON (${String(error)})`)
  }
}

const parseJsonPointer = (value: string): TargetPointer => {
  const parsed = parseJson(value)
  if (!isRecord(parsed)) return pointerError("not a JSON object")
  const root = optionalString(parsed, "root")
  if (root === null) return pointerError(`"root" is missing`)
  return { root, commit: optionalString(parsed, "commit"), config: pointerConfig(parsed["config"]) }
}

/**
 * Parses a target pointer. Two forms are accepted:
 *
 *   /abs/path/to/parity-target                                    the checkout only
 *   { "root": "/abs/path", "commit": "<sha>", "config": { … } }   the checkout, its pinned commit and the
 *                                                                 target-specific pinned config
 *
 * A bare path still names the checkout, but the acceptance suite refuses to measure it until a commit is
 * pinned. `config` goes through the same field-by-field validation as a user's config file; any issue or
 * unknown field is an error, because a silently dropped key would change what the pinned run means.
 */
export const parsePointer = (value: string): TargetPointer => {
  const trimmed = value.trim()
  return trimmed.startsWith("{") ? parseJsonPointer(trimmed) : { root: trimmed, commit: null, config: null }
}

/**
 * The parity target pointer, or `null` — in which case the real-repo gate skips cleanly.
 *
 * ## One channel, read in one place
 *
 * **Vitest 4 does not forward arbitrary environment variables to test workers**: each worker is spawned
 * with the allowlist `{ TEST, VITEST, NODE_ENV, VITEST_MODE, FORCE_TTY }` plus `test.env`, so
 * `APPGRAPH_PARITY_FIXTURE=… vitest run` reaches the CLI but reads back `undefined` in the test, and
 * `describe.skipIf` silently skips the whole suite. Forwarding is therefore `vitest.config.ts`'s job — see
 * the note there, including why a `process.env`-derived `test.env` value cannot work (the config file is
 * evaluated in the sanitized environment too). It forwards the whole trimmed content of `target.local`,
 * so the JSON form travels through the same variable; under `tsx`, pass the same content with
 * `APPGRAPH_PARITY_FIXTURE="$(cat test/parity/target.local)"`.
 *
 * A blank value counts as absent: `test.env` stringifies, so a channel that ever defaults to `""` must
 * not be mistaken for a configured target.
 */
export const parityTargetPointer = (): TargetPointer | null => {
  const fromEnv = process.env[TARGET_ENV_VAR]
  if (fromEnv === undefined || fromEnv.trim() === "") return null
  return parsePointer(fromEnv)
}

/** The application checkout, or `null` when no target is configured. */
export const parityTarget = (): string | null => parityTargetPointer()?.root ?? null

/** The message the skipped suite should carry, so "skipped" never looks like "passed". */
export const TARGET_HINT = `set ${TARGET_ENV_VAR} (tsx / report.mts) or write the target pointer into test/parity/target.local (vitest — see vitest.config.ts and test/parity/BASELINE.md)`

const readTrimmed = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8").trim()
  } catch {
    return null
  }
}

const gitDirOf = (root: string): string | null => {
  const dotGit = path.join(root, ".git")
  if (fs.statSync(dotGit, { throwIfNoEntry: false })?.isDirectory() === true) return dotGit
  const pointer = readTrimmed(dotGit)?.match(/^gitdir: (.+)$/)?.[1]
  return pointer === undefined ? null : path.resolve(root, pointer)
}

const commonDirOf = (gitDir: string): string => {
  const common = readTrimmed(path.join(gitDir, "commondir"))
  return common === null ? gitDir : path.resolve(gitDir, common)
}

const packedRef = (commonDir: string, ref: string): string | null =>
  (readTrimmed(path.join(commonDir, "packed-refs")) ?? "")
    .split("\n")
    .map((line) => line.split(" "))
    .find(([, name]) => name === ref)?.[0] ?? null

const resolveRef = (gitDir: string, ref: string): string | null =>
  readTrimmed(path.join(gitDir, ref)) ??
  readTrimmed(path.join(commonDirOf(gitDir), ref)) ??
  packedRef(commonDirOf(gitDir), ref)

/** The checked-out commit of `root`, read from `.git` directly (plain checkout or worktree), or `null`. */
export const targetHead = (root: string): string | null => {
  const gitDir = gitDirOf(root)
  if (gitDir === null) return null
  const head = readTrimmed(path.join(gitDir, "HEAD"))
  if (head === null) return null
  const ref = head.match(/^ref: (.+)$/)?.[1]
  return ref === undefined ? head : resolveRef(gitDir, ref)
}

/**
 * Why the pointer is not usable as the parity target, or `null` when its checkout is at its pinned commit.
 *
 * The golden describes one commit of the application, and the application keeps moving — every route
 * added after that commit is drift the golden cannot know about, and reads as a gate-1 failure that no
 * change to this package caused. Pinning the checkout keeps "red" meaning "appgraph changed", so the
 * target must be a detached worktree at exactly the pointer's `commit`.
 */
export const pinMismatch = ({ root, commit }: TargetPointer): string | null => {
  if (commit === null)
    return `the parity target pointer for ${root} names no pinned commit. Write test/parity/target.local as ${POINTER_SHAPE} (see test/parity/BASELINE.md)`
  const head = targetHead(root)
  if (head === commit) return null
  return `parity target ${root} is at ${head ?? "an unreadable HEAD"}, not the pinned commit ${commit}. Every difference would mix appgraph changes with application drift. Create a pinned worktree and point ${TARGET_ENV_VAR} / test/parity/target.local at it: git -C <app checkout> worktree add --detach <worktree path> ${commit}`
}
