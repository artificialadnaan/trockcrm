# File Attachments Expansion Discovery

Date: 2026-05-14  
Branch: `fix/file-attachments-expansion`  
Worktree: `/Users/adnaaniqbal/projects/trockcrm/.worktrees/fix-file-attachments-expansion`

## Coordination Read

- Existing in-progress markers in the parent checkout:
  - `timeline-status-save`: expected overlap in lead form and server lead modules.
  - `estimator-notes-backspace`: expected overlap in deal scoping workspace only.
  - `permission-expansion`: expected overlap in recording upload endpoints and permission gates. This branch will avoid broad RBAC/upload middleware changes; MIME constants are the only intended shared upload change.
- Assumption: this feature should ship after smaller active PRs if they land first because it touches lead detail UI, file upload validation, email listing, and lead conversion behavior.

## Current File Upload Pipeline

1. Client upload entrypoint is `client/src/hooks/use-files.ts::uploadFile`.
2. The client validates size locally and asks `POST /api/files/upload-url` for a presigned upload URL.
3. The server validates category, target access, file association, MIME, extension, MIME-extension match, and file size in `server/src/modules/files/service.ts::requestUploadUrl`.
4. Storage is Cloudflare R2 when configured. `server/src/lib/r2-client.ts` provides `generateUploadUrl`, `headObject`, `putObject`, and download URL helpers. Dev mode uses `/api/files/dev-upload`.
5. The browser uploads the bytes directly to R2 via signed `PUT`.
6. The client calls `POST /api/files/confirm-upload`; the server verifies the R2 object exists and matches content type/length, then inserts `files`.
7. Upload side effects in `server/src/modules/files/upload-workflow.ts` write photo audit rows for photo files and enqueue a `file.uploaded` job.

## File Associations

- `shared/src/schema/tenant/files.ts` already has additive association columns:
  - `deal_id`
  - `lead_id`
  - `contact_id`
  - `procore_project_id`
  - `change_order_id`
- `migrations/0058_allow_lead_file_attachments.sql` already added `files.lead_id`, the lead FK, `files_lead_idx`, and widened the association check.
- `shared/src/schema/tenant/file-links.ts` exists, but current file views and upload routes primarily use direct columns. This feature should stay with direct columns to match current code.
- Deal file listing uses `getFiles({ dealId })`, which calls `buildDealFileScopeCondition`. If a deal has `source_lead_id`, it includes files where `files.deal_id = dealId OR files.lead_id = sourceLeadId`. This already makes source-lead files visible on the deal Files tab.
- Deal photos use `getDealPhotoTimeline`, which delegates conditions to `photo-timeline-filters`; the deal detail currently relies on source-lead lineage for photo visibility. Verification will confirm after implementation.

## Deal Tabs to Mirror

- Deal detail tabs live in `client/src/pages/deals/deal-detail-page.tsx`.
- Existing deal tabs:
  - Files: `client/src/components/files/deal-file-tab.tsx`
  - Photos: `client/src/pages/deals/deal-photos-tab.tsx`
  - Email: `client/src/components/email/deal-email-tab.tsx`
- Lead detail currently has only `timeline`, `questionnaire`, and `recordings` in `client/src/pages/leads/lead-detail-page.tsx`.
- Implementation choice:
  - Add Lead Files with the same `FileUploadZone` + `FileList` primitives, filtered by `leadId`.
  - Add Lead Photos with a lightweight photo upload/list surface filtered by `leadId` and `category=photo`.
  - Add Lead Emails by adding a `leadId` email query path and a lead email tab component matching the deal email tab structure.

## Lead to Deal Conversion

- Conversion is in `server/src/modules/leads/conversion-service.ts::convertLead`.
- It locks the lead, validates ownership/stage/questionnaire gate, calls `createDeal`, then marks the lead converted/inactive.
- The successor deal stores `source_lead_id`.
- Current conversion does not explicitly update files or emails.
- Implementation choice:
  - After the deal is created and before returning, update active lead files to also set `deal_id = successorDeal.id`.
  - Preserve `lead_id` so the original lead remains a readable pre-RFP record.
  - For files tagged as Client Provided Docs, auto-route:
    - Image extensions/MIME types stay `category='photo'`, set `intake_requirement_key='site_photos'`, `intake_source='scoping_intake'`.
    - PDF/Office/spreadsheet/text/email document uploads use `category='other'`, set `intake_requirement_key='scope_docs'`, `intake_source='scoping_intake'`.
    - All files get `deal_id`, so they appear in the deal Files tab.
  - For lead emails, keep the lead assignment intact and make deal email queries include emails assigned to the source lead. This preserves lead email history and makes it visible downstream without rewriting email ownership.

## Client Provided Docs Field

- The existing seed questions define `client_provided_docs` as `textarea` in migrations `0054` and `0083`.
- Lead questionnaire rendering is centralized in `client/src/components/leads/lead-questionnaire-sections.tsx`.
- Create/edit forms use `LeadQuestionnaireSections` from `client/src/components/leads/lead-form.tsx` and `client/src/components/leads/lead-questionnaire-editor.tsx`.
- Implementation choice:
  - Special-case `client_provided_docs` in the questionnaire renderer as a multi-file picker/upload surface rather than a textarea.
  - In create mode, retain selected files in component state, create the lead first, then upload the pending files with `leadId`.
  - In edit mode, upload directly to the existing `leadId`.
  - Do not persist filenames as questionnaire answer text; the canonical record is the `files` table.

## MIME and Upload Surfaces

- Server shared validation constants are in `server/src/modules/files/file-constants.ts`.
- Client shared picker/validation constants are in `client/src/lib/file-utils.ts`.
- Current allowed MIME/extension lists do not include:
  - `.eml` / `message/rfc822`
  - `.msg` / `application/vnd.ms-outlook`
- File upload zone uses `accept={Array.from(ALLOWED_EXTENSIONS).join(",")}` so updating client constants updates picker support.
- Deal Files, lead Files, Client Provided Docs, and scoping uploads use the shared `uploadFile` path, so adding constants applies consistently there.
- Site Photos should remain image-only in purpose. The generic upload validator can accept `.eml/.msg`, but photo-specific surfaces should continue to upload `category='photo'` and UI copy should not invite email files there.

## Migration Need

- No new migration appears necessary for lead file/photo support because `files.lead_id` and the tenant migration already exist.
- No new migration appears necessary for lead emails because `emails.assigned_entity_type='lead'` and `assigned_entity_id=<leadId>` already exist and `associateEmailToEntity` supports lead targets.
- All changes are additive behavior/code changes. If later discovery during implementation proves a missing production column, add an idempotent startup SQL migration only.

## Accepted Assumptions

- Client Provided Docs are identified by upload tags, not by adding a new DB column.
- Auto-routing is extension/MIME driven by default; reps can re-categorize through existing file metadata category editing.
- A file can retain `lead_id` and also gain `deal_id` after conversion. This is intentional so the original lead and the successor deal both show the same file row.
- `.eml/.msg` are document/correspondence artifacts, not photo artifacts. They should appear in Files, not Site Photos.
