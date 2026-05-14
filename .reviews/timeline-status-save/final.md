# Timeline Status Save Final

## Result

Fixed and deployed. The lead create form now treats `Timeline Target Date` as the single visible Timeline input and mirrors it into the V2 `leadQuestionAnswers.timeline` payload so the detail/questionnaire read path stays populated.

## Merged SHAs

- Primary fix PR #305: `ef8921dd6a5eefa87c684563bc09750a6c411639`
- Script-only smoke follow-up PR #306: `6496c10bdf21a8a4b2ce439fad67e6b512ad860e`
- Final deployed SHA: `6496c10bdf21a8a4b2ce439fad67e6b512ad860e`

## Railway Deployment IDs

Final rollout after PR #306:

- Frontend: `19d41217-a8b7-4d3f-9539-2ea48194bcae` - SUCCESS
- API: `05d2b01c-160d-4bbf-9d3f-ad0e8e4f0b46` - SUCCESS
- Worker: `8e2fb413-b45c-4a70-8c60-7bc0b4f94071` - SUCCESS
- Field: `ee054cce-61ce-4ef0-a299-4cc2e17a6142` - SUCCESS

Earlier primary-fix rollout after PR #305:

- Frontend: `b99e1ffe-90c0-4a4d-91b0-4b4548a08fec` - SUCCESS
- API: `211766d5-ad5a-402b-9598-7fdc5c2d2114` - SUCCESS
- Worker: `db75b533-c818-45cd-86de-725df5d170db` - SUCCESS
- Field: `ee054cce-61ce-4ef0-a299-4cc2e17a6142` - SUCCESS

## Diagnosis

- UI label: `Timeline Target Date`
- Form state: `formData.qualificationPayload.timeline_status`
- API field: `qualificationPayload.timeline_status`
- DB storage: `office_<tenant>.leads.qualification_payload -> 'timeline_status'`
- V2 mirror: `leadQuestionAnswers.timeline`

The API, ORM, and DB write path already persisted `qualificationPayload.timeline_status`. The bug was the create-form V2 UI/payload layer: create mode rendered both `Timeline Target Date` and a separate V2 `Timeline` question for the same business concept, and did not mirror `Timeline Target Date` into `leadQuestionAnswers.timeline`.

## Fix Summary

- Hid the duplicate V2 `timeline` questionnaire node in `client/src/components/leads/lead-form.tsx`.
- Preserved `Timeline Target Date` as the only visible Timeline input.
- Mirrored normalized `qualificationPayload.timeline_status` into `leadQuestionAnswers.timeline` on create/update payload construction.
- Preserved required-field validation for required hidden V2 `timeline` nodes by validating the visible `Timeline Target Date` field.
- Added regression coverage in `client/src/components/leads/lead-form.test.tsx`.
- Added `scripts/smoke-timeline-save.ts` for production API create/refetch/update/refetch/cleanup verification.

## Verification Evidence

Local/test verification:

- Red test first confirmed duplicate Timeline create-mode surface.
- Red test first confirmed a hidden required V2 `timeline` node could be bypassed until validation was patched.
- `npx vitest run client/src/components/leads/lead-form.test.tsx --testNamePattern "Timeline Target Date" --exclude ".worktrees/**"`: 2 passed.
- `npx vitest run client/src/components/leads/lead-form.test.tsx --testNamePattern "sends the selected ATL office code" --exclude ".worktrees/**"`: 1 passed.
- `npx tsc --noEmit --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 --types node scripts/smoke-timeline-save.ts`: passed.
- `git diff --check origin/main...HEAD`: passed.

Review:

- Subagent review round 1 found the hidden-required-timeline bypass; fixed with regression.
- Subagent review round 2 found no blocking issues.
- Round 3 was not needed.

Production smoke after final deploy:

```json
{
  "ok": true,
  "leadId": "cd824ca4-9157-4204-b100-e149b4ccf5f9",
  "createdTimeline": "2026-12-31",
  "updatedTimeline": "2027-06-15"
}
{
  "cleanup": {
    "leadId": "cd824ca4-9157-4204-b100-e149b4ccf5f9",
    "deleted": true
  }
}
```

Browser spot check:

- Logged into production as `test-admin@trock.test`.
- Opened `https://trockcrm.com/leads/new`.
- Confirmed create mode shows exactly one Timeline control: `Timeline Target Date`.
- Confirmed the duplicate V2 `Timeline` field is not visible.

## Fields Fixed

- `qualificationPayload.timeline_status`
- V2 mirror `leadQuestionAnswers.timeline`

No other dropped fields with the same root cause were found in the lead write-path audit.

## Migration Details

No migration. Existing JSONB storage and V2 answer storage were already present.

## Accepted Risks

- Full `lead-form.test.tsx` suite had one existing ATL office-code case time out at 5s during a full-suite run; that same case passed when rerun individually. The timeline-specific tests passed.
- Browser verification confirmed the production create-form surface, while the persistence create/update/refetch path was verified through the production API smoke script.

## Deferred Items

- None for this bug.
