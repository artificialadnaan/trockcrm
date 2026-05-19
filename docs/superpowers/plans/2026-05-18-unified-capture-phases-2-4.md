# Unified Capture Phases 2-4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add field-photo voice dictation, free-form photo tags, and branded photo-report PDFs to `trockcam.com` and the CRM without regressing the existing field auth/upload flow.

**Architecture:** Extend the existing `files`-backed photo model instead of creating a parallel photo domain. Add a small field-photo service layer for transcription, tagging, and report generation, reuse the working field auth/upload APIs, and keep report generation server-side with R2-backed downloads so the field app and CRM can both consume the same report artifacts.

**Tech Stack:** PostgreSQL, Drizzle schema + SQL migrations, Express, React, TypeScript, Vitest, Cloudflare R2, OpenAI audio transcription API, `pdf-lib` for PDF generation.

---

## File map

- Shared schema
  - Modify: `shared/src/schema/tenant/files.ts`
  - Modify: `shared/src/schema/index.ts`
  - Modify: `shared/src/types/enums.ts` if new audit/report enums are needed
- SQL migrations
  - Create: `migrations/0127_photo_tags_and_reports.sql`
- Server field photo/report modules
  - Modify: `server/src/modules/field/photos-service.ts`
  - Modify: `server/src/modules/field/routes.ts`
  - Modify: `server/src/modules/field/projects-service.ts`
  - Create: `server/src/modules/field/photo-transcription-service.ts`
  - Create: `server/src/modules/field/photo-tags-service.ts`
  - Create: `server/src/modules/field/photo-reports-service.ts`
  - Create: `server/src/modules/field/pdf-layout.ts`
- Server tests
  - Create/modify: `server/tests/modules/field/routes.test.ts`
  - Create: `server/tests/modules/field/photo-transcription-service.test.ts`
  - Create: `server/tests/modules/field/photo-tags-service.test.ts`
  - Create: `server/tests/modules/field/photo-reports-service.test.ts`
- Field app
  - Modify: `client-field/src/lib/field-projects.ts`
  - Modify: `client-field/src/lib/api.ts`
  - Modify: `client-field/src/lib/capture-upload.ts`
  - Create: `client-field/src/lib/photo-dictation.ts`
  - Create: `client-field/src/components/VoiceRecorder.tsx`
  - Create: `client-field/src/components/PhotoTagInput.tsx`
  - Create: `client-field/src/components/ReportBuilder.tsx`
  - Modify: `client-field/src/pages/CapturePage.tsx`
  - Modify: `client-field/src/pages/ProjectDetailPage.tsx`
  - Create/modify tests under `client-field/src/**`
- CRM photo surfaces
  - Modify: `client/src/components/photos/deal-photo-components.tsx`
  - Modify: `client/src/pages/deals/deal-photos-tab.tsx`

## Phase breakdown

### Task 1: Schema foundation
- [ ] Add `photo_tags` table with unique `(photo_id, tag)` constraint, project-friendly indexes, and `created_by_user_id`.
- [ ] Add report persistence tables for generated photo reports if needed to support CRM visibility and 7-day download retention.
- [ ] Add any new photo audit event/report status enums required by the services.
- [ ] Run `npm run db:migrate` locally and verify migration `0127_*` applies cleanly.

### Task 2: Voice dictation server slice
- [ ] Reuse the call-recording MIME validation rules as the allowed input set for photo-description dictation.
- [ ] Implement `POST /api/field/photos/:photoId/transcribe-description` with field auth, photo access check, multipart audio parsing, OpenAI transcription call, description persistence, and photo audit logging.
- [ ] Keep a small pure helper for the OpenAI request so the route test can comprehensively mock the provider without real network access.
- [ ] Add focused Vitest coverage for access control, unsupported MIME, transcript success, and provider failure.

### Task 3: Voice dictation field UI
- [ ] Add a mobile-first `VoiceRecorder` component around `MediaRecorder` with permission, timer, recording state, and browser fallback messaging.
- [ ] Extend the capture session model so each staged photo can store editable description text before upload.
- [ ] Add the post-capture detail/editor surface in `CapturePage` for description text, microphone, keyboard, and future draw affordance.
- [ ] Wire transcription upload to the new endpoint and keep the returned transcript editable before commit.
- [ ] Add field app tests for recorder state, unsupported browser fallback, and transcript application.

### Task 4: Photo tags server slice
- [ ] Implement tag normalization, dedupe, replace-all writes, delete-one writes, and project-scoped autocomplete using the photo’s linked deal/project.
- [ ] Extend field photo payloads and CRM photo payloads to include `tags: string[]`.
- [ ] Add focused route/service tests for CRUD and autocomplete ordering.

### Task 5: Photo tags UI
- [ ] Add reusable tag-chip input with recent/project autocomplete and free-form entry.
- [ ] Surface tags in field capture edit flow, field gallery viewer, and CRM photo viewer.
- [ ] Add tests for chip add/remove and autocomplete selection.

### Task 6: PDF report preview/generation server slice
- [ ] Add preview JSON endpoint that groups selected photos by tag/date/none and returns editable sections.
- [ ] Build a server-side branded PDF generator using `pdf-lib`, the T Rock logo asset, and R2-backed download storage.
- [ ] Add generate endpoint, 7-day expiry metadata, and audit logging.
- [ ] Add focused PDF tests: valid bytes, cover page text, section numbering, multi-page numbering, and description wrapping.

### Task 7: Report builder UI
- [ ] Add photo selection and report builder flow in the field app from `ProjectDetailPage`.
- [ ] Support section rename/add/remove, description edits, and simple move between sections for v1.
- [ ] Keep Phase 4 public sharing deferred unless the report API lands with margin and no regressions.

### Task 8: CRM visibility + verification
- [ ] Add a CRM entry point to view generated photo reports from the deal photo surface.
- [ ] Verify field auth, upload flow, and main CRM photo display still work.
- [ ] Run focused tests, `npm run typecheck --workspace=server`, and `npm run typecheck --workspace=client-field`.

## Deferred by default

- Custom public share links (Phase 4) stay deferred unless Phases 2-3 finish without expanding the data model or rollout risk.
