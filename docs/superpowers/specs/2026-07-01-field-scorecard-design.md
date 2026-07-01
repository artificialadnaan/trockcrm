# Field Scorecard — Design Spec

- **Date:** 2026-07-01
- **Status:** Approved (design), ready for planning
- **Author:** Adnaan Iqbal (with Claude)
- **Source doc:** `TRC_05_Field Scorecard_050526_.pdf` (T-Rock Construction weekly field scorecard)
- **Surfaces:** `mobile/` (TRock Cam, primary), `server/`, `worker/`, `shared/`, `client/` (CRM web)

## 1. Summary

Translate T-Rock's paper **Weekly Field Scorecard** into a native form inside the TRock Cam mobile app. A superintendent picks a project, scores 7 sections (100 points total), attaches photo evidence with captions/voice transcription per section, flags critical deficiencies, records required action items, and submits. On submit the server persists a structured record, renders a branded PDF that mirrors the paper form, emails it to a configurable recipient list, and exposes the card in the CRM web app for PMs/directors.

The scoring system and answer text are reproduced **exactly** from the PDF. The photo/caption/voice-transcription experience reuses the existing TRock Cam capture pipeline unchanged.

## 2. Goals & non-goals

**Goals**
- New **"Scorecard" bottom tab** in TRock Cam (4th tab, next to Capture and Profile).
- A guided, snappy wizard that captures the exact scoring model from the PDF.
- Per-section photo evidence using the same camera/import + caption + voice-to-text flow as Capture; those photos also land in the project's gallery, auto-tagged.
- Local draft autosave + durable offline submission (nothing lost on bad jobsite signal).
- Server-authoritative scoring, total, rating, and the action-item gate.
- PDF generation on submit + email to a **configurable** recipient list (ships inert until set).
- CRM web visibility of completed scorecards on the deal.

**Non-goals (v1)**
- Editing a submitted scorecard (submitted = locked; a correction is a new card).
- Hard DB uniqueness on one-card-per-project-per-week (UI groups by week; no constraint).
- Drawn/on-glass signatures (accountability = auto-recorded submitter + typed Super/PM names).
- Director cross-deal scorecard roll-up / analytics (natural phase-2).
- Per-office / per-project recipient lists and auto-CC of the PM's email (phase-2; the resolver is built to allow it).
- Server-side drafts or multi-user collaborative editing.

## 3. Canonical scoring model (transcribed from the PDF)

Single source of truth in `shared`; imported by mobile, server, worker, and web so nothing drifts.

### 3.1 Sections (100 points total)

| # | `sectionKey` | Title | Max | Options — `points` → label |
|---|--------------|-------|-----|-----------------------------|
| 1 | `planning_precon` | Planning & Precon | 10 | 10 → "Scope, schedule, and logistics fully aligned" · 5 → "Minor gaps requiring follow-up" · 0 → "Major gaps impacting execution" |
| 2 | `jobsite_5s` | Jobsite Organization / 5S | 15 | 15 → "Clean, organized, and fully controlled" · 10 → "Minor housekeeping or staging issues" · 5 → "Disorganized areas affecting production" · 0 → "Poor site condition or lack of control" |
| 3 | `schedule` | Schedule Performance | 20 | 20 → "On schedule and meeting milestones" · 15 → "Minor slippage with recovery in progress" · 10 → "Behind schedule without full recovery" · 0 → "Off track and impacting project progress" |
| 4 | `subcontractor` | Subcontractor Performance | 15 | 15 → "Performing to plan and expectations" · 10 → "Minor coordination or manpower issues" · 5 → "Performance impacting production or quality" · 0 → "Major performance failure" |
| 5 | `quality` | Quality Control | 20 | 20 → "Hold points completed with no deficiencies" · 15 → "Minor corrections required" · 10 → "Rework or repeated deficiencies present" · 0 → "Major quality or inspection failures" |
| 6 | `communication` | Communication & Documentation | 10 | 10 → "Reports, updates, and documentation current" · 5 → "Minor communication gaps" · 0 → "Missing, late, or inconsistent reporting" |
| 7 | `financial` | Financial Control | 10 | 10 → "Costs aligned with budget and production" · 5 → "Minor cost variance or unresolved exposure" · 0 → "Budget concerns or uncontrolled costs" |

