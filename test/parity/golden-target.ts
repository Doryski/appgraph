export const GOLDEN_ENV_VAR = "APPGRAPH_PARITY_GOLDEN"

/**
 * Where the golden lives, or `null` — in which case every golden-dependent test skips cleanly.
 *
 * The golden is a frozen output snapshot of the reference implementation this package was ported from,
 * taken over a private application. It describes that application in detail, so it is kept OUTSIDE this repository
 * and pointed at, exactly the way `target.ts` points at the application checkout itself. The two
 * pointers are independent: the golden's own integrity checks need only this one, and the full
 * acceptance suite needs both.
 *
 * Same single-channel discipline as `target.ts`, and for the same reason: vitest sanitises the
 * worker environment, so under Vitest the value is injected by `vitest.config.ts` (which reads the
 * gitignored pointer file `test/parity/golden.local` at config time); under `tsx` the shell variable is
 * inherited normally. Whatever the source, there is exactly one thing to read here.
 *
 * A blank value counts as absent: `test.env` stringifies, so a channel that ever defaults to `""` must
 * not be mistaken for a configured golden.
 */
export const parityGolden = (): string | null => {
  const fromEnv = process.env[GOLDEN_ENV_VAR]
  if (fromEnv === undefined || fromEnv.trim() === "") return null
  return fromEnv.trim()
}

/** The message a skipped suite carries, so "skipped" never looks like "passed". */
export const GOLDEN_HINT = `set ${GOLDEN_ENV_VAR} (tsx / report.mts) or write the absolute path of the golden directory into test/parity/golden.local (vitest — see vitest.config.ts)`

/** For the few call sites that are already inside a `skipIf(golden === null)` guard. */
export const requireGolden = (): string => {
  const dir = parityGolden()
  if (dir === null) throw new Error(`no parity golden — ${GOLDEN_HINT}`)
  return dir
}
