import { GLOSSARY } from "../../emit/glossary.js"
import { t } from "../../emit/strings.js"
import { EXIT_OK } from "../../pipeline/exit-codes.js"
import type { CommandSpec, EnvelopeKind, FieldSpec, FieldType, QueryContext, QueryRun } from "../commands.js"
import { COMMAND_NAMES, DIAGNOSTIC_FIELDS, REGISTERED_COMMANDS, field } from "../commands.js"
import { CATALOG_LOCALE, unknownValueError } from "./catalog.js"
import { QUERY_SCHEMA_VERSION, formatJson } from "./output.js"
import { CACHE_STATUSES } from "./runtime.js"

export type JsonSchema = Readonly<Record<string, unknown>>

export const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema"

export const ERROR_SCHEMA_ID = "error"

const BASE_TYPES = {
  string: { type: "string" },
  integer: { type: "integer" },
  number: { type: "number" },
  boolean: { type: "boolean" },
  object: { type: "object" },
  array: { type: "array" },
  "string[]": { type: "array", items: { type: "string" } },
  "object[]": { type: "array", items: { type: "object" } },
} as const satisfies Readonly<Record<FieldType, { readonly type: string; readonly items?: JsonSchema }>>

const GLOSSARY_HELP: ReadonlyMap<string, string> = new Map(GLOSSARY.map((entry) => [entry.id, t(CATALOG_LOCALE, entry.helpKey)]))

const descriptionOf = (spec: FieldSpec): string => {
  const help = spec.term === undefined ? undefined : GLOSSARY_HELP.get(spec.term)
  return help === undefined ? spec.description : `${spec.description}. ${help}`
}

const isNullable = (spec: FieldSpec): boolean => spec.nullable === true

const typeKeyword = (types: readonly string[], nullable: boolean): string | readonly string[] => {
  const all = nullable ? [...types, "null"] : types
  return all.length === 1 ? (all[0] ?? "null") : all
}

const typesOf = (spec: FieldSpec): readonly FieldType[] => (typeof spec.type === "string" ? [spec.type] : spec.type)

export const objectSchema = (fields: readonly FieldSpec[]): JsonSchema => ({
  type: "object",
  properties: Object.fromEntries(fields.map((spec) => [spec.name, fieldSchema(spec)])),
  required: fields.filter((spec) => spec.optional !== true).map((spec) => spec.name),
  additionalProperties: false,
})

const nestedOf = (type: FieldType, fields: readonly FieldSpec[] | undefined): JsonSchema => {
  if (fields === undefined) return {}
  if (type === "object") return objectSchema(fields)
  return type === "object[]" ? { items: objectSchema(fields) } : {}
}

const enumOf = (spec: FieldSpec): JsonSchema =>
  spec.choices === undefined ? {} : { enum: isNullable(spec) ? [...spec.choices, null] : [...spec.choices] }

const typedSchema = (spec: FieldSpec): JsonSchema => {
  const types = typesOf(spec)
  const [single] = types
  if (types.length !== 1 || single === undefined)
    return { type: typeKeyword([...new Set(types.map((type) => BASE_TYPES[type].type))], isNullable(spec)) }
  return { ...BASE_TYPES[single], ...nestedOf(single, spec.fields), type: typeKeyword([BASE_TYPES[single].type], isNullable(spec)) }
}

export const fieldSchema = (spec: FieldSpec): JsonSchema => ({
  description: descriptionOf(spec),
  ...typedSchema(spec),
  ...enumOf(spec),
})

const CACHE_FIELDS = [
  field("status", "string", "fresh: read as is; refreshed: rebuilt because stale or incompatible; built: built because missing or corrupt", {
    choices: CACHE_STATUSES,
  }),
  field("path", "string", "Graph cache file, relative to the project root"),
  field("fingerprint", "string", "Fingerprint of the project state the graph answers for"),
]

