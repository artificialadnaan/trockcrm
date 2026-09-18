# Build Report — 2 photos per page (design)

**Date:** 2026-08-18
**Requested by:** Adnaan Iqbal
**Ask:** *"the build report feature on trockcam.com and on trock cam app needs to put 2 images per page instead of the formatting it is now. the photos are too small and cant be seen in the report"*

## Current state

`server/src/modules/field/pdf-layout.ts` (confirmed against `origin/main`) renders the standard field photo report — reached as **"Build Report"** on the T-Rock Cam mobile app (`mobile/app/(app)/projects/[id].tsx`, `mobile/src/components/ReportBuilder.tsx`) and **"Generate Report"** on the trockcam.com web app (`client-field/src/components/ReportBuilder.tsx`). Both surfaces call the same two server endpoints (`/field/reports/preview`, `/field/reports/generate`) and receive the same server-rendered PDF — **neither has its own client-side grid rendering**, so this one file change covers both surfaces the request names.

There is a **second, separate** report layout — the AI Report's `photoLayout: "findings"` mode (already 1 photo/page, full width, with bulleted findings) — reached via a distinct "AI Report" action in the same mobile modal. **Out of scope**: this spec only touches the standard grid layout ("grid" mode, the default).

### Current grid constants (exact, from `pdf-layout.ts`)

```
PAGE_WIDTH = 612, PAGE_HEIGHT = 792, PAGE_MARGIN = 32
CONTENT_WIDTH = 548
PHOTO_COLUMNS = 2
PHOTO_ROWS_PER_PAGE = 4        →  PHOTOS_PER_PAGE = 8
COLUMN_GAP = 20
COLUMN_WIDTH = 264              (per column, shared by tile + caption)
PHOTO_ROWS_TOP = 72, PHOTO_ROWS_BOTTOM = 740, PHOTO_ROW_GAP = 14
PHOTO_ROW_PITCH = 170.5  →  PHOTO_TILE_HEIGHT = 156.5
PHOTO_TILE_WIDTH = 148
CAPTION_GAP = 10  →  CAPTION_WIDTH = 106   (caption sits BESIDE the tile, in the leftover column width)
```

The image is drawn **contain, then centred** inside the fixed 148×156.5pt tile (`drawPhotoEntry`, `pdf-layout.ts:636-754`) and clipped to it. This is a deliberate, pre-existing choice, stated in the code's own comment:

> *"Contain, then centre. NOT cover: this is an evidence document, and filling the tile would silently crop the edges off the thing being photographed."*

## The measured problem

Extracted and measured directly from a real report (`La Serena Photo Report`, generated 2026-08-18, 4 photos) via `pdfimages -list`:

- All 4 embedded photos: **884 × 1920px — aspect ratio 0.4604:1**. This is far narrower than a normal iPhone photo (3:4 = 0.75:1); it's close to the phone's *screen* aspect ratio, not the camera sensor's. These photos are dated Jul 21, 2026 — 10 days before PR #1024 (2026-07-31), which fixed a T-Rock Cam camera bug that cropped every capture to the preview layer's aspect instead of the sensor's native 4:3. These look like an artifact of that pre-fix bug, though this is not confirmed and is **not** part of this spec (see "Explicitly out of scope" below).
- At today's 148×156.5pt tile, a 0.46:1 photo contain-fits **HEIGHT-bound**: it renders **72 × 156.5pt** — a 72pt-wide strip. (An earlier draft of this spec said 148×322; that was wrong and impossible, since a contain-fit photo cannot be taller than its 156.5pt tile. Corrected after a review challenged the arithmetic. The error understated the problem — the photos are smaller than first stated, not larger.)

### Why "just reduce rows per page" is not sufficient on its own

`PHOTO_TILE_WIDTH` (148) and `PHOTO_TILE_HEIGHT` (derived from row count) are independent constants, and **both** have to change.

Growing height alone is not enough: at 148pt wide, a 0.46:1 photo that gets more vertical room becomes width-bound at 148pt and stops there — 148pt is still far too narrow, which is the actual complaint. Growing width alone is not enough either: at 156.5pt tall the photo stays height-bound at 72pt wide no matter how wide the tile gets. Only widening the tile **and** giving it the height to use that width moves the rendered image, and the width can only come from the space the caption currently occupies beside it.

