import { describe, expect, it } from "vitest"
import { buildReportPayload, serializePayload } from "@appgraph/emit/report-payload.js"
import { buildFixtureGraph } from "../../../e2e/fixture-graph"
import { makeGraph } from "../../test/render"
import { PAYLOAD_ELEMENT_ID, readPayload } from "./payload"

const docWith = (text: string | null) => {
  const doc = document.implementation.createHTMLDocument("t")
  if (text === null) return doc
  const script = doc.createElement("script")
  script.type = "application/json"
  script.id = PAYLOAD_ELEMENT_ID
  script.textContent = text
  doc.body.appendChild(script)
  return doc
}

describe("readPayload", () => {
  it("parses the embedded payload", () => {
    const text = serializePayload(buildReportPayload(makeGraph(), { locale: "pl", generatedAt: null }))
    const payload = readPayload(docWith(text))
    expect(payload?.locale).toBe("pl")
    expect(payload?.strings.tabScreens).toBe("Ekrany")
    expect(payload?.screens).toEqual([])
  })

  it("hydrates interned screen and shell trees back to the in-memory payload", () => {
    const built = buildReportPayload(buildFixtureGraph(), { locale: "en", generatedAt: null })
    const payload = readPayload(docWith(serializePayload(built)))
    expect(payload).toEqual(JSON.parse(JSON.stringify(built)))
    expect(payload?.screens.some((screen) => screen.tree.length > 0)).toBe(true)
  })

  it("returns null when interned trees reference missing subtrees", () => {
    const serialized = JSON.parse(serializePayload(buildReportPayload(buildFixtureGraph(), { locale: "en", generatedAt: null })))
    expect(readPayload(docWith(JSON.stringify({ ...serialized, subtrees: [] })))).toBeNull()
    expect(readPayload(docWith(JSON.stringify({ ...serialized, paths: [] })))).toBeNull()
    expect(readPayload(docWith(JSON.stringify({ ...serialized, subtrees: undefined })))).toBeNull()
  })

  it("returns null when the element is missing, empty or malformed", () => {
    expect(readPayload(docWith(null))).toBeNull()
    expect(readPayload(docWith(""))).toBeNull()
    expect(readPayload(docWith("__APPGRAPH_DATA__"))).toBeNull()
    expect(readPayload(docWith("{\"meta\":1}"))).toBeNull()
  })
})
