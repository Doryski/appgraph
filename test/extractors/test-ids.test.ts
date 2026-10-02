import { describe, expect, it } from "vitest"
import { DEFAULT_CANDIDATE_ATTRIBUTES, createTestIdsExtractor } from "../../src/extractors/test-ids.js"
import type { TestIdAttributeUsage } from "../../src/extractors/test-ids.js"
import { createTagMask } from "../../src/extractors/types.js"
import { ROOT, maskedValuesOf, run, runVue, valuesOf } from "./harness.js"

const extractor = createTestIdsExtractor()

const ids = (code: string, e = extractor) => valuesOf(run([e], code), "testIds")
const histogram = (code: string, e = extractor) =>
  valuesOf(run([e], code), "testIdAttributeHistogram") as readonly TestIdAttributeUsage[]

describe("test-ids — the winning attribute, chosen by occurrence count", () => {
  it("collects values under data-testid when it is the only attribute present", () => {
    expect(ids('<button data-testid="submit">Go</button>')).toEqual(["submit"])
  })

  it("picks the attribute with more occurrences and reports only its values in testIds", () => {
    const code = [
      '<a data-cy="link-a" />',
      '<b data-testid="a" />',
      '<c data-testid="b" />',
      '<d data-testid="c" />',
    ].join("\n")

    expect(ids(code)).toEqual(["a", "b", "c"])
  })

  it("breaks a tie in favor of data-testid, the conventional default", () => {
    const code = ['<a data-cy="x" />', '<b data-testid="y" />'].join("\n")
    expect(ids(code)).toEqual(["y"])
  })

  it("deduplicates repeated values", () => {
    expect(ids('<a data-testid="x" /><b data-testid="x" />')).toEqual(["x"])
  })
})

describe("test-ids — 'none found' is a legible outcome, not silence", () => {
  it("emits an all-zero histogram and no testIds when nothing matches any candidate", () => {
    const result = run([extractor], "<div className=\"card\" />")

    expect(valuesOf(result, "testIds")).toEqual([])
    const rows = histogram("<div className=\"card\" />")
    expect(rows).toHaveLength(6)
    expect(rows.every((row) => row.count === 0)).toBe(true)
  })

  it("shows a pinned-but-wrong attribute as zero, distinguishing it from a true zero", () => {
    const wrongAttribute = createTestIdsExtractor({ attribute: "data-qa" })
    const code = '<button data-testid="submit">Go</button>'

    expect(ids(code, wrongAttribute)).toEqual([])
    const rows = histogram(code, wrongAttribute)
    expect(rows).toEqual([{ attribute: "data-qa", count: 0, winner: true }])
  })
})

describe("test-ids — configurable attribute, never hardcoded", () => {
  it("uses a fully custom attribute when candidates are overridden", () => {
    const custom = createTestIdsExtractor({ candidates: ["data-e2e"] })
    expect(ids('<button data-e2e="submit" data-testid="other">Go</button>', custom)).toEqual(["submit"])
  })

  it("pins a single attribute outright, ignoring higher counts elsewhere", () => {
    const pinned = createTestIdsExtractor({ attribute: "data-cy" })
    const code = ['<a data-testid="a" />', '<b data-testid="b" />', '<c data-cy="only" />'].join("\n")
    expect(ids(code, pinned)).toEqual(["only"])
  })
})

describe("test-ids — histogram marks exactly one winner and reports every candidate", () => {
  it("marks winner:true on exactly one row", () => {
    const rows = histogram('<a data-testid="x" /><b data-cy="y" /><c data-cy="z" />')
    expect(rows.filter((row) => row.winner).map((row) => row.attribute)).toEqual(["data-cy"])
    expect(rows.map((row) => row.attribute).sort()).toEqual(
      ["data-cy", "data-qa", "data-test", "data-test-id", "data-testid", "testID"].sort(),
    )
  })
})

describe("test-ids — masking still applies even though emission is deferred to finish", () => {
  it("drops a masked subtree's test-ids while keeping the histogram count of raw occurrences", () => {
    const mask = createTagMask({
      name: "dev-preview-mask",
      tags: ["DevStatesPreview"],
      reason: "dev-only preview",
      channels: ["testIds"],
    })

    const code = [
      "function Content() {",
      "  return (",
      '    <div data-testid="real">',
      "      <DevStatesPreview>",
      '        <span data-testid="preview-only" />',
      "      </DevStatesPreview>",
      "    </div>",
      "  )",
      "}",
    ].join("\n")

    const result = run([extractor, mask], code)

    expect(valuesOf(result, "testIds")).toEqual(["real"])
    expect(maskedValuesOf(result, "testIds")).toEqual(["preview-only"])
  })
})

