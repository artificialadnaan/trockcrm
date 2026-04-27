# Changelog

## 2026-04-24 - Lead Questionnaire V2

Added:
- Feature-flagged editable lead detail mode with project-type-driven cascading questionnaire rendering.
- Server-side questionnaire enforcement on entry into Sales Validation Stage, with conversion re-validation as a backstop.
- Post-conversion answer editing through source lead lineage with append-only answer history.

New tables and schema:
- `public.project_type_question_nodes`
- `tenant.lead_question_answers`
- `tenant.lead_question_answer_history`
- No legacy questionnaire JSON columns were modified or removed in this release.
- Legacy lead JSON questionnaire columns are deprecated and are read-fallback only in V2; the V2 code path never writes to them.

Feature flag:
- `ENABLE_LEAD_EDIT_V2`
- Default: `false`

Regression checks:
- Lead detail should remain read-only when the flag is off.
- Hidden leads (`isActive=false`) should remain readable but non-editable unless editing questionnaire answers through converted-deal lineage.
- Sales Validation entry should reject incomplete required questionnaire answers.
- Lead-to-deal conversion should still preserve pre-RFP activity and revalidate questionnaire completeness.
- Post-conversion answer edits should update `lead_question_answers` and `lead_question_answer_history` without mutating `leads.updated_at`.

Rollback:
- Flip `ENABLE_LEAD_EDIT_V2=false` to disable the new path immediately.
- If a schema rollback is later required, revert migration `0030_lead_questionnaire_v2.sql` only after confirming no production data in:
  - `public.project_type_question_nodes`
  - `tenant.lead_question_answers`
  - `tenant.lead_question_answer_history`

Follow-up:
- Drop deprecated legacy lead questionnaire JSON columns in a follow-up migration after 30 days of clean V2 production operation post-rollout.
