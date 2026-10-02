import * as fs from "node:fs"
import * as path from "node:path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

/**
 * Forwards the parity gate's two optional pointers into test workers.
 *
 * The parity gate has two independent inputs, and neither ships with this package:
 *
 *   APPGRAPH_PARITY_FIXTURE / test/parity/target.local  — the target pointer: the application checkout
 *                                                          to analyse, its pinned commit and its pinned config
 *   APPGRAPH_PARITY_GOLDEN  / test/parity/golden.local  — the reference output to compare against
 *
 * Both are private, both are absent in CI, and everything that needs one skips cleanly with a message
 * naming what to set. The synthetic-fixture half of the suite needs neither and always runs.
 *
 * ## Why this reads FILES and not `process.env`
 *
 * On vitest 4.1.10 two mechanisms bite, and the obvious one-liner
 * (`env: { APPGRAPH_PARITY_FIXTURE: process.env.APPGRAPH_PARITY_FIXTURE ?? "" }`) defeats itself on the
 * second:
 *
 *  1. Test workers get an env ALLOWLIST. `resolveOptions` at
 *     `node_modules/vitest/dist/chunks/cli-api.BK8pd4xc.js:3738-3745` passes only
 *     `{ TEST, VITEST, NODE_ENV, VITEST_MODE, FORCE_TTY }`, merged with `test.env` (line 3738). An
 *     arbitrary variable exported in the shell therefore reaches the Vitest CLI and reads back
 *     `undefined` inside the test. Hence the need for `test.env` at all.
 *
 *  2. **THIS CONFIG FILE IS ITSELF EVALUATED IN THAT SANITIZED ENVIRONMENT.** The evaluating process
 *     sees only `TEST=true`, `VITEST=true`, `NODE_ENV` and a minimal base (HOME, PATH, PWD, SHELL,
 *     TERM, USER, …), never the shell's `APPGRAPH_PARITY_FIXTURE`. So
 *     `process.env.APPGRAPH_PARITY_FIXTURE` is `undefined` here no matter what the caller exported,
 *     and a `?? ""` fallback makes it worse: it forwards an empty string that wins the merge, and the
 *     gate then skips exactly as if nothing had been wired.
 *
 *     A LITERAL `test.env` value DOES reach the worker; every `process.env`-derived one does not.
 *     There is also no `--env` CLI flag to route around it.
 *
 * So under Vitest a pointer has to enter through something the sanitizer cannot touch — a file. That is
 * what `test/parity/*.local` is: untracked, gitignored files whose whole trimmed content is read here and
 * injected as a literal. `golden.local` holds one absolute path. `target.local` holds either a bare path
 * or a JSON object, parsed by `parsePointer` in `test/parity/target.ts`:
 *
 *   { "root": "<detached worktree path>", "commit": "<sha the golden describes>",
 *     "config": { "stringSources": [...], "kindRules": [...] } }
 *
 * The commit and the config describe the private application and are obtained out of band. The
 * acceptance suite refuses to measure a checkout whose HEAD is not `commit`, so `root` points at a
 * detached worktree: `git -C <app checkout> worktree add --detach <worktree path> <commit>`.
 *
 * The important part is that this is the ONLY channel. `target.ts` and `golden-target.ts` each read
 * exactly one variable, whether they run under Vitest (fed from here) or under `tsx` for `report.mts`
 * (fed by the shell, which tsx inherits normally).
 *
 *   # Vitest:
 *   $EDITOR test/parity/target.local                    # the JSON above
 *   echo /abs/path/to/parity-golden > test/parity/golden.local
 *   pnpm test
 *
 *   # report.mts, under tsx:
 *   APPGRAPH_PARITY_FIXTURE="$(cat test/parity/target.local)" \
 *   APPGRAPH_PARITY_GOLDEN=/abs/path/to/parity-golden npx tsx test/parity/report.mts
 *
 * When a future Vitest evaluates the config with the caller's environment intact, `fromEnv` starts
 * winning on its own and the files become optional — no code change needed.
 */
const POINTERS = [
  { variable: "APPGRAPH_PARITY_FIXTURE", file: "target.local" },
  { variable: "APPGRAPH_PARITY_GOLDEN", file: "golden.local" },
] as const

const readPointerFile = (file: string): string => {
  try {
    return fs.readFileSync(path.join(import.meta.dirname, "test", "parity", file), "utf8").trim()
  } catch {
    return ""
  }
}

// Omitted rather than blanked when there is no value: an empty string here would be forwarded over a
// real one, and would force the readers to treat "" and undefined as the same thing anyway.
const forwarded = Object.fromEntries(
  POINTERS.flatMap(({ variable, file }) => {
    const fromEnv = process.env[variable]?.trim() ?? ""
    const value = fromEnv === "" ? readPointerFile(file) : fromEnv
    return value === "" ? [] : [[variable, value] as const]
  }),
)

const fromRoot = (relative: string) => path.join(import.meta.dirname, relative)

const EXCLUDE = ["**/node_modules/**", "**/dist/**", "e2e/**"]

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text", "html"],
      reportsDirectory: "coverage/",
      thresholds: { statements: 92, branches: 84, functions: 94, lines: 95 },
    },
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["test/**/*.test.ts"],
          exclude: EXCLUDE,
          env: forwarded,
          globalSetup: ["test/setup/ensure-template.ts"],
        },
      },
      {
        plugins: [react()],
        resolve: {
          alias: {
            "@/": fromRoot("report-ui/src/"),
            "@appgraph/": fromRoot("src/"),
          },
        },
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["report-ui/**/*.test.tsx"],
          exclude: EXCLUDE,
          setupFiles: ["report-ui/test/setup.ts"],
        },
      },
    ],
  },
})
