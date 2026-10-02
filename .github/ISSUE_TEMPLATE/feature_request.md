---
name: Feature request
about: Suggest an idea or enhancement
title: "[Feature]: "
labels: enhancement
assignees: ""
---

## Problem / motivation

What problem are you trying to solve? What is the use case? A clear description of the
need helps more than a proposed solution alone. If the goal is "my agent cannot find
screen X", say what the agent needed to know and what the artifact told it instead.

## Proposed solution

A clear and concise description of what you want to happen, including the proposed
config field, CLI flag, or artifact shape if relevant.

## Alternatives considered

Any alternative solutions or workarounds you have considered — including whether an
`appgraph.config.ts` override already gets you there.

## Additional context

Add any other context, references or prior art.

Please keep the project's v0.1 constraints in mind; a request that requires one of
these is a larger conversation than a feature request:

- **Parser-only.** Analysis uses `ts.createSourceFile` and never the TypeScript
  TypeChecker, so it stays fast and works on a repo that does not compile. A feature
  that needs resolved types needs that constraint relaxed first.
- **One runtime dependency.** The published package depends on `commander` and nothing
  else; `typescript` is a peer dependency so it parses with your project's compiler.
- **Determinism.** Identical input must produce byte-identical output on every machine.
- **Zero-config first.** A new capability should be detected where it can be, with
  config as the override rather than the entry fee.
- **Honesty over coverage.** A confidently wrong map is worse than no map. A feature
  that guesses is worse than one that reports that it cannot tell.

See the [non-goals](../../README.md#non-goals-in-v01) for what is deliberately out of
scope in v0.1.
