# Parity baseline — how the gate is kept honest

**What this document is for.** `test/parity/` compares appgraph against a checksum-verified snapshot of
the prototype's output. The gate does not — and should not — match that snapshot exactly: some
differences are intended. Read this as the answer to one question: *my diff changed a
number in `test/parity` — is that bad?*

- If a test not accounted for below fails, it is a regression. There are no undocumented reds.
- The **measured** baseline — every current difference, with its cause, its numbers and its fix
  criterion — lives with the golden, outside this repository, as `BASELINE.md`. That is deliberate: the
  measurements name the routes, modules and endpoints of a private application, and this package is
  published.

---

## 1. Two halves, two pointers

The suite has a CI half and an acceptance half, and only the first ships with anything it needs.

| Half | Files | Needs | In CI |
| --- | --- | --- | --- |
| Synthetic fixture | `fixture.test.ts`, `fixture/**`, `config-ablation.test.ts` | nothing | always runs |
| Golden integrity | `golden.test.ts`, `golden.ts` | `APPGRAPH_PARITY_GOLDEN` | skips cleanly |
| Acceptance | `target-app.test.ts`, `assertions.ts`, `report.mts` | both pointers | skips cleanly |

| Pointer | Selects | Env var | Pointer file (gitignored) |
| --- | --- | --- | --- |
| Golden | the frozen prototype output + `expectations.json` | `APPGRAPH_PARITY_GOLDEN` | `test/parity/golden.local` |
| Target | the application checkout, its pinned commit and its pinned config | `APPGRAPH_PARITY_FIXTURE` | `test/parity/target.local` |

The target pointer is either a bare path (the checkout only) or a JSON object:

```json
{
  "root": "/abs/path/to/parity-target",
  "commit": "<sha the golden describes>",
  "config": { "stringSources": ["…"], "kindRules": [{ "match": { "pathPrefix": "src/…/" }, "kind": "…", "traversable": false, "screenEntry": false }] }
}
```

`config` is the target-specific half of the pinned run — the string sources and the directory -> kind
rules, which describe one application's layout. `pinned.ts` holds the generic half (`PINNED_BASE`); the
synthetic fixture supplies its own target-specific half (`MINI_APP_PINNED_CONFIG`). `config` is validated
field by field like a user's config file, and any issue or unknown field fails the suite.

```bash
# Vitest — see §5 for why this reads files rather than the environment
echo /abs/path/to/parity-golden > test/parity/golden.local
$EDITOR test/parity/target.local     # the JSON above
pnpm test

# report.mts, under tsx, which inherits the shell environment normally
APPGRAPH_PARITY_GOLDEN=/abs/path/to/parity-golden \
APPGRAPH_PARITY_FIXTURE="$(cat test/parity/target.local)" npx tsx test/parity/report.mts
```

**The target is pinned.** The golden describes one commit of the application, and the application keeps
moving: a route added after that commit is drift, not a regression, and would read as a gate-1 failure no
change here caused. The pointer's `commit` names that commit; the acceptance suite reads the target's
HEAD from its `.git` (plain checkout or worktree) and refuses to measure anything else — or a bare-path
pointer with no commit at all — naming the command that fixes it. Point `root` at a detached worktree,
never at a live checkout:

```bash
git -C /abs/path/to/app/frontend worktree add --detach /abs/path/to/parity-target <commit>
```

A skip is never silent: each gated suite's `describe` name carries the pointer it is missing, so
"skipped" can never be read as "passed".

**Nothing in this repository names the application.** Every application-specific expectation the
acceptance suite asserts — route names, module paths, endpoint URLs, the extra nav group's name and
source — is read from `expectations.json`, which sits with the golden behind the same pointer; the pinned
commit and the application's directory layout come from the target pointer. Adding a new expectation
means adding a field there, never a literal here.

---

## 2. Why the gate does not demand byte equality

appgraph departs from the prototype in four deliberate ways, and each shows up as a difference from the
golden that is correct rather than tolerated.

| Decision | Consequence against the golden |
| --- | --- |
| §8.9 sort by codepoint, not `localeCompare` | `entries[0]` moves on screens with more than one entry; the component-key order diverges at index 4 of 696 |
| §6.3.1 ancestor chains spliced at depth 0 | `reachable` is a strict **superset** on every screen — the excess is the chain's closure |
| §8.2 `via` is part of a navigation edge's identity | more edges than the golden; a shell file's edge does not shadow a page's own |
| §10.1/§10.6 detect ALL nav sources, report ALL | more menu groups than the prototype, which was told exactly one file |

