import { createRequire } from "node:module"
import { Argument, Command, CommanderError, InvalidArgumentError, Option } from "commander"
import type { Locale } from "../emit/strings.js"
import { DEFAULT_FORMATS } from "../config/types.js"
import type { ExitCode } from "../pipeline/exit-codes.js"
import {
  EXIT_CACHE_UNAVAILABLE,
  EXIT_CODE_DESCRIPTIONS,
  EXIT_CODES,
  EXIT_DIAGNOSTIC_ERROR,
  EXIT_FAILURE,
  EXIT_NO_SCREENS,
  EXIT_OK,
  EXIT_PRECEDENCE,
  EXIT_STRICT_WARNING,
  EXIT_USAGE,
} from "../pipeline/exit-codes.js"
import type { CommandName, CommandSpec, OptionParserId, OptionSpec, OptionValue, QueryOptions, RegisteredCommand } from "./commands.js"
import {
  COMMAND_NAMES,
  DEFAULT_LIMIT,
  FORMATS,
  LOCALES,
  REGISTERED_COMMANDS,
  SHARED_OPTIONS,
  isCommandName,
  sharedOptionIds,
} from "./commands.js"

export {
  EXIT_CACHE_UNAVAILABLE,
  EXIT_DIAGNOSTIC_ERROR,
  EXIT_FAILURE,
  EXIT_NO_SCREENS,
  EXIT_OK,
  EXIT_STRICT_WARNING,
  EXIT_USAGE,
  FORMATS,
  LOCALES,
}

export const COMMANDS = COMMAND_NAMES

export type CliCommandName = CommandName

export type CliOptions = {
  readonly root?: string
  readonly config?: string
  /** Empty means "let the resolved config decide" (default: index + html, plus the graph cache). */
  readonly formats: readonly string[]
  readonly screen?: string
  readonly source?: string
  readonly out?: string
  readonly depth?: number
  readonly locale?: Locale
  readonly allSources: boolean
  readonly allowEmpty: boolean
  readonly ifStale: boolean
  readonly timestamp: boolean
  readonly strict: boolean
  readonly quiet: boolean
  readonly json: boolean
  readonly timing: boolean
}

export type ParsedCli = {
  readonly command: CliCommandName
  readonly options: CliOptions
  readonly query: QueryOptions
  readonly args: Readonly<Record<string, string>>
  readonly own: Readonly<Record<string, OptionValue | undefined>>
}

export type ParseOutcome =
  | { readonly kind: "run"; readonly parsed: ParsedCli }
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "error"; readonly code: number; readonly message: string }

export type ProgramIo = {
  readonly writeOut?: (text: string) => void
  readonly writeErr?: (text: string) => void
}

type PackageManifest = {
  readonly name?: unknown
  readonly version?: unknown
  readonly description?: unknown
}

const MANIFEST_CANDIDATES = ["../package.json", "../../package.json", "../../../package.json"] as const

const isManifest = (value: unknown): value is PackageManifest => typeof value === "object" && value !== null

const loadManifest = (specifier: string): PackageManifest | null => {
  try {
    const loaded: unknown = createRequire(import.meta.url)(specifier)
    return isManifest(loaded) && loaded.name === "appgraph" ? loaded : null
  } catch {
    return null
  }
}

const readPackageManifest = (): PackageManifest =>
  MANIFEST_CANDIDATES.map(loadManifest).find((manifest) => manifest !== null) ?? {}

const stringOr = (value: unknown, fallback: string): string =>
  typeof value === "string" && value !== "" ? value : fallback

export const readPackageVersion = (): string => stringOr(readPackageManifest().version, "0.0.0")

export const readPackageName = (): string => stringOr(readPackageManifest().name, "appgraph")

const readPackageDescription = (): string =>
  stringOr(
    readPackageManifest().description,
    "Static map of your app's screens — routes, component trees, API calls and selectors",
  )

const exitCodeLines = (codes: readonly ExitCode[]): readonly string[] => {
  const precedence = EXIT_PRECEDENCE.filter((code) => codes.includes(code))
  return [
    "Exit codes:",
    ...codes.map((code) => `  ${String(code)}  ${EXIT_CODE_DESCRIPTIONS[code]}`),
    ...(precedence.length < 2 ? [] : ["", `Precedence when several apply: ${precedence.map(String).join(" > ")}.`]),
  ]
}

const exampleLines = (examples: readonly string[]): readonly string[] => [
  "Examples:",
  ...examples.map((example) => `  $ ${example}`),
]

const commandHelp = (spec: CommandSpec): string =>
  ["", "Output:", `  ${spec.output}`, "", ...exampleLines(spec.examples), "", ...exitCodeLines(spec.exitCodes), ""].join("\n")

const ROOT_EXAMPLES = REGISTERED_COMMANDS.flatMap((spec) => spec.examples.slice(0, 1))