const vueIds = (sfc: string, e = extractor) => valuesOf(runVue([e], sfc), "testIds")
const vueHistogram = (sfc: string, e = extractor) =>
  valuesOf(runVue([e], sfc), "testIdAttributeHistogram") as readonly TestIdAttributeUsage[]

const countOf = (rows: readonly TestIdAttributeUsage[], attribute: string) =>
  rows.find((row) => row.attribute === attribute)?.count

describe("test-ids — Vue templates", () => {
  it("reads a static attribute", () => {
    expect(vueIds('<template><button data-testid="save">Go</button></template>')).toEqual(["save"])
  })

  it("resolves a bound constant from script setup", () => {
    const sfc = [
      '<script setup lang="ts">',
      "const ID = 'bound-id'",
      "</script>",
      '<template><button :data-testid="ID" /></template>',
    ].join("\n")

    expect(vueIds(sfc)).toEqual(["bound-id"])
  })

  it("flattens a bound template literal", () => {
    const sfc = [
      '<script setup lang="ts">',
      "const PREFIX = 'row'",
      "</script>",
      "<template><li :data-testid=\"`${PREFIX}-item`\" /></template>",
    ].join("\n")

    expect(vueIds(sfc)).toEqual(["row-item"])
  })

  it("counts a dynamic binding in the histogram but emits no value", () => {
    const sfc = '<template><li :data-testid="item.id" /></template>'

    expect(vueIds(sfc)).toEqual([])
    expect(countOf(vueHistogram(sfc), "data-testid")).toBe(1)
  })

  it("shares one election with JSX-style occurrences per file, picking the majority attribute", () => {
    const sfc = '<template><a data-cy="x" /><b data-testid="a" /><c data-testid="b" /></template>'

    expect(vueIds(sfc)).toEqual(["a", "b"])
  })

  it("counts data-test-id as its own candidate, listed last", () => {
    const sfc = '<template><a data-test-id="x" /><b data-test-id="y" /></template>'

    expect(vueIds(sfc)).toEqual(["x", "y"])
    expect(countOf(vueHistogram(sfc), "data-test-id")).toBe(2)
    expect(countOf(vueHistogram(sfc), "data-test")).toBe(0)
  })

  it("keeps data-testid first in the default candidates and the late additions data-test-id then testID last", () => {
    expect(DEFAULT_CANDIDATE_ATTRIBUTES[0]).toBe("data-testid")
    expect(DEFAULT_CANDIDATE_ATTRIBUTES.slice(-2)).toEqual(["data-test-id", "testID"])
  })
})

describe("test-ids — React Native testID", () => {
  it("elects testID and collects its values when it is the attribute in use", () => {
    const rows = histogram('<View testID="home" /><Text testID="title" />')

    expect(rows.filter((row) => row.winner).map((row) => row.attribute)).toEqual(["testID"])
  })
})

describe("test-ids — a value imported from a test-id module", () => {
  const TEST_IDS = `${ROOT}/src/utils/testIds.ts`

  const withModule = (code: string) =>
    valuesOf(
      run([createTestIdsExtractor()], code, {
        file: "src/pages/Tokens.tsx",
        resolveModule: (specifier) => (specifier === "utils/testIds" ? TEST_IDS : null),
        sources: { [TEST_IDS]: "export const CREATE_TOKEN = 'CREATE_TOKEN';\nexport const ROW = `token-row`;" },
      }),
      "testIds",
    )

  it("reads the exported string constant behind an imported identifier", () => {
    expect(
      withModule(
        "import { CREATE_TOKEN, ROW } from 'utils/testIds'\nexport const P = () => <div><button data-testid={CREATE_TOKEN} /><i data-testid={ROW} /></div>",
      ),
    ).toEqual(["CREATE_TOKEN", "token-row"])
  })

  it("emits nothing for an import the resolver cannot read", () => {
    expect(withModule("import { MISSING } from 'elsewhere'\nexport const P = () => <b data-testid={MISSING} />")).toEqual([])
  })
})
