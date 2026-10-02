## Summary

Briefly describe what this PR changes and why.

## Related issue

Closes #

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that changes existing behavior)
- [ ] Adapter (new or extended screen source)
- [ ] Documentation only
- [ ] Internal / tooling

## Checklist

- [ ] `pnpm type-check` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] `pnpm build` succeeds
- [ ] Tests added or updated to cover the change
- [ ] No runtime dependencies were added (the package ships `commander` only, with
      `typescript` as a peer dependency)
- [ ] No use of the TypeScript TypeChecker — analysis stays parser-only
- [ ] No `any` types, unsafe `as` casts, or code comments were introduced
- [ ] Output is still deterministic (no `localeCompare`, no `Date.now()`, no filesystem
      or `Map` iteration order leaking into the artifact)
- [ ] CHANGELOG.md updated under `[Unreleased]` (for user-facing changes)

## Artifact impact

If this changes what is emitted, say so explicitly and show it.

- [ ] This PR does not change the emitted artifact
- [ ] This PR changes the emitted artifact

If it does change the artifact:

- Which counts move, in which direction, and why:
- Parity golden (kept outside the repository, see CONTRIBUTING.md) regenerated deliberately,
  with the justification recorded (a silent golden diff is never acceptable):
- `test/parity/` baseline updated, with the accepted difference named:

## Documentation honesty

The README deliberately states what the tool does **not** do. If this PR changes any of
those boundaries, update the docs in the same PR.

- [ ] Non-goals, limitations, and adapter-completeness statements in the README are
      still accurate after this change
