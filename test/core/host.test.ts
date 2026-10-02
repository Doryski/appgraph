import { describe, expect, it } from "vitest"
import type { FileHost } from "../../src/core/host.js"
import { createCachingHost, createMemoryHost } from "../../src/core/host.js"

const COUNTED = ["readFile", "exists", "isFile", "isDirectory", "mtimeMs", "readDir"] as const

type Counted = (typeof COUNTED)[number]

const countingHost = (inner: FileHost) => {
  const calls = new Map<string, number>()
  const count =
    <T>(method: Counted, fn: (abs: string) => T) =>
    (abs: string): T => {
      calls.set(`${method} ${abs}`, (calls.get(`${method} ${abs}`) ?? 0) + 1)
      return fn(abs)
    }
  const host: FileHost = {
    ...inner,
    readFile: count("readFile", inner.readFile),
    exists: count("exists", inner.exists),
    isFile: count("isFile", inner.isFile),
    isDirectory: count("isDirectory", inner.isDirectory),
    mtimeMs: count("mtimeMs", inner.mtimeMs),
    readDir: count("readDir", inner.readDir),
  }
  return { host, calls }
}

const memory = () =>
  createMemoryHost({
    files: {
      "/repo/a.ts": "a",
      "/repo/src/b.ts": "b",
      "/repo/src/nested/c.tsx": "c",
    },
    symlinks: ["/repo/src/link"],
    mtimes: { "/repo/a.ts": 42 },
  })

describe("createCachingHost", () => {
  it("answers exactly like the inner host", () => {
    const inner = memory()
    const cached = createCachingHost(memory())
    const probes = ["/repo/a.ts", "/repo/src", "/repo/src/link", "/repo/missing.ts", "/repo/src/nested/c.tsx"]

    for (const abs of probes) {
      expect(cached.readFile(abs)).toBe(inner.readFile(abs))
      expect(cached.exists(abs)).toBe(inner.exists(abs))
      expect(cached.isFile(abs)).toBe(inner.isFile(abs))
      expect(cached.isDirectory(abs)).toBe(inner.isDirectory(abs))
      expect(cached.mtimeMs(abs)).toBe(inner.mtimeMs(abs))
      expect(cached.readDir(abs)).toEqual(inner.readDir(abs))
    }
    expect(cached.glob("/repo", "**/*.{ts,tsx}")).toEqual(inner.glob("/repo", "**/*.{ts,tsx}"))
    expect(cached.symlinksSeen()).toEqual(inner.symlinksSeen())
  })

  it("asks the inner host once per method and path, null and false answers included", () => {
    const { host, calls } = countingHost(memory())
    const cached = createCachingHost(host)

    for (let round = 0; round < 3; round += 1)
      for (const method of COUNTED) {
        cached[method]("/repo/a.ts")
        cached[method]("/repo/missing.ts")
        cached[method]("/repo/src/link")
      }

    expect([...calls.values()].every((count) => count === 1)).toBe(true)
    expect(calls.size).toBe(COUNTED.length * 3)
  })

  it("globs over the cached directory listing", () => {
    const { host, calls } = countingHost(memory())
    const cached = createCachingHost(host)

    expect(cached.glob("/repo", "**/*.ts")).toEqual(["a.ts", "src/b.ts"])
    expect(cached.glob("/repo", "**/*.tsx")).toEqual(["src/nested/c.tsx"])
    cached.readDir("/repo/src")

    expect([...calls.entries()].filter(([key]) => key.startsWith("readDir ")).every(([, count]) => count === 1)).toBe(true)
    expect(calls.get("readDir /repo/src")).toBe(1)
  })

  it("reports the union of its own and the inner host's symlinks, sorted", () => {
    const inner = createMemoryHost({ files: { "/x/z/f.ts": "" }, symlinks: ["/x/b", "/x/z/a"] })
    inner.glob("/x/z", "**/*")
    const cached = createCachingHost(inner)
    cached.glob("/x", "**/*")

    expect(cached.symlinksSeen()).toEqual(["/x/b", "/x/z/a"])
  })
})
