# Build Report 2-Photos-Per-Page Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make photos in the standard field photo report ("Build Report" on the T-Rock Cam app, "Generate Report" on trockcam.com) roughly 12× larger in visible area by going from 8 photos per page to 2, widening the tile, and moving each caption from beside its photo to below it.

**Architecture:** One server-side renderer (`server/src/modules/field/pdf-layout.ts`) produces the PDF for both surfaces — neither the mobile app nor the web app renders its own photo grid, so changing this single file changes both. The change is: `PHOTO_ROWS_PER_PAGE` 4→1, `PHOTO_TILE_WIDTH` 148→256, `PHOTO_TILE_HEIGHT` (currently derived) →560 fixed, and the caption block in `drawPhotoEntry` relocated from the right of the tile to underneath it. Contain-fit (no cropping) is preserved exactly — it is a deliberate evidence-document constraint.

**Tech Stack:** TypeScript, PDFKit, Vitest. Spec: `docs/superpowers/specs/2026-08-18-build-report-2up-photo-layout-design.md`.

---

## Context an engineer new to this code needs

**Read the spec first.** It explains *why* cropping is forbidden here (this report is used as QC/corrective-action evidence; two photos in the motivating report document ceiling water damage in the top third of frame, which any crop aggressive enough to help would remove).

**Working directory:** all commands assume the worktree `/Users/adnaaniqbal/developer/trockcrm/.worktrees/build-report-2up` on branch `feat/build-report-2up-layout`. `npm install` and `npm run build --workspace=shared` have already been run there. If you start from a *fresh* worktree, run both first — otherwise `shared` silently resolves to the main checkout and tests validate the wrong branch's code.

**Test commands (this matters):** `cd server && npx vitest run` uses a different config than CI and **skips files the gate runs**. Always use the CI config:

```bash
cd server && npx vitest run --config vitest.ci.config.ts <path>
```

**How the layout works today.** The photo page is a grid of identical *cells*. Each cell = one grey rounded tile with the photo letterboxed inside it, plus a caption/metadata block. Cell positions come from `PHOTO_COLUMNS` (across) and `PHOTO_ROWS_PER_PAGE` (down), computed in the page loop at `pdf-layout.ts:1129-1142`. The tile and caption are drawn by `drawPhotoEntry` (`pdf-layout.ts:636-754`), which receives the cell's top-left `(left, top)`.

**Current geometry (verified against the file):**
```
PAGE_WIDTH=612  PAGE_HEIGHT=792  PAGE_MARGIN=32   CONTENT_WIDTH=548
PHOTO_COLUMNS=2  PHOTO_ROWS_PER_PAGE=4  →  PHOTOS_PER_PAGE=8
COLUMN_GAP=20    COLUMN_WIDTH=264
PHOTO_ROWS_TOP=72  PHOTO_ROWS_BOTTOM=740  PHOTO_ROW_GAP=14
PHOTO_ROW_PITCH=170.5  PHOTO_TILE_HEIGHT=156.5  PHOTO_TILE_WIDTH=148
CAPTION_GAP=10  CAPTION_WIDTH=106   (caption sits to the RIGHT of the tile)
```

**Target geometry:**
```
PHOTO_ROWS_PER_PAGE=1  →  PHOTOS_PER_PAGE=2   PHOTO_ROW_PITCH=682
PHOTO_TILE_WIDTH=256   PHOTO_TILE_HEIGHT=560  (fixed, NOT derived from pitch)
CAPTION_GAP=10 (now vertical)   CAPTION_WIDTH=256 (full tile width)
caption block occupies the 122pt between tile bottom (72+560=632) and the next row start (~98pt usable after CAPTION_GAP + PHOTO_ROW_GAP)
```

**Do NOT change:** `PHOTO_COLUMNS` (stays 2), the contain-fit/clip logic, the index badge, the `"findings"` layout (AI Report — separate code path, 1 photo/page already), caption *content*.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `server/src/modules/field/pdf-layout.ts` | The only PDF renderer; owns all layout constants and `drawPhotoEntry` | **Modify** — constants (lines ~35-88) and the caption half of `drawPhotoEntry` (lines ~707-754) |
| `server/tests/modules/field/photo-report-pdf-layout.test.ts` | Page-count + cell-geometry guards | **Modify** — 4 assertions coupled to the old numbers |
| `server/src/modules/field/photo-reports-service.ts` | Report data prep | **Modify** — one stale comment only (~line 267) |
| `mobile/src/components/ReportBuilder.tsx` | T-Rock Cam Build Report UI | **Modify** — one stale comment only (~line 499) |

