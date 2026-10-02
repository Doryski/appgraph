import { describe, expect, it } from "vitest"
import { createValueResolver } from "../../src/adapters/array-values.js"
import { configFileOf, createConfigFileReader } from "../../src/adapters/config-file.js"
import { discoverBench } from "./discover-harness.js"

const CONFIG = [
  `import { withSentryConfig } from '@sentry/nextjs'`,
  `const cfg = {`,
  `  absent: 1,`,
  `  literal: ['a', "b"],`,
  `  dynamic: ['a', ext],`,
  `  computed: build(),`,
  `}`,
  `export default withSentryConfig(cfg, { silent: true })`,
  "",
].join("\n")

const setup = (files: Readonly<Record<string, string>> = { "app.config.ts": CONFIG }) => {
  const { ctx } = discoverBench(files)
  const reader = createConfigFileReader(ctx, createValueResolver(ctx))
  const source = ctx.sourceFile("app.config.ts")
  if (source === null) throw new Error("no source")
  const exported = reader.exportedOf(source)
  if (exported === null) throw new Error("no export")
  const object = reader.configObjectsOf(exported, "app.config.ts", 0)[0]
  if (object === undefined) throw new Error("no config object")
  const literal = ctx.ast.asObjectLiteral(object.node)
  if (literal === null) throw new Error("no literal")
  return { ctx, reader, literal }
}

describe("adapters/config-file literalStringArray", () => {
  it("reports an absent member", () => {
    const { reader, literal } = setup()

    expect(reader.literalStringArray(literal, "missing")).toEqual({ kind: "absent" })
  })

  it("reads an array of string literals", () => {
    const { reader, literal } = setup()

    expect(reader.literalStringArray(literal, "literal")).toEqual({ kind: "literal", values: ["a", "b"] })
  })

  it("reports a non-literal element or value as dynamic with its node", () => {
    const { reader, literal } = setup()

    const element = reader.literalStringArray(literal, "dynamic")
    const value = reader.literalStringArray(literal, "computed")
    expect(element.kind === "dynamic" && element.node.getText()).toBe("ext")
    expect(value.kind === "dynamic" && value.node.getText()).toBe("build()")
  })

  it("reports a number member as dynamic, not absent", () => {
    const { reader, literal } = setup()

    expect(reader.literalStringArray(literal, "absent").kind).toBe("dynamic")
  })
})

describe("adapters/config-file configFileOf", () => {
  it("returns the first existing candidate", () => {
    const { ctx } = setup({ "app.config.ts": CONFIG, "b.config.js": "", "c.config.js": "" })

    expect(configFileOf(ctx, ["a.config.ts", "c.config.js", "b.config.js"])).toBe("c.config.js")
    expect(configFileOf(ctx, ["a.config.ts"])).toBeNull()
  })
})

describe("adapters/config-file exportedOf", () => {
  it("unwraps a HOC wrapper down to the config object", () => {
    const { reader, literal } = setup()

    expect(reader.memberNamed(literal, "literal")).not.toBeNull()
    expect(reader.literalField(literal, "literal")).toBeNull()
  })

  it("reads module.exports", () => {
    const { ctx } = discoverBench({ "x.js": `module.exports = { a: 'b' }` })
    const reader = createConfigFileReader(ctx, createValueResolver(ctx))
    const source = ctx.sourceFile("x.js")
    const exported = source === null ? null : reader.exportedOf(source)

    expect(exported?.getText()).toBe("{ a: 'b' }")
  })
})
