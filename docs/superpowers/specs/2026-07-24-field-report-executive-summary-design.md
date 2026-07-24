# Executive summary on the web field report builder

**Date:** 2026-07-24
**Surface:** `client-field` (T-Rock Cam field web app) — the photo report builder
**Status:** Approved design

## Problem

The web field report builder (`client-field/src/components/ReportBuilder.tsx`) lets a
user pick photos, edit a cover + sections, and generate a branded PDF. It has **no way
to add an executive summary** — a short narrative that summarizes the report. The mobile
app already offers this, and the generated PDF already renders a summary page when one is
supplied; the web builder is the only surface that can't provide it.

## Key finding: the backend and the mobile app already support this

- **Server accepts it.** `POST /field/reports/generate` reads `req.body.executiveSummary`
  (`server/src/modules/field/routes.ts`). `photo-reports-service.ts` trims it, caps it at
  **5000 chars**, and passes `null` when blank.
- **Server renders it after the cover.** `pdf-layout.ts` `drawExecutiveSummaryPages()`
  draws the summary page(s) immediately after the cover, before the photo sections.
- **Mobile already sends it** (`mobile/src/components/ReportBuilder.tsx` +
  `report-builder-request.ts`): trimmed, `null` when blank.
- **Web already has voice transcription infra.** `client-field/src/components/VoiceRecorder.tsx`
  (self-contained mic → transcript) and `lib/photo-dictation.ts`
  (`getVoiceTranscriptionConfig()` probe + `transcribeDescriptionAudio()`), already used on
  `CapturePage.tsx`, backed by `POST /field/photos/transcribe-description` (Whisper).

**Therefore this is a `client-field`-only change. No server change, no migration.**

## Decisions (confirmed with the user)

- **Placement:** summary appears **after the cover page, before the photo sections** — matches
  what the server already renders and the mobile app. No server change.
- **Input:** **typing + voice dictation** — reuse the existing `VoiceRecorder` + config probe.

## Design

Reuse existing infrastructure (Approach A). Rejected alternatives: extracting a shared
`<DictationTextArea>` (refactor for a single new caller — YAGNI), and the browser Web Speech
API (Safari-flaky, diverges from the app's Whisper transcription).

### UI — edit step

A new **"Executive summary"** card in the edit step, placed **after the cover fields**
(title / creator / date / company) and **before the sections list**:

- Label + helper text: *"Optional — a short overview shown after the cover page."*
- A `<textarea>` bound to new `executiveSummary` state, `maxLength={5000}`, with a live
  `N / 5000` counter.
- A `<VoiceRecorder>` rendered **only when transcription is configured**. Its `onTranscript`
  **appends** to the existing text (space-joined, trimmed), clamped to 5000 chars — matching
  `CapturePage`. Disabled while a PDF is generating.

### State & effects

- `executiveSummary: string` (default `""`), reset in the existing `isOpen` reset effect.
- `voiceConfigured: boolean` (default `false`), set from `getVoiceTranscriptionConfig()` in an
  effect keyed on `isOpen`. The mic is never rendered unconditionally (mirrors `CapturePage`;
  a stale/failed probe simply hides the mic and typing still works).

### Payload

In `generateReport()`, add a top-level field to the POST body:

```
executiveSummary: executiveSummary.trim() ? executiveSummary.trim() : null
```

Matches mobile's `buildGenerateReportRequest` and the server's trim/`null` semantics
(blank ⇒ no summary page).

### Safety

**"Generate PDF" is blocked while a dictation is still transcribing**, so a slow transcript
can't be dropped by an early generate. (Mobile guards this; we mirror it.) Implemented by
adding an **optional** `onBusyChange?: (busy: boolean) => void` prop to `VoiceRecorder` that
fires whenever it starts/stops recording or transcribing. `ReportBuilder` tracks a
`summaryDictating` flag from that callback and disables **Generate PDF** while it is true.
The prop is optional and backward-compatible — `CapturePage` doesn't pass it, so its behavior
is unchanged.

## Testing (`ReportBuilder.test.tsx`)

- A typed summary appears (trimmed) in the `/field/reports/generate` payload.
- A blank / whitespace-only summary sends `executiveSummary: null`.
- A voice transcript **appends** to the existing summary text (space-joined).
- The mic is **hidden** when `configured: false` and **shown** when `configured: true`.
- The summary is **clamped to 5000 chars** (append path, not just the `maxLength` attribute).

The test file mocks `../lib/photo-dictation` (to control the config probe deterministically)
and the `./VoiceRecorder` child (to fire `onTranscript` without a real `MediaRecorder`, which
jsdom lacks). This keeps the existing `apiMock` call ordering (preview = call 1, generate =
call 2) intact. `ReportBuilder.test.tsx` runs in CI via `client-field/vitest.ci.config.ts`.

## Out of scope

- Server / PDF changes (already implemented).
- End-of-report placement (user chose after-cover).
- Persisting the summary as a reusable draft (the builder is ephemeral today).
