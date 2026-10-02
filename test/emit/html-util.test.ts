import { describe, expect, it } from "vitest"
import type { Screen } from "../../src/core/model.js"
import { byCodepoint, escapeHtml, isApiScreen } from "../../src/emit/html-util.js"

const screenOf = (kindTag: string | null): Screen => ({ kindTag }) as unknown as Screen

describe("emit/html-util escapeHtml", () => {
  it("escapes all five HTML-significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;")
  })

  it("escapes the ampersand exactly once (no double-escaping of produced entities)", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b")
    expect(escapeHtml("&amp;")).toBe("&amp;amp;")
  })

  it("neutralises a hostile attribute/script breakout", () => {
    const hostile = `"><script>alert('x')</script>`
    const escaped = escapeHtml(hostile)

    expect(escaped).not.toMatch(/[<>"']/)
    expect(escaped).toBe("&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;")
  })

  it("returns empty and already-safe strings unchanged, including non-ASCII", () => {
    expect(escapeHtml("")).toBe("")
    expect(escapeHtml("zażółć gęślą jaźń 🙂")).toBe("zażółć gęślą jaźń 🙂")
  })

  it("leaves backticks and slashes alone", () => {
    expect(escapeHtml("`a/b`")).toBe("`a/b`")
  })
})

describe("emit/html-util byCodepoint", () => {
  it("compares by UTF-16 code unit, so uppercase sorts before lowercase (not locale order)", () => {
    expect(["b", "B", "a", "A"].sort(byCodepoint)).toEqual(["A", "B", "a", "b"])
  })

  it("returns 0 for equal strings and -1/1 otherwise", () => {
    expect(byCodepoint("a", "a")).toBe(0)
    expect(byCodepoint("a", "b")).toBe(-1)
    expect(byCodepoint("b", "a")).toBe(1)
    expect(byCodepoint("", "a")).toBe(-1)
    expect(byCodepoint("ab", "a")).toBe(1)
  })

  it("is deterministic regardless of input order", () => {
    const input = ["/z", "/a", "/Z", "/_x", "/0"]

    expect([...input].reverse().sort(byCodepoint)).toEqual([...input].sort(byCodepoint))
  })
})

describe("emit/html-util isApiScreen", () => {
  it("is true only for the apiRoute and api kind tags", () => {
    expect(isApiScreen(screenOf("apiRoute"))).toBe(true)
    expect(isApiScreen(screenOf("api"))).toBe(true)
  })

  it("is false for a null tag, other tags, and near-miss spellings", () => {
    expect(isApiScreen(screenOf(null))).toBe(false)
    expect(isApiScreen(screenOf("page"))).toBe(false)
    expect(isApiScreen(screenOf("API"))).toBe(false)
    expect(isApiScreen(screenOf("apiroute"))).toBe(false)
    expect(isApiScreen(screenOf(""))).toBe(false)
  })
})
