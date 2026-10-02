import * as fs from "node:fs"
import * as path from "node:path"
import type { ParitySnapshot, ScreenContract, ScreenCoverage } from "./model.js"
import { requireGolden } from "./golden-target.js"
import { readYaml, type YamlValue } from "./yaml-read.js"

/**
 * The golden is not part of this package — it is a frozen snapshot taken over a private application and
 * lives outside the repository, behind the `APPGRAPH_PARITY_GOLDEN` pointer. Resolved lazily so that
 * importing this module is harmless when no golden is configured; every caller sits behind a
 * `skipIf(golden === null)` gate.
 */
export const goldenDir = (): string => requireGolden()

/**
 * The SHA-256 sums the golden's `MANIFEST.md` recorded at capture time. The gate verifies them on every
 * run: a golden that has drifted invalidates every number the gate reports, and the one failure mode
 * §12.1 cannot tolerate is a golden quietly edited to make a test pass. The sums stay HERE, in the
 * package, on purpose — a checksum kept next to the file it checksums is not a check.
 */
export const GOLDEN_SHA256 = {
  "component-map.yaml": "f702024ec41f5ff04fe77f7002192e0dc4efe5a089ca9f20fa895eb4448f6e08",
  "component-map.index.yaml": "b8b52778989089b8cf56e84abb6091d300e197e19d18c6a37039fd9601414f44",
  "component-map.invoices-id.yaml": "9e5eb502891214109a7b8badd47c0eba525d20500afe8ffb6eff92b0ae3d9a82",
} as const

// The HTML report is deliberately absent from the golden set (§12.6): the reference implementation
// embeds `new Date().toISOString().slice(0, 16)` in it, so its bytes differ from themselves at minute
// granularity. What is asserted about the HTML lives in `test/emit/html.test.ts` and
// `test/cli/html-assets.test.ts`.

const isRecord = (value: YamlValue): value is Record<string, YamlValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const field = (row: Record<string, YamlValue>, key: string): YamlValue => {
  if (!(key in row)) throw new Error(`golden route is missing '${key}'`)
  return row[key] as YamlValue
}

const asString = (value: YamlValue, what: string): string => {
  if (typeof value !== "string") throw new Error(`${what}: expected string, got ${JSON.stringify(value)}`)
  return value
}

const asNullableString = (value: YamlValue, what: string): string | null =>
  value === null ? null : asString(value, what)

const asArray = (value: YamlValue, what: string): readonly YamlValue[] => {
  if (!Array.isArray(value)) throw new Error(`${what}: expected sequence, got ${JSON.stringify(value)}`)
  return value
}

const len = (value: YamlValue, what: string): number => asArray(value, what).length

export const readGoldenDocument = (file: keyof typeof GOLDEN_SHA256): Record<string, YamlValue> => {
  const text = fs.readFileSync(path.join(goldenDir(), file), "utf8")
  const parsed = readYaml(text)
  if (!isRecord(parsed)) throw new Error(`${file} did not parse as a mapping`)
  return parsed
}

/**
 * Projects the golden's `component-map.yaml` into the gate's shape. Every mapping below pairs a golden
 * field with its appgraph counterpart, recorded once here instead of being re-derived per assertion:
 *
 *   routes[]                 -> screens[] (+ stateScreens[] for the non-addressable ones)
 *   route.entries[0]         -> screen.entries[0].file
 *   route.endpoints[]        -> screen.facts.endpoints[] (split into http/rpc on emit)
 *   route.{stores,testIds,…} -> screen.facts.{stores,testIds,…}
 *   menu.items[]             -> navGroups[0].entries[]
 */