**Verified as needing NO change** (checked, do not touch):
- `server/src/modules/field/pdf-layout.test.ts` — almost entirely `"findings"` layout. Its one grid assertion is deliberately relative, not absolute (`countPdfPages(grid) < countPdfPages(findings)` with 6 photos: 4 < 7 still holds at 2/page). A prior author already hit this exact churn and de-coupled it.
- `server/tests/modules/field/pdf-layout.test.ts` — fonts/logo/branding only; its multi-page test asserts `byteLength > 1500`, not page count.
- `server/tests/modules/field/photo-reports-service.test.ts` — only asserts `cover.photoCount` (an input count, not pages).
- `client-field/src/components/ReportBuilder.tsx` — no layout knowledge; just opens the returned PDF URL.

---

## Task 1: Move the layout constants to 2-up

**Files:**
- Modify: `server/src/modules/field/pdf-layout.ts:35-88`
- Test: `server/tests/modules/field/photo-report-pdf-layout.test.ts`

This task changes chunking and tile size. The caption still draws to the right of the tile after this task — it will look wrong until Task 2, which is fine and expected; page-count behavior is correct and independently verifiable now.

- [ ] **Step 1: Update the failing test first — page count for 4 photos**

In `server/tests/modules/field/photo-report-pdf-layout.test.ts`, find the first test (`"a single section of 4 photos is COVER + one photo page — no divider, no trailing blank pages"`). Replace the whole `it(...)` block with:

```typescript
  it("a single section of 4 photos is COVER + two photo pages at 2-up — no trailing blank pages", async () => {
    const buffer = await renderFieldPhotoReportPdf({
      cover,
      sections: [{ title: "Doors", photos: [photo(1), photo(2), photo(3), photo(4)] }],
    });
    // Two photos a page, so 4 photos = 2 photo pages + cover. The guard that matters is that there are NO
    // trailing blank pages (an earlier layout produced ~12 here when footer text spilled onto auto-created
    // pages), not the per-page density on its own.
    expect(countPdfPages(buffer)).toBe(3);
  });
```

- [ ] **Step 2: Update the sibling corrupt-photo test's page count**

Same file, in the test `"names the photograph in the log when its bytes will not decode"`, there is one line:

```typescript
      expect(countPdfPages(buffer)).toBe(2);
```

