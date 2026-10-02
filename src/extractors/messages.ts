import type ts from "typescript"
import type { TypeScriptApi } from "../core/tsconfig.js"
import type { ExtractContext, FactExtractor } from "./types.js"
import { collectStringMembers } from "../core/strings.js"

// A Chrome MV3 extension has no router, so the `MessageType` enum plus its `if (message.type === X)` /
// `switch` handler chain IS the edge graph between the popup, the content script and the background
// worker. This extractor has no npm package to bind against (the enum and the chain are project-local
// code, like `feature-flags.ts`'s lookup functions), so the enum's NAME is the configured contract —
// but which member a comparison resolves to is read off a DECLARED enum / `as const` map, never off
// the identifier text of the comparison alone. The declaration may live in another module: the
// identifier's import binding says which file to read, and reading it is confined to `finish` (§5.4).
export const DEFAULT_ENUM_NAME_PATTERN = /MessageType/i
export const DEFAULT_TYPE_FIELD = "type"
export const DEFAULT_GLOBAL_RECEIVERS = ["chrome", "browser"] as const
export const DEFAULT_SEND_METHODS = ["sendMessage", "postMessage"] as const
export const DEFAULT_HANDLER_REGISTRARS = ["onMessage.addListener"] as const

export type MessagesOptions = {
  readonly enumNamePattern?: RegExp
  readonly typeField?: string
  readonly globalReceivers?: readonly string[]
  readonly sendMethods?: readonly string[]
  readonly handlerRegistrars?: readonly string[]
}

// Not `KnownChannel`s — `FactValue` falls back to `unknown` for both, which is what lets them carry
// an edge (who handles / who sends) instead of a bare type string. The plain `messages` channel
// still gets just the type name, satisfying `ChannelValues.messages: string`.
export type MessageHandlerFact = {
  readonly messageType: string
  readonly file: string
  readonly line: number
}

// `typeResolution` separates the two reasons `messageType` is null: `dynamic` means the payload was
// inspected and its type is not statically knowable, `absent` means there was no type field to read.
export type MessageTypeResolution = "resolved" | "dynamic" | "absent"

export type MessageSendFact = {
  readonly messageType: string | null
  readonly typeResolution: MessageTypeResolution
  readonly via: "chrome.runtime.sendMessage" | "postMessage"
  readonly file: string
  readonly line: number
}

type EnumTable = ReadonlyMap<string, string>

type HandlerScope = {
  readonly param: string
  readonly pos: number
  readonly end: number
}

type HandlerCandidate = {
  readonly kind: "handler"
  readonly at: ts.Node
  readonly value: ts.Node
  readonly subject: string | null
}

type SendCandidate = {
  readonly kind: "send"
  readonly at: ts.CallExpression
  readonly via: MessageSendFact["via"]
  readonly typeNode: ts.Node | null
  readonly payloadIsLiteral: boolean
}

type Candidate = HandlerCandidate | SendCandidate

type State = {
  readonly localEnums: Map<string, EnumTable>
  readonly candidates: Candidate[]
  readonly scopes: HandlerScope[]
  readonly listenerRefs: string[]
  readonly functions: Map<string, HandlerScope>
  readonly seenTypes: Set<string>
}

const emptyState = (): State => ({
  localEnums: new Map(),
  candidates: [],
  scopes: [],
  listenerRefs: [],
  functions: new Map(),
  seenTypes: new Set(),
})

const enumTableOf = (declaration: ts.EnumDeclaration, ctx: ExtractContext): EnumTable => {
  const table = new Map<string, string>()
  for (const member of declaration.members) {
    if (!ctx.ts.isIdentifier(member.name)) continue
    const flat = member.initializer === undefined ? null : ctx.flattenString(member.initializer)
    table.set(member.name.text, flat?.value ?? member.name.text)
  }
  return table
}

const firstParameterName = (fn: ts.Node, ctx: ExtractContext): string | null => {
  const api = ctx.ts
  if (!api.isArrowFunction(fn) && !api.isFunctionExpression(fn) && !api.isFunctionDeclaration(fn)) return null
  const parameter = fn.parameters[0]
  if (parameter === undefined || !api.isIdentifier(parameter.name)) return null
  return parameter.name.text
}

