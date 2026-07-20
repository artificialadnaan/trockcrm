# TRockCam: camera-roll backup + faster uploads — design

**Date:** 2026-07-20
**Status:** Approved (design); pending spec review before planning
**Area:** `mobile/` (React Native / Expo — TRockCam field app)

## Problem

1. **Uploads feel slow.** Each captured photo is compressed to a 4032px / 0.92 JPEG at **upload (drain) time** (`mobile/src/capture/upload.ts` → `compressForUpload` in `mobile/src/capture/compress.ts`), on the JS thread, per photo. Full-resolution originals sit in the durable upload queue until drain. A batch therefore triggers a burst of concurrent decode/encode work (5 upload workers) plus large on-disk I/O — the "slow upload" the field crews feel. Uploads are already concurrent (5 workers) and binary (no base64), so those are not the bottleneck.

2. **No on-device backup.** When a crew takes a photo, the only copy is the CRM upload. There is no copy in the phone's camera roll as a safety net.

## Goals

- Save every captured photo to the device **camera roll** as a **full-resolution original** backup, the moment the shutter fires.
- Make it a **user setting, default ON** (crews can opt out of mirroring jobsite photos into their personal roll).
- **Speed up uploads** by moving the 4032/0.92 compression **off the upload path** to just after capture, **without lowering CRM image quality** (unchanged 4032/0.92).

## Non-goals (explicit decisions)

- **No dedicated album** — save to the main camera roll (`saveToLibraryAsync`), not a "T-Rock Cam" album.
- **No CRM quality reduction** — the uploaded image stays 4032/0.92; we do not shrink it for network speed.
- **No save-after-upload** — the camera-roll copy is written at capture, independent of upload success (it is a true backup).

## Design overview

Both changes anchor at the capture moment. The **original** photo goes to the camera roll (full-res); a **compressed** copy is what enters the durable upload queue.

### Capture flow (after this change)

1. `takePictureAsync({ quality: 1, exif: true })` → **original** URI (full-res, EXIF/GPS intact).
2. **Fire-and-forget:** `saveOriginalToCameraRoll(originalUri)` — only if the setting is ON and write-only permission is granted. Never blocks the shutter; never fails capture or upload.
3. **Background enqueue** (already fire-and-forget in the current code): `compressForUpload(originalUri)` → 4032/0.92 JPEG → the **compressed** bytes are copied into the durable queue / review-draft. The drain then does a pure network PUT.

Net effect: the camera roll keeps the pristine original (EXIF/GPS intact); the CRM receives the identical 4032/0.92 image it does today; and compression cost is spread across shooting instead of bursting at upload.

### Why EXIF/GPS is unaffected

`compressForUpload` (ImageManipulator) already strips EXIF today; the app extracts GPS/EXIF separately (`mobile/src/capture/metadata.ts`) and sends GPS in the `confirm-upload` step. Moving compression earlier does not change that. The camera-roll copy is the **original** (`photo.uri`), so it retains EXIF/GPS.

## Components (each small, single-purpose, testable)

### 1. Dependency + permission
- Add `expo-media-library` to `mobile/package.json` and its plugin to `mobile/app.config.ts`.
- The iOS `NSPhotoLibraryAddUsageDescription` string is **already declared** in `app.config.ts`.
- Request **write-only / add-only** permission (`MediaLibrary.requestPermissionsAsync(true)` on iOS 14+) — least privilege; we only add, never read.

### 2. `mobile/src/capture/camera-roll.ts` — the save unit
- **Interface:** `saveOriginalToCameraRoll(uri: string): Promise<void>`.
- **Behavior:** returns immediately if the setting is OFF; otherwise ensures write-only permission (lazily requested, result cached in memory); on grant, calls `MediaLibrary.saveToLibraryAsync(uri)`. **Best-effort** — catches and logs any error, never throws to the caller.
- **Depends on:** `expo-media-library`, the settings module (§3).
- **Tested with:** mocked MediaLibrary + settings — saves when ON+permitted; skips when OFF or permission denied; never throws.