That fixture renders a **single** photo, so at 2-up it is still cover + 1 page. **Leave this line unchanged.** (Recorded explicitly so you don't "fix" a line that is already correct.)

- [ ] **Step 3: Replace the 8-per-page density test with the 2-per-page boundary**

Same file, replace the whole `it("packs EIGHT photographs onto a page, two cells across", ...)` block with:

```typescript
  it("packs TWO photographs onto a page, two cells across", async () => {
    // Boundary proof of the chunk size: 2 photos is exactly one page, 3 spills to a second. Page-count
    // assertions elsewhere in this file cannot see the chunk size on their own — a 4-photo fixture gives
    // the same answer for several plausible densities — so the pair below is what pins it to 2.
    const two = await renderFieldPhotoReportPdf({
      cover,
      sections: [{ title: "Doors", photos: [photo(1), photo(2)] }],
    });
    expect(countPdfPages(two)).toBe(2);

    const three = await renderFieldPhotoReportPdf({
      cover,
      sections: [{ title: "Doors", photos: [photo(1), photo(2), photo(3)] }],
    });
    expect(countPdfPages(three)).toBe(3);
  });
```

- [ ] **Step 4: Update the tile-width bound in the side-by-side geometry test**

Same file, in `it("lays the two cells of a row out side by side, both inside the page margins", ...)`, find the final assertion:

```typescript
    expect(distinct[1] + 148).toBeLessThanOrEqual(612 - 32);
```

Replace with:

```typescript
    // 316 + 256 = 572, inside the 580pt right margin with 8pt to spare.
    expect(distinct[1] + 256).toBeLessThanOrEqual(612 - 32);
```

Leave the two `distinct[0]` / `distinct[1]` x-origin assertions unchanged — column geometry (`COLUMN_WIDTH`, `COLUMN_GAP`) does not change, only tile width within the column.

- [ ] **Step 5: Run the tests to verify they fail**

```bash
cd server && npx vitest run --config vitest.ci.config.ts ../server/tests/modules/field/photo-report-pdf-layout.test.ts
```

Expected: **FAIL**. Specifically `expected 2 to be 3` on the 4-photo test (it still renders 1 photo page at 8-up), and `expected 2 to be 3` on the new 3-photo boundary case. The `572 <= 580` assertion will already pass (it is a bound, and 148 < 256 both satisfy it) — that is expected and fine; it becomes meaningful after Step 6.

- [ ] **Step 6: Change the constants**

In `server/src/modules/field/pdf-layout.ts`, replace the block from the `/** TWO photo cells per row, four rows down... */` docblock through `const PHOTO_TILE_WIDTH = 148;` with:

```typescript
/**
 * TWO photo cells per row, ONE row down: two photographs a page.
 *
 * The 8-up grid this replaces fit eight cells a page, which made every photograph small — and the app's
 * captures are much narrower than a normal phone photo (measured 884x1920, ~0.46:1, against a 148pt-wide
 * tile), so they rendered as thin strips nobody could read. Two cells a page is what buys the width back.
 * The cost is stated plainly: four times the pages for the same number of photographs.
 */
const PHOTO_COLUMNS = 2;
const PHOTO_ROWS_PER_PAGE = 1;
const PHOTOS_PER_PAGE = PHOTO_COLUMNS * PHOTO_ROWS_PER_PAGE;
const COLUMN_GAP = 20;
const COLUMN_WIDTH = (CONTENT_WIDTH - COLUMN_GAP * (PHOTO_COLUMNS - 1)) / PHOTO_COLUMNS;
const PHOTO_ROWS_TOP = 72;
const PHOTO_ROWS_BOTTOM = 740; // stay clear of the footer (drawn at PAGE_HEIGHT - 44)
const PHOTO_ROW_GAP = 14;
const PHOTO_ROW_PITCH = (PHOTO_ROWS_BOTTOM - PHOTO_ROWS_TOP + PHOTO_ROW_GAP) / PHOTO_ROWS_PER_PAGE;
/**
 * The photo sits in a FIXED grey tile and is letterboxed inside it, rather than being drawn at whatever
 * size its aspect happens to produce.
 *
 * This is the difference between a report that reads as designed and one that reads as broken. Fitting each
 * image to its own rectangle on page-white meant a portrait, a landscape and a panorama all started and
 * ended in different places — 0 to 196pt of ragged dead space per row — and the metadata, hung off the
 * rendered image, drifted with them. A constant tile gives every photograph the same footprint whatever its
 * shape, and letterboxing onto grey reads as deliberate framing where the identical letterbox on white just
 * reads as a mistake.
 *
 * FIXED at 560 rather than derived from PHOTO_ROW_PITCH: the caption block now sits BELOW the tile inside
 * the same cell, so the tile must leave room for it. The remainder (PHOTO_ROW_PITCH - PHOTO_TILE_HEIGHT =
 * 682 - 560 = 122pt) is that room, of which ~98pt is usable once CAPTION_GAP and PHOTO_ROW_GAP are taken.
 */
const PHOTO_TILE_HEIGHT = 560;
/**
 * Nearly the full column width, and a tall tile — sized for the narrow captures the app actually produces.
 *
 * A 0.46:1 photograph (the measured shape of the app's current captures) is WIDTH-bound: at the old 148pt
 * 148x156.5 tile: it rendered 72x156.5, and widening the tile alone would not have helped it while the tile
 * stayed short. At 256x560 the same photograph is WIDTH-bound and renders 256x556 — about 4pt of letterbox,
 * and ~12.6x the visible area (11.3k -> 142.3k pt^2). A 3:4 portrait goes 117x156.5 -> 256x341, a 4:3
 * landscape 148x111 -> 256x192; all three are larger, with more surrounding grey on the wider shapes,
 * because one fixed tile cannot be optimal for every aspect ratio and the narrow case is the unreadable one.
 */
const PHOTO_TILE_WIDTH = 256;
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd server && npx vitest run --config vitest.ci.config.ts ../server/tests/modules/field/photo-report-pdf-layout.test.ts
```

Expected: **PASS**, 9 tests.

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/field/pdf-layout.ts server/tests/modules/field/photo-report-pdf-layout.test.ts
git commit -m "feat(field-report): two photos per page, wider tile

PHOTO_ROWS_PER_PAGE 4->1 and PHOTO_TILE_WIDTH 148->256, with
PHOTO_TILE_HEIGHT fixed at 560 to leave room for the caption block that
moves below the tile in the next commit.

The app's captures measure ~884x1920 (0.46:1), which is width-bound at a
148pt tile — taller rows alone would have grown the grey box and not the
photograph."
```

---

## Task 2: Move the caption block below the tile

**Files:**
- Modify: `server/src/modules/field/pdf-layout.ts` — the `CAPTION_*` constants (~lines 84-88) and the caption half of `drawPhotoEntry` (~lines 707-754)
- Test: `server/tests/modules/field/photo-report-pdf-layout.test.ts`

After Task 1 the tile is 256pt wide but `CAPTION_WIDTH` is `COLUMN_WIDTH - PHOTO_TILE_WIDTH - CAPTION_GAP` = `264 - 256 - 10` = **-2pt**, i.e. negative. The caption is currently unreadable/broken. This task fixes it by moving the block underneath.

- [ ] **Step 1: Write the failing test**

Add this test to `server/tests/modules/field/photo-report-pdf-layout.test.ts`, immediately after the `"lays the two cells of a row out side by side..."` test:

```typescript
  it("draws the caption BELOW its tile, not beside it", async () => {
    // The caption used to sit in the leftover column width to the right of the tile. At a 256pt tile in a
    // 264pt column that space is gone (264 - 256 - 10 = -2pt), so the block moves underneath.
    //
    // Asserting on the drawn text's X ORIGIN is what distinguishes "moved below" from "still beside, just
    // clipped off the page" — a page count cannot see that difference and neither can a byte length.
    //
    // NOTE ON TECHNIQUE: do NOT try to locate the caption by searching the stream for its text. PDFKit
    // SUBSETS the embedded font, so the literal characters do not appear in the content stream — a
    // `streams.indexOf("SomeName")` lookup silently returns -1 and the test degrades into asserting
    // nothing. Verified against pdfkit directly before writing this. What IS emitted, per text run, is a
    // text matrix `1 0 0 1 <x> <y> Tm`, so the x values are readable even when the glyphs are not.
    const buffer = await renderFieldPhotoReportPdf({
      cover,
      sections: [{ title: "Doors", photos: [photo(1)] }],
    });
    const streams = [...buffer.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)endstream/g)]
      .map((m) => {
        try {
          return zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1");
        } catch {
          return "";
        }
      })
      .join("\n");

    const textXs = [...streams.matchAll(/[\d.\-]+ [\d.\-]+ [\d.\-]+ [\d.\-]+ ([\d.\-]+) [\d.\-]+ Tm/g)].map((m) =>
      Number(m[1]),
    );
    expect(textXs.length).toBeGreaterThan(0); // guard: a regex that matched nothing must fail, not pass

    // A single photo occupies the LEFT cell, so a caption drawn beside a 256pt tile would land at
    // 32 + 256 + 10 = 298. Nothing may be drawn there.
    expect(textXs.filter((x) => Math.abs(x - 298) < 1)).toEqual([]);
    // ...and the caption is drawn at the tile's own left edge instead.
    expect(textXs.some((x) => Math.abs(x - 32) < 1)).toBe(true);
  });
