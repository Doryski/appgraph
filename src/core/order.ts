export const byCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export const byNumber = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0)

export const by =
  <T>(key: (value: T) => string) =>
  (a: T, b: T): number =>
    byCodepoint(key(a), key(b))

export const thenBy =
  <T>(...comparators: readonly ((a: T, b: T) => number)[]) =>
  (a: T, b: T): number => {
    for (const comparator of comparators) {
      const result = comparator(a, b)
      if (result !== 0) return result
    }
    return 0
  }

export const sortStrings = (values: Iterable<string>): string[] => [...values].sort(byCodepoint)

export const sortBy = <T>(values: Iterable<T>, key: (value: T) => string): T[] =>
  [...values].sort(by(key))

export const stableUnique = (values: Iterable<string>): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

export const uniqueBy = <T>(values: Iterable<T>, key: (value: T) => string): T[] => {
  const seen = new Set<string>()
  const out: T[] = []
  for (const value of values) {
    const id = key(value)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(value)
  }
  return out
}

export const sortedUnique = (values: Iterable<string>): string[] =>
  stableUnique(values).sort(byCodepoint)

export const sortedUniqueBy = <T>(values: Iterable<T>, key: (value: T) => string): T[] =>
  uniqueBy(values, key).sort(by(key))

export const sortedEntries = <T>(record: Readonly<Record<string, T>>): [string, T][] =>
  Object.entries(record).sort(([a], [b]) => byCodepoint(a, b))

export const sortedRecord = <T>(record: Readonly<Record<string, T>>): Record<string, T> =>
  Object.fromEntries(sortedEntries(record))

export const compareStringArrays = (a: readonly string[], b: readonly string[]): number => {
  const shared = a.length < b.length ? a.length : b.length
  for (let index = 0; index < shared; index += 1) {
    const result = byCodepoint(a[index] ?? "", b[index] ?? "")
    if (result !== 0) return result
  }
  return byNumber(a.length, b.length)
}
