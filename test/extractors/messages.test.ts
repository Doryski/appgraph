import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createMessagesExtractor } from "../../src/extractors/messages.js"
import type { MessageHandlerFact, MessageSendFact } from "../../src/extractors/messages.js"
import { ROOT, run, valuesOf } from "./harness.js"

const extractor = createMessagesExtractor()

const types = (code: string) => valuesOf(run([extractor], code), "messages")
const handlers = (code: string) =>
  valuesOf(run([extractor], code), "messageHandlers") as readonly MessageHandlerFact[]
const sends = (code: string) => valuesOf(run([extractor], code), "messageSends") as readonly MessageSendFact[]

const ENUM = "enum MessageType { StartAuth = 'startAuth', StopAuth = 'stopAuth' }"

const PROTOCOL_FILE = `${ROOT}/src/shared/messages/types.ts`

// The cross-file half of the extractor reads the DECLARING module through `ctx.resolve.sourceFile`;
// the fixture is handed to that capability, so it stays in memory instead of on disk.
const declaring = (declaration: string, options: { readonly file?: string } = {}) => ({
  [options.file ?? PROTOCOL_FILE]: declaration,
})

// A fresh extractor per call: the per-declaring-file member cache lives on the instance (one per
// analyze run), so sharing one instance across tests would let one fixture answer another's lookup.
const importing = (code: string, sources = declaring(`export ${ENUM}`)) =>
  run([createMessagesExtractor()], code, {
    resolveModule: (specifier) => (specifier.startsWith(".") ? PROTOCOL_FILE : null),
    sources,
  })

describe("messages — the if-chain handler graph, resolved against a declared protocol", () => {
  it("resolves an if (message.type === MessageType.X) branch", () => {
    const code = [ENUM, "if (message.type === MessageType.StartAuth) { begin() }"].join("\n")
    expect(types(code)).toEqual(["startAuth"])
    expect(handlers(code)).toEqual([{ messageType: "startAuth", file: "src/File.tsx", line: 2 }])
  })

  it("resolves an else-if chain into multiple handled types", () => {
    const code = [
      ENUM,
      "if (message.type === MessageType.StartAuth) { begin() }",
      "else if (message.type === MessageType.StopAuth) { end() }",
    ].join("\n")

    expect(types(code)).toEqual(["startAuth", "stopAuth"])
  })

  it("resolves a switch(message.type) / case MessageType.X chain", () => {
    const code = [
      ENUM,
      "switch (message.type) {",
      "  case MessageType.StartAuth: begin(); break",
      "  case MessageType.StopAuth: end(); break",
      "}",
    ].join("\n")

    expect(types(code)).toEqual(["startAuth", "stopAuth"])
  })

  it("does NOT resolve MessageType.X when nothing declares MessageType — no local enum, no import", () => {
    const code = "if (message.type === MessageType.StartAuth) { begin() }"
    expect(types(code)).toEqual([])
  })

  it("does not fire on an unrelated .type comparison naming a different field", () => {
    const code = [ENUM, "if (message.kind === MessageType.StartAuth) { begin() }"].join("\n")
    expect(types(code)).toEqual([])
  })

  it("resolves the early-return spelling: if (message.type !== MessageType.X) return", () => {
    const code = [
      ENUM,
      "const handle = (message) => {",
      "  if (message.type !== MessageType.StartAuth) return",
      "  begin()",
      "}",
    ].join("\n")

    expect(types(code)).toEqual(["startAuth"])
  })

  it("resolves a comparison that is one operand of a conjunction", () => {
    const code = [ENUM, "if (message.type === MessageType.StartAuth && message.user) { begin() }"].join("\n")
    expect(types(code)).toEqual(["startAuth"])
  })

  it("resolves both operands of a disjunction", () => {
    const code = [
      ENUM,
      "if (message.type === MessageType.StartAuth || message.type === MessageType.StopAuth) { go() }",
    ].join("\n")

    expect(types(code)).toEqual(["startAuth", "stopAuth"])
  })

  it("keeps the narrowing rule under the new operators: no declaration behind it, no fact", () => {
    const inverted = "if (message.type !== MessageType.StartAuth) return"
    const conjoined = "if (entry.type === 'file' && entry.size > 0) { append(entry) }"

    expect(types(inverted)).toEqual([])
    expect(types(conjoined)).toEqual([])
  })

  it("respects a custom enum-name pattern and custom type field", () => {
    const custom = createMessagesExtractor({ enumNamePattern: /^Kind$/, typeField: "kind" })
    const code = ["enum Kind { A = 'a' }", "if (message.kind === Kind.A) { go() }"].join("\n")
    expect(valuesOf(run([custom], code), "messages")).toEqual(["a"])
    expect(types(code)).toEqual([])
  })
})