```

This test needs `zlib`, which the file already imports at the top (`import zlib from "node:zlib";`) — verify it is there; if not, add it.

The `expect(textXs.length).toBeGreaterThan(0)` line is not ceremony: a regex-based PDF assertion that matches nothing degrades into a test that passes while checking nothing, which is the exact failure mode this codebase has hit before.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && npx vitest run --config vitest.ci.config.ts ../server/tests/modules/field/photo-report-pdf-layout.test.ts -t "draws the caption BELOW"
```

Expected: **FAIL** — the `filter((x) => Math.abs(x - 298) < 1)` array is non-empty, because after Task 1 the caption is still drawn beside the tile at `left + PHOTO_TILE_WIDTH + CAPTION_GAP` = `32 + 256 + 10` = 298.

(For orientation: on `origin/main`, before Task 1, that same expression is `32 + 148 + 10` = 190 — which is why this test belongs here, after the tile widened, rather than at the start of the branch.)

- [ ] **Step 3: Update the caption constants**

In `server/src/modules/field/pdf-layout.ts`, replace this block:

```typescript
// Caption + metadata sit to the RIGHT of the tile inside the same cell, BOTTOM-aligned to it, so the last
// line always lands on the tile's bottom edge no matter how tall the photograph rendered.
const CAPTION_GAP = 10;
const CAPTION_WIDTH = COLUMN_WIDTH - PHOTO_TILE_WIDTH - CAPTION_GAP;
```

