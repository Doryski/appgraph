import path from "node:path"
import { describe, expect, it } from "vitest"
import { createMemoryHost } from "../../src/core/host.js"
import { EXCLUDED_FILE, NON_APP_PATH, createProjectPaths, isExcludedFile, isNonAppFile } from "../../src/core/project.js"

const ROOT = "/repo"

const FILES = {
  "/repo/src/app.tsx": "export const App = () => null",
  "/repo/src/app.test.tsx": "it('x', () => {})",
  "/repo/src/app.spec.ts": "it('x', () => {})",
  "/repo/src/app.stories.tsx": "export default {}",
  "/repo/src/env.d.ts": "declare const x: number",
  "/repo/src/legacy.test.jsx": "it('x', () => {})",
  "/repo/src/modern.spec.mts": "it('x', () => {})",
  "/repo/src/nested/Panel.tsx": "export const Panel = () => null",
  "/repo/src/nested/Panel.test.tsx": "it('x', () => {})",
}

const paths = () => createProjectPaths({ host: createMemoryHost({ files: FILES }), root: ROOT, sourceRoots: ["src"] })

describe("isExcludedFile — one rule for tests, specs, stories and declarations", () => {
  it("matches the four excluded kinds on the basename only", () => {
    expect(isExcludedFile("src/app.test.tsx")).toBe(true)
    expect(isExcludedFile("src/app.spec.ts")).toBe(true)
    expect(isExcludedFile("src/app.stories.tsx")).toBe(true)
    expect(isExcludedFile("src/env.d.ts")).toBe(true)
    expect(isExcludedFile("src/legacy.test.jsx")).toBe(true)
    expect(isExcludedFile("src/modern.spec.mts")).toBe(true)
  })

  it("does not match a directory called test/ or a component whose name merely contains 'test'", () => {
    expect(isExcludedFile("src/test/helpers.ts")).toBe(false)
    expect(isExcludedFile("src/LatestOrders.tsx")).toBe(false)
    expect(isExcludedFile("src/testing.ts")).toBe(false)
    expect(EXCLUDED_FILE.test("attest.ts")).toBe(false)
  })
})

/**
 * An exclusion applied only in the resolver's `accept` would let `glob` hand `*.test.tsx` to screen
 * discovery, turning a test file into a screen source.
 */
describe("ProjectPaths — the exclusion covers DISCOVERY, not just module resolution", () => {
  it("keeps excluded kinds out of glob results", () => {
    expect(paths().glob("**/*.{ts,tsx,js,jsx,mts,cts}")).toEqual([
      "src/app.tsx",
      "src/nested/Panel.tsx",
    ])
  })

  it("reports excluded kinds through isExcluded, so the resolver and the walker agree", () => {
    const project = paths()
    expect(project.isExcluded("/repo/src/app.test.tsx")).toBe(true)
    expect(project.isExcluded("/repo/src/env.d.ts")).toBe(true)
    expect(project.isExcluded("/repo/src/app.tsx")).toBe(false)
  })
})

/**
 * Without these exclusions a Next.js `distDir: ".next-build"` re-declares every route from `server/app`
 * and `types/app`, and a `.claude/skills/**` template reads as a TanStack route file.
 */
describe("ProjectPaths — build output, tool directories and .gitignore stay out of discovery", () => {
  const BUILD_FILES = {
    "/app/.git/HEAD": "ref",
    "/app/next.config.ts": `const distDir = process.env.NODE_ENV === "production" ? ".next-build" : ".next"\nexport default { distDir }`,
    "/app/.gitignore": "/data/\nuploads\n*.pem\n/public/*\n!/public/keep.ts",
    "/app/src/app/page.tsx": "export default () => null",
    "/app/.next-build/server/app/page.js": "module.exports = {}",
    "/app/.next-build/types/app/page.ts": "export {}",
    "/app/.claude/skills/templates/route-examples.tsx": "createFileRoute('/')",
    "/app/.storybook/preview.tsx": "export default {}",
    "/app/.nuxt/pages/index.ts": "export {}",
    "/app/data/fixture.ts": "export {}",
    "/app/src/lib/uploads/handler.ts": "export {}",
    "/app/src/cert.pem": "x",
    "/app/public/drop.ts": "export {}",
    "/app/public/keep.ts": "export {}",
    "/app/src/features/.server/secret.ts": "export {}",
    "/app/src/nested/.gitignore": "local-only.ts",
    "/app/src/nested/local-only.ts": "export {}",
    "/app/src/nested/kept.ts": "export {}",
  }

  const buildPaths = () => createProjectPaths({ host: createMemoryHost({ files: BUILD_FILES }), root: "/app" })

  it("globs only real sources", () => {
    expect(buildPaths().glob("**/*.{ts,tsx,js}")).toEqual([
      "next.config.ts",
      "public/keep.ts",
      "src/app/page.tsx",
      "src/nested/kept.ts",
    ])
  })

  it("answers isExcludedDir for every rule and for descendants", () => {
    const project = buildPaths()
    expect(project.isExcludedDir(".next-build")).toBe(true)
    expect(project.isExcludedDir(".next-build/server/app")).toBe(true)
    expect(project.isExcludedDir(".claude/skills")).toBe(true)
    expect(project.isExcludedDir("data")).toBe(true)
    expect(project.isExcludedDir("src/lib/uploads")).toBe(true)
    expect(project.isExcludedDir("src/features/.server")).toBe(true)
    expect(project.isExcludedDir("src/app")).toBe(false)
    expect(project.isExcludedDir("public")).toBe(false)
  })

  it("agrees through isExcluded for files and directories", () => {
    const project = buildPaths()
    expect(project.isExcluded("/app/.next-build/server/app/page.js")).toBe(true)
    expect(project.isExcluded("/app/data")).toBe(true)
    expect(project.isExcluded("/app/src/cert.pem")).toBe(true)
    expect(project.isExcluded("/app/public/drop.ts")).toBe(true)
    expect(project.isExcluded("/app/public/keep.ts")).toBe(false)
    expect(project.isExcluded("/app/src")).toBe(false)
  })

  it("adds a single-segment distDir to the name list and explains every rule", () => {
    const project = buildPaths()
    expect(project.excludedDirs).toContain(".next-build")
    project.glob("**/*.ts")
    expect(project.exclusions().filter((entry) => entry.reason !== "default")).toEqual([
      { pattern: ".git/", reason: "mandatory" },
      { pattern: "node_modules/", reason: "mandatory" },
      { pattern: "/.next-build/", reason: "next-dist-dir", source: "next.config.ts" },
      { pattern: "/.next/", reason: "next-dist-dir", source: "next.config.ts" },
      { pattern: ".*/", reason: "dot-directory" },
      { pattern: ".gitignore", reason: "gitignore", source: ".gitignore" },
      { pattern: "src/nested/.gitignore", reason: "gitignore", source: "src/nested/.gitignore" },
    ])
  })

  it("is deterministic across instances", () => {
    expect(buildPaths().glob("**/*")).toEqual(buildPaths().glob("**/*"))
  })
})