Max points sum: 10 + 15 + 20 + 15 + 20 + 10 + 10 = **100**.

### 3.2 Rating bands

| `rating` | Range | Label |
|----------|-------|-------|
| `elite` | 90–100 | Elite Execution |
| `on_standard` | 85–89 | On Standard |
| `needs_improvement` | 75–84 | Needs Immediate Improvement |
| `corrective_action` | 0–74 | Corrective Action Required |

### 3.3 Critical deficiencies (check all that apply)

`missed_hold_point` "Missed hold point" · `failed_inspection` "Failed inspection" · `schedule_slipping` "Schedule slipping without recovery plan" · `site_org_below` "Site organization below standard" · `unapproved_co` "Unapproved Change Order work" · `safety_access` "Safety or access issue" · `poor_sub` "Poor subcontractor performance" · `missing_docs` "Missing documentation or reporting"

### 3.4 Action-item gate

Required action items (≥ 1 non-empty) are **required when `totalScore < 85` OR any critical deficiency is checked**. Otherwise optional. Enforced client-side and re-enforced server-side.

## 4. Architecture overview

Full-stack, delivered in four gated PRs (§12). Data lives in per-office tenant tables (like `deals`, `files`, `closeout_checklist_items`). The mobile client holds the working draft locally and submits atomically; the server is the authority for scoring and the record; the worker sends the email off a domain event; the CRM web app reads the same tables for review.

**Draft/submit model — local-draft + atomic submit** (chosen over server-side drafts): the entire wizard state (answers + attached photos) is a device-local draft, autosaved as edited. On Submit, one durable job (a) drains the attached photos through the existing `upload-url → R2 → confirm-upload` pipeline so they persist to the deal gallery, then (b) POSTs the scorecard referencing those photos by `clientUploadId`. Reuses the photo queue's offline/retry machinery; works with no signal. Rejected alternative: create a server row immediately and PATCH per change — real-time but breaks offline and multiplies endpoints.

**Storage shape — dedicated structured tables** (chosen over a JSONB blob): scores/rating/deficiencies are first-class columns/rows so the CRM and future reporting query them directly.

## 5. Data model

### 5.1 Shared definition & types — `shared/src/types/field-scorecard.ts` (new)

Re-exported from `shared/src/types/index.ts`. Contents:
- `FIELD_SCORECARD_SECTIONS` — the §3.1 array: `{ key, title, maxPoints, options: { points, label }[] }[]`.
- `FIELD_SCORECARD_CRITICAL_DEFICIENCIES` — the §3.3 array: `{ key, label }[]`.
- `FIELD_SCORECARD_RATING_BANDS` — the §3.2 bands.
- `FIELD_SCORECARD_TOTAL_POINTS = 100`.
- Pure functions: `computeScorecardTotal(items)`, `resolveScorecardRating(total)`, `actionItemsRequired({ total, deficiencyCount })`, `isLegalSectionPoints(sectionKey, points)`.
- Types: `ScorecardSectionKey`, `ScorecardRating`, `ScorecardCriticalDeficiencyKey`, `ScorecardSubmissionInput` (POST payload — carries a client-generated `clientSubmissionId` uuid for idempotent retries), `FieldScorecardSummary`, `FieldScorecardDetail`.

### 5.2 Tenant tables — `shared/src/schema/tenant/field-scorecards.ts` (new)

Registered in `shared/src/schema/index.ts`. Three per-office tables:

**`field_scorecards`**
- `id` uuid pk (`gen_random_uuid()`)
- `client_submission_id` uuid **not null** — client-generated, stable across retries; **unique** index makes `POST` idempotent (a retried offline submit resolves to the same row instead of duplicating a card/PDF/email)
- `deal_id` uuid **not null** — FK → `deals.id` (mirror the `files.deal_id` FK added in `0158`)
- `week_of` date **not null**
- `project_number` text — resolved project number snapshot at submit
- `superintendent_name` text · `pm_name` text
- `total_score` integer **not null** · `rating` text **not null** (one of §3.2 keys)
- `critical_deficiencies` text[] **not null** default `'{}'` (deficiency keys)
- `action_items` text[] **not null** default `'{}'`
- `status` text **not null** default `'submitted'` (reserved for future states)
- `submitted_by` uuid **not null** (`users.id`) · `submitted_by_name` text (snapshot) · `submitted_at` timestamptz **not null** default `now()`
- `pdf_r2_key` text · `pdf_r2_bucket` text · `pdf_generated_at` timestamptz — set when the PDF is rendered (PR3)
- `email_sent_at` timestamptz — set when the recipient email is dispatched (PR3); the email worker's idempotency marker
- `is_active` boolean **not null** default `true` (soft-delete parity) · `created_at` / `updated_at` timestamptz