Byte equality would therefore fail on line 5 of the components map *by design*, which is why §12.2
rules out a byte-equality check and §12.3 specifies the four gates instead.

---

## 3. The shape of the accepted state

Each accepted difference is a **pair**, and that is the mechanism that keeps this from rotting:

- an `it.fails` for the difference — it turns **red when the difference disappears**, which is the
  promotion signal;
- a positive assertion pinning the cause — it turns **red when the difference changes shape**, which is
  the regression signal.

Neither can drift silently, and "expected fail: N" in the test output is a number worth reading. When a
difference is resolved: promote the `it.fails` to a plain `it`, delete or reclassify the `known-gaps.ts`
entry, update the golden's `BASELINE.md`, and re-run `report.mts` to confirm the numbers you wrote down
are the numbers the tool produces.

`known-gaps.ts` ids carry their kind, so a stale entry is visible:

- `GAP-*` — an open defect or accepted limitation. Must be wired to a failing expectation; a `GAP-*`
  with nothing red behind it is stale bookkeeping. `fixture.test.ts` asserts that the set of `GAP-*` ids
  equals the set the suites actually wire, so a gap cannot be filed and forgotten.
- `SPEC-*` — the tool is right and §12.3's wording is wrong. Wired to a **passing** assertion stating
  the corrected claim; survives until `docs/architecture.md` is amended by its owner.
- `FIXED-*` — a closed defect whose original diagnosis was wrong. Kept only long enough to stop the
  wrong explanation being rediscovered, and always paired with the regression assertion the
  misdiagnosis failed to produce.

---

## 4. What this gate cannot check anywhere

- **A3** (§8.10 resolver) asserts on an AdminJS app; **A6** (§6.3.1) on a TanStack Start app;
  **A7**/**A8** (§6.3.2, §5.4 masking) on a browser-extension app. No goldens for those exist here.
- **A5c** (§8.3 entryless tagging) needs a route with neither entry nor redirect. The parity application
  has none, so it runs on the committed fixture only — which is exactly why the fixture carries an
  `/entryless` route.
- **The HTML report** is excluded from the goldens by construction (§12.6): the prototype embeds
  `new Date().toISOString().slice(0, 16)` in its header, so its bytes differ from themselves at minute
  granularity. What is asserted about the HTML lives in `test/emit/html.test.ts` and
  `test/cli/html-assets.test.ts`.
- **Which router file detection found.** `AppgraphConfig` has no `router` key; `screenSources:
  ['react-router']` pins which source runs, not which file it reads. Stage 2 cannot distinguish
  "detection found the right router" from "there is only one router to find".

---

## 5. The env channel, and why it is a file

Measured on vitest 4.1.10:

1. Workers get an env allowlist — `{ TEST, VITEST, NODE_ENV, VITEST_MODE, FORCE_TTY }` plus `test.env`
   (`node_modules/vitest/dist/chunks/cli-api.BK8pd4xc.js:3738-3745`).
2. **`vitest.config.ts` is itself evaluated in that sanitized environment.** A probe there reports 18
   variables (`TEST=true`, `VITEST=true`, plus a minimal base) and contains neither an exported pointer
   variable nor a control `FOO_BAR` — against 75 in a plain `node -e` from the same shell. A literal
   `test.env` value *does* reach the worker; a `process.env`-derived one never can. There is no `--env`
   CLI flag either.

So `env: { X: process.env.X ?? "" }` is worse than nothing: it forwards `""`, which **wins the merge**
and makes the gate skip precisely as if unwired.

**Resolution.** The pointer files are read in `vitest.config.ts` at config time and injected as
literals; `target.ts` and `golden-target.ts` each read exactly one variable and nothing else. The whole
trimmed content of `target.local` is forwarded, so the JSON form travels through the same variable.
`report.mts` under `tsx` inherits the shell environment normally and needs no file.

`envprobe.test.ts` guards the two failure modes that survive: that `""` never arrives, and that a
configured pointer file actually reaches the worker (conditional, so CI without a pointer passes). A
silent skip is the one failure this directory exists to prevent.
