# Follow-ups

Items flagged but not addressed in their originating commit. Pick one when scope and risk allow.

## Lead service

- **v1-client posting `source` alone gets silently dropped under v2.** `server/src/modules/leads/service.ts` — line ~1224, `else if (!v2Enabled && input.source !== undefined)`. Symptom mirrors the qualificationPayload bug (Commit 1) but lower stakes — only triggers if a stale browser bundle posts `source` instead of `sourceCategory`/`sourceDetail`. Fix path: either accept `source` as a legacy alias and route it through `resolveLeadSourceForWrite`, or have the API reject the legacy field with a clear error so old bundles fail loud instead of silent. Surfaced during 2026-04-27 CRM fixes batch.
