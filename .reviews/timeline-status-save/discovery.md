# Timeline Status Save Discovery

## Assumptions

- Production API base used for reproduction: `https://api-production-ad218.up.railway.app`.
- Smoke account used: `test-sales@trock.test`.
- The reported user-facing field is `Timeline Target Date` in the lead Sales Validation Fields panel. The related V2 questionnaire node is `Timeline` with key `timeline`.

## Exact Field Mapping

- UI label: `Timeline Target Date`
- Lead form state: `formData.qualificationPayload.timeline_status`
- API payload field: `qualificationPayload.timeline_status`
- Database storage: `office_<tenant>.leads.qualification_payload -> 'timeline_status'`
- Related V2 questionnaire mirror:
  - UI label: `Timeline`
  - API payload field: `leadQuestionAnswers.timeline`
  - Database table: `office_<tenant>.lead_question_answers` via question node key `timeline`

No dedicated SQL column exists or is needed. The canonical CRM storage for this field is JSONB on `leads.qualification_payload`.

## Save Path

1. `client/src/components/leads/lead-form.tsx`
   - Reads `lead.qualificationPayload.timeline_status` into `formData.qualificationPayload.timeline_status`.
   - Renders `Timeline Target Date` from `LEAD_QUALIFICATION_FIELDS`.
   - Builds the create/update payload in `workflowPayload.qualificationPayload.timeline_status`.

2. `client/src/components/leads/lead-questionnaire-editor.tsx`
   - Also reads `lead.qualificationPayload.timeline_status`.
   - Hides duplicate V2 node `timeline` from display.
   - On save, mirrors `qualificationPayload.timeline_status` into `leadQuestionAnswers.timeline`.

3. `server/src/modules/leads/routes.ts`
   - `POST /api/leads` spreads request body into `createLead`.
   - `PATCH /api/leads/:id` passes request body to `updateLead`.
   - No Zod stripping layer exists on this route.

4. `server/src/modules/leads/service.ts`
   - `CreateLeadInput` and `UpdateLeadInput` both accept `qualificationPayload`.
   - `createLead` writes `qualificationPayload: normalizeQualificationPayload(input.qualificationPayload)`.
   - `updateLead` writes `updates.qualificationPayload = normalizeQualificationPayload(input.qualificationPayload)`.
   - `normalizeQualificationPayload` currently returns the payload as-is, so no server-side strip occurs.

5. `shared/src/schema/tenant/leads.ts`
   - `qualificationPayload: jsonb("qualification_payload").default({}).notNull()`.

6. Readback:
   - `GET /api/leads/:id` returns `lead.qualificationPayload`.
   - When V2 is enabled, the route also returns `lead.leadQuestionnaire.answers`, sourced from `lead_question_answers`.

## Production Reproduction Evidence

Created a `SMOKE TEST DELETE` lead through the production API with:

```json
{
  "qualificationPayload": {
    "existing_customer_status": null,
    "estimated_value": 1000,
    "timeline_status": "2026-12-31"
  },
  "leadQuestionAnswers": {
    "budget": 1000,
    "timeline": "2026-12-31"
  }
}
```

Production `POST /api/leads` response for lead `13610dbf-6d8b-4143-8080-b2e4560ba323` included:

```json
"qualificationPayload": {
  "estimated_value": 1000,
  "timeline_status": "2026-12-31",
  "existing_customer_status": null
}
```

Then updated through production `PATCH /api/leads/13610dbf-6d8b-4143-8080-b2e4560ba323` with:

```json
"qualificationPayload": {
  "existing_customer_status": null,
  "estimated_value": 1000,
  "timeline_status": "2027-06-15"
}
```

Production response included:

```json
"qualificationPayload": {
  "estimated_value": 1000,
  "timeline_status": "2027-06-15",
  "existing_customer_status": null
}
```

Browser verification on `/leads/13610dbf-6d8b-4143-8080-b2e4560ba323`, Questionnaire tab, showed:

- `Timeline Target Date`: `2027-06-15`
- V2 Project Question `Timeline`: `2027-06-15`

## Root Cause

The API, ORM, and DB persistence path are not dropping `qualificationPayload.timeline_status`.

The drop/confusion point is the V2 create form UI/payload layer:

- The create form renders `Timeline Target Date` from `qualificationPayload.timeline_status`.
- It also renders the V2 universal questionnaire node `Timeline` from `leadQuestionAnswers.timeline`.
- Unlike `LeadQuestionnaireEditor`, `LeadForm` did not hide the duplicate `timeline` node and did not mirror the visible `Timeline Target Date` into `leadQuestionAnswers.timeline`.

This created two editable Timeline controls for the same business concept. Depending on which one the user filled, the other could appear empty on return, making it look like the Timeline date was silently dropped.

## Similar Dropped-Field Audit

Audited the lead write surface for the same class of issue:

- `qualificationPayload.estimated_value`: included in create/update payload and server write path.
- `qualificationPayload.timeline_status`: included in create/update payload and server write path, but lacked V2 create-form mirroring to `leadQuestionAnswers.timeline`.
- `leadQuestionAnswers.timeline`: explicitly mirrored by `LeadQuestionnaireEditor`, but not by `LeadForm` create mode before this fix.
- `bidDueDate`: first-class `leads.bid_due_date` and best-effort mirrored to V2 `bid_due_date` by service.
- No Drizzle schema column mismatch found.
- No server validation/schema stripping found.
- No migration required.

## Fix Plan

- Hide the V2 universal `timeline` questionnaire node in `LeadForm` create mode, matching `LeadQuestionnaireEditor`.
- Treat `Timeline Target Date` as the single visible Timeline input.
- Mirror normalized `qualificationPayload.timeline_status` into `leadQuestionAnswers.timeline` whenever the V2 questionnaire contains that node.
- Preserve required-field behavior: when the hidden V2 `timeline` node is required, validate the visible `Timeline Target Date` field and surface `Timeline Target Date` in the required-field error.
- Add a regression test proving:
  - only one Timeline input is rendered;
  - create payload includes both `qualificationPayload.timeline_status` and `leadQuestionAnswers.timeline`.
  - a blank `Timeline Target Date` blocks create when the V2 `timeline` node is required.
