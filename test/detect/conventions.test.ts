import ts from "typescript"
import { describe, expect, it } from "vitest"
import { createMemoryHost } from "../../src/core/host.js"
import {
  NO_TEST_IDS_NOTICE,
  TEST_ID_ATTRIBUTES,
  detectLibraries,
  enabledLibraryGroups,
  probeTestIdAttribute,
} from "../../src/detect/conventions.js"
import { runDetection } from "../../src/detect/index.js"
import { DEFAULT_CANDIDATE_ATTRIBUTES } from "../../src/extractors/test-ids.js"
import { createProjectProbe } from "../../src/detect/project.js"

const ROOT = "/repo"

const TSCONFIG = JSON.stringify({ compilerOptions: { baseUrl: "." }, include: ["src"] })

const probeOf = (files: Readonly<Record<string, string>>) =>
  createProjectProbe({
    ts,
    root: ROOT,
    host: createMemoryHost({
      files: Object.fromEntries(
        Object.entries({ "tsconfig.json": TSCONFIG, "package.json": "{}", ...files }).map(([file, content]) => [
          `${ROOT}/${file}`,
          content,
        ]),
      ),
    }),
  })

const countsOf = (probe: ReturnType<typeof probeOf>) =>
  Object.fromEntries(probeTestIdAttribute(probe).histogram.map((entry) => [entry.attribute, entry.count]))

