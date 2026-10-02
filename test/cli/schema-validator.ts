type Schema = Readonly<Record<string, unknown>>

type Check = (schema: Schema, value: unknown, at: string) => readonly string[]

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const asSchema = (value: unknown): Schema => (isRecord(value) ? value : {})

const jsonTypeOf = (value: unknown): string => {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number"
  return typeof value
}

const typeMatches = (wanted: string, actual: string): boolean => wanted === actual || (wanted === "number" && actual === "integer")

const checkType: Check = (schema, value, at) => {
  if (schema["type"] === undefined) return []
  const wanted = Array.isArray(schema["type"]) ? schema["type"].map(String) : [String(schema["type"])]
  const actual = jsonTypeOf(value)
  return wanted.some((type) => typeMatches(type, actual)) ? [] : [`${at}: expected ${wanted.join("|")}, got ${actual}`]
}

const checkEnum: Check = (schema, value, at) => {
  const options = schema["enum"]
  if (!Array.isArray(options) || options.includes(value)) return []
  return [`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(options)}`]
}

const checkObject: Check = (schema, value, at) => {
  if (!isRecord(value)) return []
  const properties = asSchema(schema["properties"])
  const required = Array.isArray(schema["required"]) ? schema["required"].map(String) : []
  const missing = required.filter((key) => !(key in value)).map((key) => `${at}: missing required key '${key}'`)
  const undeclared =
    schema["additionalProperties"] === false
      ? Object.keys(value)
          .filter((key) => !(key in properties))
          .map((key) => `${at}: undeclared key '${key}'`)
      : []
  const nested = Object.entries(value).flatMap(([key, child]) =>
    key in properties ? validate(asSchema(properties[key]), child, `${at}.${key}`) : [],
  )
  return [...missing, ...undeclared, ...nested]
}

const checkItems: Check = (schema, value, at) =>
  Array.isArray(value) && schema["items"] !== undefined
    ? value.flatMap((child, index) => validate(asSchema(schema["items"]), child, `${at}[${String(index)}]`))
    : []

const checkAnyOf: Check = (schema, value, at) => {
  const options = schema["anyOf"]
  if (!Array.isArray(options)) return []
  const failures = options.map((option) => validate(asSchema(option), value, at))
  return failures.some((errors) => errors.length === 0) ? [] : [`${at}: matches no anyOf branch`, ...failures.flat()]
}

const CHECKS: readonly Check[] = [checkType, checkEnum, checkObject, checkItems, checkAnyOf]

export const validate = (schema: Schema, value: unknown, at = "$"): readonly string[] =>
  CHECKS.flatMap((check) => check(schema, value, at))
