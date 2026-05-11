# Lead Timeline Fixes Discovery

## TIMELINE-A: lead detail timeline is empty

- Lead detail renders `LeadTimelineTab` from `client/src/pages/leads/lead-detail-page.tsx`.
- `LeadTimelineTab` only fetches `/api/activities` through `useActivities({ leadId, limit: 100 })` when a lead has not converted. See `client/src/components/leads/lead-timeline-tab.tsx:92`.
- The current renderer only knows generic activities with `type`, `subject`, `body`, and `occurredAt`. It does not render actor attribution or avatars. See `client/src/components/leads/lead-timeline-tab.tsx:35`.
- Lead stage changes are already written to `lead_stage_history` inside `updateLead` when `input.stageId !== existing.stageId`. The audit record is built at `server/src/modules/leads/service.ts:1477` and inserted at `server/src/modules/leads/service.ts:1573`.
- The missing emission point is `server/src/modules/leads/service.ts:1573`: after writing `lead_stage_history`, no corresponding row is written to the `activities` table, so the lead detail timeline has no activity to render.
- `/api/activities` applies rep RBAC by forcing `responsibleUserId` to the current sales rep at `server/src/modules/activities/routes.ts:52`. Stage-change activity rows therefore need `responsibleUserId` set to the lead owner while preserving the stage changer in `performedByUserId`.
- `getActivities` filters by `leadId` and sorts descending by `occurredAt`/`createdAt`. See `server/src/modules/activities/service.ts:111` and `server/src/modules/activities/service.ts:123`.

Conclusion: the truncation is not a read filter issue for admin/director and not a timeline component lookup issue. The lead stage-change write path records stage history, but it does not emit a lead activity row for the timeline API. Add a `note` activity with `outcome = "lead_stage_changed"` because the existing DB enum does not include a `stage_change` activity type.

## TIMELINE-B: qualified questionnaire timeline appears twice

- The qualified lead editor has a fixed qualification payload input labeled `Timeline` backed by `qualificationPayload.timeline_status`. See `client/src/components/leads/lead-questionnaire-editor.tsx:471`.
- The editor then renders active dynamic questionnaire nodes through `LeadQuestionnaireSections` at `client/src/components/leads/lead-questionnaire-editor.tsx:498`.
- The universal questionnaire seed includes a dynamic question with key `timeline` and label `Timeline` at `migrations/0083_universal_lead_questionnaire_seed.sql:57`; the earlier seed also had the same key/label at `migrations/0054_seed_lead_questionnaire_nodes.sql:25`.
- The duplicate is not two `<LeadTimelineTab>` invocations. It is the legacy gate-backed `timeline_status` field plus the dynamic universal `timeline` node both appearing in the same form.

Conclusion: keep the fixed `timeline_status` field because the current stage gate/update payload uses it, and hide the dynamic `timeline` questionnaire node in this editor to avoid rendering the same business question twice.