### 3. Settings — the toggle
- A "Save photos to camera roll" preference, **default ON**.
- **Persistence:** the existing `expo-secure-store` (already a dependency — no new package), keyed e.g. `settings.saveToCameraRoll`. A tiny `mobile/src/settings/` module wraps get/set with an in-memory cache loaded at app start, so capture reads the value synchronously.
- **UI:** a toggle row on the existing `mobile/app/(app)/profile.tsx` screen.
- **Tested with:** mocked secure-store — defaults ON when unset; round-trips a set value.

### 4. Compress-on-enqueue — the perf fix
- Move the `compressForUpload` call out of the drain (`mobile/src/capture/upload.ts` `uploadCapture`) and into the **background enqueue / review-draft stage path**, so the durable queue stores the **compressed** bytes (also shrinks the on-disk footprint).
- The stored photo record carries a `compressed: boolean` marker. The drain compresses **only** an item marked `compressed: false` — covering (a) in-flight queue items enqueued by the current app version before this change, and (b) any enqueue-time compression failure (see error handling). So compression happens **at most once**, preferring enqueue-time.
- `mobile/src/capture/compress.ts` is **unchanged** (same 4032/0.92).

### 5. Wiring
- One call added at the capture hook (`mobile/src/capture/CameraCapture.tsx`, just after `takePictureAsync`, or in the `onCameraCapture` handler in `mobile/app/(app)/capture.tsx`): fire-and-forget `saveOriginalToCameraRoll(photo.uri)`.
- The existing enqueue path (`streamPhoto` for per-photo mode, `stageReviewPhoto` for batch mode) gains the compression step (§4).

## Error handling

- **Camera-roll save:** best-effort. Permission denied → skip silently (at most a one-time toast). Any failure is logged; capture and upload are unaffected. A denied/undetermined permission never blocks capture.
- **Enqueue compression failure:** fall back to storing the **original** with `compressed: false`; the drain compresses it (today's behavior). No photo is ever lost or dropped.
- **Setting read failure:** treat as the default (ON) so a storage hiccup never silently disables the backup.

## Data flow summary

```
takePictureAsync (quality 1, EXIF)  ──► original URI (full-res, EXIF/GPS)
        │
        ├─(fire-and-forget, if setting ON + write perm)─► MediaLibrary.saveToLibraryAsync ─► main camera roll (ORIGINAL)
        │
        └─(background enqueue)─► compressForUpload (4032/0.92) ─► durable queue/draft {uri: compressed, compressed: true}
                                                                          │
                                                                   drain: pure PUT (no compress)  ──► CRM / R2
                                                                   (legacy compressed:false → compress at drain, fallback)
```

## Testing

- **`camera-roll.ts`** (unit, mocked MediaLibrary + settings): saves when ON+permitted; skips when OFF; skips when permission denied; never throws on MediaLibrary error.
- **settings** (unit, mocked secure-store): defaults ON when unset; persists a toggle.
- **compress-on-enqueue** (unit): enqueue stores `compressed: true` bytes and the drain does NOT re-compress; a legacy `compressed: false` item still compresses at drain (fallback); enqueue-compression failure stores the original as `compressed: false`.

## Rollout notes

- New native dependency (`expo-media-library`) → requires a new EAS build (ship off the feature branch to TestFlight for verification, per the team's EAS flow).
- Migration: in-flight durable-queue items from the current app version have no `compressed` marker → treated as `compressed: false` → compressed at drain (safe, unchanged behavior). No queue reset needed.

## Open implementation anchors (confirm during implementation)

The exploration read a working tree behind `origin/main`; exact line numbers are approximate. Confirm on the feature branch: the `takePictureAsync` site in `CameraCapture.tsx`, the `onCameraCapture` / `streamPhoto` / `stageReviewPhoto` enqueue points in `capture.tsx`, and the `compressForUpload` call site in `upload.ts`.
