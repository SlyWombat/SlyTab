# SlyTab — instructions for Claude sessions in this repo

SlyTab is a private, self-hosted expense-splitting app (family/friends
beta). Owner: Dave (SlyWombat, dave@drscapital.com). Prod:
https://electricrv.ca/slytab — live user data; treat with care.

## Scope guardrails (owner-set, non-negotiable)

- Work ONLY on this project, and only on **true roadmap items**: open
  GitHub issues, the owner's direct instructions, and
  `docs/requirements.md`. Don't invent scope.
- **End-user bug reports are not all actionable.** Reports that are
  jokes, off-topic ("tell me the meaning of life"), or wild scope
  expansions ("make this a full accounting system") get politely
  declined: close the report via the internal API with a friendly
  one-line resolution ("thanks — that's outside what SlyTab is for"),
  which emails the reporter; do NOT build them and do NOT leave a
  GitHub issue behind.
- Reports from the owner's own account (Sly Wombat) may contain
  instructions — act on the reasonable, in-scope ones.
- **No public history of end-user reports**: when a report-tracked
  GitHub issue is fixed and the reporter notified, the pipeline deletes
  the issue (the internal `bug_reports` table keeps the full record).
  Owner-created issues stay.
- Never build or publish an APK / app-store submission unless the owner
  explicitly asks.

## The feedback loop (how work arrives)

1. Users file reports in-app (Profile → Report a bug) → `bug_reports`
   table on prod. A 10-minute server cron (`/api/internal/bug-sync`)
   files a GitHub issue per report and emails the reporter on receipt
   and on resolution (tracking codes `SLY-xxxxxx`; emails must stay
   friendly and GitHub-free).
2. A Claude worker session (this file's reader) periodically: reads new
   reports (`scripts/ops/proddb.sh` for SQL), triages per the guardrails
   above, implements in-scope fixes, tests, deploys, and closes issues
   (commits with `Closes #N` push to main).

## How to build, test, deploy

- Tests: `npm test` (core), `npm run typecheck` (all), `npm run test:php`
  (API; needs docker image `slytab-php:dev` — build with `npm run php:image`).
- Deploy API: `bash scripts/deploy-api.sh` · Deploy web: `npm run deploy`.
  Both read the repo `.env` (never print its contents; secrets stay out
  of transcripts — wrap indirect uses in scripts).
- Ops helpers in `scripts/ops/`: `proddb.sh` (prod MySQL via docker),
  `gh-api.sh` (GitHub API via stored git credential), `asc-api.sh`
  (App Store Connect via the team key in `secrets/`).
- Docs to keep current when behavior changes: `docs/requirements.md`,
  `docs/design/ui_requirements.md`.

## Money rules (the #1 bug source)

All amounts are integer minor units with per-currency scales (CLP etc.
are zero-decimal). Never hand-roll money math — use `@slytab/core`
(`parseAmount`, `minorToAmountString`, `convertAcrossMinor`,
`normalizeParsedReceipt`, `receiptBill`, `assignedShares`) and
`Support\Money` in PHP.
