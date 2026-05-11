# Summary

- Emit a lead activity whenever a lead stage changes so the lead detail timeline shows stage movement.
- Enrich listed activities with responsible/performed-by user display metadata for timeline attribution and avatars.
- Render lead stage-change timeline rows as actor-attributed movement events with timestamps.
- Remove the duplicate Qualified Lead questionnaire Timeline prompt by keeping the gate-backed `timeline_status` field and mapping the hidden universal `timeline` node to the same value on save.

# Verification

- `npm run typecheck`
- `npx vitest run server/tests/modules/leads/service.test.ts server/tests/modules/activities/service.test.ts client/src/components/leads/lead-questionnaire-editor.test.tsx client/src/components/leads/lead-timeline-tab.test.tsx`

# Review

- Round 1 reviewer artifact: `.reviews/lead-timeline-fixes/review-round-1.md`
- Findings: 0

# Scope Notes

- No deal-side timeline or activity code was modified.
- No lead stage workflow rules were changed; the stage-change path only adds activity emission.
