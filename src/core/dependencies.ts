import type { FileHost } from "./host.js"

const MANIFEST_KEYS = ["dependencies", "devDependencies", "peerDependencies"] as const

const parseManifest = (text: string): Readonly<Record<string, unknown>> | null => {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null ? (parsed as Readonly<Record<string, unknown>>) : null
  } catch {
    return null
  }
}

const sectionNames = (manifest: Readonly<Record<string, unknown>>): readonly string[] =>
  MANIFEST_KEYS.flatMap((key) => {
    const section = manifest[key]
    return typeof section === "object" && section !== null ? Object.keys(section) : []
  })

/**
 * §10.7: dependency PRESENCE keys on the manifest key, never on the value — a host that pins
 * `"typescript": "npm:@typescript/typescript6@^6.0.2"` gives any code reading the value an alias spec
 * rather than a range.
 */
export const readDependencies = (host: FileHost, manifests: readonly string[]): ReadonlySet<string> =>
  new Set(
    manifests.flatMap((manifest) => {
      const text = host.readFile(manifest)
      const parsed = text === null ? null : parseManifest(text)
      return parsed === null ? [] : sectionNames(parsed)
    }),
  )
