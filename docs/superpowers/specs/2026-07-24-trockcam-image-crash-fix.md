# T-Rock Cam: fix the "crashes while taking photos" (RN core Image UAF)

**Date:** 2026-07-24
**Surface:** `mobile` (T-Rock Cam app)
**Status:** Approved (build) — diagnosed from three device crash logs

## Root cause (from the crash logs)

Three `.ips` crash logs (builds 30 and 31, iOS 26.5.2, iPhone 17 Pro Max) are all identical:

- `EXC_BAD_ACCESS (SIGSEGV)`, `KERN_INVALID_ADDRESS at 0x10`
- queue `com.meta.react.turbomodulemanager.queue`
- top frame `facebook::react::ImageResponseObserverCoordinator::nativeImageResponseProgress(...)`
  under `-[RCTImageManager requestImage:surfaceId:]`

This is a **use-after-free in React Native's New-Architecture (Fabric) image pipeline**: an async
image-load progress callback fires after the image component/observer was freed. It's triggered by RN
**core `<Image>`** components loading images while they mount/unmount rapidly — i.e. capturing photos
(recent strip, per-shot caption, review tray all churn) and scrolling the gallery. That's the real
"crashes while taking photos."

The build-#31 report/share virtualization fix moved *those* grids to `expo-image`, but five other
image surfaces still used RN core `<Image>`, so the crash persisted.

## Fix

Migrate every remaining RN core `<Image>` render of a photo to **`expo-image`** (already the app's
image library — `ZoomablePhoto`, `PhotoPickerGrid`, `ReportBuilder`). `expo-image` has its own native
pipeline and never touches `RCTImageManager` / `ImageResponseObserverCoordinator`, so it **bypasses the
crashing code path entirely** — the standard fix for this RN Fabric crash. It also downsamples +
disk-caches, and `recyclingKey` makes churning lists/strips safe.

Migrated (with `contentFit`, `recyclingKey`, `cachePolicy="memory-disk"`):

| File | Surface | Active during |
|---|---|---|
| `capture/CameraCapture.tsx` | recent-shots strip | capturing |
| `components/PhotoCaptionEditor.tsx` | per-shot caption photo | capturing |
| `components/ReviewTray.tsx` | review grid | after capture |
| `components/PhotoGrid.tsx` | project gallery | viewing |
| `components/ScorecardDetailView.tsx` | signature + evidence grid | viewing |

## Testing

Full mobile suite green (46 suites / 483 tests), `tsc` clean. Existing component tests give regression
coverage; added/updated **"is expo-image" guards** (array-normalized `source` + `cachePolicy`) on
`PhotoGrid` (new test — the untested primary surface), `ScorecardDetailView`, `ReviewTray`, and
`PhotoCaptionEditor`, so a silent revert to core `<Image>` (which re-introduces the crash) fails.

## Notes

- Mobile-only → needs a fresh **EAS build** (32) + TestFlight submit after merge.
- The pre-log hypothesis (camera-roll backup / compress-on-enqueue) was wrong; the crash logs settled
  it as the RN Fabric image UAF.