describe("NON_APP_PATH — test-tool directories only at the project root", () => {
  it("matches cypress/, e2e/ and playwright/ at the root, bare or ./-prefixed", () => {
    expect(NON_APP_PATH.test("cypress/support/component/setup.tsx")).toBe(true)
    expect(NON_APP_PATH.test("e2e/fixtures/router.tsx")).toBe(true)
    expect(NON_APP_PATH.test("playwright/helpers.ts")).toBe(true)
    expect(NON_APP_PATH.test("./cypress/support/e2e.ts")).toBe(true)
  })

  it("keeps cypress, e2e and playwright folders nested under the app's sources", () => {
    expect(NON_APP_PATH.test("src/routes/e2e/index.tsx")).toBe(false)
    expect(NON_APP_PATH.test("src/features/playwright/Runs.tsx")).toBe(false)
    expect(NON_APP_PATH.test("src/pages/cypress/index.tsx")).toBe(false)
    expect(NON_APP_PATH.test("src/e2e-encryption/index.tsx")).toBe(false)
    expect(NON_APP_PATH.test("e2e.ts")).toBe(false)
  })

  it("keeps the pre-existing test, mock and Storybook names at any depth", () => {
    for (const dir of ["test-utils", "test", "tests", "__tests__", "__mocks__", "mocks", ".storybook", "storybook"]) {
      expect(NON_APP_PATH.test(`${dir}/x.ts`)).toBe(true)
      expect(NON_APP_PATH.test(`src/deep/${dir}/x.ts`)).toBe(true)
    }
  })

  it("normalises separators before matching", () => {
    expect(isNonAppFile(["cypress", "support", "setup.tsx"].join(path.sep))).toBe(true)
    expect(isNonAppFile(["src", "routes", "e2e", "index.tsx"].join(path.sep))).toBe(false)
  })
})

describe("isExcludedFile — Vue single-file components", () => {
  it("excludes .vue tests, specs, stories and histoire *.story.vue files", () => {
    expect(isExcludedFile("src/Card.test.vue")).toBe(true)
    expect(isExcludedFile("src/Card.spec.vue")).toBe(true)
    expect(isExcludedFile("src/Card.stories.vue")).toBe(true)
    expect(isExcludedFile("src/Card.story.vue")).toBe(true)
  })

  it("keeps ordinary .vue components and a .story.ts helper", () => {
    expect(isExcludedFile("src/Card.vue")).toBe(false)
    expect(isExcludedFile("src/StoryCard.vue")).toBe(false)
    expect(isExcludedFile("src/story.vue")).toBe(false)
    expect(isExcludedFile("src/user.story.ts")).toBe(false)
  })
})

describe("ProjectPaths.rel", () => {
  it("matches path.relative for inside, root, unnormalised and outside paths, and repeats its answer", () => {
    const project = paths()
    const probes = ["/repo/src/a.ts", "/repo", "/repo/", "/repo/src/../lib/b.ts", "/repo/./src/c.ts", "/other/x.ts", "/repository/y.ts"]
    const expected = probes.map((probe) => path.relative("/repo", path.resolve(probe)))

    expect(probes.map(project.rel)).toEqual(expected)
    expect(probes.map(project.rel)).toEqual(expected)
  })
})
