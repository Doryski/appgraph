import type { Evidence } from "../core/model.js"
import { byNumber, sortedUnique, thenBy } from "../core/order.js"
import { ANGULAR_HTTP_PACKAGE, HTTP_CLIENT_PACKAGES } from "../extractors/http-client.js"
import { DEFAULT_CANDIDATE_ATTRIBUTES } from "../extractors/test-ids.js"
import type { ProjectProbe } from "./project.js"
import { lineAt } from "../adapters/source-utils.js"
import { isSourceFile } from "../core/extensions.js"
import { resolveTemplateUrl } from "../adapters/angular/template.js"

export const TEST_ID_ATTRIBUTES = DEFAULT_CANDIDATE_ATTRIBUTES

export type TestIdAttribute = (typeof TEST_ID_ATTRIBUTES)[number]

/** §10.5: the prose the index must print when the histogram is all zeros. */
export const NO_TEST_IDS_NOTICE =
  "this repository declares no test-id attributes; select elements by role or visible text."

export const TEST_ID_SCAN_LIMITS = { maxFiles: 20_000, maxBytes: 512_000 } as const

export type TestIdCount = {
  readonly attribute: TestIdAttribute
  readonly count: number
  readonly files: number
  readonly firstSeen: Evidence | null
}

/**
 * The result of the probe HAVING RUN. `attribute: null` with an all-zero histogram is the legible
 * "there are none" outcome; "the probe never ran" is the absence of this object entirely (§10.5).
 */
export type TestIdProbe = {
  readonly attribute: TestIdAttribute | null
  /** Every candidate, always, including the zeros. */
  readonly histogram: readonly TestIdCount[]
  readonly filesScanned: number
  readonly filesSkipped: number
  readonly totalOccurrences: number
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const matcherFor = (attribute: TestIdAttribute): RegExp => new RegExp(`(?<![\\w-])${escapeRegExp(attribute)}(?![\\w-])`, "g")

const preferenceOf = (attribute: TestIdAttribute): number => TEST_ID_ATTRIBUTES.indexOf(attribute)

const ANGULAR_CORE = "@angular/core"
const TEMPLATE_URL = /templateUrl\s*:\s*(["'`])([^"'`$]+)\1/g

const templateUrlsIn = (file: string, text: string): readonly string[] =>
  [...text.matchAll(TEMPLATE_URL)].map((match) => resolveTemplateUrl(file, match[2] ?? ""))

const pairedTemplatesOf = (probe: ProjectProbe): readonly string[] => {
  if (!probe.context.hasDependency(ANGULAR_CORE)) return []
  const referenced = probe.probeFiles().flatMap((file) => {
    const text = probe.readFile(file)
    return text === null ? [] : templateUrlsIn(file, text)
  })
  return sortedUnique(referenced).filter((file) => probe.readFile(file) !== null)
}

export type TestIdProbeOptions = {
  readonly maxFiles?: number
  readonly maxBytes?: number
}

/**
 * Bounded on purpose: the histogram is evidence, not an index, and many apps
 * contribute nothing but zeros to it.
 */
export const probeTestIdAttribute = (probe: ProjectProbe, options: TestIdProbeOptions = {}): TestIdProbe => {
  const maxFiles = options.maxFiles ?? TEST_ID_SCAN_LIMITS.maxFiles
  const maxBytes = options.maxBytes ?? TEST_ID_SCAN_LIMITS.maxBytes

  const counts = new Map<TestIdAttribute, { count: number; files: number; firstSeen: Evidence | null }>(
    TEST_ID_ATTRIBUTES.map((attribute) => [attribute, { count: 0, files: 0, firstSeen: null }]),
  )

  const candidates = [...probe.probeFiles().filter(isSourceFile), ...pairedTemplatesOf(probe)]
  let scanned = 0
  let skipped = 0

  for (const file of candidates) {
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

    for (const attribute of TEST_ID_ATTRIBUTES) {
      const matcher = matcherFor(attribute)
      let hits = 0
      let first = -1
      for (let match = matcher.exec(text); match !== null; match = matcher.exec(text)) {
        hits += 1
        if (first === -1) first = match.index
      }
      if (hits === 0) continue

      const entry = counts.get(attribute)
      if (entry === undefined) continue
      entry.count += hits
      entry.files += 1
      entry.firstSeen =
        entry.firstSeen ?? { what: `${attribute} attribute`, file, line: lineAt(text, first) }
    }
  }

  const histogram: readonly TestIdCount[] = [...counts.entries()]
    .map(([attribute, entry]) => ({
      attribute,
      count: entry.count,
      files: entry.files,
      firstSeen: entry.firstSeen,
    }))
    .sort(
      thenBy<TestIdCount>(
        (a, b) => byNumber(b.count, a.count),
        (a, b) => byNumber(preferenceOf(a.attribute), preferenceOf(b.attribute)),
      ),
    )

  const winner = histogram[0]
  const total = histogram.reduce((sum, entry) => sum + entry.count, 0)

  return {
    attribute: winner === undefined || winner.count === 0 ? null : winner.attribute,
    histogram,
    filesScanned: scanned,
    filesSkipped: skipped,
    totalOccurrences: total,
  }
}

// ---------------------------------------------------------------------------
// Library detection (§10.5)
// ---------------------------------------------------------------------------

export const LIBRARY_GROUPS = ["query", "store", "i18n", "forms", "http"] as const

export type LibraryGroup = (typeof LIBRARY_GROUPS)[number]

type LibrarySignal = {
  readonly group: LibraryGroup
  /** Any one of these enables the group. */
  readonly packages: readonly string[]
  /** Recorded when present, never enabling on its own (a validator without a form library is not forms). */
  readonly companions?: readonly string[]
}

export const LIBRARY_SIGNALS: readonly LibrarySignal[] = [
  {
    group: "query",
    packages: ["@tanstack/react-query", "@tanstack/query-core", "react-query", "swr", "convex", "@convex-dev/react-query", "@tanstack/vue-query"],
  },
  { group: "store", packages: ["zustand", "jotai", "valtio", "@reduxjs/toolkit", "redux", "react-redux", "mobx", "pinia", "vuex", "@ngrx/store"] },
  { group: "i18n", packages: ["react-i18next", "i18next", "next-intl", "react-intl", "vue-i18n", "@nuxtjs/i18n", "@ngx-translate/core", "@angular/localize", "@lingui/core", "@lingui/react", "@lingui/macro"] },
  {
    group: "forms",
    packages: ["react-hook-form", "formik", "react-final-form"],
    companions: ["zod", "yup", "valibot"],
  },
  { group: "http", packages: [...HTTP_CLIENT_PACKAGES, ANGULAR_HTTP_PACKAGE] },
]

export type LibraryDetection = {
  readonly group: LibraryGroup
  readonly enabled: boolean
  readonly matched: readonly string[]
  readonly companions: readonly string[]
}

export const detectLibraries = (dependencies: ReadonlySet<string>): readonly LibraryDetection[] =>
  LIBRARY_SIGNALS.map((signal) => {
    const matched = sortedUnique(signal.packages.filter((name) => dependencies.has(name)))
    const companions = sortedUnique((signal.companions ?? []).filter((name) => dependencies.has(name)))
    return { group: signal.group, enabled: matched.length > 0, matched, companions }
  })

export const enabledLibraryGroups = (detections: readonly LibraryDetection[]): readonly LibraryGroup[] =>
  detections.filter((entry) => entry.enabled).map((entry) => entry.group)
