---
name: Bug report
about: Report a problem so it can be fixed
title: "[Bug]: "
labels: bug
assignees: ""
---

## Describe the bug

A clear and concise description of what the bug is. For a wrong-output bug, say which
part of the artifact is wrong: a screen that should exist and doesn't, a screen that
shouldn't exist and does, a wrong `url`/`auth`/`flags` value, a missing navigation edge,
a phantom endpoint, and so on.

## `appgraph doctor` output

Run `appgraph doctor` in the affected project and paste the output. This is the single
most helpful thing you can provide: it prints the detection scores with evidence, the
globs that were attempted, the near-misses, the test-id histogram and the resolved
config, which is almost always where the answer is.

```
# paste `appgraph doctor` output here
```

## Reproduction

The best reproduction is a **minimal repo or directory tree** — a handful of files that
show the pattern the parser mishandles. If the input is a private codebase, a reduced
snippet of the route definition or component in question is usually enough, since
analysis is parser-only and does not need the project to build.

```tsx
// minimal repro: the route/component shape that is mishandled
```

## Command run

```bash
appgraph ...
```

## Expected behavior

What you expected in the emitted artifact.

## Actual behavior

What was actually emitted, plus any diagnostics printed and the process exit code.

## Environment

- `appgraph` version:
- `typescript` version (the peer dependency, i.e. your project's own compiler):
- Node.js version:
- OS:
- Router / stack: react-router (v5 / v6 / v7, library or framework mode) | wouter | Next.js App Router | Next.js Pages Router | TanStack Router | Vue Router | Nuxt | Angular Router | Expo Router | React Navigation | AdminJS | router-less (extension / state-activated) | other
- Config: zero-config | `appgraph.config.ts` (please include it)

## Additional context

Anything else relevant — a monorepo layout, unusual `tsconfig.json` path mappings, a
generated route file, a custom test-id attribute.
