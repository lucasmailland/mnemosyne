<!--
Thanks for contributing to Mnemosyne! Keep pull requests focused: one change each.
Security problems are reported privately, never in a pull request: see SECURITY.md.
-->

## Summary

<!-- What does this change and why? Link the issue it closes, e.g. "Closes #123". -->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change (needs a minor bump while on 0.x)
- [ ] Docs / tooling only

## Checklist

- [ ] `pnpm build && pnpm lint && pnpm typecheck && pnpm test` pass
- [ ] `pnpm test:integration` passes, if I touched RLS, recall, migrations or the database adapters
- [ ] A bug fix comes with a test that fails without it
- [ ] Commits follow [Conventional Commits](https://www.conventionalcommits.org/) and are signed off (`git commit -s`)
- [ ] A line under **Unreleased** in `CHANGELOG.md`, if users will notice the change
- [ ] Docs and examples updated if behaviour or a public API changed (English and Spanish)

## Notes for reviewers

<!-- Anything tricky: migration ordering, isolation implications, performance, follow-ups. -->
