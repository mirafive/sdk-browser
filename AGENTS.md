# Agents working in mirafive/sdk-browser

`@mirafive/sdk-browser`: the browser SDK (core plus one plugin entry per feature). Part
of the MIRA FIVE SDK family; the wire contract, flag semantics and public API live in
[mirafive/protocol](https://github.com/mirafive/protocol) (PROTOCOL.md, FLAGS.md,
API.md).

## Commands

```sh
bun install --frozen-lockfile
bun run check            # format, lint, typecheck, test, build, publint, attw, size-limit
bun run test             # vitest (happy-dom)
bun run size             # size-limit against the limits in package.json
bun run vendor:protocol  # refresh src/protocol from ../protocol (or MIRAFIVE_PROTOCOL)
bunx vitest run -u test/golden.test.ts  # rewrite test/golden/*.json after a deliberate wire change
```

## Rules

- API.md is the contract for this package's public surface. Do not add, rename or
  remove exports without changing API.md first.
- `src/protocol/` is vendored. Never edit it; change mirafive/protocol and run
  `bun run vendor:protocol`. Which modules are vendored is listed in
  `package.json#mirafive.protocol`.
- Test fixtures come from mirafive/protocol, copied unchanged, their sha256 pinned in
  `test/golden.test.ts`. Never edit them. `test/golden/*.json` are this SDK's own
  batches; the app's contract test ingests them, so a change there is a wire change.
- Bundle size is the headline goal. Every public subpath has a size-limit entry; a
  change that grows one explains why. No runtime dependencies without approval.
- Plugins import only types from the core and share nothing at runtime except
  `src/protocol/`; anything a plugin needs from the core goes through `MiraCore`, so
  each entry is measured and loaded on its own.
- Consentless code paths never read `navigator.language`, `Intl…timeZone` or `screen`
  and never touch storage or cookies; `test/consentless.test.ts` spies on all of them.
- Each feature is its own entry point; `sideEffects: false` must stay true.
- Transport failures never throw into the caller's code (API.md, shared rules).
- A secret key never reaches browser code; `secretKey` throws.
- Comments only for a non-obvious constraint, one or two lines.
- Do not run git write commands unless asked; the maintainer commits.

## Releasing

To release, bump `version` in `package.json` (and any SDK version constant), add a `## X.Y.Z — YYYY-MM-DD` section to `CHANGELOG.md`, commit, then `git tag vX.Y.Z && git push origin vX.Y.Z`. `.github/workflows/release.yml` checks both, runs `bun run check`, stages it on npm through trusted publishing (no token) and creates the GitHub release from the changelog section. The version goes live only after a maintainer approves it with 2FA on npmjs.com (`npm stage approve`). Never `npm publish` from a laptop.
