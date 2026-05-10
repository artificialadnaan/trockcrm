# Track J Deals Overhaul Review Round 2

## Fixes Applied From Round 1

- P1 date precedence:
  - Replaced terminal filter date SQL so Won uses `contract_signed_at` / `contract_signed_date`, falling back directly to `stage_entered_at`.
  - Lost uses `lost_at`, falling back directly to `stage_entered_at`.
  - Stage history no longer takes precedence for terminal filtering.
- P2 export:
  - Export now fetches every page matching the current embedded-list filters before generating CSV.
  - Export no longer silently exports only the current 25-row page.
- P2 inert control:
  - Removed the visible `Filters` button because there is no additional filter drawer in this PR.

## Verification

- `npm run typecheck`: PASS.
- Focused affected suites: PASS, 8 files / 85 tests.

## Broad Test Note

`npm run test` still fails in this sandbox due primarily to supertest `listen EPERM: operation not permitted 0.0.0.0` and unrelated existing suite failures. Focused deal/pipeline suites pass.
