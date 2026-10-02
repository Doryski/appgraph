import { describe, expect, it } from "vitest"
import { CONFIDENCE_STATUSES, confidenceStatus } from "../../src/core/confidence.js"
import type { ConfidenceStatus } from "../../src/core/confidence.js"
import type { SectionConfidence } from "../../src/core/model.js"
import {
  SCREEN_SCALED_CHANNELS,
  SPARSE_SCREEN_RATIO,
  isSparseForScale,
} from "../../src/pipeline/phases.js"

const entry = (overrides: Partial<SectionConfidence> = {}): SectionConfidence => ({
  section: "stores",
  count: 0,
  enablingDependency: null,
  dependencyInstalled: false,
  level: "low",
  ...overrides,
})

type Row = {
  readonly name: string
  readonly input: Partial<SectionConfidence>
  readonly expected: ConfidenceStatus
}

const TABLE: readonly Row[] = [
  { name: "facts found, level high", input: { count: 3, level: "high" }, expected: "ok" },
  { name: "facts found, level low", input: { count: 3, level: "low" }, expected: "partial" },
  { name: "facts found, level suspect", input: { count: 3, level: "suspect" }, expected: "partial" },
  { name: "empty, no dependency, level low", input: { count: 0, level: "low" }, expected: "empty-expected" },
  {
    name: "empty, dependency declared but not installed",
    input: { count: 0, level: "low", enablingDependency: "zustand", dependencyInstalled: false },
    expected: "empty-expected",
  },
  {
    name: "empty, dependency installed",
    input: { count: 0, level: "low", enablingDependency: "zustand", dependencyInstalled: true },
    expected: "empty-unexpected",
  },
  {
    name: "empty, level suspect without a named dependency",
    input: { count: 0, level: "suspect" },
    expected: "empty-unexpected",
  },
  {
    name: "empty, level high (kernel never emits this) stays expected",
    input: { count: 0, level: "high" },
    expected: "empty-expected",
  },
]

describe("confidenceStatus", () => {
  for (const row of TABLE) {
    it(`maps ${row.name} to ${row.expected}`, () => {
      expect(confidenceStatus(entry(row.input))).toBe(row.expected)
    })
  }

  it("covers every declared status and nothing else", () => {
    expect(CONFIDENCE_STATUSES).toEqual(["ok", "partial", "empty-expected", "empty-unexpected"])
    expect(new Set(TABLE.map((row) => row.expected))).toEqual(new Set(CONFIDENCE_STATUSES))
  })
})

describe("isSparseForScale — the size-aware confidence rule", () => {
  /**
   * The false negative this guards: `endpoints  count=1  level=high  status=ok` on a 99-screen admin
   * panel. An `enablingDependency` cannot catch it — that route to `suspect` only fires while
   * `count === 0` — and there is no single package to name, since endpoints come from axios, from bare
   * `fetch` and from `createServerFn` alike. Scale is the only available signal.
   */
  it("calls one endpoint across 99 screens sparse", () => {
    expect(isSparseForScale("endpoints", 1, 99)).toBe(true)
    expect(confidenceStatus(entry({ section: "endpoints", count: 1, level: "low" }))).toBe("partial")
  })

  it("leaves a healthy ratio alone", () => {
    expect(isSparseForScale("endpoints", 241, 99)).toBe(false)
    expect(isSparseForScale("endpoints", 61, 37)).toBe(false)
    expect(isSparseForScale("endpoints", 21, 9)).toBe(false)
  })

  it("never fires on an empty section, which the count-zero rules already own", () => {
    expect(isSparseForScale("endpoints", 0, 230)).toBe(false)
  })

  it("never fires on a section whose expected size is not the screen count", () => {
    expect(isSparseForScale("stores", 1, 99)).toBe(false)
    expect(isSparseForScale("screens", 1, 99)).toBe(false)
    expect(SCREEN_SCALED_CHANNELS).toEqual(["endpoints"])
  })

  it("cannot fire on a small app, where one fact per ten screens is one fact", () => {
    expect(isSparseForScale("endpoints", 1, SPARSE_SCREEN_RATIO)).toBe(false)
    expect(isSparseForScale("endpoints", 1, SPARSE_SCREEN_RATIO + 1)).toBe(true)
  })
})