Fixing width requires moving the caption from **beside** the tile to **below** it, so the tile can use the column's full width rather than sharing it with a caption column.

## Approaches considered and rejected

**Cover-fit / crop to fill the tile (rejected).** Tested directly against this report's real photos: two of the four are documenting **ceiling water damage** (a visible stain/mold patch in the top third of the frame). Simulating a crop aggressive enough to make the tile meaningfully bigger removes the damage from frame — the exact thing the photo exists to prove. There is no fixed crop percentage safe across construction condition photos in general: the subject is sometimes at the top (ceiling damage), sometimes at the bottom (floor-level debris), sometimes at a side edge (a doorway). This is also independently confirmed by the code's own existing "NOT cover" comment above — the codebase already made this call for the same reason before this spec existed.

**Stretch-to-fill (rejected).** Fills the tile with no crop, but visibly distorts proportions (a doorway would render roughly 2× too wide in the narrow-photo case). Ruled out on inspection — a documentation photo that looks factually wrong defeats its purpose.

**1 column, stacked full-width (considered, not chosen).** For a *height-bound* photo, extra width beyond `tile_height × aspect_ratio` is wasted — so for these specific narrow photos, a full-width single column gives no visible size benefit over keeping 2 columns, while fitting only half as many distinct photos per page for the same total page count. 2 columns is the smaller, more page-efficient change and was chosen instead.

## The design

**Contain-fit is kept, unconditionally — no cropping, ever.** This is the one non-negotiable constraint: the report is used as documentation/evidence (corrective actions, QC), and nothing may be silently removed from a photo.

| | Today | Proposed |
|---|---|---|
| `PHOTO_ROWS_PER_PAGE` | 4 | **1** |
| `PHOTOS_PER_PAGE` | 8 (2×4) | **2** (2×1) |
| `PHOTO_TILE_WIDTH` | 148 | **256** (`COLUMN_WIDTH` is 264; 8pt left as a breathing margin — caption no longer needs side space) |
| `PHOTO_TILE_HEIGHT` | 156.5 | **560** (calibrated to the dominant narrow-photo case, see below — NOT simply `PHOTO_ROW_PITCH − PHOTO_ROW_GAP`; that formula has no term for a caption reserved below it and needs restructuring) |
| Caption position | beside tile, in the 106pt leftover column width | **below tile**, using ~full tile width, in the ~122pt reserved below (`PHOTO_ROW_PITCH` at 1 row = 682pt, minus the 560pt tile) |
| Fit mode | contain | contain (unchanged) |

These numbers are not round guesses — 560 is chosen because a 256pt-wide tile renders a 0.4604:1 photo (the exact ratio measured from this report's 4 photos) at **256 × 556pt** (width-bound; box aspect 256/560 ≈ 0.457 is nearly identical to 0.4604), leaving only **~4pt** of combined letterbox at that specific ratio. Going *taller* than 560 buys that case nothing further (it's already width-bound, so extra tile height beyond ~556pt just sits empty) while taking room away from the caption, which is why 560 rather than the full ~610pt otherwise available. That's **~12.6× the visible photo area** versus today's 72×156.5pt render (11,277 → 142,341 pt²), for a photo at exactly this ratio — computed, not estimated. The four measured photos all shared this ratio, but four photos from one report is not proof every narrow capture lands on exactly 0.4604; treat 560 as a well-reasoned starting point, not a value to defend to the pixel — the verification step below checks it against a real render before treating it as final. A normal 3:4 portrait photo goes from 117×156.5 to 256×341. A 4:3 landscape photo goes from 148×111 to 256×192 — the one orientation that was already width-bound at the old tile.

### What moves in `drawPhotoEntry` (`pdf-layout.ts:636-754`)

