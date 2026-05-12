# Final Report — Credentials and Disclosure Cleanup

## Status

**PASS.** All scrubbed, hook installed and self-tested, two-round subagent review CLEAN, live login probe verified. Ready to merge.

## PR / Merge

- PR: https://github.com/artificialadnaan/trockcrm/pull/252
- Merge SHA: filled in after merge
- No runtime deploy required (doc + dev-tooling only). Confirmed by inspecting recent doc-only PRs (#250, #251) which were merged without triggering meaningful behavior changes; husky `prepare` script auto-installs the hook on the next `npm install` for any teammate.

## Leak inventory summary (pre-scrub state)

| Class | Pattern shape | Files in `.reviews/` | Lines |
|---|---|---|---|
| A | test-account password literals (admin dev-mode + shared smoke) | `projects-page-backfill/diagnosis.md`, `final.md`, `smoke.md`; `reports-500-regression/final.md`, `smoke.md` | 16 |
| B | production Railway hostname `api-production-<id>.up.railway.app` | `projects-page-backfill/diagnosis.md`; `track-f-project-number-casing/discovery.md`; `reports-500-regression/smoke.md` | 4 |
| C | compiled `/app/server/dist/...js:NN:N` stack-trace fragments | `projects-page-backfill/diagnosis.md`, `followup-architecture.md`, `smoke.md` | 3 |

Total: 23 lines across 8 files.

Note: Class A and B counts went up between the leak-inventory snapshot and the final pass because PR #251 (reports-500 docs) merged into main mid-track and brought 6 more leaks; the rebase pulled them in. The follow-up commit `30e3485` extended the scrub to cover them.

Replacements applied:
- Class A → `<redacted — test creds in ops vault>`
- Class B → `<prod-api-host>`
- Class C → kept filename, dropped precise line (e.g., `tenant.js:<line>`)

## Pre-commit hook test evidence

```
OK   : literal admin password was blocked
OK   : literal shared password was blocked
OK   : password assignment regex was blocked
OK   : railway prod hostname was blocked
OK   : clean prose was allowed
OK   : redacted password was allowed

PASS: pre-commit hook behaves as designed (4 blocked, 2 allowed).
```

Run from `bash scripts/test-precommit-hook.sh`. Self-installs via `prepare = "husky"` in `package.json` on the next `npm install`. Bypassable per-commit with `--no-verify` when explicitly approved.

## Subagent review rounds

- Round 1 (`.reviews/credentials-and-disclosure-cleanup/review-round-1.md`): REQUEST CHANGES — 5 P0 (missed scrubs in `reports-500-regression/` files that arrived via rebase from PR #251). All fixed in commit `30e3485`. The reviewer also flagged a P1 concern that the hook hadn't blocked its own PR; that turned out to be a misunderstanding (the `reports-500-regression` files were not added by this PR, they came in via rebase from a PR authored before the hook existed).
- Round 2 (`.reviews/credentials-and-disclosure-cleanup/review-round-2.md`): CLEAN — no P0/P1. One P2 about the production hostname appearing in source code outside `.reviews/` — explicitly out of scope per the standing orders. Exit loop.

## Accepted risks

1. **Test-account passwords are not rotated.** The user explicitly accepted residual risk for these test accounts. Rationale: (a) they are test accounts only, (b) the threat model on a pre-go-live CRM is bounded, (c) coordination cost of rotation during go-live week is high. Recommend rotation after May 12 go-live if the risk is later judged unacceptable.
2. **Old credential values still exist in git history pre-this-PR.** The standing orders forbid `git filter-repo` rewrites because another agent's branch (PR #245 etc.) was active during this work. After go-live, a clean-history pass is feasible if the org judges the residual disclosure risk worth the coordination cost of rewriting shared history.
3. **Production hostname remains in source code outside `.reviews/`.** Identified by round-2 reviewer as a P2 observation. Functional references (CORS allow-list, API fallback URL, test fixtures, planning docs) — not credential disclosures. Could be moved to env-only configuration in a future hardening pass.

## Assumptions made during autonomous operation

1. Emails alone (without paired passwords) in narrative docs and E2E test code are not leaks. The standing orders explicitly carve this out: *"emails are not the secret; pairing them with passwords is."*
2. The `git grep` verification gate's intent is "no leak in app code, docs, or `.reviews/`" — the security tooling itself (the hook + its self-test) must reference the literal patterns to function. Documented this exception in the leak inventory and the round-2 review.
3. Husky 9 is the right choice for pre-commit hook plumbing: well-trodden, single dev dependency, auto-installs via `prepare`. Not overengineering by reaching for git's native `core.hooksPath` configuration since husky is already widely used in the JS ecosystem.
4. `chore(security):` is the right commit-message prefix for the scrubs and the hook (matches the conventional-commit style observed in the repo's recent history).
5. The `.reviews/projects-page-backfill/` and `.reviews/reports-500-regression/` narratives have engineering value worth preserving — they document the multi-PR diagnosis chain. Redact only the credentials/host/line-numbers, keep the prose.

## Known issues / NEEDS INTERVENTION

None blocking merge.

## Worktree cleanup status

Worktree at `/Users/adnaaniqbal/projects/trockcrm-creds-cleanup` to be removed after merge. Branch `fix/credentials-disclosure-cleanup` will be auto-deleted on `gh pr merge --delete-branch`.

## Out-of-band follow-up

P3 from the original Codex review on PR #246 — savepoint test mock allowing `RELEASE SAVEPOINT` in an aborted transaction (when real Postgres rejects it) — to be filed as a separate issue per the track brief. Filed via `gh issue create` after this PR merges to keep the issue link to the merged-PR commit SHA stable.
