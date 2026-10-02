# Contributing to appgraph

Thanks for your interest in contributing! This project welcomes issues, bug reports,
and pull requests.

## Project principles

`appgraph` is deliberately constrained. Most of these constraints exist because
measurement forced them, not because they sounded nice. Please keep changes aligned
with them.

- **Parser-only. Never the TypeChecker.** Analysis goes through
  `ts.createSourceFile` and reads ASTs. It never constructs a `ts.Program` and never
  asks the TypeScript TypeChecker anything. That is what makes a run fast and what
  makes it work on a repo that does not currently compile — a property the tool is not
  willing to trade. If a feature seems to need resolved types, the answer is usually a
  syntactic heuristic plus an honest diagnostic, not a TypeChecker.
- **One runtime dependency.** The published package depends on `commander` and nothing
  else. `typescript` is a **peer** dependency, on purpose: the tool parses your code
  with your project's own compiler, so it never disagrees with your repo about syntax.
  `vue` is a second, **optional** peer (`>=3.4 <4`), used only to read Vue template ASTs;
  an optional peer does not count against the one-runtime-dependency rule. Only `src/core/vue-compiler.ts` may import
  `vue` or `@vue/*` (lint-enforced); everything else receives the compiler from the pipeline.
  `@angular/compiler` (`>=14`) is a third, **optional** peer next to `vue`, used only to read Angular template
  ASTs, with the same rule: only `src/core/angular-compiler.ts` may import `@angular/*` (lint-enforced).
  Dev-only tooling is fine (the whole report UI stack — React, Vite, Tailwind, shadcn/ui,
  TanStack — is a devDependency, compiled at build time); a new runtime dep needs a very good
  argument.
- **Honesty over coverage.** A confidently wrong map is worse than no map. Where the
  parser cannot tell, the artifact must say so — an empty section with a stated reason,
  a diagnostic, a refusal — rather than emit a plausible guess. Several deliberate
  behaviors follow from this: guards are captured as *text and never evaluated*; a repo
  with several live screen sources is **refused** rather than guessed at; a project with
  no test-id attributes gets an explicit "none found" rather than an empty list that
  reads like a clean result.
- **Deterministic output.** The same input must produce byte-identical output on every
  machine, in any locale. Practically: **no `localeCompare`** (sort by code point via
  the helpers in `src/core/order.ts`), no `Date.now()` or `new Date()` outside the one
  injected clock, and never let filesystem order, `Map`/`Set` iteration order, or glob
  order reach the artifact unsorted.
- **Zero-config first.** A new stack should be *detected*, with `appgraph.config.ts` as
  the override rather than the entry fee. Detection lives in `src/detect/` and must
  produce the same resolved-config shape a hand-written config would, because both are
  checked by the same gate.
- **TypeScript strict, no `any`.** Prefer inference and generics over explicit
  annotations. `any` and unsafe `as` casts are not accepted in `src/` (tests may use
  `any`). Use `type`, not `interface`. `tsconfig.json` runs with
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, which is intentional.
- **No code comments.** The codebase avoids inline commentary that restates the code.
  Comments that survive are the ones carrying non-obvious knowledge — a measured
  finding, a spec reference, a reason a tempting simplification is wrong. Favor clear
  names and small, composable functions over explanation.
- **Small, composable, functional.** Prefer pure functions over classes, early returns
  over nesting, and a single source of truth over parallel lists. The phases in
  `src/pipeline/` are pure `input -> output`; only the CLI touches the filesystem.
- **ESM-only, Node >= 20.** Don't introduce anything that breaks either.

## Development setup