with:

```typescript
// Caption + metadata sit BELOW the tile inside the same cell, running the tile's full width.
//
// They used to sit to its RIGHT, in whatever column width the tile did not use. At a 256pt tile inside a
// 264pt column that leftover is -2pt, so there is no "beside" left to sit in — and the move is what let the
// tile take the width in the first place. CAPTION_GAP is now a VERTICAL gap (tile bottom -> first text
// baseline) rather than a horizontal one.
const CAPTION_GAP = 10;
const CAPTION_WIDTH = PHOTO_TILE_WIDTH;
```

- [ ] **Step 4: Rewrite the caption drawing block**

In `drawPhotoEntry`, replace everything from the comment `// --- Caption + metadata, to the right of the tile and BOTTOM-aligned to it ---...` through the end of the function (the closing `}` of the `if (description) { ... }` block and the function's own `}`) with:

```typescript
  // --- Caption + metadata, BELOW the tile ----------------------------------------------------------
  // Top-anchored to the tile's bottom edge and flowing downward: description first, then metadata. The old
  // layout bottom-anchored this group to the tile's bottom-right, which only made sense while it lived in a
  // narrow side column. Below the tile there is a fixed ~98pt usable band, so ordinary top-down reading order is
  // both simpler and what a reader expects under a photograph.
  //
  // The "Project:"/"Date:"/"Creator:" labels stay GONE — the values are self-evident, and the project name
  // is already the page header, the footer and the cover title. It is printed here ONLY when a photograph
  // belongs to some other project than the report's, the case where it is information rather than furniture.
  const captionLeft = left;
  const captionTop = top + boxHeight + CAPTION_GAP;

  const metaLines = [formatPhotoDateCompact(photo.takenAt, photo.createdAt), photo.uploaderName];
  if (photo.projectName.trim() && photo.projectName.trim() !== coverProjectName.trim()) {
    metaLines.push(photo.projectName);
  }

  // The description gets whatever vertical room is left after the metadata rows are reserved, so a long
  // caption can never push the metadata out of the cell and into the page furniture below it.
  const metaBlockHeight = metaLines.length * META_LINE_PITCH;
  const captionBandHeight = PHOTO_ROW_PITCH - boxHeight - CAPTION_GAP - PHOTO_ROW_GAP;
  const descriptionAvailable = Math.max(0, captionBandHeight - metaBlockHeight - 4);

  let cursor = captionTop;
  const description = clampText(photo.descriptionOverride ?? photo.description ?? "", 200);
  if (description && descriptionAvailable > 0) {
    doc.fillColor(BRAND_BLACK).font(fonts.regular).fontSize(8);
    const measured = doc.heightOfString(description, { width: CAPTION_WIDTH, lineGap: 1.5 });
    const descriptionHeight = Math.min(measured, descriptionAvailable);
    doc.text(description, captionLeft, cursor, {
      width: CAPTION_WIDTH,
      lineGap: 1.5,
      height: descriptionHeight,
      ellipsis: true,
    });
    cursor += descriptionHeight + 4;
  }

  metaLines.forEach((value, index) => {
    doc.fillColor(BRAND_MUTED).font(fonts.regular).fontSize(META_FONT_SIZE);
    // One line each, ellipsised, so a 500-char project name truncates instead of wrapping into the page
    // furniture below the cell.
    doc.text(value, captionLeft, cursor + index * META_LINE_PITCH, {
      width: CAPTION_WIDTH,
      align: "left",
      lineBreak: false,
      height: META_LINE_PITCH,
      ellipsis: true,
    });
  });
}
```

- [ ] **Step 5: Run the new test to verify it passes**

```bash
cd server && npx vitest run --config vitest.ci.config.ts ../server/tests/modules/field/photo-report-pdf-layout.test.ts -t "draws the caption BELOW"
```

Expected: **PASS**.

- [ ] **Step 6: Run the whole file to check nothing regressed**

```bash
cd server && npx vitest run --config vitest.ci.config.ts ../server/tests/modules/field/photo-report-pdf-layout.test.ts
```

Expected: **PASS**, 10 tests.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/field/pdf-layout.ts server/tests/modules/field/photo-report-pdf-layout.test.ts
git commit -m "feat(field-report): move the photo caption below its tile

At a 256pt tile in a 264pt column the old side position had -2pt of room.
The block now runs the tile's full width underneath it, description first
then metadata, bounded to the band between the tile and the next row so a
long caption cannot push metadata into the page furniture."
```

---

## Task 3: Correct the two stale comments

**Files:**
- Modify: `server/src/modules/field/photo-reports-service.ts` (~line 267)
- Modify: `mobile/src/components/ReportBuilder.tsx` (~line 499)

Both say "3 photos per page" — already wrong before this change (it was 8), and wrong differently after (2). No behavior change; comments only.

- [ ] **Step 1: Find both comments**

```bash
grep -rn "3-per-page\|3 photos per page" server/src/modules/field/photo-reports-service.ts mobile/src/components/ReportBuilder.tsx
```

Expected: one match in each file. If a match is missing or the wording differs, read the surrounding lines and update the wording that is actually there rather than forcing the exact string below.

- [ ] **Step 2: Update the server comment**

In `server/src/modules/field/photo-reports-service.ts`, change the phrase `keeps the 3-per-page grid` to `keeps the 2-per-page grid`. Leave the rest of the sentence intact.

- [ ] **Step 3: Update the mobile comment**

In `mobile/src/components/ReportBuilder.tsx`, change `PDF prints 3 photos per page` to `PDF prints 2 photos per page`. Leave the rest of the sentence intact.

- [ ] **Step 4: Verify no stale references remain**

```bash
grep -rn "3-per-page\|3 photos per page\|8 photos per page\|eight photographs" server/src mobile/src client-field/src || echo "clean"
```

Expected: `clean`, or only matches inside historical/changelog prose that should not be edited.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/field/photo-reports-service.ts mobile/src/components/ReportBuilder.tsx
git commit -m "docs: correct stale photos-per-page comments

Both said 3; it was 8 before this branch and is 2 after."
```

---

## Task 4: Verify against a real rendered PDF

The spec requires this explicitly, and it is how every prior layout change to this file was settled — *"parse the artifact, don't eyeball it."* Unit tests confirm page counts and text placement; they do not confirm the photograph is actually bigger or that nothing got cropped.

**Files:**
- Create: `/tmp/verify-report-layout.mjs` (throwaway, not committed)

- [ ] **Step 1: Write a script that renders a report with mixed aspect ratios**

Create `/tmp/verify-report-layout.mjs`:

```javascript
// Renders a report through the REAL renderer with three deliberately different aspect ratios, then
// reports what actually landed on the page. Throwaway — not committed.
import { writeFileSync } from "node:fs";
import sharp from "sharp";

const { renderFieldPhotoReportPdf } = await import(
  "../Users/adnaaniqbal/developer/trockcrm/.worktrees/build-report-2up/server/dist/modules/field/pdf-layout.js"
).catch(async () => await import(
  "/Users/adnaaniqbal/developer/trockcrm/.worktrees/build-report-2up/server/src/modules/field/pdf-layout.ts"
));

async function jpeg(w, h, rgb) {
  return await sharp({ create: { width: w, height: h, channels: 3, background: rgb } }).jpeg().toBuffer();
}

const shapes = [
  { label: "narrow 884x1920 (0.46:1, the app's current capture)", w: 884, h: 1920, rgb: { r: 200, g: 60, b: 60 } },
  { label: "portrait 3024x4032 (3:4)", w: 3024, h: 4032, rgb: { r: 60, g: 160, b: 90 } },
  { label: "landscape 4032x3024 (4:3)", w: 4032, h: 3024, rgb: { r: 60, g: 90, b: 200 } },
];

const photos = [];
for (const [i, s] of shapes.entries()) {
  const buf = await jpeg(s.w, s.h, s.rgb);
  photos.push({
    id: `p${i}`,
    displayName: s.label,
    description: `Aspect check — ${s.label}`,
    takenAt: null,
    createdAt: "2026-08-18T15:00:00.000Z",
    uploaderName: "Layout Check",
    projectName: "Layout Verification",
    tags: [],
    r2Key: null,
    externalUrl: `data:image/jpeg;base64,${buf.toString("base64")}`,
    externalThumbnailUrl: null,
    reportIndex: i + 1,
  });
}

const pdf = await renderFieldPhotoReportPdf({
  cover: {
    reportTitle: "Layout Verification",
    creatorName: "Layout Check",
    companyName: "TRock Construction",
    reportDateLabel: "August 18, 2026",
    projectName: "Layout Verification",
    photoCount: photos.length,
  },
  sections: [{ title: "Aspect ratios", photos }],
});

writeFileSync("/tmp/layout-verify.pdf", pdf);
console.log("wrote /tmp/layout-verify.pdf");
```

- [ ] **Step 2: Run it**

```bash
cd /Users/adnaaniqbal/developer/trockcrm/.worktrees/build-report-2up/server && npx tsx /tmp/verify-report-layout.mjs
```

Expected: `wrote /tmp/layout-verify.pdf`. If the import path fails, adjust it — the goal is to call the real `renderFieldPhotoReportPdf`, not to preserve the exact import line.

- [ ] **Step 3: Measure what actually rendered**

```bash
pdfimages -list /tmp/layout-verify.pdf
pdfinfo /tmp/layout-verify.pdf | grep -i pages
```

Expected:
- **Pages: 3** (cover + 2 photo pages for 3 photos at 2-up).
- Three embedded photo images, each preserving its **source** pixel dimensions and aspect ratio (884x1920, 3024x4032, 4032x3024) — the renderer scales at draw time, so the embedded bytes keep their own ratio. **If any listed image's aspect ratio differs from its source, something is cropping — stop and investigate.**

- [ ] **Step 4: Confirm visually that nothing is cropped and the photos are larger**

```bash
pdftoppm -png -r 80 /tmp/layout-verify.pdf /tmp/layout-verify-page
open /tmp/layout-verify-page-2.png
```

Check by eye, against the three solid-colour rectangles:
- each is a **complete rectangle** (letterboxed on grey where its ratio differs from the tile) — no colour block runs off the edge of its tile, which is what a crop would look like
- the narrow red one nearly fills its tile top to bottom
- the caption text sits **below** each photo, not beside it
- two photos per page, side by side

- [ ] **Step 5: Clean up**

```bash
rm -f /tmp/verify-report-layout.mjs /tmp/layout-verify.pdf /tmp/layout-verify-page*.png
```

No commit — this task produces no repository changes.

---

## Task 5: Full gate and PR

- [ ] **Step 1: Typecheck the server**

```bash
cd /Users/adnaaniqbal/developer/trockcrm/.worktrees/build-report-2up/server && npx tsc -p tsconfig.typecheck.json
```

Expected: no output (success). If `shared` type errors appear, run `npm run build --workspace=shared` from the worktree root first.

- [ ] **Step 2: Run the full server CI suite**

```bash
cd /Users/adnaaniqbal/developer/trockcrm/.worktrees/build-report-2up/server && npx vitest run --config vitest.ci.config.ts 2>&1 | tail -20
```

Expected: **PASS**. Capture the file/test counts for the PR body. If anything unrelated to this change fails, verify it also fails on a clean `origin/main` checkout before treating it as yours — do not silently absorb a pre-existing failure, and do not claim a green run you did not get.

- [ ] **Step 3: Typecheck mobile (it is gated in CI and easy to forget)**

```bash
cd /Users/adnaaniqbal/developer/trockcrm/.worktrees/build-report-2up && npm run typecheck --prefix mobile
```

Expected: exit 0. Task 3 only touched a comment there, so a failure means something unrelated — check it against `origin/main` before assuming it is yours.

- [ ] **Step 4: Push and open the PR**

```bash
cd /Users/adnaaniqbal/developer/trockcrm/.worktrees/build-report-2up
git push -u origin feat/build-report-2up-layout
gh pr create --title "feat(field-report): two photos per page, sized for the app's narrow captures" --body "$(cat <<'EOF'
## The problem

Photos in the Build Report (T-Rock Cam) / Generate Report (trockcam.com) were too small to make out.

Measured from a real report rather than assumed: the app's captures are **884x1920px, ~0.46:1** — much narrower than a normal phone photo (3:4). In the old 148x156.5pt tile they contain-fit height-bound to **72x156.5pt** — a 72pt-wide strip.

## Why "fewer rows" alone would not have worked

Tile width and height were independent constants and **both** had to change. More height alone caps out at the 148pt width; more width alone caps out at the 156.5pt height (the photo stays 72pt wide). The width could only come from the space the caption occupied beside the tile, which is why the caption moved below it.

## The change

| | Before | After |
|---|---|---|
| Photos/page | 8 (2x4) | **2** (2x1) |
| Tile | 148 x 156.5pt | **256 x 560pt** |
| Caption | beside the tile | **below it** |
| Fit | contain | contain (unchanged) |

~3x the visible photo area for the narrow case, which renders 256x556 with about 4pt of letterbox.

## Cropping was considered and rejected

Two photos in the motivating report document **ceiling water damage in the top third of frame**. A crop aggressive enough to help lands on the evidence. There is no crop percentage safe across construction condition photos generally — the subject is variously at the top, bottom, or a side edge. This matches the renderer's own pre-existing comment: *"NOT cover: this is an evidence document, and filling the tile would silently crop the edges off the thing being photographed."*

## Trade-off, stated plainly

**4x the pages for the same photo count.** A 20-photo report goes from 3 pages to 10. That is the direct cost of the request.

## Scope

Both surfaces go through the one server renderer, so this single file covers both. The AI Report's separate `findings` layout (already 1/page) is untouched. Caption *content* is unchanged — only its position.

## Verification

- Unit tests: page-count boundary (2 photos -> 1 page, 3 -> 2), cell geometry within margins, and a new assertion that the caption's drawn x-origin is the tile's left edge (proving it moved below rather than being clipped beside).
- Real rendered PDF checked with `pdfimages`/`pdftoppm` across three aspect ratios (0.46:1, 3:4, 4:3) — confirmed each renders complete and letterboxed, with no cropping.
- Also corrected two stale comments that claimed "3 photos per page" (wrong before this branch too — it was 8).

Spec: `docs/superpowers/specs/2026-08-18-build-report-2up-photo-layout-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Request review — do not self-merge**

This repo's standing rule: merge only after an independent adversarial review of the **current tip** comes back with nothing. Post `@codex review` on the PR. If Codex is rate-limited, dispatch an adversarial subagent review instead and say plainly in the PR which kind of review the tip actually got.

---

## Notes for whoever executes this

- **Task 1 leaves the caption visibly broken** (negative width) until Task 2. That is expected and sequenced deliberately — Task 1 is independently verifiable on page counts, Task 2 on text placement. Do not "fix" the caption early in Task 1.
- **Do not touch `PHOTO_COLUMNS`.** Two columns is the chosen design; the size win comes from row count and tile width.
- **If the 560pt tile height needs tuning** after seeing the real render in Task 4, that is fine and anticipated — the spec calls 560 a well-reasoned starting point, not a value to defend to the pixel. If you change it, update the docblock's stated arithmetic to match, and re-run Task 4.