export const createMessagesExtractor = (options: MessagesOptions = {}): FactExtractor => {
  const enumNamePattern = options.enumNamePattern ?? DEFAULT_ENUM_NAME_PATTERN
  const typeField = options.typeField ?? DEFAULT_TYPE_FIELD
  const globalReceivers = new Set(options.globalReceivers ?? DEFAULT_GLOBAL_RECEIVERS)
  const sendMethods = new Set(options.sendMethods ?? DEFAULT_SEND_METHODS)
  const handlerRegistrars = new Set(options.handlerRegistrars ?? DEFAULT_HANDLER_REGISTRARS)

  // Keyed by the DECLARING file, so a protocol enum imported by forty files is parsed once per run.
  const declaredMembers = new Map<string, ReadonlyMap<string, string>>()

  let state = emptyState()

  const membersOfDeclaringFile = (
    absFile: string,
    exportName: string,
    ctx: ExtractContext,
  ): ReadonlyMap<string, string> | null => {
    const resolve = ctx.resolve
    if (resolve === null) return null

    const declaring = resolve.declarationFile(absFile, exportName)
    const cached = declaredMembers.get(declaring)
    if (cached !== undefined) return cached

    const source = resolve.sourceFile(declaring)
    const members = source === null ? new Map<string, string>() : collectStringMembers(ctx.ts, source)

    declaredMembers.set(declaring, members)
    return members
  }

  // The narrowing rule: `Root.Member` is a message type only when `Root` resolves — through this
  // file's own declarations or through an import binding — to a declared enum / `as const` map whose
  // NAME matches the configured protocol pattern. No binding, or a binding to something that is not
  // such a declaration, yields nothing.
  const memberValue = (root: string, member: string, ctx: ExtractContext): string | null => {
    const local = state.localEnums.get(root)?.get(member)
    if (local !== undefined) return local

    const binding = ctx.bindings.get(root)
    if (binding === null) return null

    if (binding.kind === "local")
      return enumNamePattern.test(root) ? (ctx.strings.members.get(`${root}.${member}`) ?? null) : null

    if (binding.kind !== "import" && binding.kind !== "dynamic-import") return null

    const exported = binding.imported === "default" || binding.imported === "*" ? root : binding.imported
    if (!enumNamePattern.test(exported) && !enumNamePattern.test(root)) return null

    const fromDeclaration =
      binding.file === null ? undefined : membersOfDeclaringFile(binding.file, exported, ctx)?.get(`${exported}.${member}`)
    if (fromDeclaration !== undefined) return fromDeclaration

    // Configured `stringSources` already hold the member table for some projects; an import binding
    // is still required to get here, so a bare `MessageType.X` with no declaration behind it fails.
    return ctx.strings.members.get(`${exported}.${member}`) ?? ctx.strings.members.get(`${root}.${member}`) ?? null
  }

  const protocolValue = (node: ts.Node, ctx: ExtractContext): string | null => {
    const access = ctx.ast.asPropertyAccess(node)
    if (access === null) return null
    const root = ctx.ast.asIdentifier(access.expression)
    if (root === null) return null
    return memberValue(root.text, access.name.text, ctx)
  }

  const isTypeFieldAccess = (node: ts.Node, ctx: ExtractContext): boolean => {
    const access = ctx.ast.asPropertyAccess(node)
    return access !== null && access.name.text === typeField
  }

  const subjectOf = (node: ts.Node, ctx: ExtractContext): string | null => {
    const access = ctx.ast.asPropertyAccess(node)
    if (access === null) return null
    return ctx.ast.asIdentifier(access.expression)?.text ?? null
  }

  // The only surviving heuristic, and it is far narrower than "any string on the right of `=== x.type`":
  // the compared object must BE the message parameter of a function registered as a message listener,
  // and the comparison must sit inside that function's body. `entry.type === 'file'` inside such a
  // listener therefore stays out — `entry` is not the listener's message parameter.
  const isHandlerShaped = (candidate: HandlerCandidate): boolean =>
    candidate.subject !== null &&
    state.scopes.some(
      (scope) =>
        scope.param === candidate.subject && candidate.at.pos >= scope.pos && candidate.at.end <= scope.end,
    )

  const handlerValue = (candidate: HandlerCandidate, ctx: ExtractContext): string | null => {
    const access = ctx.ast.asPropertyAccess(candidate.value)
    const root = access === null ? null : ctx.ast.asIdentifier(access.expression)
    if (access !== null && root !== null) return memberValue(root.text, access.name.text, ctx)
    if (!isHandlerShaped(candidate)) return null
    return ctx.flattenString(candidate.value)?.value ?? null
  }

  const recordComparison = (node: ts.Node, left: ts.Node, right: ts.Node, ctx: ExtractContext): void => {
    const value = isTypeFieldAccess(left, ctx) ? right : isTypeFieldAccess(right, ctx) ? left : null
    if (value === null) return
    const compared = value === right ? left : right
    state.candidates.push({ kind: "handler", at: node, value, subject: subjectOf(compared, ctx) })
  }

  // The four operators a handler branch is written with. `!==` is the early-return spelling of the
  // same fact — `if (message.type !== X) return` is a function that handles X and nothing else — and
  // it carries exactly the evidence `===` does, because WHICH type it names is still read off a
  // declared enum, never off the operator.
  const isEqualityOperator = (operator: ts.SyntaxKind, api: TypeScriptApi): boolean =>
    operator === api.SyntaxKind.EqualsEqualsEqualsToken ||
    operator === api.SyntaxKind.EqualsEqualsToken ||
    operator === api.SyntaxKind.ExclamationEqualsEqualsToken ||
    operator === api.SyntaxKind.ExclamationEqualsToken

  // `if (message.type === X && message.user)` is one branch handling one type, so the conjunction is
  // walked into. `||` too: each operand is its own handled type.
  const comparisonsIn = (node: ts.Node, ctx: ExtractContext): readonly ts.BinaryExpression[] => {
    const expression = ctx.ast.unwrap(node)
    if (!ctx.ts.isBinaryExpression(expression)) return []

    const operator = expression.operatorToken.kind
    if (
      operator === ctx.ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ctx.ts.SyntaxKind.BarBarToken
    )
      return [...comparisonsIn(expression.left, ctx), ...comparisonsIn(expression.right, ctx)]

    return isEqualityOperator(operator, ctx.ts) ? [expression] : []
  }

  const visitIfStatement = (node: ts.IfStatement, ctx: ExtractContext): void => {
    for (const comparison of comparisonsIn(node.expression, ctx))
      recordComparison(node, comparison.left, comparison.right, ctx)
  }

  const visitSwitchStatement = (node: ts.SwitchStatement, ctx: ExtractContext): void => {
    if (!isTypeFieldAccess(node.expression, ctx)) return
    const subject = subjectOf(node.expression, ctx)

    for (const clause of node.caseBlock.clauses) {
      if (!ctx.ts.isCaseClause(clause)) continue
      state.candidates.push({ kind: "handler", at: clause, value: clause.expression, subject })
    }
  }

  // `chrome.runtime.onMessage.addListener(...)` — the registration that makes a function's first
  // parameter a message. Named callbacks are matched by declaration in `finish`.
  const visitListenerRegistration = (call: ts.CallExpression, ctx: ExtractContext): void => {
    const callee = ctx.ast.asPropertyAccess(call.expression)
    if (callee === null) return
    const owner = ctx.ast.asPropertyAccess(callee.expression)
    if (owner === null || !handlerRegistrars.has(`${owner.name.text}.${callee.name.text}`)) return

    for (const argument of call.arguments) {
      const inner = ctx.ast.unwrap(argument)
      const parameter = firstParameterName(inner, ctx)
      if (parameter !== null) {
        state.scopes.push({ param: parameter, pos: inner.pos, end: inner.end })
        continue
      }
      const identifier = ctx.ast.asIdentifier(inner)
      if (identifier !== null) state.listenerRefs.push(identifier.text)
    }
  }

  const recordFunction = (node: ts.Node, ctx: ExtractContext): void => {
    const api = ctx.ts
    if (api.isFunctionDeclaration(node)) {
      const parameter = firstParameterName(node, ctx)
      if (node.name === undefined || parameter === null) return
      state.functions.set(node.name.text, { param: parameter, pos: node.pos, end: node.end })
      return
    }
    if (!api.isVariableDeclaration(node) || !api.isIdentifier(node.name) || node.initializer === undefined) return
    const fn = ctx.ast.unwrap(node.initializer)
    const parameter = firstParameterName(fn, ctx)
    if (parameter === null) return
    state.functions.set(node.name.text, { param: parameter, pos: fn.pos, end: fn.end })
  }

  // `chrome.runtime.sendMessage(...)` / `browser.runtime.sendMessage(...)`: a global namespace, not
  // an import — the same "unbound identifier" gate `http-client.ts` uses for bare `fetch`.
  const visitSendCall = (call: ts.CallExpression, ctx: ExtractContext): void => {
    const callee = ctx.ast.asPropertyAccess(call.expression)

    const via: MessageSendFact["via"] | null = (() => {
      if (callee !== null && sendMethods.has(callee.name.text)) {
        const root = ctx.bindings.rootIdentifier(callee.expression)
        if (root !== null && globalReceivers.has(root) && ctx.bindings.get(root) === null)
          return "chrome.runtime.sendMessage"
        return null
      }
      const identifier = ctx.ast.asIdentifier(call.expression)
      if (identifier !== null && sendMethods.has(identifier.text) && ctx.bindings.get(identifier.text) === null)
        return "postMessage"
      return null
    })()
    if (via === null) return

    // `chrome.tabs.sendMessage(tabId, message)` puts the payload second, so take the first argument
    // that is an object literal rather than assuming argument zero.
    const payload = call.arguments.map((argument) => ctx.ast.asObjectLiteral(argument)).find((object) => object !== null)

    const typeProperty = payload?.properties.find(
      (candidate): candidate is ts.PropertyAssignment =>
        ctx.ts.isPropertyAssignment(candidate) &&
        ctx.ts.isIdentifier(candidate.name) &&
        candidate.name.text === typeField,
    )

    state.candidates.push({
      kind: "send",
      at: call,
      via,
      typeNode: typeProperty?.initializer ?? null,
      payloadIsLiteral: payload !== undefined,
    })
  }

  const emitType = (value: string, node: ts.Node, ctx: ExtractContext): void => {
    if (state.seenTypes.has(value)) return
    state.seenTypes.add(value)
    ctx.emitFact("messages", value, node)
  }

  const finishHandler = (candidate: HandlerCandidate, ctx: ExtractContext): void => {
    const value = handlerValue(candidate, ctx)
    if (value === null) return
    emitType(value, candidate.at, ctx)
    const fact: MessageHandlerFact = { messageType: value, file: ctx.file, line: ctx.lineOf(candidate.at) }
    ctx.emitFact("messageHandlers", fact, candidate.at)
  }

  const finishSend = (candidate: SendCandidate, ctx: ExtractContext): void => {
    // A send is proven to be a message by the API it calls, so a plain string type is legitimate here
    // in a way it never is on the left of a comparison.
    const value =
      candidate.typeNode === null
        ? null
        : (protocolValue(candidate.typeNode, ctx) ?? ctx.flattenString(candidate.typeNode)?.value ?? null)

    const typeResolution: MessageTypeResolution =
      value !== null ? "resolved" : candidate.typeNode === null && candidate.payloadIsLiteral ? "absent" : "dynamic"

    if (value !== null) emitType(value, candidate.at, ctx)

    const fact: MessageSendFact = {
      messageType: value,
      typeResolution,
      via: candidate.via,
      file: ctx.file,
      line: ctx.lineOf(candidate.at),
    }
    ctx.emitFact("messageSends", fact, candidate.at)
  }

  return {
    name: "messages",
    provides: ["messages", "messageHandlers", "messageSends"],
    requires: ["bindings", "stringConstants"],
    stage: "main",

    start: () => {
      state = emptyState()
    },

    enter: (node, ctx) => {
      const api = ctx.ts
      if (api.isEnumDeclaration(node)) {
        if (enumNamePattern.test(node.name.text)) state.localEnums.set(node.name.text, enumTableOf(node, ctx))
        return
      }
      if (api.isIfStatement(node)) {
        visitIfStatement(node, ctx)
        return
      }
      if (api.isSwitchStatement(node)) {
        visitSwitchStatement(node, ctx)
        return
      }
      recordFunction(node, ctx)
      const call = ctx.ast.asCallExpression(node)
      if (call === null || call !== node) return
      visitListenerRegistration(call, ctx)
      visitSendCall(call, ctx)
    },

    // Cross-file resolution (`declarationFile` plus reading the declaring module) is confined to
    // `finish` (§5.4); every comparison and send recorded during the walk is resolved here, in walk
    // order, so the emitted order does not depend on where the declaration lives.
    finish: (ctx) => {
      for (const reference of state.listenerRefs) {
        const scope = state.functions.get(reference)
        if (scope !== undefined) state.scopes.push(scope)
      }

      for (const candidate of state.candidates) {
        if (candidate.kind === "handler") finishHandler(candidate, ctx)
        else finishSend(candidate, ctx)
      }
    },
  }
}
