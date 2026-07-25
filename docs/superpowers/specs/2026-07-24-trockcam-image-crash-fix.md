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

Precisely, in `ImageResponseObserverCoordinator.cpp`:

```cpp
mutex_.lock();
auto observers = observers_;   // copy of a vector of RAW ImageResponseObserver*
mutex_.unlock();
for (auto observer : observers) {
  observer->didReceiveProgress(progress, loaded, total);   // observer may already be destroyed
}
```

The coordinator itself is safe (the callback holds it via `weak_ptr::lock()`); it is the **observers**
that dangle. Any core `<Image>` unmounting inside that unlocked window can fault.

The build-#31 report/share virtualization fix moved *those* grids to `expo-image`, but **eleven** other
image surfaces still used RN core `<Image>`, so the crash persisted.

## Fix

Migrate every remaining RN core `<Image>` render of a photo to **`expo-image`** (already the app's
image library — `ZoomablePhoto`, `PhotoPickerGrid`, `ReportBuilder`). `expo-image` has its own native
pipeline and never touches `RCTImageManager` / `ImageResponseObserverCoordinator`, so it **bypasses the
crashing code path entirely** — the standard fix for this RN Fabric crash. It also downsamples +
disk-caches, and `recyclingKey` makes churning lists/strips safe.

Migrated (with `contentFit`, and for photo surfaces a stable `recyclingKey` +
`cachePolicy="memory-disk"`):

| File | Surface | Active during |
|---|---|---|
| `capture/CameraCapture.tsx` | recent-shots strip | capturing |
| `components/PhotoCaptionEditor.tsx` | per-shot caption photo | capturing |
| `components/ReviewTray.tsx` | review grid | after capture |
| `components/PhotoGrid.tsx` | project gallery | viewing |
| `components/ScorecardDetailView.tsx` | signature + evidence grid | viewing |
| `app/(app)/capture.tsx` | pending-captures strip | capturing |
| `app/(app)/scorecards/[draftId].tsx` | draft evidence thumbs | capturing |
| `app/(app)/scorecards/leadership/[draftId].tsx` | draft evidence thumbs | capturing |
| `app/(app)/scorecards/corrective-action/[id].tsx` | response photo thumbs | documenting a fix |
| `app/(app)/scorecards/corrective-action/[id].tsx` | resolved item photos | viewing |
| `components/BrandLogo.tsx` | header brand mark | every screen |

`recyclingKey` is `photo.key` / `photo.id`, deliberately **not** `photo.uri` — a retained scorecard photo's
presigned URL rotates on every editor resume, which would blank each thumb on refresh. The handwritten
signature in `ScorecardDetailView` keeps `cachePolicy="memory"`: it is personal data arriving as a `data:`
URI, and there is no signature-scoped disk-cache cleanup.

### Two corrections to the first pass

1. **The first sweep covered `mobile/src` only.** Five core `<Image>` renders survived in the `mobile/app`
   expo-router route files. That included `capture.tsx`'s pending-captures strip, which re-renders as
   uploads land — so the literal reported symptom was still reachable after the first five migrations.
2. **`BrandLogo` was wrongly exempted as "a synchronous bundled `require()` asset".** That premise is false
   on Fabric: `RCTImageManager::requestImage` `dispatch_async`es *every* request onto its background serial
   queue, and `RCTBundleAssetImageLoader` still fires `progressHandler(1, 1)` from there — reaching the same
   coordinator. `ScreenHeader` mounts the logo on the capture and tab screens, so it unmounts on every
   navigation. Narrow window, same race, nearly every screen. There is now **no allowlist at all**.

## Testing

Full mobile suite green at the time of this change (**48 suites / 537 tests**), `tsc` clean. (A point-in-time
count, recorded as evidence for this dated record — it is expected to drift as tests are added.)

Per-component **"is expo-image" guards** (array-normalized `source` + `cachePolicy`) on `PhotoGrid` (new
test — the untested primary surface), `ScorecardDetailView`, `ReviewTray`, and `PhotoCaptionEditor`, and a new `BrandLogo` test (it had none) covering the expo-image swap,
`contentFit`, the dark/light surface mark selection, and the grouped-VoiceOver label.

Those only lock components that already have a test, which is exactly how the route files slipped through —
and `mobile/app` route files have no render tests at all. So the real lock is
`src/__tests__/no-core-rn-image.test.ts`, a **tree-wide invariant**: it parses every source file under
`app/` and `src/` with the TypeScript compiler and fails on any route to the core component — named
imports (incl. aliases), destructured and member `require`/dynamic-`import` forms, deep subpaths like
`react-native/Libraries/Image/Image`, re-export barrels, `Animated.Image` matched on the local binding,
`createAnimatedComponent(Image)` when the argument really is a core binding, and `RN.Image` /
`RN["Image"]` / `RN.Animated.Image` through a namespace, default or re-bound module local.

It parses rather than greps because the regex version leaked five separate ways, every one found by
review rather than by the guard — culminating in a fail-OPEN design flaw where an unparseable specifier
was silently dropped, so a single comment inside an import list disarmed it. Text matching also produced
the mirror failure, flagging an `Image` that appeared only in a comment. Against a syntax tree both
classes disappear: comments are trivia, aliases and binding forms are structure, formatting is irrelevant.
An adversarial audit then generated 43 candidate evasions and executed each against the implementation;
everything it confirmed is now covered and pinned by a self-test. It **self-tests** each detection route against a literal offending
snippet, plus negative cases. It also splices `Image` into the react-native import of EVERY real file in
the tree and requires the guard to fire on each — because a parser that silently fails on our actual file
shapes reports zero offenders just like a clean tree does, and synthetic snippets cannot detect that.

## Notes

- Mobile-only → needs a fresh **EAS build** (32) + TestFlight submit after merge.
- The pre-log hypothesis (camera-roll backup / compress-on-enqueue) was wrong; the crash logs settled
  it as the RN Fabric image UAF.
- This is an app-layer workaround for an RN core Fabric defect present in 0.81.5. If RN ever fixes the
  lock-free observer iteration, the guard can relax — until then, treat "core `<Image>` anywhere" as a bug.
