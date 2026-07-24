# T-Rock Cam: virtualize the report / share photo grids

**Date:** 2026-07-24
**Surface:** `mobile` (T-Rock Cam app) — report builder + photo share
**Status:** Approved (build)

## Problem

On projects with many photos, opening **Build report** or **Share** is slow and often **crashes**
the app.

## Root cause

Both `ReportBuilder` (select step) and `PhotoShareModal` rendered **every** project photo inside a
`ScrollView` via `photos.map(...)` using React Native's **core `<Image>`**. There is no
virtualization, so opening the picker on a large gallery **mounts hundreds of `<Image>`s and decodes
all their bitmaps into memory at once** → slow, and OOM-crashes on big projects. Core `<Image>` also
re-downloads/re-decodes on remount (the "waiting on them to load again" the user reported).

Note: the images are **already thumbnails** — `listFieldProjectPhotos` sets `imageUrl` to the
server-generated thumbnail (`fullImageUrl` is the high-res original), and the report preview reuses
that same photo. So **no server change is needed**; the problem is purely client-side rendering.

## Design (mobile-only)

Extract one shared **`PhotoPickerGrid`** used by both surfaces:

- **`FlatList`** (`numColumns=3`, `windowSize`, `initialNumToRender`, `maxToRenderPerBatch`,
  `removeClippedSubviews`, `getItemLayout`) — only the visible window mounts, so a big gallery no
  longer OOMs. `flex: 1` so it fills and scrolls within the modal's bounded column.
- **`expo-image`** (already a dependency, used in `ZoomablePhoto`) with `recyclingKey={photo.id}`,
  `cachePolicy="memory-disk"`, `contentFit="cover"` — downsamples the thumbnail to the cell and
  re-displays from disk on re-open instead of re-downloading.
- Props: `photos`, `selected` (Set), `onToggle`, `cellSize`, `disabled?`, `header?`, `footer?`,
  `getAccessibilityLabel?`. Header/footer render inside the same list so the picker stays one scroll
  container (the report's "N selected / Select all" row and "Group photos" chips; the share screen's
  header + hint).

`ReportBuilder`'s edit step keeps its `ScrollView` (a small selected subset) but swaps its core
`<Image>` for `expo-image` for the same caching/memory benefit.

## Testing

`PhotoPickerGrid.test.tsx` (mobile jest / `@testing-library/react-native`): renders a cell per photo,
press → `onToggle(id)`, selection reflected via `accessibilityState`, `disabled` blocks toggling, and
— the point of the fix — **a 200-photo gallery mounts far fewer than 200 cells** (virtualization).

## Out of scope

- Server changes (`imageUrl` is already a thumbnail).
- Virtualizing the edit-step section list (it's a small selected subset; `expo-image` is enough).

## Note

Mobile-only, so it needs a fresh **EAS build** to reach TestFlight after merge. Mobile is not in the
CI premerge workspaces, so it's validated by mobile `jest` + `tsc` (476 tests + typecheck green).
