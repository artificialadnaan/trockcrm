# Follow-ups

Items flagged but not addressed in their originating commit. Pick one when scope and risk allow.

## Lead service

- **v1-client posting `source` alone gets silently dropped under v2.** `server/src/modules/leads/service.ts` — line ~1224, `else if (!v2Enabled && input.source !== undefined)`. Symptom mirrors the qualificationPayload bug (Commit 1) but lower stakes — only triggers if a stale browser bundle posts `source` instead of `sourceCategory`/`sourceDetail`. Fix path: either accept `source` as a legacy alias and route it through `resolveLeadSourceForWrite`, or have the API reject the legacy field with a clear error so old bundles fail loud instead of silent. Surfaced during 2026-04-27 CRM fixes batch.
- **Thread questionnaire node displayLabel through stage-gate field labels.** `server/src/modules/leads/stage-gate.ts` — `questionnaireFieldLabel()` currently does mechanical underscore-to-titlecase conversion for `question.<key>` rows in the advance-stage modal checklist. Won't match user-facing question text from the questionnaire authoring UI. Fix path: pass node `label` through from `evaluateLeadQuestionGate` (or look up by key in stage-gate when rendering) so UI shows the real display label. Surfaced during 2026-04-27 CRM fixes batch.

## Tests

- **Align test fixtures with prod stage slugs.** `server/tests/modules/leads/service.test.ts` around line 299 uses bare `sales_validation` slug instead of `sales_validation_stage`. V2 gate likely never fires in those fixtures. Not a regression — pre-dates this batch — but worth aligning test fixtures with prod slugs for accurate coverage. Surfaced during 2026-04-27 CRM fixes batch slug verification.
