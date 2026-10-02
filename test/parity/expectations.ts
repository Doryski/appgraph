import * as fs from "node:fs"
import * as path from "node:path"
import { requireGolden } from "./golden-target.js"

/**
 * The application-specific values the acceptance suite asserts, read from the external golden.
 *
 * These are route names, module paths, endpoint URLs and counts belonging to a private application.
 * They are NOT held in this repository: keeping them here would publish the very thing the golden was
 * moved out for. `expectations.json` sits next to the golden YAML, behind the same pointer, and the
 * suite that consumes it already skips when the pointer is absent.
 *
 * Parsed through explicit narrowing rather than a cast: a malformed expectations file must fail with
 * "expectations.json: …" rather than surface later as an unrelated assertion failure.
 */
export type ParityExpectations = {
  readonly label: string
  readonly screenUrlCount: number
  readonly componentKeyCount: number
  readonly navigationEdgeCount: number
  readonly menuPathCount: number
  readonly manifestCounts: Readonly<Record<string, number>>
  readonly shells: readonly string[]
  readonly coverageWitnesses: readonly {
    readonly url: string
    readonly endpoints: number
    readonly testIds: number
    readonly reachable: number
  }[]
  readonly zeroEntryRedirects: Readonly<Record<string, string>>
  readonly navShadowingWitnesses: readonly {
    readonly from: string
    readonly to: string
    readonly trigger: string
    readonly via: readonly string[]
  }[]
  readonly testIdWitness: { readonly url: string; readonly count: number }
  readonly extraMenuGroup: {
    readonly name: string
    readonly source: string
    readonly paths: readonly string[]
  }
  readonly deadNavLinks: readonly string[]
  readonly gainedEntries: readonly string[]
  readonly extraShell: string
  readonly shellCount: number
  readonly entry0Differences: { readonly count: number; readonly urls: readonly string[] }
  readonly pinnedCounts: Readonly<Record<string, number>>
  readonly emittedFiles: readonly string[]
}

export const EXPECTATIONS_FILE = "expectations.json"

const fail = (what: string): never => {
  throw new Error(`${EXPECTATIONS_FILE}: ${what}`)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const at = (source: Record<string, unknown>, key: string, where: string): unknown => {
  if (!(key in source)) fail(`missing '${where}${key}'`)
  return source[key]
}

const str = (value: unknown, where: string): string =>
  typeof value === "string" ? value : fail(`${where} is not a string`)

const num = (value: unknown, where: string): number =>
  typeof value === "number" ? value : fail(`${where} is not a number`)

const list = (value: unknown, where: string): readonly unknown[] =>
  Array.isArray(value) ? value : fail(`${where} is not an array`)

const record = (value: unknown, where: string): Record<string, unknown> =>
  isRecord(value) ? value : fail(`${where} is not an object`)

const strings = (value: unknown, where: string): readonly string[] =>
  list(value, where).map((entry, index) => str(entry, `${where}[${String(index)}]`))

const numberMap = (value: unknown, where: string): Readonly<Record<string, number>> =>
  Object.fromEntries(
    Object.entries(record(value, where)).map(([key, entry]) => [key, num(entry, `${where}.${key}`)]),
  )

const stringMap = (value: unknown, where: string): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(record(value, where)).map(([key, entry]) => [key, str(entry, `${where}.${key}`)]),
  )

const parse = (raw: unknown): ParityExpectations => {
  const root = record(raw, "document")
  const field = (key: string): unknown => at(root, key, "")
  const sub = (key: string): Record<string, unknown> => record(field(key), key)

  const testIdWitness = sub("testIdWitness")
  const extraMenuGroup = sub("extraMenuGroup")
  const entry0Differences = sub("entry0Differences")

  return {
    label: str(field("label"), "label"),
    screenUrlCount: num(field("screenUrlCount"), "screenUrlCount"),
    componentKeyCount: num(field("componentKeyCount"), "componentKeyCount"),
    navigationEdgeCount: num(field("navigationEdgeCount"), "navigationEdgeCount"),
    menuPathCount: num(field("menuPathCount"), "menuPathCount"),
    manifestCounts: numberMap(field("manifestCounts"), "manifestCounts"),
    shells: strings(field("shells"), "shells"),
    coverageWitnesses: list(field("coverageWitnesses"), "coverageWitnesses").map((entry, index) => {
      const row = record(entry, `coverageWitnesses[${String(index)}]`)
      const where = `coverageWitnesses[${String(index)}]`
      return {
        url: str(at(row, "url", `${where}.`), `${where}.url`),
        endpoints: num(at(row, "endpoints", `${where}.`), `${where}.endpoints`),
        testIds: num(at(row, "testIds", `${where}.`), `${where}.testIds`),
        reachable: num(at(row, "reachable", `${where}.`), `${where}.reachable`),
      }
    }),
    zeroEntryRedirects: stringMap(field("zeroEntryRedirects"), "zeroEntryRedirects"),
    navShadowingWitnesses: list(field("navShadowingWitnesses"), "navShadowingWitnesses").map(
      (entry, index) => {
        const where = `navShadowingWitnesses[${String(index)}]`
        const row = record(entry, where)
        return {
          from: str(at(row, "from", `${where}.`), `${where}.from`),
          to: str(at(row, "to", `${where}.`), `${where}.to`),
          trigger: str(at(row, "trigger", `${where}.`), `${where}.trigger`),
          via: strings(at(row, "via", `${where}.`), `${where}.via`),
        }
      },
    ),
    testIdWitness: {
      url: str(at(testIdWitness, "url", "testIdWitness."), "testIdWitness.url"),
      count: num(at(testIdWitness, "count", "testIdWitness."), "testIdWitness.count"),
    },
    extraMenuGroup: {
      name: str(at(extraMenuGroup, "name", "extraMenuGroup."), "extraMenuGroup.name"),
      source: str(at(extraMenuGroup, "source", "extraMenuGroup."), "extraMenuGroup.source"),
      paths: strings(at(extraMenuGroup, "paths", "extraMenuGroup."), "extraMenuGroup.paths"),
    },
    deadNavLinks: strings(field("deadNavLinks"), "deadNavLinks"),
    gainedEntries: strings(field("gainedEntries"), "gainedEntries"),
    extraShell: str(field("extraShell"), "extraShell"),
    shellCount: num(field("shellCount"), "shellCount"),
    entry0Differences: {
      count: num(at(entry0Differences, "count", "entry0Differences."), "entry0Differences.count"),
      urls: strings(at(entry0Differences, "urls", "entry0Differences."), "entry0Differences.urls"),
    },
    pinnedCounts: numberMap(field("pinnedCounts"), "pinnedCounts"),
    emittedFiles: strings(field("emittedFiles"), "emittedFiles"),
  }
}

export const readExpectations = (): ParityExpectations =>
  parse(JSON.parse(fs.readFileSync(path.join(requireGolden(), EXPECTATIONS_FILE), "utf8")) as unknown)