This project uses [pnpm](https://pnpm.io).

```bash
git clone https://github.com/doryski/appgraph.git
cd appgraph
pnpm install
```

Node >= 20 is required at runtime; development uses Node 22 (`.nvmrc` pins 22).

### Running the CLI against a real project

```bash
pnpm build
node dist/cli/bin.js --root /path/to/some/react-app

# or without building, straight from source
pnpm exec tsx src/cli/index.ts --root /path/to/some/react-app
```

`appgraph doctor --root /path/to/app` is the fastest way to see what detection decided
and why. Use it before assuming an adapter is broken.

### Report UI

The HTML report is a React 19 + Vite + Tailwind v4 + shadcn/ui (Base UI) app in
`report-ui/`. Vite (`vite-plugin-singlefile`) inlines everything into one HTML file, which
`scripts/generate-assets.ts` embeds as `REPORT_TEMPLATE` in `src/emit/assets/generated.ts`
(gitignored, **generated** — never hand-edit). `renderHtml` (`src/emit/html.ts`) fills four
placeholders (lang, title, palette CSS, JSON payload built by `src/emit/report-payload.ts`).

```bash
pnpm assets      # rebuild the UI and regenerate src/emit/assets/generated.ts
pnpm ui:build    # build only the Vite bundle
pnpm e2e         # Playwright (chromium) against the report opened via file://
```

`pnpm build` runs `pnpm assets` first. `pnpm test`, `pnpm test:watch` and `pnpm type-check`
rebuild the template when it is missing or older than any file under `report-ui/` or the
`src/emit/` modules the UI imports. Bare `vitest` never builds it: run `pnpm assets` first, or
the node project's global setup fails with a "missing or stale" error. The template has a 1 MB size budget
(`test/emit/report-template.test.ts`).

- **Adding a shadcn component:** copy it from the shadcn registry into `report-ui/` and
  conform it to the repo: `type`, not `interface`; no comments; Base UI's `render` prop,
  not `asChild`.
- **No `useEffect` / `useLayoutEffect`.** ESLint bans them in `report-ui/`; the exceptions
  live in `EFFECT_ALLOWLIST` in `eslint.config.js`. Prefer `useSyncExternalStore`, event
  handlers, derived state, ref callbacks and `key` resets.
- **i18n:** every UI string is a key in `src/emit/strings.ts`, with both `en` and `pl`.
  Plural keys use `|`-separated segments.

## Quality checks

Before opening a pull request, make sure all of these pass:

```bash
pnpm type-check  # assets:ensure && tsc --noEmit (node + report UI)
pnpm lint        # eslint .
pnpm test        # assets:ensure && vitest run --bail=5
pnpm build       # pnpm assets && tsup (ESM + d.ts)
pnpm e2e         # Playwright, when touching report-ui/
```

`pnpm lint:fix` auto-fixes what ESLint can.

## Testing

The suite uses [Vitest](https://vitest.dev), with a dual-strategy command convention:

- **Targeted** (when changing fewer than ~5 files):

  ```bash
  pnpm exec vitest run --bail=5 test/adapters/react-router.test.ts
  ```

- **Full suite**:

  ```bash
  pnpm test
  ```

`--bail=5` stops after 5 failures. Tests are isolated with no shared state.

### How the tests are organised

`test/` mirrors `src/`, plus two layers that deserve explanation:

| Directory        | What it covers                                                                 |
| ---------------- | ------------------------------------------------------------------------------ |
| `test/core/`     | The data model, graph assembly, ordering and determinism helpers               |
| `test/detect/`   | Zero-config detection: scores, evidence, near-misses, conventions             |
| `test/adapters/` | One suite per screen source (react-router v5–v7 library and framework mode, wouter, Next.js App and Pages Router, TanStack Router, Vue Router, Nuxt, Angular, Expo Router, React Navigation, AdminJS, extension manifests, state-activated screens, nav configs) |
| `test/extractors/` | Per-fact-channel extraction: endpoints, flags, test ids, guards, messages    |
| `test/emit/`     | The YAML views, report payload, and the HTML template contract                 |
| `report-ui/` tests | Component and hook tests (vitest `ui` project, jsdom)                      |
| `e2e/`           | Playwright tests of the built report over `file://` (`pnpm e2e`)               |
| `test/cli/`      | Flag parsing, exit codes, `doctor`, staleness/fingerprinting                   |
| `test/parity/`   | Gates comparing this implementation against the frozen golden baseline         |
| `test/public-api.test.ts` | Locks the exported surface of `src/index.ts`                          |

### Golden fixtures are frozen

The golden is a frozen output snapshot with recorded SHA-256 checksums in its
`MANIFEST.md`. It lives **outside this repository** and is pointed at either by the
`APPGRAPH_PARITY_GOLDEN` environment variable or by an untracked
`test/parity/golden.local` file holding an absolute path; when neither is present the
golden-dependent tests **skip cleanly**. Read its `README.md` before touching it. The rule
in short: **a diff against the golden is a finding to review, not a stale fixture to
refresh.** Never edit the golden to make a test pass. If a fix legitimately moves one of
those numbers, regenerate deliberately, update the SHA-256 checksums in `MANIFEST.md`, and
say in the commit message which bug justified the change and why the new numbers are
correct. A silent golden diff is never acceptable.

### The real-repo parity gate

`test/parity/target-app.test.ts` runs against a private application checkout and
**skips cleanly when it is not available** — which is the case for every outside
contributor and in CI. You do not need it to contribute. It is pointed at a checkout
either by the `APPGRAPH_PARITY_FIXTURE` environment variable or by an untracked
`test/parity/target.local` file. The pointer is either a bare path or a JSON object
parsed by `parsePointer` in `test/parity/target.ts`:

```json
{
  "root": "<detached worktree path>",
  "commit": "<sha the golden describes>",
  "config": { "stringSources": ["…"], "kindRules": ["…"] }
}
```

`commit` and `config` describe the private application, so they are obtained out of
band and never committed. The suite refuses to measure a checkout whose HEAD is not
`commit` (a bare path names no commit, so it is refused too), so point `root` at a
detached worktree:

```bash
git -C <app checkout> worktree add --detach <worktree path> <commit>
```

Vitest reads `test/parity/target.local` through `vitest.config.ts`. `report.mts` runs
under `tsx` and takes the same content from the shell:

```bash
APPGRAPH_PARITY_FIXTURE="$(cat test/parity/target.local)" \
APPGRAPH_PARITY_GOLDEN=/abs/path/to/parity-golden npx tsx test/parity/report.mts
```

`test/parity/BASELINE.md` covers the full setup.

A skipped gate must never look like a passing one: if you touch this area, keep the skip
message intact.

## Adding or extending an adapter

A screen source is an `Adapter` in `src/adapters/`, registered in
`src/pipeline/registry.ts`. A new one is expected to bring all of:

1. **A `detect()` implementation** that returns a score with **evidence** (`file`,
   `line`, `what`). A score >= 50 is live; `[1, 50)` is a near-miss that never runs on
   its own and must be selected with `--source`. Detection reports and orders; it never
   silently picks a winner between two live sources.
2. **Tests under `test/adapters/`** covering both the detection scoring and the emitted
   screens, including the cases the adapter cannot handle.
3. **Honest limitations.** If the adapter cannot see part of a stack, surface it — as a
   diagnostic, as a stated limitation in `meta.limitations`, or in the README's
   non-goals. Do not paper over it with a guess.
4. **A README update.** The README states how complete each adapter is. Keep it true.

## Pull request process

1. Fork the repository and create a feature branch.
2. Make your change, keeping it focused and small.
3. Ensure `pnpm type-check`, `pnpm lint`, `pnpm test` and `pnpm build` all pass.
4. Add or update tests covering your change.
5. If the emitted artifact changes, say so explicitly in the PR and justify every count
   that moves.
6. Update `CHANGELOG.md` under `[Unreleased]` for any user-facing change.
7. Open a pull request describing the motivation and the approach. Reference any related
   issue.

## Reporting bugs and requesting features

Use the GitHub issue templates for [bug reports](.github/ISSUE_TEMPLATE/bug_report.md)
and [feature requests](.github/ISSUE_TEMPLATE/feature_request.md).

For a bug, the two most helpful things you can provide are the output of
**`appgraph doctor`** and a **minimal reproduction**. Because analysis is parser-only, a
reproduction does not need to build or even be runnable — a few files with the shape the
parser mishandles is enough.

## Code of conduct

By participating, you agree to abide by the [Code of Conduct](./CODE_OF_CONDUCT.md).