describe("messages — the protocol enum declared in ANOTHER module", () => {
  const IMPORT = "import { MessageType } from './shared/messages/types'"

  it("resolves an imported enum's members in an if chain", () => {
    const code = [
      IMPORT,
      "if (message.type === MessageType.StartAuth) { begin() }",
      "else if (message.type === MessageType.StopAuth) { end() }",
    ].join("\n")

    expect(valuesOf(importing(code), "messages")).toEqual(["startAuth", "stopAuth"])
    expect(valuesOf(importing(code), "messageHandlers")).toEqual([
      { messageType: "startAuth", file: "src/File.tsx", line: 2 },
      { messageType: "stopAuth", file: "src/File.tsx", line: 3 },
    ])
  })

  it("resolves an imported enum's members in a switch", () => {
    const code = [
      IMPORT,
      "switch (message.type) {",
      "  case MessageType.StartAuth: begin(); break",
      "  case MessageType.StopAuth: end(); break",
      "}",
    ].join("\n")

    expect(valuesOf(importing(code), "messages")).toEqual(["startAuth", "stopAuth"])
  })

  it("resolves an imported `as const` map the same way", () => {
    const sources = declaring("export const MessageType = { StartAuth: 'startAuth' } as const")
    const code = [IMPORT, "if (message.type === MessageType.StartAuth) { begin() }"].join("\n")
    expect(valuesOf(importing(code, sources), "messages")).toEqual(["startAuth"])
  })

  it("resolves an aliased import through the imported name, not the local one", () => {
    const code = [
      "import { MessageType as Msg } from './shared/messages/types'",
      "if (message.type === Msg.StopAuth) { end() }",
    ].join("\n")

    expect(valuesOf(importing(code), "messages")).toEqual(["stopAuth"])
  })

  it("does not resolve an import whose name is not the configured protocol", () => {
    const sources = declaring("export const Palette = { StartAuth: 'blue' } as const")
    const code = [
      "import { Palette } from './shared/messages/types'",
      "if (message.type === Palette.StartAuth) { paint() }",
    ].join("\n")

    expect(valuesOf(importing(code, sources), "messages")).toEqual([])
  })

  it("does not resolve a member the declaring module does not declare", () => {
    const code = [IMPORT, "if (message.type === MessageType.Unknown) { go() }"].join("\n")
    expect(valuesOf(importing(code), "messages")).toEqual([])
  })

  it("yields nothing when the declaring module cannot be read", () => {
    const sources = declaring(`export ${ENUM}`, { file: `${ROOT}/src/elsewhere.ts` })
    const code = [IMPORT, "if (message.type === MessageType.StartAuth) { begin() }"].join("\n")
    expect(valuesOf(importing(code, sources), "messages")).toEqual([])
  })
})

describe("messages — comparisons that are NOT the message protocol", () => {
  it("ignores entry.type === 'file' on a DOM-ish local with no protocol behind it", () => {
    const code = [
      "for (const entry of config.formData) {",
      "  if (entry.type === 'file') { append(entry) }",
      "}",
    ].join("\n")

    expect(types(code)).toEqual([])
    expect(handlers(code)).toEqual([])
  })

  it("still ignores entry.type === 'file' INSIDE a message listener — entry is not the message", () => {
    const code = [
      "chrome.runtime.onMessage.addListener((message, sender) => {",
      "  for (const entry of message.request.formData) {",
      "    if (entry.type === 'file') { append(entry) }",
      "  }",
      "})",
    ].join("\n")

    expect(types(code)).toEqual([])
  })

  it("ignores an optional-chained DOM property comparison", () => {
    const code = "if (zalEl?.type === 'datetime-local') { fill() }"
    expect(types(code)).toEqual([])
  })

  it("ignores an unrelated local object that happens to have a same-named member", () => {
    const code = [
      "const Palette = { StartAuth: 'blue' }",
      "if (message.type === Palette.StartAuth) { paint() }",
    ].join("\n")

    expect(types(code)).toEqual([])
  })
})

describe("messages — the message-listener parameter is the only string-literal heuristic", () => {
  it("accepts a bare string compared against the listener's own message parameter", () => {
    const code = [
      "chrome.runtime.onMessage.addListener((message, sender) => {",
      "  if (message.type === 'PING') { pong() }",
      "})",
    ].join("\n")

    expect(types(code)).toEqual(["PING"])
  })

  it("accepts a named listener callback declared in the same file", () => {
    const code = [
      "function messageListener(message) {",
      "  if (message.type === 'PING') { pong() }",
      "}",
      "chrome.runtime.onMessage.addListener(messageListener)",
    ].join("\n")

    expect(types(code)).toEqual(["PING"])
  })

  it("rejects the same comparison when nothing registers the function as a listener", () => {
    const code = [
      "function messageListener(message) {",
      "  if (message.type === 'PING') { pong() }",
      "}",
      "run(messageListener)",
    ].join("\n")

    expect(types(code)).toEqual([])
  })

  it("rejects a comparison on a different object inside a listener", () => {
    const code = [
      "chrome.runtime.onMessage.addListener((message) => {",
      "  if (other.type === 'PING') { pong() }",
      "})",
    ].join("\n")

    expect(types(code)).toEqual([])
  })
})

