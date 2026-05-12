# Leak Inventory — Credentials and Disclosure Cleanup

Snapshot prior to scrub. Source: `git grep` on `origin/main` at SHA `a7a5862`.

## Class A — Credentials (passwords paired with emails) — SCRUB

All in `.reviews/projects-page-backfill/`. Three test-account passwords appear in tables, sentences, and shell-comments:

| File | Lines | Pattern |
|---|---|---|
| `.reviews/projects-page-backfill/diagnosis.md` | 16, 17, 18 | full credential table — admin password (a 7-char dev sentinel) and the shared smoke password (a 13-char value) both appear in plaintext |
| `.reviews/projects-page-backfill/final.md` | 56, 68 | inline mentions of admin and shared smoke passwords |
| `.reviews/projects-page-backfill/smoke.md` | 30, 57, 77, 96, 97, 98 | shell comments + credentials table for all three accounts |

Total credential occurrences in `.reviews/`: **11 lines across 3 files**.

## Class B — Production host telemetry in `.reviews/` docs — SCRUB

| File | Lines | Pattern |
|---|---|---|
| `.reviews/projects-page-backfill/diagnosis.md` | 27 | `POST https://<prod-api-host>/api/projects/backfill` (the literal Railway hostname appeared, scrubbed to placeholder) |
| `.reviews/track-f-project-number-casing/discovery.md` | 62, 63 | two `GET https://<prod-api-host>/api/deals?...` lines (literal Railway hostname appeared, scrubbed to placeholder) |

Total in `.reviews/`: **3 lines across 2 files**.

## Class C — Production stack-trace paths in `.reviews/` docs — SCRUB

Compiled `/app/server/dist/...` filenames + line numbers from Railway stack traces. Different from normal source-code `file.ts:N` references in code reviews, which are kept.

| File | Lines | Pattern |
|---|---|---|
| `.reviews/projects-page-backfill/diagnosis.md` | 41 | `file:///app/server/dist/middleware/tenant.js:65:9` |
| `.reviews/projects-page-backfill/followup-architecture.md` | 10 | `file:///app/server/dist/modules/projects/backfill-service.js:84:13` |
| `.reviews/projects-page-backfill/smoke.md` | 7 | `(backfill-service.js:84)` |

Total in `.reviews/`: **3 lines across 3 files**.

## Class D — Legitimate occurrences — KEEP

These are not leaks; the standing orders explicitly carve out their categories:

### D1. Emails alone in narrative docs (no paired password)

Standing orders: *"emails are not the secret; pairing them with passwords is"*.

| File | Lines |
|---|---|
| `.reviews/track-f-project-number-casing/discovery.md` | 58 — `test-admin@trock.test` referenced without password |
| `client/e2e/autonomous-production-smoke.spec.ts` | 134, 170 — emails in E2E test code |
| `docs/autonomous-smoke-2026-05-08.md` | 18, 48, 49, 80 — narrative mentions of accounts |

### D2. Production host in source code, config, and tests

Standing-orders grep limits the host check to `.reviews/`. Source-code uses are config/fallback constants, security middleware allow-lists, and test fixtures.

| File | Reason kept |
|---|---|
| `client/src/lib/api.ts:1` | `RAILWAY_API_FALLBACK` constant |
| `client/src/lib/api.test.ts` (lines 10, 11, 15, 16, 21, 23) | API base URL resolver tests |
| `client/src/hooks/use-notifications.test.ts:8` | mock fixture |
| `server/src/middleware/security.ts:4` | CSRF allow-list |
| `server/tests/lib/r2-client.test.ts` (lines 84, 87) | R2 CORS allow-list test |
| `tests/audit/helpers.ts:22` | E2E audit helper |
| `docs/superpowers/plans/2026-04-05-report-export.md:187` | reference plan |
| `docs/superpowers/plans/2026-04-20-invite-hardening-and-volume-validation.md:412` | reference plan |
| `AUDIT_LOG.md:301` | operational log, outside `.reviews/` scope |

### D3. Normal source-code `file.ts:N` references in code reviews

The grep for `(tenant|backfill-service|routes)\.(js|ts):[0-9]+` returned many results from past review docs (`director-all-bugs/`, `email-all/`, `file-upload-fix/`, `leads-kanban-truncation-bug/`, `projects-tab/`, `track-a-conversion/`, `track-b-scope-tab/`, `round-2-review.md`). Those point to source `.ts` files and are normal review-doc craft, not leaked stack traces. Only the `dist/*.js:NN:N` compiled paths from Railway are scrubbed.

## Scrub plan summary

| Class | Files | Lines | Replacement strategy |
|---|---|---|---|
| A (creds) | 3 | 11 | Replace each password literal with `<redacted — test creds in ops vault>`. Keep the email plus the role label. Hits both the admin dev-mode password and the shared smoke password everywhere they appear in `.reviews/`. |
| B (prod host) | 2 | 3 | Replace the production Railway hostname (form `api-production-<id>.up.railway.app`) with `<prod-api-host>` in `.reviews/` only. |
| C (stack traces) | 3 | 3 | Replace compiled file + line with `tenant.js:<line>` / `backfill-service.js:<line>` (drop the precise position; keep the filename). |

After the scrub, the verification gates must succeed:
- `git grep` for either canonical test-account password literal returns zero results repo-wide
- `git grep` for the production Railway hostname returns zero results inside `.reviews/`
- Pre-commit hook blocks a synthetic test commit that introduces the admin-password literal
- Pre-commit hook does NOT block a normal commit that doesn't contain a leak.