describe("test-id attribute probe", () => {
  it("picks the most frequent attribute and records every candidate", () => {
    const probe = probeOf({
      "src/A.tsx": '<div data-testid="a" /><div data-testid="b" />',
      "src/B.tsx": '<div data-cy="c" />',
    })
    const result = probeTestIdAttribute(probe)

    expect(result.attribute).toBe("data-testid")
    expect(result.totalOccurrences).toBe(3)
    expect(result.histogram.map((entry) => entry.attribute)).toEqual([
      "data-testid",
      "data-cy",
      "data-test",
      "data-qa",
      "data-test-id",
      "testID",
    ])
    expect(countsOf(probe)).toEqual({
      "data-testid": 2,
      "data-cy": 1,
      "data-test": 0,
      "data-qa": 0,
      "data-test-id": 0,
      testID: 0,
    })
  })

  it("elects the React Native testID attribute when it is the one an app uses", () => {
    const probe = probeOf({ "src/A.tsx": 'export const A = () => <View testID="home" />' })

    expect(probeTestIdAttribute(probe).attribute).toBe("testID")
  })

  it("counts the files Angular components name in templateUrl, and only in Angular projects", () => {
    const files = {
      "src/app/a.component.ts": 'export class A {}\nconst meta = { templateUrl: "./view.html" }',
      "src/app/view.html": '<div data-test="a"></div><div data-test="b"></div>',
      "src/app/stale.component.ts": "export class Stale {}",
      "src/app/stale.component.html": '<div data-cy="x"></div><div data-cy="y"></div><div data-cy="z"></div>',
      "src/index.html": '<div data-cy="shell"></div>',
    }
    const angular = probeOf({ ...files, "package.json": JSON.stringify({ dependencies: { "@angular/core": "^20.0.0" } }) })

    expect(probeTestIdAttribute(angular).attribute).toBe("data-test")
    expect(countsOf(angular)["data-test"]).toBe(2)
    expect(countsOf(angular)["data-cy"]).toBe(0)
    expect(countsOf(probeOf(files))["data-test"]).toBe(0)
  })

  it("an all-zero histogram is a legible outcome, distinct from the probe never running", () => {
    const probe = probeOf({ "src/A.tsx": "export const A = () => <div />" })
    const ran = probeTestIdAttribute(probe)

    expect(ran.attribute).toBeNull()
    expect(ran.filesScanned).toBe(1)
    expect(ran.histogram).toHaveLength(TEST_ID_ATTRIBUTES.length)
    expect(ran.histogram.every((entry) => entry.count === 0 && entry.files === 0)).toBe(true)
    expect(ran.totalOccurrences).toBe(0)

    const skipped = runDetection({ ts, root: ROOT, probe: probeOf({ "src/A.tsx": "export {}" }), testIds: false })
    expect(skipped.testIds).toBeNull()

    const performed = runDetection({ ts, root: ROOT, probe })
    expect(performed.testIds).not.toBeNull()
    expect(performed.testIds?.attribute).toBeNull()
  })

  it("states the no-test-ids guidance in prose rather than fabricating selectors", () => {
    expect(NO_TEST_IDS_NOTICE).toContain("no test-id attributes")
    expect(NO_TEST_IDS_NOTICE).toContain("role or visible text")
  })

  it("records first-seen evidence for the winner only where it occurs", () => {
    const probe = probeOf({ "src/A.tsx": 'const a = 1\nconst b = <div data-qa="x" />' })
    const result = probeTestIdAttribute(probe)

    expect(result.attribute).toBe("data-qa")
    expect(result.histogram[0]?.firstSeen).toEqual({ what: "data-qa attribute", file: "src/A.tsx", line: 2 })
    expect(result.histogram.filter((entry) => entry.firstSeen !== null)).toHaveLength(1)
  })

  it("breaks a tie by the documented preference order, data-testid first", () => {
    expect(probeTestIdAttribute(probeOf({ "src/A.tsx": '<div data-cy="a" data-testid="b" />' })).attribute).toBe(
      "data-testid",
    )
    expect(probeTestIdAttribute(probeOf({ "src/A.tsx": '<div data-qa="a" data-cy="b" />' })).attribute).toBe("data-cy")
  })

  it("shares its preference order with the test-ids extractor", () => {
    expect(TEST_ID_ATTRIBUTES).toBe(DEFAULT_CANDIDATE_ATTRIBUTES)
    expect(TEST_ID_ATTRIBUTES[0]).toBe("data-testid")
  })

  it("never scans generated or excluded files", () => {
    const probe = probeOf({
      "src/A.tsx": "export const A = () => <div />",
      "src/legacy.gen.tsx": '<div data-cy="generated" />',
      "dist/B.tsx": '<div data-cy="built" />',
    })

    expect(probeTestIdAttribute(probe).attribute).toBeNull()
    expect(probeTestIdAttribute(probe).filesScanned).toBe(1)
  })

  it("stays bounded", () => {
    const probe = probeOf({
      "src/A.tsx": '<div data-testid="a" />',
      "src/B.tsx": '<div data-testid="b" />',
      "src/C.tsx": '<div data-testid="c" />',
    })
    const result = probeTestIdAttribute(probe, { maxFiles: 2 })

    expect(result.filesScanned).toBe(2)
    expect(result.filesSkipped).toBe(1)
    expect(result.totalOccurrences).toBe(2)
  })

  it("skips a single file larger than the byte budget", () => {
    const probe = probeOf({ "src/Big.tsx": `<div data-testid="a" />${" ".repeat(50)}` })
    const result = probeTestIdAttribute(probe, { maxBytes: 10 })

    expect(result.filesScanned).toBe(0)
    expect(result.filesSkipped).toBe(1)
    expect(result.attribute).toBeNull()
  })
})

describe("test-id attribute probe — Vue single-file components", () => {
  it("scans .vue templates alongside script files", () => {
    const probe = probeOf({
      "src/A.vue": '<template>\n  <button data-cy="save" />\n</template>\n',
      "src/B.tsx": '<div data-cy="b" />',
    })
    const result = probeTestIdAttribute(probe)

    expect(result.filesScanned).toBe(2)
    expect(countsOf(probe)["data-cy"]).toBe(2)
    expect(result.histogram[0]?.firstSeen).toEqual({ what: "data-cy attribute", file: "src/A.vue", line: 2 })
  })
})

