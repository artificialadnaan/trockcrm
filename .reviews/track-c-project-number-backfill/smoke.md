# Project Number Backfill Smoke

Date: 2026-05-10

## Production execution summary

- Dallas execute updated 425 rows.
- Atlanta execute updated 0 rows because current production had no eligible Atlanta candidates.
- Post-execute Dallas dry-run showed 0 remaining canonical candidates.
- Remaining Dallas null `project_number` rows are expected manual-triage rows:
  - 311 legacy/freeform preserved values
  - 20 rows with no preserved value

## Sample verification

Read-only production DB verification checked five `UPDATE` rows from
`docs/audit/project-number-backfill-2026-05-10T18-54-17-576Z.csv`.

| Deal ID | Expected project_number | Verified |
| --- | --- | --- |
| 00f7c38a-f84e-5fcd-8bf5-99d1e94f1e0f | ATL-4-11126-aa | yes |
| 01600d50-34b6-531f-b4f7-67cb0348f616 | DFW-5-02826-ac | yes |
| 03ade023-a470-5112-965a-3d291948a455 | DFW-4-09926-ad | yes |
| 044e2641-c202-59c5-ad76-e78eac799c8f | DFW-7-02926-ab | yes |
| 0585db29-3230-5995-a1fa-5352ac683da5 | DFW-4-10326-ai | yes |

Read-only production DB verification checked two `SKIP - legacy format` rows and
two `SKIP - no preserved value` rows. All four still have `project_number IS NULL`.

| Deal ID | Skip reason | Verified null |
| --- | --- | --- |
| 0078f6d3-c699-5c96-8c72-258f76fee448 | legacy format | yes |
| 0118b2b0-445a-5628-adff-4d57ce87f8aa | legacy format | yes |
| 1e4587ca-b2b4-53bb-9e6a-39a533730ca5 | no preserved value | yes |
| 1fe0bb57-ea49-5741-be31-fb9577ab550a | no preserved value | yes |

## Browser smoke

Requested browser smoke as `test-admin` could not be completed because the existing
`/tmp/trock-test-admin.cookie` token is expired and production `/api/auth/dev/users`
returned an empty user list. No alternate session-cookie sweep was performed.

Verdict: DB-level smoke passed; UI login is blocked on fresh test-admin credentials.

Manual triage issue: https://github.com/artificialadnaan/trockcrm/issues/207
