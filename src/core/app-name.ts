export type AppNameInput = {
  /** Raw text of the analysed project's `package.json`, or null when there is none. */
  readonly manifest: string | null
  /** The root directory's basename — what `meta.root` carries (§11 rule 5). */
  readonly rootLabel: string
}

const manifestName = (manifest: string): string | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(manifest)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const name = (parsed as Record<string, unknown>)["name"]
  if (typeof name !== "string") return null
  const trimmed = name.trim()
  return trimmed === "" ? null : trimmed
}

/**
 * The manifest's own `name` — not a dependency specifier — so no `npm:` alias unwrapping applies.
 */
export const resolveAppName = (input: AppNameInput): string | null => {
  const fromManifest = input.manifest === null ? null : manifestName(input.manifest)
  if (fromManifest !== null) return fromManifest
  const label = input.rootLabel.trim()
  return label === "" ? null : label
}