- Tile drawing, image contain/clip logic: **unchanged in shape**, automatically flows through once `PHOTO_TILE_WIDTH`/`PHOTO_TILE_HEIGHT` change, since both are already parameterized as `boxWidth`/`boxHeight` from those constants.
- Index badge (`drawIndexBadge`): stays at the tile corner, unaffected.
- Caption block (metadata lines — date, uploader, project name when it differs from the report's — plus the optional free-text description/finding, currently rendered bottom-anchored to the RIGHT of the tile): moves to **below** the tile. Same content, same relative order (description above metadata, metadata at the bottom of the block) — only the position changes. `CAPTION_WIDTH` becomes based on the new (wider) tile width rather than the leftover column sliver.

### Consequence to state plainly

**4× more pages for the same photo count** (8→2 per page). The La Serena example (4 photos) goes from 1 photo page to 2. A 20-photo report goes from 3 pages to 10. This is the direct, expected trade of the original ask.

## Bundled minor fix

Two comments are already stale and would become more wrong after this change — both found during research, both adjacent to what's being touched:

- `server/src/modules/field/photo-reports-service.ts` (~line 267): says "keeps the 3-per-page grid" — already wrong (it's 8 today), will be wrong differently after (2).
- `mobile/src/components/ReportBuilder.tsx` (~line 499): says "PDF prints 3 photos per page" — same.

Both corrected to describe the shipped behavior at merge time.

## Existing tests that will need updating

Found via `git ls-tree` + targeted reads against `origin/main`; these are not exhaustive but are the ones directly keyed to the constants and pixel math this spec changes:

- **`server/tests/modules/field/photo-report-pdf-layout.test.ts`**
  - `"a single section of 4 photos is COVER + one photo page"` — asserts `countPdfPages === 2` (cover + 1 photo page, since 4 photos fit in one 8-per-page sheet today). Under 2/page, 4 photos span **2 photo pages**, so this becomes `countPdfPages === 3`. Same for the sibling "corrupt photo" test using the same 4-photo fixture.
  - `"packs EIGHT photographs onto a page, two cells across"` — its whole premise (8/page, 9-photo boundary) is being replaced. Needs an analogous boundary test at the new chunk size: 2 photos → 1 page, 3 photos → 2 pages.
  - `"lays the two cells of a row out side by side..."` — asserts exact tile-left x-origins (`32`, `32+264+20=316`, unaffected — column geometry doesn't change) **and** `distinct[1] + 148 <= 612 - 32` (the right tile's edge check) — the `148` must become the new `PHOTO_TILE_WIDTH` (256). At 256, `distinct[1] + 256 = 316 + 256 = 572`, which must stay `≤ 580` (`612 − 32`) — it does, with 8pt to spare.
- **`server/src/modules/field/pdf-layout.test.ts`** and **`server/tests/modules/field/pdf-layout.test.ts`** — exist, not yet read for constant-specific assertions; check during implementation.
- **`server/tests/modules/field/photo-reports-service.test.ts`** — check for any assertion referencing the stale "3-per-page"/8-per-page comment context or page-count expectations tied to the old chunk size.

## Verification approach

Matching this codebase's established practice for this exact file (PR #1022/#1023: *"parse the artifact, don't eyeball it"* — every prior layout decision here was settled by running `pdfimages`/`pdftoppm` against a real rendered PDF, not by reading the code and assuming):

1. Generate a real report through the actual render path (not just unit-test buffers) using photos with a mix of aspect ratios — including the narrow 0.46:1 case, since that's the one this spec is built around.
2. `pdfimages -list` / `pdftoppm` the output and confirm actual rendered tile dimensions match the target numbers above (or close, allowing for final constant tuning during implementation).
3. Confirm zero cropping — the full source image is present in the rendered tile (letterboxed, not clipped) for at least one photo of each orientation (narrow, normal portrait, landscape).
4. Confirm page count matches the new chunking math for a few concrete photo counts (2, 3, 4, 9) — the same style of boundary-proof the existing "8 photos" test used.

## Explicitly out of scope

- The AI Report's separate "findings" (1-photo/page) layout — untouched.
- Caption *content* — same fields shown today (date, uploader, project name when it differs, optional description/finding text); only position changes.
- Whether new (post-#1024-fix) captures still produce 0.46:1-ratio photos — a separate, optional investigation Adnaan may want run independently; not a dependency of this layout change, which is designed to degrade gracefully across any aspect ratio.
- Report page orientation (kept portrait) and any redesign of the cover/executive-summary pages.
- A user-facing "photos per page" setting — this spec hardcodes the new value; no UI control is added.
