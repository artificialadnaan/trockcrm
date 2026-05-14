# File Attachments Expansion - In Progress

- Branch: `fix/file-attachments-expansion`
- Worktree: `/Users/adnaaniqbal/projects/trockcrm/.worktrees/fix-file-attachments-expansion`
- Started: 2026-05-14
- Files-touched list, expected:
  - Lead detail view tabs and lead attachment UI
  - Lead form `Client Provided Docs` field
  - Lead to deal conversion logic
  - Upload pipeline and MIME validation
  - File storage backend / R2 integration if discovery confirms shared validation lives there
  - Lead schema additions for file, photo, and email associations if existing models do not already support leads
  - `scripts/smoke-file-attachments-expansion.ts`
  - `.reviews/file-attachments-expansion/discovery.md`
  - `.reviews/file-attachments-expansion/final.md`
- Migrations: YES if leads do not already have file/photo/email associations; additive and startup-idempotent only.
- Permission-system changes: POSSIBLE. `fix/permission-expansion` is touching recording uploads and permission gates; this branch will avoid broad permission middleware changes unless the existing file upload endpoints require a narrow lead/deal authorization addition.
- Estimated merge ETA: after discovery, TDD implementation, up to 3 review rounds, rebase on latest `origin/main`, PR, self-merge, Railway deploy watch, and production smoke.

Coordination notes:
- Read existing in-progress markers for `timeline-status-save`, `estimator-notes-backspace`, and `permission-expansion` before implementation.
- Recording uploads are separate from lead/deal file/photo/email uploads. Shared middleware changes, if any, will be limited to MIME/extension validation and documented in discovery.
- This PR has schema/data-model risk and should ship after smaller active PRs if those land first.