const rootHelp = (): string =>
  [
    "",
    "Run with no command to analyze; `appgraph analyze --help` lists the analysis flags.",
    "Query commands answer from the graph cache in --out and refresh it when the project changed.",
    "",
    ...exampleLines(ROOT_EXAMPLES),
    "",
    ...exitCodeLines(EXIT_CODES),
    "",
  ].join("\n")

const oneOf = (flag: string, allowed: readonly string[]) => (value: string): string => {
  if (!allowed.includes(value))
    throw new InvalidArgumentError(`${flag} must be one of: ${allowed.join(", ")}`)
  return value
}

const integerAtLeast = (flag: string, minimum: number, what: string) => (value: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum) throw new InvalidArgumentError(`${flag} must be a ${what} integer`)
  return parsed
}

const listOf = (value: string): readonly string[] =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")

const longFlag = (spec: OptionSpec): string => spec.flags.split(/[ ,]/)[0] ?? spec.flags

const PARSERS: Readonly<Record<OptionParserId, (flag: string) => (value: string, previous: unknown) => unknown>> = {
  format: (flag) => (value, previous) => [...(Array.isArray(previous) ? previous : []), oneOf(flag, FORMATS)(value)],
  count: (flag) => integerAtLeast(flag, 0, "non-negative"),
  positive: (flag) => integerAtLeast(flag, 1, "positive"),
  list: () => listOf,
}

const optionOf = (spec: OptionSpec): Option => {
  const option = new Option(spec.flags, spec.description)
  if (spec.choices !== undefined) option.choices(spec.choices)
  if (spec.parser !== undefined) option.argParser(PARSERS[spec.parser](longFlag(spec)))
  if (spec.defaultValue !== undefined) option.default(spec.defaultValue)
  return option
}

export const optionAttribute = (spec: OptionSpec): string => new Option(spec.flags).attributeName()

type RawOptions = Readonly<Record<string, unknown>>

const stringOf = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const numberOf = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined)

const stringListOf = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined

const localeOf = (value: unknown): Locale | undefined => (value === "en" || value === "pl" ? value : undefined)

const normalizeOptions = (raw: RawOptions): CliOptions => {
  const [root, config, screen, source, out] = (["root", "config", "screen", "source", "out"] as const).map((key) => stringOf(raw[key]))
  const depth = numberOf(raw["depth"])
  const locale = localeOf(raw["locale"])
  return {
    ...(root === undefined ? {} : { root }),
    ...(config === undefined ? {} : { config }),
    formats: [...(stringListOf(raw["format"]) ?? [])],
    ...(screen === undefined ? {} : { screen }),
    ...(source === undefined ? {} : { source }),
    ...(out === undefined ? {} : { out }),
    ...(depth === undefined ? {} : { depth }),
    ...(locale === undefined ? {} : { locale }),
    allSources: raw["allSources"] === true,
    allowEmpty: raw["allowEmpty"] === true,
    ifStale: raw["ifStale"] === true,
    timestamp: raw["timestamp"] !== false,
    strict: raw["strict"] === true,
    quiet: raw["quiet"] === true,
    json: raw["json"] === true,
    timing: raw["timing"] === true,
  }
}

const queryOptionsOf = (raw: RawOptions): QueryOptions => ({
  cached: raw["cached"] === true,
  limit: numberOf(raw["limit"]) ?? DEFAULT_LIMIT,
  offset: numberOf(raw["offset"]) ?? 0,
  fields: stringListOf(raw["fields"]) ?? null,
})

const optionValueOf = (value: unknown): OptionValue | undefined => {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  return stringListOf(value)
}

const ownOptionsOf = (spec: CommandSpec, raw: RawOptions): ParsedCli["own"] =>
  Object.fromEntries(spec.options.map((option) => [optionAttribute(option), optionValueOf(raw[optionAttribute(option)])]))

const argsOf = (spec: CommandSpec, positional: readonly unknown[]): ParsedCli["args"] =>
  Object.fromEntries(
    spec.args.flatMap((arg, index) => {
      const value = positional[index]
      return typeof value === "string" ? [[arg.key, value]] : []
    }),
  )

/**
 * `--screen` is honoured by exactly one emitter. `index`, `full` and `html` render the whole graph
 * whatever it is set to, so accepting the pair would report success for output the flag did not
 * restrict. The relation is symmetric: neither half
 * means anything without the other.
 */
const validate = (parsed: ParsedCli): ParseOutcome => {
  const { formats, screen } = parsed.options
  if (formats.includes("detail") && screen === undefined)
    return { kind: "error", code: EXIT_USAGE, message: "--format detail requires --screen <id>" }

  const unrestricted = formats.filter((format) => format !== "detail")
  if (screen !== undefined && (formats.length === 0 || unrestricted.length > 0))
    return {
      kind: "error",
      code: EXIT_USAGE,
      message:
        formats.length === 0
          ? `--screen requires --format detail (the default formats are ${[...DEFAULT_FORMATS].join(", ")}, none of which it restricts)`
          : `--screen requires --format detail; it restricts nothing in ${unrestricted.join(", ")}`,
    }

  return { kind: "run", parsed }
}