const headFields = (spec: CommandSpec): readonly FieldSpec[] => [
  field("schemaVersion", "integer", "Version of the query output contract", { choices: [QUERY_SCHEMA_VERSION] }),
  field("command", "string", "Command that produced the output", { choices: [spec.name] }),
  field("cache", "object", "Graph cache the answer came from; absent when the command reads no graph", {
    optional: true,
    fields: CACHE_FIELDS,
  }),
  field("emptyResult", "boolean", "Present, and true, when the graph has no screens", { optional: true }),
  field("emptyReason", "string", "Why the graph has no screens", { optional: true, nullable: true }),
  ...(spec.extra ?? []),
]

const PAGE_FIELDS = [
  field("total", "integer", "Matching items before paging"),
  field("offset", "integer", "Items skipped (--offset)"),
  field("limit", "integer", "Page size (--limit)"),
  field("truncated", "boolean", "More items exist past this page"),
  field("nextOffset", "integer", "--offset of the next page; present only when truncated", { optional: true }),
]

const ROW_NOTE = "every declared key is present unless --fields keeps only the named ones"

const listFields = (spec: CommandSpec): readonly FieldSpec[] => [
  ...headFields(spec),
  ...PAGE_FIELDS,
  field("items", "object[]", `Rows of this page; ${ROW_NOTE}`, { fields: spec.fields }),
]

const itemFields = (spec: CommandSpec): readonly FieldSpec[] => [
  ...headFields(spec),
  field("item", "object", `The answer; ${ROW_NOTE}`, { fields: spec.fields }),
]

const ENVELOPES = {
  summary: (spec) => objectSchema(spec.fields),
  list: (spec) => objectSchema(listFields(spec)),
  item: (spec) => objectSchema(itemFields(spec)),
  "list-or-item": (spec) => ({ anyOf: [objectSchema(listFields(spec)), objectSchema(itemFields(spec))] }),
  document: () => ({ type: "object", description: "A JSON Schema (2020-12 subset) document" }),
} as const satisfies Readonly<Record<EnvelopeKind, (spec: CommandSpec) => JsonSchema>>

const ERROR_FIELDS = [
  field("command", "string", "Command that failed"),
  field("exitCode", "integer", "The process exit code"),
  field("error", "object", "What went wrong", {
    fields: [
      field("code", "string", "Stable error code, such as usage/unknown-field or cache/stale"),
      field("message", "string", "Human-readable message"),
      field("hint", "string", "What to try next", { nullable: true }),
    ],
  }),
  field("diagnostics", "object[]", "Diagnostics behind the failure", { fields: DIAGNOSTIC_FIELDS }),
]

export const commandSchema = (spec: CommandSpec): JsonSchema => ({
  title: `appgraph ${spec.name} --json`,
  description: spec.output,
  ...ENVELOPES[spec.envelope](spec),
})

export const errorSchema = (): JsonSchema => ({
  title: "appgraph --json error",
  description: "Printed on stdout instead of the command's output when any command run with --json fails",
  ...objectSchema(ERROR_FIELDS),
})

const SCHEMA_IDS: readonly string[] = [...COMMAND_NAMES, ERROR_SCHEMA_ID]

const definitions = (): Readonly<Record<string, JsonSchema>> => ({
  ...Object.fromEntries(REGISTERED_COMMANDS.map((spec) => [spec.name, commandSchema(spec)])),
  [ERROR_SCHEMA_ID]: errorSchema(),
})

export const schemaDocument = (target: string | undefined): JsonSchema => {
  const defs = definitions()
  if (target === undefined)
    return {
      $schema: SCHEMA_DIALECT,
      title: "appgraph --json outputs",
      description: "Schemas of every command's --json output, keyed by command name, plus the error object",
      $defs: defs,
    }
  const found = defs[target]
  if (found === undefined)
    throw unknownValueError({ what: "command", value: target, valid: SCHEMA_IDS, code: "usage/unknown-command" })
  return { $schema: SCHEMA_DIALECT, ...found }
}

const PRETTY_INDENT = 2

const answer = (context: QueryContext): number => {
  const document = schemaDocument(context.args["command"])
  const lines = context.options.json ? [formatJson(document)] : JSON.stringify(document, null, PRETTY_INDENT).split("\n")
  for (const line of lines) context.writer.out(line)
  return EXIT_OK
}

const run: QueryRun = (context) => Promise.resolve(context).then(answer)

export default run