export const goldenSnapshot = (): ParitySnapshot => {
  const document = readGoldenDocument("component-map.yaml")
  const routes = asArray(field(document, "routes"), "routes").map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`routes[${String(index)}] is not a mapping`)
    return entry
  })

  const contracts: ScreenContract[] = routes.map((route) => {
    const url = asString(field(route, "url"), "route.url")
    const entries = asArray(field(route, "entries"), `${url}.entries`)
    const first = entries[0]
    return {
      url,
      entry0: first === undefined ? null : asString(first, `${url}.entries[0]`),
      params: asArray(field(route, "params"), `${url}.params`).map((value) => asString(value, `${url}.params[]`)),
      auth: asString(field(route, "auth"), `${url}.auth`),
      redirectTo: asNullableString(field(route, "redirectTo"), `${url}.redirectTo`),
    }
  })

  const entryLists = routes.map((route) => {
    const url = asString(field(route, "url"), "route.url")
    return {
      url,
      entries: asArray(field(route, "entries"), `${url}.entries`).map((value) =>
        asString(value, `${url}.entries[]`),
      ),
    }
  })

  const coverage: ScreenCoverage[] = routes.map((route) => {
    const url = asString(field(route, "url"), "route.url")
    return {
      url,
      reachable: len(field(route, "reachable"), `${url}.reachable`),
      endpoints: len(field(route, "endpoints"), `${url}.endpoints`),
      testIds: len(field(route, "testIds"), `${url}.testIds`),
      stores: len(field(route, "stores"), `${url}.stores`),
      queryKeys: len(field(route, "queryKeys"), `${url}.queryKeys`),
      i18nNamespaces: len(field(route, "i18nNamespaces"), `${url}.i18nNamespaces`),
      formSchemas: len(field(route, "formSchemas"), `${url}.formSchemas`),
      formFields: len(field(route, "formFields"), `${url}.formFields`),
      featureGates: len(field(route, "featureGates"), `${url}.featureGates`),
    }
  })

  const endpointsByScreen = Object.fromEntries(
    routes.map((route) => {
      const url = asString(field(route, "url"), "route.url")
      const list = asArray(field(route, "endpoints"), `${url}.endpoints`).map((entry) => {
        if (!isRecord(entry)) throw new Error(`${url}.endpoints[] is not a mapping`)
        return `${asString(field(entry, "method"), "endpoint.method")} ${asString(field(entry, "url"), "endpoint.url")}`
      })
      return [url, [...list].sort()] as const
    }),
  )

  const navigation = asArray(field(document, "navigation"), "navigation").map((entry) => {
    if (!isRecord(entry)) throw new Error("navigation[] is not a mapping")
    // `via` and `trigger` are part of the key: two different files navigating to the same target are
    // two edges, and collapsing them to `from -> to` would hide a lost one behind a surviving twin.
    return `${asString(field(entry, "from"), "nav.from")} -> ${asString(field(entry, "to"), "nav.to")} via ${asString(field(entry, "via"), "nav.via")} (${asString(field(entry, "trigger"), "nav.trigger")})`
  })

  const menu = field(document, "menu")
  const menuPaths = isRecord(menu)
    ? asArray(field(menu, "items"), "menu.items").map((entry) => {
        if (!isRecord(entry)) throw new Error("menu.items[] is not a mapping")
        return asString(field(entry, "path"), "menu.item.path")
      })
    : []

  const shellsBlock = field(document, "shells")
  const shells = isRecord(shellsBlock) ? Object.keys(shellsBlock) : []

  const componentsBlock = field(document, "components")
  const componentKeys = isRecord(componentsBlock) ? Object.keys(componentsBlock) : []

  const metaBlock = field(document, "meta")
  const countsBlock = isRecord(metaBlock) ? field(metaBlock, "counts") : null
  const counts = Object.fromEntries(
    Object.entries(isRecord(countsBlock) ? countsBlock : {}).map(([key, value]) => [key, Number(value)]),
  )

  return {
    label: "golden",
    contracts,
    entryLists,
    coverage,
    endpointsByScreen,
    navigationEdges: [...navigation].sort(),
    menuPaths,
    shells,
    componentKeys,
    counts,
  }
}