export type CommandInvocation = {
  readonly spec: RegisteredCommand
  readonly positional: readonly unknown[]
  readonly raw: RawOptions
}

export type ProgramInput = {
  readonly io?: ProgramIo
  readonly onRun: (invocation: CommandInvocation) => void
}

const argumentOf = (spec: CommandSpec["args"][number]): Argument =>
  new Argument(spec.required ? `<${spec.display}>` : `[${spec.display}]`, spec.description)

const addCommand = (program: Command, spec: RegisteredCommand, input: ProgramInput): void => {
  const command = program
    .command(spec.name, { isDefault: spec.isDefault === true })
    .summary(spec.summary)
    .description(spec.description)
    .allowExcessArguments(false)
    .addHelpText("after", commandHelp(spec))

  for (const arg of spec.args) command.addArgument(argumentOf(arg))
  for (const id of sharedOptionIds(spec)) command.addOption(optionOf(SHARED_OPTIONS[id]))
  for (const option of spec.options) command.addOption(optionOf(option))

  command.action(() => {
    input.onRun({ spec, positional: command.processedArgs, raw: command.opts() })
  })
}

export const buildProgram = (input: ProgramInput): Command => {
  const program = new Command()
  const write = (sink: ((text: string) => void) | undefined, fallback: (text: string) => void) =>
    sink ?? fallback

  program
    .name(readPackageName())
    .description(readPackageDescription())
    .version(readPackageVersion())
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({
      writeOut: write(input.io?.writeOut, (text) => process.stdout.write(text)),
      writeErr: write(input.io?.writeErr, (text) => process.stderr.write(text)),
      outputError: () => undefined,
    })
    .addHelpText("after", rootHelp())

  for (const spec of REGISTERED_COMMANDS) addCommand(program, spec, input)

  return program
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error"

const HELP_CODES = ["commander.helpDisplayed", "commander.help", "commander.version"]

const HELP_COMMAND = "help"

const unknownCommand = (argv: readonly string[]): string | null => {
  const [first] = argv
  if (first === undefined || first.startsWith("-") || first === HELP_COMMAND || isCommandName(first)) return null
  return `unknown command '${first}'. Commands: ${COMMAND_NAMES.join(", ")} (run appgraph --help)`
}

const parsedOf = (invocation: CommandInvocation): ParsedCli => ({
  command: invocation.spec.name,
  options: normalizeOptions(invocation.raw),
  query: queryOptionsOf(invocation.raw),
  args: argsOf(invocation.spec, invocation.positional),
  own: ownOptionsOf(invocation.spec, invocation.raw),
})

const SHARED_FLAG_ARITY: ReadonlyMap<string, boolean> = new Map(
  Object.values(SHARED_OPTIONS).map((option) => [option.flags.split(" ")[0] ?? "", option.flags.includes("<")]),
)

const leadingCommandIndex = (argv: readonly string[], index = 0): number | null => {
  const token = argv[index]
  if (token === undefined) return null
  if (!token.startsWith("-")) return isCommandName(token) ? index : null
  if (token.includes("=")) return leadingCommandIndex(argv, index + 1)
  const takesValue = SHARED_FLAG_ARITY.get(token)
  if (takesValue === undefined) return null
  return leadingCommandIndex(argv, index + (takesValue ? 2 : 1))
}

const commandFirst = (argv: readonly string[]): readonly string[] => {
  const index = leadingCommandIndex(argv)
  if (index === null || index === 0) return argv
  return [argv[index] ?? "", ...argv.slice(0, index), ...argv.slice(index + 1)]
}

/** Pure over `argv` (already stripped of `node` and the script path) — the tests call this directly. */
export const parseArgv = (rawArgv: readonly string[], io: ProgramIo = {}): ParseOutcome => {
  const argv = commandFirst(rawArgv)
  const unknown = unknownCommand(argv)
  if (unknown !== null) return { kind: "error", code: EXIT_USAGE, message: unknown }

  let outcome: ParseOutcome | null = null

  const program = buildProgram({
    io,
    onRun: (invocation) => {
      outcome = validate(parsedOf(invocation))
    },
  })

  try {
    program.parse([...argv], { from: "user" })
  } catch (error) {
    if (error instanceof CommanderError)
      return HELP_CODES.includes(error.code)
        ? { kind: "exit", code: EXIT_OK }
        : { kind: "error", code: EXIT_USAGE, message: error.message }
    return { kind: "error", code: EXIT_USAGE, message: messageOf(error) }
  }

  return outcome ?? { kind: "exit", code: EXIT_OK }
}
