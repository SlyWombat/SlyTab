# Contributing to SlyTab

SlyTab follows the same conventions as the other SlyWombat projects
(CaseMaker, SlyLED). The short version: **issue first, regression test with
every fix, small focused PRs.**

## Bug fixes

1. File a GitHub issue describing the bug (repro steps, expected vs actual).
2. Fix it on a branch.
3. Add a regression test that fails without the fix.
4. Open a PR referencing the issue with `Fixes #N` in the description.

## Development setup

```bash
npm ci                     # installs all JS workspaces
composer install -d api    # installs the PHP API (needs PHP 8.2+, MySQL)
npm run dev                # PHP API via php -S (:8100) + web app (:8000)
npm run dev:mobile         # Expo dev server
npm test                   # Vitest (core, web) + PHPUnit (api)
npm run test:e2e           # Playwright E2E against the web app
npm run lint && npm run typecheck
```

## Code style

- TypeScript strict mode, `noUncheckedIndexedAccess`, no `any`.
- All money math goes through `packages/core` — never do arithmetic on floats
  in UI code. Amounts are integer minor units (cents) everywhere.
- All API payloads are validated with the Zod schemas in `packages/core` on
  both ends. Don't hand-roll validation.
- Plain CSS with `--ss-*` design tokens on web; the same token values come
  from `packages/core/src/tokens.ts` on mobile. No CSS frameworks, no
  component libraries.

## Tests

- Split math, currency conversion, and debt simplification in `packages/core`
  must keep 100% branch coverage — these functions decide who owes money.
- The same algorithms exist in PHP (`api/src/Domain/`). Any change to them
  must update the shared fixtures in `packages/core/test-vectors/` — both
  Vitest and PHPUnit assert those vectors, and CI fails if TS and PHP ever
  disagree.
- Every API endpoint has at least one happy-path and one auth-failure test
  (PHPUnit).
- E2E covers the golden path: sign up → create group → add expense → settle.

## Commit messages

Imperative subject line, body explains *why*. Reference issues with
`Fixes #N`. AI-assisted commits carry a co-author trailer:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

## PR checklist

- [ ] Issue referenced
- [ ] Tests added/updated and passing
- [ ] `npm run lint && npm run typecheck` clean
- [ ] CHANGELOG.md `[Unreleased]` entry added (with issue number)
- [ ] No secrets, tokens, or `.env` contents in the diff