describe("test-id attribute probe — attribute boundaries", () => {
  it("does not count data-test-id as data-test", () => {
    const probe = probeOf({ "src/A.vue": '<template><b data-test-id="x" /><i data-test="y" /></template>' })

    expect(countsOf(probe)).toMatchObject({ "data-test": 1, "data-test-id": 1 })
  })

  it("does not count data-testid-like prefixes or suffixes", () => {
    const probe = probeOf({ "src/A.tsx": '<div x-data-test="a" data-test-foo="b" />' })

    expect(countsOf(probe)).toMatchObject({ "data-test": 0, "data-test-id": 0 })
  })
})

describe("library detection from the dependency union", () => {
  it("maps each group from dependency keys", () => {
    const detections = detectLibraries(
      new Set(["@tanstack/react-query", "zustand", "react-i18next", "react-hook-form", "zod", "axios"]),
    )

    expect(enabledLibraryGroups(detections)).toEqual(["query", "store", "i18n", "forms", "http"])
    expect(detections.find((entry) => entry.group === "forms")?.companions).toEqual(["zod"])
  })

  it("a validator alone does not enable forms", () => {
    const detections = detectLibraries(new Set(["zod"]))
    expect(enabledLibraryGroups(detections)).toEqual([])
    expect(detections.find((entry) => entry.group === "forms")?.companions).toEqual(["zod"])
  })

  it("detects node-fetch and react-redux, which the extractors read", () => {
    const detections = detectLibraries(new Set(["node-fetch", "react-redux"]))
    expect(enabledLibraryGroups(detections)).toEqual(["store", "http"])
  })

  it("detects the Vue and Nuxt library signals", () => {
    const detections = detectLibraries(new Set(["@tanstack/vue-query", "pinia", "vue-i18n", "ofetch"]))
    expect(enabledLibraryGroups(detections)).toEqual(["query", "store", "i18n", "http"])
    expect(enabledLibraryGroups(detectLibraries(new Set(["vuex", "@nuxtjs/i18n", "nuxt"])))).toEqual(["store", "i18n"])
  })

  it("detects the Angular library signals (G18)", () => {
    const detections = detectLibraries(new Set(["@angular/core", "@angular/common", "@ngrx/store", "@ngx-translate/core"]))
    expect(enabledLibraryGroups(detections)).toEqual(["store", "i18n", "http"])
    expect(detections.find((entry) => entry.group === "http")?.matched).toEqual(["@angular/common"])
    expect(enabledLibraryGroups(detectLibraries(new Set(["@angular/localize"])))).toEqual(["i18n"])
  })

  it("detects Lingui as the i18n group", () => {
    for (const name of ["@lingui/core", "@lingui/react", "@lingui/macro"]) {
      expect(enabledLibraryGroups(detectLibraries(new Set([name])))).toEqual(["i18n"])
    }
  })

  it("reports every group even when nothing is installed", () => {
    const detections = detectLibraries(new Set<string>())
    expect(detections).toHaveLength(5)
    expect(detections.every((entry) => !entry.enabled && entry.matched.length === 0)).toBe(true)
  })

  it("reaches the union through detection, not a single manifest", () => {
    const detection = runDetection({
      ts,
      root: ROOT,
      probe: createProjectProbe({
        ts,
        root: ROOT,
        host: createMemoryHost({
          files: {
            [`${ROOT}/tsconfig.json`]: JSON.stringify({ compilerOptions: { paths: { "@/*": ["app/src/*"] } } }),
            [`${ROOT}/package.json`]: JSON.stringify({ dependencies: { axios: "1.0.0" } }),
            [`${ROOT}/app/package.json`]: JSON.stringify({ dependencies: { zustand: "5.0.0" } }),
            [`${ROOT}/app/src/a.ts`]: "export {}",
          },
        }),
      }),
    })

    expect(enabledLibraryGroups(detection.libraries)).toEqual(["store", "http"])
  })
})
