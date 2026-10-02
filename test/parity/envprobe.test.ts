/**
 * Guards the ONE channel `target.ts` reads, and the two ways it can break.
 *
 * Vitest 4 spawns workers with an env allowlist, so `vitest.config.ts` forwards the parity target into
 * the worker and `target.ts` reads one variable. Two failure modes remain:
 *
 *  - **The silent skip.** If the `test.env` wiring is removed, `parityTarget()` returns `null`,
 *    `describe.skipIf` skips the entire acceptance suite, and the gate reports GREEN while measuring
 *    nothing. A skip that looks like a pass is the exact failure this directory exists to prevent.
 *  - **The poison empty string.** The natural-looking `env: { X: process.env.X ?? "" }` forwards `""`
 *    over a real value, because the config is evaluated in the sanitized environment (see
 *    `vitest.config.ts`). `""` must therefore never arrive; a blank target is expressed by the variable
 *    being ABSENT, which is what `parityTarget()` is written against.
 *
 * The forwarding check is conditional on a target actually being configured, so CI — which has no
 * `target.local` and no private checkout — passes without pretending to have one.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import * as url from "node:url"
import { describe, expect, it } from "vitest"
import { TARGET_ENV_VAR, parityTarget, parsePointer } from "./target.js"

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
const POINTER_FILE = path.join(HERE, "target.local")

const FORWARDED = ["TEST", "VITEST", "NODE_ENV", "VITEST_MODE"] as const

const pointerFileTarget = (): string | null => {
  if (!fs.existsSync(POINTER_FILE)) return null
  const value = fs.readFileSync(POINTER_FILE, "utf8").trim()
  return value === "" ? null : parsePointer(value).root
}

describe("Vitest worker environment", () => {
  it("forwards its own variables", () => {
    for (const name of FORWARDED) expect(process.env[name], name).toBeDefined()
  })

  it(`never forwards ${TARGET_ENV_VAR} as an empty string — absent is how "no target" is expressed`, () => {
    // The poison value. If this fails, `vitest.config.ts` has a `?? ""` default and the real-repo gate
    // skips regardless of what the caller configured.
    const seen = process.env[TARGET_ENV_VAR]
    if (seen !== undefined) expect(seen.trim(), `${TARGET_ENV_VAR} arrived blank`).not.toBe("")
  })

  it("agrees with parityTarget(), which is the only reader", () => {
    const seen = process.env[TARGET_ENV_VAR] ?? ""
    expect(parityTarget()).toBe(seen.trim() === "" ? null : parsePointer(seen).root)
  })

  it.runIf(pointerFileTarget() !== null)(
    "forwards the target.local pointer file into the worker, so the acceptance gate cannot silently skip",
    () => {
      // The real forwarding guard, and the reason `vitest.config.ts` reads a file rather than the
      // environment. Skipped when no pointer file exists (CI), because there is then nothing to forward
      // and `target-app.test.ts` skipping is correct rather than a bug.
      expect(parityTarget(), `${POINTER_FILE} exists but its value never reached the worker`).toBe(
        pointerFileTarget(),
      )
    },
  )
})
