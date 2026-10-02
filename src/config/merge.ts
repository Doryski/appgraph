/**
 * Keyed list merge for configuration rules: a later entry whose `name` is already present replaces it IN
 * PLACE (rule order is match order), a new name is appended. This is what lets a config override one
 * default wrapper rule without restating the other five.
 */
export const mergeByName = <T extends { readonly name: string }>(...lists: readonly (readonly T[] | undefined)[]): readonly T[] => {
  const merged = new Map<string, T>()
  for (const list of lists) for (const entry of list ?? []) merged.set(entry.name, entry)
  return [...merged.values()]
}