describe("messages — sending, the only navigation this app has", () => {
  it("finds chrome.runtime.sendMessage and resolves its type through the enum", () => {
    const code = [ENUM, "chrome.runtime.sendMessage({ type: MessageType.StartAuth })"].join("\n")
    expect(types(code)).toEqual(["startAuth"])
    expect(sends(code)).toEqual([
      {
        messageType: "startAuth",
        typeResolution: "resolved",
        via: "chrome.runtime.sendMessage",
        file: "src/File.tsx",
        line: 2,
      },
    ])
  })

  it("resolves a send whose type comes from an enum in another module", () => {
    const code = [
      "import { MessageType } from './shared/messages/types'",
      "chrome.runtime.sendMessage({ type: MessageType.StopAuth, target: 'background' })",
    ].join("\n")

    expect(valuesOf(importing(code), "messageSends")).toEqual([
      {
        messageType: "stopAuth",
        typeResolution: "resolved",
        via: "chrome.runtime.sendMessage",
        file: "src/File.tsx",
        line: 2,
      },
    ])
  })

  it("finds browser.runtime.sendMessage too", () => {
    const code = [ENUM, "browser.runtime.sendMessage({ type: MessageType.StopAuth })"].join("\n")
    expect(sends(code)[0]?.via).toBe("chrome.runtime.sendMessage")
  })

  it("finds a bare global postMessage call", () => {
    const code = "postMessage({ type: 'ping' })"
    expect(sends(code)).toEqual([
      { messageType: "ping", typeResolution: "resolved", via: "postMessage", file: "src/File.tsx", line: 1 },
    ])
  })

  it("takes the payload from the second argument of chrome.tabs.sendMessage", () => {
    const code = [ENUM, "chrome.tabs.sendMessage(tabId, { type: MessageType.StartAuth })"].join("\n")
    expect(sends(code)[0]?.messageType).toBe("startAuth")
  })

  it("marks a send built from a variable as attempted but dynamic", () => {
    const code = "chrome.runtime.sendMessage(payload)"
    expect(sends(code)).toEqual([
      {
        messageType: null,
        typeResolution: "dynamic",
        via: "chrome.runtime.sendMessage",
        file: "src/File.tsx",
        line: 1,
      },
    ])
  })

  it("marks a send whose payload carries no type field as absent, not dynamic", () => {
    const code = "chrome.runtime.sendMessage({ target: 'background' })"
    expect(sends(code)[0]?.typeResolution).toBe("absent")
  })

  it("marks an unresolvable enum-shaped type as dynamic rather than resolved", () => {
    const code = "chrome.runtime.sendMessage({ type: MessageType.StartAuth })"
    expect(sends(code)).toEqual([
      {
        messageType: null,
        typeResolution: "dynamic",
        via: "chrome.runtime.sendMessage",
        file: "src/File.tsx",
        line: 1,
      },
    ])
  })

  it("ignores sendMessage on a receiver that is not the chrome/browser global", () => {
    const code = "const analytics = { sendMessage: () => null }\nanalytics.sendMessage({ type: 'x' })"
    expect(sends(code)).toEqual([])
  })

  it("ignores a local function named postMessage that shadows the global", () => {
    const code = "function postMessage(x) { return x }\npostMessage({ type: 'x' })"
    expect(sends(code)).toEqual([])
  })
})

/**
 * The invariant these two tests pin, from opposite sides: cross-file enum resolution goes through
 * `ctx.resolve.sourceFile` — the injected host — and through nothing else.
 */
describe("messages — cross-file resolution reads the injected host, not the disk", () => {
  const IMPORT = "import { MessageType } from './shared/messages/types'"
  const code = [IMPORT, "if (message.type === MessageType.StartAuth) { begin() }"].join("\n")

  it("resolves a declaring module that exists ONLY in the in-memory host", () => {
    expect(existsSync(PROTOCOL_FILE)).toBe(false)
    expect(valuesOf(importing(code), "messages")).toEqual(["startAuth"])
  })

  it("resolves nothing from a declaring module that exists ONLY on disk", () => {
    const directory = mkdtempSync(join(tmpdir(), "appgraph-messages-"))
    const onDisk = join(directory, "types.ts")
    writeFileSync(onDisk, `export ${ENUM}`, "utf8")

    try {
      const result = run([createMessagesExtractor()], code, {
        resolveModule: (specifier) => (specifier.startsWith(".") ? onDisk : null),
      })
      expect(valuesOf(result, "messages")).toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
