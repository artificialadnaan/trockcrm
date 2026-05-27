# Lead Form Sales Rep Required Fix

## Investigation

Read `.worktrees/disco-lead-form-rep-required/.reviews/lead-form-rep-required/report.md` and verified the bug in `client/src/components/leads/lead-form.tsx`.

Confirmed:

- The displayed Sales Rep label could fall back to the logged-in rep's display name while `formData.assignedRepId` remained empty.
- The Sales Rep select's stored value is `formData.assignedRepId`.
- Submit validation checks only `formData.assignedRepId`, so the UI could show a rep while submit raised `Sales rep is required.`

## Change

Added a small client-side helper in `client/src/components/leads/lead-form.tsx` that applies the create-mode rep default from the authenticated user:

- For create mode, when the logged-in user is a rep and `assignedRepId` is empty, initialize `assignedRepId` to `user.id`.
- Reuse the same helper in the post-mount synchronization effect so delayed auth/user state still populates the value.
- Preserve explicit assignment changes: if the user/admin has selected a rep, the helper leaves the stored value alone.
- Tightened the Sales Rep label fallback so it only shows the logged-in rep's name when the stored value actually matches that rep ID. Otherwise it renders `Select sales rep`.

No server validation, assignee API source, or unrelated form behavior was changed.

## Tests

Added coverage in `client/src/components/leads/lead-form.test.tsx`:

- Create form as a logged-in rep defaults the Sales Rep select value to the rep ID.
- Submitting without changing the rep sends `assignedRepId` / `salesRepId` as that rep ID and does not show `Sales rep is required.`
- Explicitly selecting a different rep sends the selected rep ID.
- Leaving the stored value empty still shows `Sales rep is required.`

## Review

One subagent code review completed.

- Finding: no blocking correctness issue.
- Residual note: duplicated defaulting logic existed after the first patch.
- Fix applied: routed both initialization and synchronization through the same `applyCreateRepDefault` helper.

## Verification

- `npm run build --workspace=shared`: passed before investigation and again after changes.
- `TMPDIR=/private/tmp npx vitest run client/src/components/leads/lead-form.test.tsx --testTimeout=15000 --exclude '.worktrees/**'`: passed, 58 tests.
- `TMPDIR=/private/tmp npx vitest run server/tests/ client/src/ shared/ --testTimeout=15000 --exclude '.worktrees/**' 2>&1 | tail -50`: broad suite still reports known existing rot; tail showed sandbox `listen EPERM: operation not permitted 0.0.0.0` in `server/tests/modules/auth/dev-auth-production-routes.test.ts`, with 49 failed files / 328 failed tests.
- `npm run typecheck --workspace=client`: passed.
- `npm run typecheck --workspace=server`: passed.
- `npm run typecheck --workspace=shared`: passed.
- `npm run build --workspace=shared`: passed.
- `npm run build --workspace=server`: passed.
- `npm run build --workspace=client`: passed with existing Vite chunk/dynamic-import warnings.
