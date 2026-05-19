# Unified Capture Phases 2-4

## Scope
- Phase 2: voice dictation for photo descriptions
- Phase 3: free-form photo tags
- Phase 3: branded PDF photo reports
- Phase 4: public share links deferred unless the branch remains clean after Phases 2-3

## Audit notes
- Field photo uploads already run through `server/src/modules/field/photos-service.ts` and `client-field/src/lib/capture-upload.ts`
- Field gallery is `client-field/src/pages/ProjectDetailPage.tsx`
- CRM photo surface is `client/src/pages/deals/deal-photos-tab.tsx`
- Existing audio MIME handling lives in `server/src/modules/call-recordings/service.ts`
- No live PDF generation module exists in `server/src`; new report PDF generation will be added server-side
- Available logo assets:
  - `TRock-construction-logo_no-mc.webp`
  - `client/public/logo.png`

## Immediate next steps
1. Phase 2 is in place:
   - `POST /api/field/photos/transcribe-description` for capture-session dictation
   - `POST /api/field/photos/:photoId/transcribe-description` for persisted photos
   - capture-session description editor with `VoiceRecorder`
2. Phase 3 tags are partially in place:
   - `photo_tags` migration + schema
   - tag replace/delete/autocomplete field endpoints
   - capture-session `PhotoTagInput` and post-upload tag sync
3. Remaining work:
   - expose tags in project detail + CRM photo viewers more fully
   - add PDF report data model, preview, generation, and UI
   - decide whether Phase 4 public sharing stays deferred