**`field_scorecard_items`** — one row per scored section
- `id` uuid pk · `scorecard_id` uuid **not null** FK → `field_scorecards.id` `ON DELETE CASCADE`
- `section_key` text **not null** · `points` integer **not null** · `note` text
- unique `(scorecard_id, section_key)`

**`field_scorecard_photos`** — evidence links to gallery photos
- `id` uuid pk · `scorecard_id` uuid **not null** FK → `field_scorecards.id` `ON DELETE CASCADE`
- `section_key` text **not null** · `file_id` uuid **not null** (→ `files.id`) · `created_at` timestamptz
- unique `(scorecard_id, file_id)`

### 5.3 Migration — `migrations/0172_field_scorecards.sql` (new)

Standard two-part convention (see `0169_files_thumbnail_r2_key.sql`):
1. `DO $$ … FOR schema_name IN SELECT nspname … LIKE 'office\_%' LOOP EXECUTE format(...)` creating the three tables (+ indexes/FKs) in every existing office schema.
2. A `-- TENANT_SCHEMA_START` / `-- TENANT_SCHEMA_END` block written against `office_dallas` so the office provisioner (`server/src/modules/office/service.ts`) replays it for new offices.

Next number after the current highest (`0171_deal_companycam_projects.sql`).

## 6. Server API (`server/src/modules/field/`)

