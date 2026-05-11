# Review Round 1

## Findings

No correctness findings.

## Verification Notes

- Reviewed `.reviews/lead-timeline-fixes/discovery.md`.
- Reviewed the current working diff for:
  - `server/src/modules/leads/service.ts`
  - `server/src/modules/activities/service.ts`
  - `client/src/components/leads/lead-timeline-tab.tsx`
  - `client/src/components/leads/lead-questionnaire-editor.tsx`
  - touched lead/activity tests
- Focused test command passed:
  - `npx vitest run client/src/components/leads/lead-questionnaire-editor.test.tsx client/src/components/leads/lead-timeline-tab.test.tsx server/tests/modules/activities/service.test.ts server/tests/modules/leads/service.test.ts`
- Typecheck passed:
  - `npm run typecheck`

## Scope Notes

- The lead stage-change activity emission is tied to the canonical `updateLead` stage-change path used by `transitionLeadStage`, so manual stage transitions and due-diligence-driven transitions share the same activity write path.
- The activity row preserves sales visibility by setting `responsibleUserId` to the assigned rep and preserves actor attribution by setting `performedByUserId` to the user who changed the stage.
- Activity user metadata is loaded in one batched lookup per activity list response, not per row.
- The questionnaire change keeps the gate-backed `qualificationPayload.timeline_status` field visible and maps the hidden dynamic `timeline` node to the same value on save, so the stage-gate answer remains populated while the duplicate prompt is removed.
- `git diff main...HEAD` in this worktree currently includes older committed deal-detail/kanban changes because local `main` is stale; `HEAD` matches `origin/main`, and the lead-timeline changes under review are in the working tree.
