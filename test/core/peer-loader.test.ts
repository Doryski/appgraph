import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import {
  type PeerLoad,
  dependencyRange,
  loadPeer,
  loadPeerSync,
  majorOfRange,
  projectMajorOf,
  resolvePeer,
} from "../../src/core/peer-loader.js"

const ROOT = "/project"
const PROJECT_BASE = path.join(ROOT, "package.json")
const PACKAGES = [{ specifier: "peer/compiler", manifest: "peer/package.json" }] as const

const notFound = (specifier: string): Error => new Error(`Cannot find module '${specifier}'`)

const scratch = mkdtempSync(path.join(tmpdir(), "appgraph-peer-loader-"))

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const writeFiles = (files: Readonly<Record<string, string>>) => {
  for (const [file, text] of Object.entries(files)) {
    const full = path.join(scratch, file)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
}

writeFiles({
  "project/package.json": JSON.stringify({ name: "project" }),
  "project/node_modules/cjs-peer/package.json": JSON.stringify({ name: "cjs-peer", version: "2.1.0", main: "index.js" }),
  "project/node_modules/cjs-peer/index.js": "module.exports = { kind: 'cjs' }\n",
  "project/node_modules/esm-peer/package.json": JSON.stringify({
    name: "esm-peer",
    version: "3.0.0",
    type: "module",
    main: "index.js",
  }),
  "project/node_modules/esm-peer/index.js": "export const kind = 'esm'\nexport const version = '3.0.1'\n",
  "elsewhere/node_modules/leaked/package.json": JSON.stringify({ name: "leaked", version: "9.9.9", main: "index.js" }),
  "elsewhere/node_modules/leaked/index.js": "module.exports = { kind: 'leaked' }\n",
  "project/node_modules/explosive-peer/package.json": JSON.stringify({ name: "explosive-peer", version: "4.2.0", main: "index.js" }),
  "project/node_modules/explosive-peer/index.js": "throw new Error('evaluated')\n",
})

const projectRoot = path.join(scratch, "project")

describe("peer-loader: candidate order", () => {
  it("prefers the project over appgraph", async () => {
    const load = vi.fn<PeerLoad>((specifier, base) => {
      if (specifier !== "peer/compiler") throw notFound(specifier)
      return { version: base === PROJECT_BASE ? "1.0.0" : "2.0.0" }
    })

    const result = await loadPeer({ root: ROOT, packages: PACKAGES, moduleKind: "cjs", load })

    expect(result).toMatchObject({ kind: "loaded", version: "1.0.0", from: "project" })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("falls back to appgraph when the project has none", async () => {
    const load: PeerLoad = (specifier, base) => {
      if (base === PROJECT_BASE) throw notFound(specifier)
      return { version: "2.0.0" }
    }

    expect(await loadPeer({ root: ROOT, packages: PACKAGES, moduleKind: "cjs", load })).toMatchObject({
      kind: "loaded",
      from: "appgraph",
    })
  })

  it("restricts the candidates to the requested sources", () => {
    const load = vi.fn<PeerLoad>(() => ({ version: "2.0.0" }))

    const result = loadPeerSync({ root: ROOT, packages: PACKAGES, load, sources: ["appgraph"] })

    expect(result).toMatchObject({ kind: "loaded", from: "appgraph" })
    expect(load.mock.calls.every(([, base]) => base !== PROJECT_BASE)).toBe(true)
  })

  it("reads the version from the manifest when the module has none", () => {
    const load: PeerLoad = (specifier) => (specifier === "peer/package.json" ? { version: "1.4.2" } : {})

    expect(loadPeerSync({ root: ROOT, packages: PACKAGES, load })).toMatchObject({ kind: "loaded", version: "1.4.2" })
  })
})

describe("peer-loader: the real loaders", () => {
  it("requires a CommonJS peer from the project's node_modules", async () => {
    const result = await loadPeer({
      root: projectRoot,
      packages: [{ specifier: "cjs-peer", manifest: "cjs-peer/package.json" }],
      moduleKind: "cjs",
    })

    expect(result).toMatchObject({ kind: "loaded", version: "2.1.0", from: "project", module: { kind: "cjs" } })
  })

  it("imports an ESM peer through its resolved file URL", async () => {
    const result = await loadPeer({
      root: projectRoot,
      packages: [{ specifier: "esm-peer", manifest: "esm-peer/package.json" }],
      moduleKind: "esm",
    })

    expect(result).toMatchObject({ kind: "loaded", version: "3.0.1", from: "project", module: { kind: "esm" } })
  })

  it("rejects a project resolution outside the project's node_modules and falls back to appgraph", async () => {
    const leaked = path.join(scratch, "elsewhere", "node_modules", "leaked", "index.js")

    const result = await loadPeer({
      root: projectRoot,
      packages: [{ specifier: leaked, manifest: path.join(path.dirname(leaked), "package.json") }],
      moduleKind: "cjs",
    })

    expect(result).toMatchObject({ kind: "loaded", from: "appgraph", version: "9.9.9" })
  })

  it("reports the isolation failure when no source can load the peer", () => {
    const leaked = path.join(scratch, "elsewhere", "node_modules", "leaked", "index.js")

    const result = loadPeerSync({
      root: projectRoot,
      packages: [{ specifier: leaked, manifest: "leaked/package.json" }],
      sources: ["project"],
    })

    expect(result.kind).toBe("missing")
    if (result.kind !== "missing") return
    expect(result.detail).toContain("resolved outside the project's node_modules")
  })
})

describe("peer-loader: resolvePeer", () => {
  it("reports the project-installed version without evaluating the module", () => {
    const result = resolvePeer({
      root: projectRoot,
      packages: [{ specifier: "explosive-peer", manifest: "explosive-peer/package.json" }],
    })

    expect(result).toEqual({ kind: "resolved", specifier: "explosive-peer", version: "4.2.0", from: "project" })
  })

  it("falls through the candidates in the same order as loadPeer", () => {
    const result = resolvePeer({
      root: projectRoot,
      packages: [
        { specifier: "absent-peer", manifest: "absent-peer/package.json" },
        { specifier: "cjs-peer", manifest: "cjs-peer/package.json" },
      ],
    })

    expect(result).toEqual({ kind: "resolved", specifier: "cjs-peer", version: "2.1.0", from: "project" })
  })

  it("reports an unknown version when the manifest cannot be resolved", () => {
    const result = resolvePeer({
      root: projectRoot,
      packages: [{ specifier: "cjs-peer", manifest: "cjs-peer/missing.json" }],
      sources: ["project"],
    })

    expect(result).toMatchObject({ kind: "resolved", version: "unknown", from: "project" })
  })

  it("honours the isolation check and reports missing when no source resolves", () => {
    const leaked = path.join(scratch, "elsewhere", "node_modules", "leaked", "index.js")

    const result = resolvePeer({
      root: projectRoot,
      packages: [{ specifier: leaked, manifest: "leaked/package.json" }],
      sources: ["project"],
    })

    expect(result.kind).toBe("missing")
    if (result.kind !== "missing") return
    expect(result.detail).toContain("resolved outside the project's node_modules")
  })
})

describe("peer-loader: ESM through an injected loader", () => {
  it("awaits an asynchronous load", async () => {
    const load: PeerLoad = (specifier) =>
      specifier === "peer/compiler" ? Promise.resolve({ version: "5.0.0" }) : Promise.reject(notFound(specifier))

    expect(await loadPeer({ root: ROOT, packages: PACKAGES, moduleKind: "esm", load })).toMatchObject({
      kind: "loaded",
      version: "5.0.0",
      from: "project",
    })
  })

  it("treats a rejected import as a failed candidate", async () => {
    const load: PeerLoad = (specifier, base) =>
      base === PROJECT_BASE ? Promise.reject(notFound(specifier)) : Promise.resolve({ version: "5.1.0" })

    expect(await loadPeer({ root: ROOT, packages: PACKAGES, moduleKind: "esm", load })).toMatchObject({
      kind: "loaded",
      from: "appgraph",
    })
  })
})

describe("peer-loader: missing never throws", () => {
  const failing: PeerLoad = (specifier) => {
    throw notFound(specifier)
  }

  it("lists every attempted candidate", async () => {
    const result = await loadPeer({ root: ROOT, packages: PACKAGES, moduleKind: "cjs", load: failing })

    expect(result).toEqual({
      kind: "missing",
      detail:
        "peer/compiler (project): Cannot find module 'peer/compiler'; peer/compiler (appgraph): Cannot find module 'peer/compiler'",
    })
  })

  it("survives a non-Error throw", () => {
    const load: PeerLoad = () => {
      throw "boom"
    }

    expect(loadPeerSync({ root: ROOT, packages: PACKAGES, load })).toMatchObject({ kind: "missing" })
  })

  it("resolves to missing for a real package that is installed nowhere", async () => {
    const result = await loadPeer({
      root: projectRoot,
      packages: [{ specifier: "appgraph-no-such-peer", manifest: "appgraph-no-such-peer/package.json" }],
      moduleKind: "esm",
    })

    expect(result.kind).toBe("missing")
  })
})

describe("peer-loader: manifest ranges", () => {
  const manifest = (fields: Record<string, Record<string, string>>): string => JSON.stringify(fields)

  it.each([
    ["^3.5.0", 3],
    ["3", 3],
    [">=17.0.0 <18", 17],
    ["npm:vue@^3.4.0", 3],
    ["npm:@angular/core@~19.2.0", 19],
    ["latest", null],
    ["workspace:^3.5.0", null],
  ] as const)("reads %s as major %s", (range, major) => {
    expect(majorOfRange(range)).toBe(major)
  })

  it("prefers dependencies, then devDependencies, then peerDependencies", () => {
    const text = manifest({ peerDependencies: { peer: "^4" }, devDependencies: { peer: "^3" } })
    expect(dependencyRange(text, "peer")).toBe("^3")
    expect(projectMajorOf(text, "peer")).toBe(3)
  })

  it("returns null for invalid JSON or an absent package", () => {
    expect(projectMajorOf("{ nope", "peer")).toBeNull()
    expect(projectMajorOf(manifest({ dependencies: { other: "1" } }), "peer")).toBeNull()
  })
})