New `scorecards-service.ts` + routes appended to `routes.ts`. Auth/CSRF unchanged: `requireFieldContractor` + `x-requested-with` / `x-office-id`. All writes run through `runFieldDealWrite` (resolves the deal's owning office; cross-office safe).

**Endpoints**
- `POST /api/field/scorecards` — body `ScorecardSubmissionInput`:
  ```
  { clientSubmissionId,                           // client-generated uuid — idempotency key
    dealId, weekOf, superintendentName?, pmName?,
    items: [{ sectionKey, points, note? }],      // all 7 sections
    criticalDeficiencies: string[],               // deficiency keys
    actionItems: string[],                        // non-empty strings
    photos: [{ sectionKey, clientUploadId }] }    // reference already-uploaded photos
  ```
  **Idempotency first**: if a card with this `clientSubmissionId` already exists, return it `200` with no new insert/PDF/event — so a retried offline submit (response lost after the row landed) never duplicates. Validation: every section present exactly once; each `points` legal for its section (`isLegalSectionPoints`); deficiency keys valid; **recompute** `totalScore` + `rating` server-side (ignore any client total); enforce the §3.4 gate (reject 422 if action items required but empty). Resolve each `clientUploadId` → `files` row via `getFileByClientUploadId`, assert it belongs to this deal/office, insert `field_scorecard_photos`. Insert `field_scorecards` + `field_scorecard_items` in one transaction, guarded by the `client_submission_id` unique index (a concurrent retry resolves to the existing row). Emit `field_scorecard.submitted` domain event (PR3). Returns `FieldScorecardSummary`.
- `GET /api/field/scorecards` — recent submitted cards across the user's accessible projects/offices (cross-office fan-out, like `/field/projects`), for the **Scorecard tab landing**, which has no pre-selected project. Paged.
- `GET /api/field/projects/:dealId/scorecards` — list summaries (newest first) for one project (project-detail + post-submit refresh).
- `GET /api/field/scorecards/:id` — `FieldScorecardDetail` (items, deficiencies, action items, photos with presigned URLs).
- `GET /api/field/scorecards/:id/download` — presigned PDF URL from `pdf_r2_key` (PR3; 404/409 until rendered).

**Cross-office reads.** These id-keyed routes hit a tenant-local scorecard id, but field is office-agnostic — `cross-office.ts` today resolves the office only for deal/lead/file ids. Add a **scorecard→office resolver** that fans out across the user's accessible office schemas by scorecard id (mirroring the deal/file read path) so opening a card for a project outside the active `x-office-id` resolves the owning office instead of 404-ing; the list + detail + download endpoints all use it.

## 7. Mobile UX (`mobile/`)

### 7.1 Navigation & entry
- New tab in `app/(app)/_layout.tsx`: `Tabs.Screen name="scorecards"` titled **"Scorecard"**, icon `clipboard-outline` (or `checkbox-outline`).
- Route group mirroring `projects/`: `app/(app)/scorecards/_layout.tsx` (Stack), `index.tsx` (landing list), `[draftId].tsx` (wizard host).
- **Landing list**: local draft cards (with **Resume**) + submitted cards (color-coded rating badge, score, week, submitter) from the cross-office `GET /field/scorecards` recent list (the tab has no pre-selected project, so it can't use the per-deal list); **＋ New scorecard** → **deal-only** project picker → new draft.
- **Project detail shortcut**: add a **"New scorecard"** button on `app/(app)/projects/[id].tsx` beside *Add photos* / *Build report*, launching the wizard pre-targeted (gated off-office view-only exactly like capture).

### 7.2 Wizard (guided, one screen per step)
1. **Setup** — Project (prefilled, or chosen via a **deal-only** picker — the shared `TargetPicker` also returns leads/opportunities, which the deal-FK schema can't accept, so the scorecard flow filters to deals/projects *before* a draft is created), Project Number (auto from deal), Superintendent, PM, Week Of (date). Super/PM prefilled from deal data when available; both optional.
2. **7 section screens** — title + max points, tap-cards for the exact options (single-select, running total pill, progress bar, Back/Next), an **optional note** with 🎙️ voice-to-text, and **Add photo**.
3. **Add-photo sheet** — reuses `CameraCapture` + import + `PhotoCaptionEditor` + `VoiceRecorder`. On attach, the photo file is **copied into durable per-draft storage** (see §7.3) and held as {durable uri + caption + metadata + `clientUploadId`}.
4. **Critical deficiencies** — the 8-item check-all-that-apply list.
5. **Required action items** — shown/required only when the §3.4 gate trips; supports dictation.
6. **Review & submit** — big total, auto color-coded `RatingBadge`, section summary with tap-to-edit, then Submit.

### 7.3 State, persistence, submission (`src/scorecard/`)
- `scorecard-definition.ts` — thin re-export of the shared definition for RN import ergonomics.
- `scorecard-draft.ts` — pure reducer (answers, notes, photos, deficiencies, action items; derives total/rating/gate). Unit-tested.
- `draft-store.ts` — device-local persistence (SecureStore/AsyncStorage for metadata), per user, keyed by draft id; autosave on change; list/load/delete for the landing screen. **Each draft owns a durable photo directory under the app document dir**: attached photos are **copied there on attach, not at submit**, because raw camera/library URIs go stale across app-kill/backgrounding — the same reason `upload-queue.ts` copies files into durable storage before persisting. The draft also carries a stable `clientSubmissionId` (uuid, generated at draft creation) used as the submit idempotency key. Submitting or deleting a draft cleans up its photo directory.
- `submit-queue.ts` — durable submission job mirroring `upload-queue-core.ts`. On Submit: (1) enqueue each attached photo (from its **durable draft copy**) as a field-photo upload (target = deal, `tags: ['scorecard', sectionKey]`, caption) and drain via the **existing** upload queue → `confirm-upload` persists them with their `clientUploadId`; (2) once all confirmed, `POST /field/scorecards` with the draft's `clientSubmissionId` + `photos: [{ sectionKey, clientUploadId }]` (the id makes the POST safe to retry); (3) on success clear the local draft (and its photo dir), invalidate the project gallery + scorecard-list queries; (4) offline/failure → stays queued, same "keeps retrying / nothing lost" banners as photos.
- API in `src/api/endpoints.ts`: `createScorecard`, `getProjectScorecards`, `getScorecard`, `getScorecardDownload`; types in `src/api/types.ts`.
- Components: `ScorecardWizard`, `SectionScorer`, `RatingBadge`; reuse `CameraCapture`, `PhotoCaptionEditor`, `VoiceRecorder`, `TargetPicker`, `ui.tsx`, theme.

### 7.4 Client validation (mirrors server)
All 7 sections scored before Review; `weekOf` + `dealId` required; action items required per §3.4; total/rating derived from the shared functions (server remains authoritative).

## 8. PDF generation (PR3)

`renderFieldScorecardPdf` (server; reuse the report renderer utilities in `photo-reports-service.ts`). Layout mirrors the paper form: header (Project / Number / Superintendent / PM / Week Of), the 7 sections with the selected option, total, rating, critical deficiencies, required action items, accountability line (submitter + timestamp), then a **photo-evidence appendix** (each section's photos with captions). Stored to R2 at `office_<slug>/deals/<dealNumber>/documents/scorecards/<yyyy-mm>/scorecard-<id>.pdf`; the key is written back to `field_scorecards.pdf_r2_key` (not the report's tag-on-a-`files`-row hack). Rendered inline at create so in-app **Download PDF** works immediately.

## 9. Email distribution (PR3)

Modeled on `worker/src/jobs/rfp-rejection-email.ts`.
- Server create emits `DOMAIN_EVENTS.FIELD_SCORECARD_SUBMITTED` (new constant in `shared`) into `job_queue` with `{ scorecardId, officeId, dealId }`.
- New worker job `worker/src/jobs/field-scorecard-email.ts`: load scorecard + deal, fetch the PDF from R2, resolve recipients, send via **Resend** with the PDF attached. **Idempotent send** — pass a deterministic Resend idempotency key (keyed by `scorecardId`; it's one email per card) and stamp `field_scorecards.email_sent_at`, so a worker retry after a send that succeeded but crashed before the job was marked complete does not re-email duplicate attachments (mirrors the RFP email jobs). Retryable; dead-letters on repeated failure.
- **Recipients** from a new env var **`FIELD_SCORECARD_EMAIL_RECIPIENTS`** (comma-separated; trimmed; deduped). **Empty/unset → no-op** (logged), matching `DAILY_SUMMARY_RECIPIENTS`. Set on the worker service later once the audience is known — no code change. Resolver (`resolveFieldScorecardRecipients`) is a pure, tested function built so per-office lists or an auto-CC of the PM's user email can be layered in without touching the send path.
- Subject: `Field Scorecard — {project} — Week of {weekOf} — {total}/100 {ratingLabel}`. Body: summary (project, super/PM, total, rating, deficiencies, action items) + PDF attachment.

## 10. Web CRM visibility (PR4, `client/`)

A **Field Scorecards** panel on the deal-detail page: submitted cards with score, color-coded rating, week, submitter; row → detail view (all sections, deficiencies, action items, evidence photos) + **Download PDF**. Backed by tenant-scoped CRM endpoints (via `tenantMiddleware`, reading the same per-office tables): `GET /api/deals/:dealId/scorecards`, `GET /api/scorecards/:id`, `GET /api/scorecards/:id/download`. Exact mount path/module pinned during planning.

## 11. Testing strategy

- **shared** (unit): `computeScorecardTotal`, `resolveScorecardRating` (band boundaries 74/75/84/85/89/90/100), `actionItemsRequired`, `isLegalSectionPoints`.
- **server** (PGlite `*.runtime.test.ts`, runs in CI gate): create → total/rating recomputed; gate rejection when action items required but empty; illegal section points rejected; `clientUploadId` resolution + deal-ownership enforcement; photo linking; office scoping; **idempotent submit (duplicate `clientSubmissionId` → single row, no dup card/PDF/event)**; **cross-office scorecard-id read resolves the owning office**; list/get; `/download` presign.
- **worker**: `resolveFieldScorecardRecipients` (split/trim/dedupe/empty→no-op) + a send test with Resend mocked, including **idempotent re-run (already-sent → no second send)** (mirror `rfp-rejection-email.test.ts`).
- **mobile** (jest `*.test.ts`): `scorecard-draft` reducer (scoring, gate derivation), `draft-store` persistence round-trip **+ durable photo-copy on attach / cleanup on delete**, `submit-queue` ordering (photos before POST) + retry/offline **+ stable `clientSubmissionId` across retries**.
- **client/web** (PR4): render test for the scorecard panel; name so it executes in the CI gate (see the client-test-and-CI-gate convention).

## 12. Phasing — four gated PRs (Adnaan merges; no self-merge)

1. **Foundation** — shared definition/types + tenant tables + migration `0172` + `POST`/`list`/`get` field endpoints + scoring validation + photo linking + PGlite runtime tests. *(No PDF/email yet.)*
2. **Mobile wizard** — 4th tab, wizard, per-section capture, draft autosave, offline submit queue, project-detail shortcut, jest tests. **Requires an EAS rebuild** (no OTA for TRockCam; reuses existing native modules — no new native deps).
3. **PDF + email** — `renderFieldScorecardPdf` + `pdf_r2_key` columns + `/download` + `FIELD_SCORECARD_SUBMITTED` event + worker job + `FIELD_SCORECARD_EMAIL_RECIPIENTS` + tests.
4. **Web CRM** — deal-detail scorecard panel + tenant endpoints + PDF download.

## 13. Key decisions & rationale

- **Local-draft + atomic submit** over server-side drafts — offline-first, reuses the durable photo queue, minimal endpoints.
- **Dedicated structured tables** over JSONB — queryable by the CRM and future reporting.
- **Server-authoritative scoring** — client can't submit a wrong total or bypass the action-item gate.
- **Idempotent submit & email** — a client-generated `clientSubmissionId` (unique index) makes the retryable offline POST safe; the email worker keys Resend idempotency on `scorecardId` and stamps `email_sent_at`. Queue retries can't duplicate cards, PDFs, or emails.
- **Photos shared to the gallery** (not siloed) — evidence is visible everywhere a project's photos are, and reuses the entire capture/upload/thumbnail pipeline; the scorecard link is an additive join.
- **Submitted = locked/immutable** — accountability; corrections are new cards.
- **One-per-project-per-week is soft** — UI groups by week; no DB constraint (avoids blocking legitimate re-scores). Retry-duplication is handled separately by `clientSubmissionId`, not a week constraint.
- **Email ships inert** — `FIELD_SCORECARD_EMAIL_RECIPIENTS` empty until the audience is confirmed; resolver built for later per-office/PM expansion.

## 14. Deferred / open items

- Director cross-deal scorecard roll-up (filter by rating/week/office).
- Per-office / per-project recipient lists; auto-CC the PM's user email; below-85 escalation-only sends.
- Superintendent/PM as picked CRM users instead of free text.
- Confirm the audience for `FIELD_SCORECARD_EMAIL_RECIPIENTS` (Adnaan to provide the "who").

## 15. Deploy / ops notes

- **Mobile:** EAS rebuild required (no OTA); no new native modules.
- **Server / worker:** deploy via Railway; run `0172` migration (`npm run db:migrate`); set `FIELD_SCORECARD_EMAIL_RECIPIENTS` on the worker service when ready (safe to leave empty).
- **Web CRM:** standard client deploy (PR4).

## 16. Revisions from design review (PR #848)

Codex review of the initial spec surfaced six issues, all incorporated above:

1. **Idempotent submit (P1)** — `clientSubmissionId` unique key so the durable offline retry can't create duplicate cards/PDFs/emails (§5.1, §5.2, §6, §7.3).
2. **Cross-office scorecard reads (P2)** — a scorecard→office resolver so id-keyed detail/download don't 404 for off-`x-office-id` projects (§6).
3. **Deal-only project picker (P2)** — the wizard filters `TargetPicker` to deals so a lead/opportunity can't produce an unsubmittable card (§7.1–7.2).
4. **Durable draft photo copies (P2)** — evidence photos are copied into per-draft durable storage on attach, not at submit, so long-lived drafts survive app-kill (§7.2–7.3).
5. **Email retry dedup (P2)** — deterministic Resend idempotency key + `email_sent_at` marker so a crash-after-send retry can't double-email (§5.2, §9).
6. **All-project landing list (P3)** — `GET /field/scorecards` (cross-office recent) so the tab lists submitted cards with no project pre-selected (§6, §7.1).
