import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { REGISTERED_COMMANDS, SHARED_OPTIONS, sharedOptionIds } from "../../src/cli/commands.js"

const DOCS = {
  skill: "skills/appgraph/SKILL.md",
  agents: "docs/agents.md",
  readme: "README.md",
  manifest: "package.json",
} as const

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), "utf8")

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const longFlag = (flags: string): string => flags.split(" ")[0] ?? flags

const mentionsFlag = (text: string, flag: string): boolean => new RegExp(`${escapeRegExp(flag)}(?![a-z-])`).test(text)

const mentionsCommand = (text: string, name: string): boolean =>
  new RegExp(`(\`|appgraph )${escapeRegExp(name)}(?![a-z-])`).test(text)

const commandFlags = REGISTERED_COMMANDS.map((spec) => ({
  name: spec.name,
  flags: [...sharedOptionIds(spec).map((id) => SHARED_OPTIONS[id].flags), ...spec.options.map((option) => option.flags)].map(longFlag),
}))

const agentDocs = `${read(DOCS.skill)}\n${read(DOCS.agents)}`

const readme = read(DOCS.readme)

const manifestFiles = (): readonly unknown[] => {
  const manifest: unknown = JSON.parse(read(DOCS.manifest))
  if (typeof manifest !== "object" || manifest === null || !("files" in manifest)) return []
  return Array.isArray(manifest.files) ? manifest.files : []
}

describe("agent docs stay in step with the command registry", () => {
  it.each(commandFlags)("documents the $name command in the skill or docs/agents.md", ({ name }) => {
    expect(mentionsCommand(agentDocs, name)).toBe(true)
  })

  it.each(commandFlags)("documents every flag of $name in the skill or docs/agents.md", ({ flags }) => {
    expect(flags.filter((flag) => !mentionsFlag(agentDocs, flag))).toEqual([])
  })

  it.each(commandFlags)("lists the $name command in the README", ({ name }) => {
    expect(mentionsCommand(readme, name)).toBe(true)
  })

  it("ships the skill in the package", () => {
    expect(manifestFiles()).toContain("skills")
  })
})
