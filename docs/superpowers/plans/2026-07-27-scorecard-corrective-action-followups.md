# Scorecard Corrective-Action Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **DO NOT dispatch Agent subagents to implement these tasks.** Subagents in this repo execute in the MAIN checkout (`/Users/adnaaniqbal/Developer/trockcrm`), not this worktree, and other CLI sessions are actively working there. Implement inline. Subagents are used ONLY for the read-only pre-PR review in Phase 4, pointed at SHAs / this worktree's absolute path.

**Goal:** Fix signatures rendering as raw base64 in the web CRM, make downloaded scorecard PDFs reflect documented corrective actions, and notify oversight when a corrective action opens and completes.

**Architecture:** Three independent-but-ordered parts. Part 1 extracts a shared signature-classification predicate so the web and PDF surfaces agree. Part 2 adds a corrective-action section to the PDF renderer and makes artifact staleness generation-aware so a corrective-action write invalidates the cached PDF. Part 3 adds a separate oversight-email worker job (never a CC on the token-bearing responder email) with its own idempotency stamps.

**Tech Stack:** TypeScript, Express, Drizzle ORM, Postgres (per-office schemas), PDFKit, React, vitest (+ PGlite for runtime tests), Resend via the worker job queue.

**Base:** `origin/main` @ `6b7e19df`. Worktree: `/Users/adnaaniqbal/Developer/trockcrm/.claude/worktrees/scorecard-corrective-action-followups`. Branch: `feat/scorecard-corrective-action-followups`.

**Spec:** `docs/superpowers/specs/2026-07-27-scorecard-corrective-action-followups-design.md`

---

## File Structure

**Part 1 — signatures**
- Create: `shared/src/types/field-scorecard-signature.ts` — the classification predicate, single source of truth for both surfaces.
- Create: `shared/src/types/__tests__/field-scorecard-signature.test.ts`
- Modify: `shared/src/types/index.ts` — re-export.
- Modify: `server/src/modules/field/scorecard-pdf.ts` — `signatureDataUrlToBuffer` / `typedSignatureFallback` delegate to the shared predicate.
- Modify: `client/src/pages/deals/deal-scorecards-tab.tsx` — `SignatureBlock` component.
- Modify: `client/src/pages/deals/deal-scorecards-tab.test.tsx` — render assertions.

**Part 2 — PDF corrective actions**
- Create: `migrations/0200_field_scorecards_pdf_content_generation.sql`
- Modify: `shared/src/schema/tenant/field-scorecards.ts` — `pdfContentGeneration` column.
- Modify: `server/src/modules/field/scorecard-pdf.ts` — `ScorecardPdfCorrectiveAction` type + `CORRECTIVE ACTIONS` section.
- Modify: `server/src/modules/field/scorecard-pdf-artifact.ts` — generation-aware staleness.
- Modify: `server/src/modules/field/scorecards-service.ts` — load corrective actions + photos, persist the generation.
- Modify: `server/src/modules/deals/scorecards-service.ts` — supply the generation fields.
- Modify: `server/src/modules/field/corrective-actions-service.ts` — bump `updated_at` on every resolve.
- Modify: `server/src/modules/field/corrective-action-api.ts` — post-commit finalize.
- Tests: `server/tests/modules/field/scorecard-pdf.test.ts`, `scorecard-pdf-artifact.runtime.test.ts`, `scorecard-pdf.runtime.test.ts` (timeout), new `scorecard-pdf-corrective-actions.runtime.test.ts`.

**Part 3 — oversight email**
- Create: `migrations/0201_field_scorecards_corrective_action_oversight_stamps.sql`
- Create: `worker/src/jobs/scorecard-corrective-action-oversight-email.ts`
- Create: `worker/tests/jobs/scorecard-corrective-action-oversight-email.test.ts`
- Modify: `shared/src/schema/tenant/field-scorecards.ts` — two stamp columns.
- Modify: `worker/src/jobs/index.ts` — register the job type.
- Modify: `server/src/modules/field/corrective-actions-service.ts` — enqueue both phases, clear stamps at both reset sites.

---

## Conventions that apply to every task

- **Never `git stash`.** The stash stack is shared across worktrees and other sessions. Commit WIP instead.
- **Run all tests with `TZ=UTC`** — matches the CI gate.
- **`@trock-crm/shared` must be rebuilt** (`npm run build --workspace=@trock-crm/shared`) after any change under `shared/src/`, or server/worker tests fail to resolve it.
- **Migrations need BOTH** the `office_*` `DO`-loop AND the `TENANT_SCHEMA_START/END` block (the office provisioner clones `office_dallas`).
- **Commit after each task.** Commit message trailer:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Fmgbdvhku1QU7XcPZj4vwJ
  ```

---

# Phase 1 — Signatures render as images

### Task 1: Shared signature-classification predicate

**Files:**
- Create: `shared/src/types/field-scorecard-signature.ts`
- Create: `shared/src/types/__tests__/field-scorecard-signature.test.ts`
- Modify: `shared/src/types/index.ts`

- [ ] **Step 1: Write the failing test**

Create `shared/src/types/__tests__/field-scorecard-signature.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  isRenderableSignatureDataUrl,
  typedSignatureFallback,
} from "../field-scorecard-signature.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("isRenderableSignatureDataUrl", () => {
  it("accepts png, jpeg and jpg data urls, case-insensitively", () => {
    expect(isRenderableSignatureDataUrl(PNG)).toBe(true);
    expect(isRenderableSignatureDataUrl("data:image/jpeg;base64,/9j/4AAQ")).toBe(true);
    expect(isRenderableSignatureDataUrl("data:image/jpg;base64,/9j/4AAQ")).toBe(true);
    expect(isRenderableSignatureDataUrl("DATA:IMAGE/PNG;BASE64,iVBORw0KGgo=")).toBe(true);
  });

  it("rejects a typed name, empty input and non-image data payloads", () => {
    expect(isRenderableSignatureDataUrl("Adnaan Iqbal")).toBe(false);
    expect(isRenderableSignatureDataUrl("")).toBe(false);
    expect(isRenderableSignatureDataUrl(null)).toBe(false);
    expect(isRenderableSignatureDataUrl(undefined)).toBe(false);
    // Not an allowed image type — must never reach an <img src> or doc.image().
    expect(isRenderableSignatureDataUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
    expect(isRenderableSignatureDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    // Right prefix, illegal base64 alphabet.
    expect(isRenderableSignatureDataUrl("data:image/png;base64,not base64!!")).toBe(false);
    // Right prefix, empty payload.
    expect(isRenderableSignatureDataUrl("data:image/png;base64,")).toBe(false);
  });
});

describe("typedSignatureFallback", () => {
  it("returns a legacy typed name", () => {
    expect(typedSignatureFallback("Adnaan Iqbal")).toBe("Adnaan Iqbal");
  });

  it("returns null for any data url, including an unrenderable one", () => {
    expect(typedSignatureFallback(PNG)).toBeNull();
    expect(typedSignatureFallback("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(typedSignatureFallback("")).toBeNull();
    expect(typedSignatureFallback(null)).toBeNull();
    expect(typedSignatureFallback(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TZ=UTC npx vitest run shared/src/types/__tests__/field-scorecard-signature.test.ts`
Expected: FAIL — `Cannot find module '../field-scorecard-signature.js'`

- [ ] **Step 3: Write the implementation**

Create `shared/src/types/field-scorecard-signature.ts`:

```ts
/**
 * Signature classification shared by EVERY surface that renders a scorecard signature — the web deal tab
 * and the server PDF renderer. A handwritten signature is captured in T-Rock Cam as a data URL; legacy
 * cards carry a plain typed name instead.
 *
 * Both surfaces MUST classify identically. If the web accepted a payload the PDF rejects (or vice versa),
 * one surface would show a signature the other renders as an em dash — the same class of drift the
 * reconciliation-consistency rule exists to prevent. That is why this lives in shared/ rather than being
 * duplicated per surface.
 */

/** png/jpeg/jpg only, matching what both PDFKit's doc.image() decodes and an <img src> can safely take. */
const RENDERABLE_SIGNATURE_DATA_URL = /^data:image\/(?:png|jpeg|jpg);base64,([A-Za-z0-9+/=\s]+)$/i;

/**
 * True when the value is a handwritten-signature data URL this platform will draw as an image.
 *
 * Deliberately NARROW: any other `data:` payload (svg+xml, text/html, an unknown image type, or a
 * malformed base64 body) is false, so callers never pass an arbitrary data URI into an image sink.
 */
export function isRenderableSignatureDataUrl(value: string | null | undefined): boolean {
  return !!value && RENDERABLE_SIGNATURE_DATA_URL.test(value);
}

/** The decoded base64 body of a renderable signature data URL, or null. Server-side image decode path. */
export function signatureDataUrlBase64Body(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = RENDERABLE_SIGNATURE_DATA_URL.exec(value);
  return match ? match[1] : null;
}

/**
 * The legacy typed-signature text to render when there is no drawable image: a plain typed name renders
 * as text, while ANY data URL returns null (an unrenderable data URL must fall through to an em dash, not
 * be printed verbatim — printing it verbatim is the reported bug).
 */
export function typedSignatureFallback(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.startsWith("data:") ? null : value;
}
```

- [ ] **Step 4: Re-export from the types barrel**

In `shared/src/types/index.ts`, add alongside the other `export *` lines:

```ts
export * from "./field-scorecard-signature.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `TZ=UTC npx vitest run shared/src/types/__tests__/field-scorecard-signature.test.ts`
Expected: PASS (3 + 2 = 5 tests)

- [ ] **Step 6: Rebuild shared and commit**

```bash
npm run build --workspace=@trock-crm/shared
git add shared/src/types/field-scorecard-signature.ts shared/src/types/__tests__/field-scorecard-signature.test.ts shared/src/types/index.ts
git commit -m "feat(shared): add scorecard signature classification predicate"
```

---

### Task 2: PDF renderer delegates to the shared predicate

**Files:**
- Modify: `server/src/modules/field/scorecard-pdf.ts:537-556` (`signatureDataUrlToBuffer`, `typedSignatureFallback`)
- Test: `server/tests/modules/field/scorecard-pdf.test.ts`

The PDF already renders signatures correctly. This task changes only WHERE the rule lives, so the web
cannot drift from it. Behaviour must be identical.

- [ ] **Step 1: Write the failing test**

Append to `server/tests/modules/field/scorecard-pdf.test.ts`:

```ts
describe("signature classification parity", () => {
  it("rejects a non-image data url instead of treating it as a typed name", () => {
    // Regression: an unrenderable data URL must produce NEITHER an image NOR verbatim text.
    expect(signatureDataUrlToBuffer("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
    expect(typedSignatureFallback("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
  });

  it("still decodes a png data url and still passes a typed name through", () => {
    expect(signatureDataUrlToBuffer("data:image/png;base64,iVBORw0KGgo=")).toBeInstanceOf(Buffer);
    expect(typedSignatureFallback("Adnaan Iqbal")).toBe("Adnaan Iqbal");
  });
});
```

Ensure the file's import of `scorecard-pdf.js` includes `signatureDataUrlToBuffer` and `typedSignatureFallback`.

- [ ] **Step 2: Run the test**

Run: `TZ=UTC npx vitest run server/tests/modules/field/scorecard-pdf.test.ts`
Expected: the svg+xml case may already pass (the old regex also rejected it); the assertion exists to LOCK the behaviour through the refactor. If it passes, that is fine — proceed.

- [ ] **Step 3: Replace both functions with delegating versions**

In `server/src/modules/field/scorecard-pdf.ts`, replace the bodies of `signatureDataUrlToBuffer` and
`typedSignatureFallback` (keeping both exported — existing tests and callers import them):

```ts
/** A handwritten-signature data URL (png/jpeg) → decoded image bytes to draw; null for anything else. */
export function signatureDataUrlToBuffer(signature: string | null): Buffer | null {
  const body = signatureDataUrlBase64Body(signature);
  if (body == null) return null;
  try {
    return Buffer.from(body, "base64");
  } catch {
    return null;
  }
}

/**
 * The legacy typed-signature text to render when there's no drawable image. Delegates to the shared
 * predicate so the web deal tab and this renderer can never disagree about what a signature is.
 */
export function typedSignatureFallback(signature: string | null): string | null {
  return sharedTypedSignatureFallback(signature);
}
```

Add to the existing `@trock-crm/shared/types` import block at the top of the file:

```ts
  signatureDataUrlBase64Body,
  typedSignatureFallback as sharedTypedSignatureFallback,
```

- [ ] **Step 4: Run the PDF tests**

Run: `TZ=UTC npx vitest run server/tests/modules/field/scorecard-pdf.test.ts server/tests/modules/field/scorecard-leadership-pdf.runtime.test.ts`
Expected: PASS, no behaviour change.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/field/scorecard-pdf.ts server/tests/modules/field/scorecard-pdf.test.ts
git commit -m "refactor(scorecards): PDF signature classification uses the shared predicate"
```

---

### Task 3: Web deal tab renders signature images

**Files:**
- Modify: `client/src/pages/deals/deal-scorecards-tab.tsx:472-473`
- Test: `client/src/pages/deals/deal-scorecards-tab.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `client/src/pages/deals/deal-scorecards-tab.test.tsx` (match the file's existing render harness and
detail fixture shape — read the surrounding tests first and reuse their setup helper rather than inventing
a new one):

```tsx
const PNG_SIGNATURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

it("renders a handwritten signature as an image, never as raw base64 text", async () => {
  // Reported bug: the tab printed the data URL as a text node.
  renderScorecardDetail({
    formVersion: 2,
    superintendentSignature: PNG_SIGNATURE,
    pmSignature: PNG_SIGNATURE,
  });

  const images = await screen.findAllByAltText(/signature$/i);
  expect(images).toHaveLength(2);
  expect(images[0]).toHaveAttribute("src", PNG_SIGNATURE);
  expect(document.body.textContent).not.toContain("data:image/png;base64");
});

it("renders a legacy typed signature as text", async () => {
  renderScorecardDetail({
    formVersion: 2,
    superintendentSignature: "Adnaan Iqbal",
    pmSignature: null,
  });

  expect(await screen.findByText("Adnaan Iqbal")).toBeInTheDocument();
  expect(screen.queryByAltText(/signature$/i)).not.toBeInTheDocument();
});

it("renders an em dash for a missing or unrenderable signature", async () => {
  renderScorecardDetail({
    formVersion: 2,
    superintendentSignature: null,
    pmSignature: "data:image/svg+xml;base64,PHN2Zz4=",
  });

  const dashes = await screen.findAllByText("—");
  expect(dashes.length).toBeGreaterThanOrEqual(2);
  expect(document.body.textContent).not.toContain("data:image/svg+xml");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TZ=UTC npx vitest run client/src/pages/deals/deal-scorecards-tab.test.tsx`
Expected: FAIL — no `<img>` with an alt ending in "signature"; body text contains `data:image/png;base64`.

- [ ] **Step 3: Add the SignatureBlock component**

In `client/src/pages/deals/deal-scorecards-tab.tsx`, add near the other local components:

```tsx
/**
 * One signature line. Mirrors the PDF's drawSignature exactly (see scorecard-pdf.ts): a handwritten
 * data-URL capture draws as an image, a legacy typed name renders as text, and anything else — including
 * a data URL of a type we will not render — falls back to an em dash rather than printing the raw payload.
 */
function SignatureBlock({ label, value }: { label: string; value: string | null | undefined }) {
  const typed = typedSignatureFallback(value);
  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 text-gray-500">{label}:</span>
      {isRenderableSignatureDataUrl(value) ? (
        <img
          src={value as string}
          alt={`${label} signature`}
          className="h-12 max-w-[220px] object-contain"
        />
      ) : (
        <span className={typed ? "text-gray-900" : "text-gray-400"}>{typed ?? "—"}</span>
      )}
    </div>
  );
}
```

Replace the two `<p>` lines:

```tsx
          <div className="space-y-1 text-sm text-gray-900">
            <SignatureBlock label="Superintendent" value={detail.superintendentSignature} />
            <SignatureBlock label="Project manager" value={detail.pmSignature} />
          </div>
```

Add to the file's imports:

```tsx
import { isRenderableSignatureDataUrl, typedSignatureFallback } from "@trock-crm/shared/types";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TZ=UTC npx vitest run client/src/pages/deals/deal-scorecards-tab.test.tsx`
Expected: PASS

- [ ] **Step 5: Sweep every other signature render site**

Confirm no other surface prints a signature as text:

```bash
grep -rn "superintendentSignature\|pmSignature" client/src client-field/src mobile/app mobile/src mobile-crm 2>/dev/null | grep -v "\.test\."
```

For each hit that renders to a user, apply the same `SignatureBlock` treatment. Record in the commit
message which surfaces were checked and which needed no change. (Per the two-source-roots rule, `mobile/app`
AND `mobile/src` must both be swept, not just one.)

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/deals/deal-scorecards-tab.tsx client/src/pages/deals/deal-scorecards-tab.test.tsx
git commit -m "fix(scorecards): render handwritten signatures as images in the deal tab"
```

---

# Phase 2 — Corrective actions in the PDF

### Task 4: Migration + schema for the rendered content generation

**Files:**
- Create: `migrations/0200_field_scorecards_pdf_content_generation.sql`
- Modify: `shared/src/schema/tenant/field-scorecards.ts`

- [ ] **Step 1: Write the migration**

Create `migrations/0200_field_scorecards_pdf_content_generation.sql`:

```sql
-- Migration 0200: field_scorecards.pdf_content_generation — the scorecard `updated_at` the stored PDF
-- artifact was rendered from, so staleness detection can notice content changes.
--
-- Bug this closes: needsScorecardPdfRegeneration decided on pdf_r2_key + pdf_render_version ALONE. Once a
-- valid content-addressed artifact existed it was considered current forever, so a corrective action
-- documented AFTER submit was never reflected in the downloaded PDF — the download presigned the
-- submit-time object. Scorecard EDITS avoided this only because the edit routes fire a best-effort
-- background re-render; when that fire-and-forget render fails there is no path to repair.
--
-- Written in the same guarded CAS UPDATE that already publishes pdf_r2_key / pdf_render_version, set to
-- the updated_at the render read. The download path regenerates when it differs from the live updated_at.
--
-- Nullable: every pre-migration row reads NULL and is therefore treated as stale, which is consistent with
-- the concurrent v2 -> v3 render-version bump already marking those rows stale. Per-tenant (office_*
-- schemas), idempotent + guarded per schema.

DO $tenant$
DECLARE schema_name text;
BEGIN
  FOR schema_name IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^office_' ORDER BY nspname LOOP
    IF to_regclass(format('%I.field_scorecards', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format(
      'ALTER TABLE %I.field_scorecards ADD COLUMN IF NOT EXISTS pdf_content_generation timestamptz',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.field_scorecards ADD COLUMN IF NOT EXISTS pdf_content_generation timestamptz;
-- TENANT_SCHEMA_END
```

- [ ] **Step 2: Add the Drizzle column**

In `shared/src/schema/tenant/field-scorecards.ts`, directly after `pdfRenderVersion`:

```ts
    /**
     * The scorecard `updated_at` the stored PDF artifact was rendered from (migration 0200). Written in the
     * same guarded CAS UPDATE that publishes pdf_r2_key. needsScorecardPdfRegeneration compares it against
     * the live updated_at, so any content change — including a corrective-action response — invalidates the
     * cached artifact. NULL on every pre-migration row, which reads as stale.
     */
    pdfContentGeneration: timestamp("pdf_content_generation", { withTimezone: true }),
```

- [ ] **Step 3: Rebuild shared and verify the migration parses**

```bash
npm run build --workspace=@trock-crm/shared
TZ=UTC npx vitest run server/tests/modules/field/scorecards-migration.runtime.test.ts
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add migrations/0200_field_scorecards_pdf_content_generation.sql shared/src/schema/tenant/field-scorecards.ts
git commit -m "feat(scorecards): persist the content generation a PDF artifact was rendered from"
```

---

### Task 5: Generation-aware staleness detection

**Files:**
- Modify: `server/src/modules/field/scorecard-pdf-artifact.ts`
- Test: `server/tests/modules/field/scorecard-pdf-artifact.runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/tests/modules/field/scorecard-pdf-artifact.runtime.test.ts`:

```ts
describe("needsScorecardPdfRegeneration — content generation", () => {
  const GEN = new Date("2026-07-27T12:00:00.000Z");
  const currentKey = `office_dallas/deals/d/scorecards/s.${"a".repeat(64)}.v${CURRENT_SCORECARD_PDF_RENDER_VERSION}.pdf`;

  const state = (over: Partial<ScorecardPdfArtifactState> = {}): ScorecardPdfArtifactState => ({
    pdfR2Key: currentKey,
    pdfRenderVersion: CURRENT_SCORECARD_PDF_RENDER_VERSION,
    linkedPhotoCount: 0,
    pdfContentGeneration: GEN,
    currentGeneration: GEN,
    ...over,
  });

  it("is current when the rendered generation matches the live one", () => {
    expect(needsScorecardPdfRegeneration(state())).toBe(false);
  });

  it("regenerates when the scorecard changed after the artifact was rendered", () => {
    // This is the reported bug: a corrective-action response advances updated_at.
    expect(
      needsScorecardPdfRegeneration(state({ currentGeneration: new Date("2026-07-27T12:05:00.000Z") })),
    ).toBe(true);
  });

  it("regenerates when the artifact predates the generation column", () => {
    expect(needsScorecardPdfRegeneration(state({ pdfContentGeneration: null }))).toBe(true);
  });

  it("compares at millisecond precision — Postgres microseconds must not force a false regeneration", () => {
    // node-postgres yields millisecond Dates while Postgres retains microseconds; comparing raw values
    // would regenerate on every single download.
    expect(
      needsScorecardPdfRegeneration(
        state({
          pdfContentGeneration: new Date("2026-07-27T12:00:00.000Z"),
          currentGeneration: new Date("2026-07-27T12:00:00.000Z"),
        }),
      ),
    ).toBe(false);
  });

  it("still regenerates a legacy render version regardless of a matching generation", () => {
    expect(needsScorecardPdfRegeneration(state({ pdfRenderVersion: 1 }))).toBe(true);
  });

  it("treats an unknown live generation as current rather than looping", () => {
    // A card whose row vanished mid-flight must not spin the download in a regenerate loop.
    expect(needsScorecardPdfRegeneration(state({ currentGeneration: null }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TZ=UTC npx vitest run server/tests/modules/field/scorecard-pdf-artifact.runtime.test.ts`
Expected: FAIL — `pdfContentGeneration` / `currentGeneration` are not on `ScorecardPdfArtifactState`.

- [ ] **Step 3: Implement**

In `server/src/modules/field/scorecard-pdf-artifact.ts`, bump the version and extend the state + decision:

```ts
export const CURRENT_SCORECARD_PDF_RENDER_VERSION = 3;
```

Update the doc comment above it to add: `Version 3 adds the corrective-action record (item status, responder, comment and response photos).`

```ts
export interface ScorecardPdfArtifactState {
  pdfR2Key: string | null;
  pdfRenderVersion: number;
  linkedPhotoCount: number;
  /** The scorecard updated_at the stored artifact was rendered from (migration 0200); null pre-migration. */
  pdfContentGeneration: Date | string | null;
  /** The scorecard's CURRENT updated_at. null only when the row could not be read. */
  currentGeneration: Date | string | null;
}
```

Add the comparison to `needsScorecardPdfRegeneration`, after the existing render-version checks and before
the content-addressed key check:

```ts
  // Content changed since the artifact was rendered — e.g. an edit, or a corrective-action response. The
  // key/version pair alone cannot see this: a content-addressed key stays "valid-looking" forever, which is
  // exactly why a documented corrective action never reached the downloaded PDF.
  if (!isRenderedGenerationCurrent(state)) return true;
```

And add the helper:

```ts
/**
 * Whether the stored artifact was rendered from the scorecard's current content.
 *
 * A null rendered generation (every pre-0200 row) is stale. A null CURRENT generation means the row could
 * not be read — treat that as current so a vanished/unreadable card cannot spin the download in an endless
 * regenerate loop; the caller's own 404/availability handling owns that case.
 *
 * Compared at millisecond precision: node-postgres materializes timestamps as millisecond Date objects
 * while Postgres retains microseconds, so a raw comparison would report every artifact stale forever.
 */
function isRenderedGenerationCurrent(state: ScorecardPdfArtifactState): boolean {
  if (state.currentGeneration == null) return true;
  if (state.pdfContentGeneration == null) return false;
  return toEpochMillis(state.pdfContentGeneration) === toEpochMillis(state.currentGeneration);
}

function toEpochMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TZ=UTC npx vitest run server/tests/modules/field/scorecard-pdf-artifact.runtime.test.ts`
Expected: PASS

- [ ] **Step 5: Fix both state-producing callers so the build compiles**

`ScorecardPdfArtifactState` gained required fields; two readers construct it.

In `server/src/modules/deals/scorecards-service.ts` `getDealScorecardPdfArtifactState`, add to the `.select({...})`:

```ts
      pdfContentGeneration: fieldScorecards.pdfContentGeneration,
      currentGeneration: fieldScorecards.updatedAt,
```

add both to the `.groupBy(...)` list, and add to the returned `state`:

```ts
    pdfContentGeneration: card.pdfContentGeneration,
    currentGeneration: card.currentGeneration,
```

Apply the SAME three edits in `server/src/modules/field/scorecards-service.ts`
`getFieldScorecardPdfArtifactState` (around `:1293`). **Both** must be updated — the deal tab and the
T-Rock Cam field surface each download through their own reader, and fixing one leaves the bug live on the
other.

- [ ] **Step 6: Typecheck and run the artifact + download suites**

```bash
npm run typecheck --workspace=server
TZ=UTC npx vitest run server/tests/modules/field/scorecard-pdf-artifact.runtime.test.ts server/tests/modules/field/scorecard-pdf-finalization.runtime.test.ts
```
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/field/scorecard-pdf-artifact.ts server/src/modules/deals/scorecards-service.ts server/src/modules/field/scorecards-service.ts server/tests/modules/field/scorecard-pdf-artifact.runtime.test.ts
git commit -m "fix(scorecards): regenerate the PDF when scorecard content changed"
```

---

### Task 6: Render the corrective-action section

**Files:**
- Modify: `server/src/modules/field/scorecard-pdf.ts`
- Test: `server/tests/modules/field/scorecard-pdf.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/tests/modules/field/scorecard-pdf.test.ts`:

```ts
describe("corrective-action section", () => {
  const base = {
    dealName: "Arboretum at Lewisville",
    projectNumber: "DFW-4-19426-ak",
    weekOf: "2026-07-27",
    superintendentName: "Adnaan Iqbal",
    pmName: "Addy",
    submittedByName: "Adnaan Iqbal",
    submittedAt: "2026-07-27T12:00:00.000Z",
    totalScore: 23,
    formVersion: 2 as const,
    rating: "corrective_action" as const,
    items: [],
    criticalDeficiencyKeys: [],
    actionItems: [],
  };

  it("carries corrective actions into the render model in NUMERIC item_ref order", () => {
    // Lexical ordering puts "10" before "2" — the lpad guard from #947. The PDF must match the deal thread.
    const data = buildScorecardPdfData({
      ...base,
      correctiveActions: [
        { itemType: "action_item", itemRef: "10", itemLabel: "Tenth", status: "open", responderName: null, respondedAt: null, responseComment: null, photos: [] },
        { itemType: "action_item", itemRef: "2", itemLabel: "Second", status: "open", responderName: null, respondedAt: null, responseComment: null, photos: [] },
      ],
    });

    expect(data.correctiveActions.map((c) => c.itemRef)).toEqual(["2", "10"]);
  });

  it("summarises partial and complete progress", () => {
    const partial = buildScorecardPdfData({
      ...base,
      correctiveActions: [
        { itemType: "action_item", itemRef: "1", itemLabel: "A", status: "resolved", responderName: "Addy", respondedAt: "2026-07-27T13:00:00.000Z", responseComment: "Fixed", photos: [] },
        { itemType: "action_item", itemRef: "2", itemLabel: "B", status: "open", responderName: null, respondedAt: null, responseComment: null, photos: [] },
      ],
    });
    expect(partial.correctiveActionSummary).toBe("1 of 2 resolved");

    const complete = buildScorecardPdfData({
      ...base,
      correctiveActions: [
        { itemType: "action_item", itemRef: "1", itemLabel: "A", status: "resolved", responderName: "Addy", respondedAt: "2026-07-27T13:00:00.000Z", responseComment: "Fixed", photos: [] },
      ],
    });
    expect(complete.correctiveActionSummary).toBe("All items resolved");
  });

  it("renders a PDF containing the corrective-action record", async () => {
    const data = buildScorecardPdfData({
      ...base,
      correctiveActions: [
        {
          itemType: "critical_deficiency",
          itemRef: "missed_hold_point",
          itemLabel: "Missed hold point",
          status: "resolved",
          responderName: "Addy",
          respondedAt: "2026-07-27T13:00:00.000Z",
          responseComment: "Re-inspected and signed off by the PM.",
          photos: [{ caption: "After", image: null }],
        },
      ],
    });

    const pdf = await renderFieldScorecardPdf(data);
    expect(pdf.byteLength).toBeGreaterThan(1000);
  });

  it("renders unchanged when the scorecard has no corrective actions", async () => {
    const withoutField = await renderFieldScorecardPdf(buildScorecardPdfData({ ...base }));
    const withEmpty = await renderFieldScorecardPdf(buildScorecardPdfData({ ...base, correctiveActions: [] }));
    expect(withEmpty.byteLength).toBe(withoutField.byteLength);
  });

  it("caps embedded response photos and reports the omitted count", () => {
    const photos = Array.from({ length: MAX_CORRECTIVE_ACTION_PHOTOS + 5 }, (_, i) => ({
      caption: `Photo ${i}`,
      image: null,
    }));
    const data = buildScorecardPdfData({
      ...base,
      correctiveActions: [
        { itemType: "action_item", itemRef: "1", itemLabel: "A", status: "resolved", responderName: "Addy", respondedAt: "2026-07-27T13:00:00.000Z", responseComment: "Done", photos },
      ],
    });

    expect(data.correctiveActions[0].photos).toHaveLength(MAX_CORRECTIVE_ACTION_PHOTOS);
    expect(data.omittedCorrectiveActionPhotoCount).toBe(5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TZ=UTC npx vitest run server/tests/modules/field/scorecard-pdf.test.ts`
Expected: FAIL — `correctiveActions` is not a known input property.

- [ ] **Step 3: Add the types and cap constant**

In `server/src/modules/field/scorecard-pdf.ts`, after `MAX_EVIDENCE_PHOTOS`:

```ts
// Cap the corrective-action RESPONSE photos embedded across the whole report. Separate from
// MAX_EVIDENCE_PHOTOS so a heavily-documented fix cannot crowd out the original evidence (or push the
// attachment past the provider ceiling). Overflow is reported as a count, never dropped silently.
export const MAX_CORRECTIVE_ACTION_PHOTOS = 24;
```

Add the input/model types beside `ScorecardPdfPhoto`:

```ts
export interface ScorecardPdfCorrectiveActionPhoto {
  caption: string | null;
  image: Buffer | null;
}

export interface ScorecardPdfCorrectiveAction {
  /** 'action_item' | 'critical_deficiency' */
  itemType: string;
  /** Action-item index as a string, or the critical-deficiency key. */
  itemRef: string;
  itemLabel: string;
  /** 'open' | 'resolved' */
  status: string;
  responderName: string | null;
  /** ISO timestamp, or null while open. */
  respondedAt: string | null;
  responseComment: string | null;
  photos: ScorecardPdfCorrectiveActionPhoto[];
}
```

Add to `ScorecardPdfInput`:

```ts
  /** The scorecard's corrective-action items (below-band cards only). Empty/absent renders no section. */
  correctiveActions?: ScorecardPdfCorrectiveAction[];
```

Add to `ScorecardPdfData`:

```ts
  correctiveActions: ScorecardPdfCorrectiveAction[];
  /** e.g. "1 of 2 resolved" / "All items resolved"; null when there are no corrective actions. */
  correctiveActionSummary: string | null;
  /** Response photos dropped by MAX_CORRECTIVE_ACTION_PHOTOS. */
  omittedCorrectiveActionPhotoCount: number;
}
```

- [ ] **Step 4: Populate them in `buildScorecardPdfData`**

Inside `buildScorecardPdfData`, before the return, add:

```ts
  // Numeric-aware ordering. item_ref is an action-item INDEX for action items (where "10" must follow "2",
  // not precede it — the lpad guard from #947) and an opaque key for critical deficiencies (lexical).
  // Action items sort ahead of deficiencies so the PDF matches the deal-thread order.
  const orderedCorrectiveActions = [...(input.correctiveActions ?? [])].sort((left, right) => {
    if (left.itemType !== right.itemType) return left.itemType === "action_item" ? -1 : 1;
    const leftNum = Number(left.itemRef);
    const rightNum = Number(right.itemRef);
    if (Number.isFinite(leftNum) && Number.isFinite(rightNum)) return leftNum - rightNum;
    return left.itemRef.localeCompare(right.itemRef);
  });

  // Apply the response-photo cap ACROSS the whole report, in the order items render, so the kept set is
  // deterministic rather than dependent on which item happened to be read first.
  let correctiveActionPhotoBudget = MAX_CORRECTIVE_ACTION_PHOTOS;
  let omittedCorrectiveActionPhotoCount = 0;
  const cappedCorrectiveActions = orderedCorrectiveActions.map((item) => {
    const kept = item.photos.slice(0, Math.max(0, correctiveActionPhotoBudget));
    omittedCorrectiveActionPhotoCount += item.photos.length - kept.length;
    correctiveActionPhotoBudget -= kept.length;
    return { ...item, photos: kept };
  });

  const resolvedCount = cappedCorrectiveActions.filter((item) => item.status === "resolved").length;
  const correctiveActionSummary =
    cappedCorrectiveActions.length === 0
      ? null
      : resolvedCount === cappedCorrectiveActions.length
        ? "All items resolved"
        : `${resolvedCount} of ${cappedCorrectiveActions.length} resolved`;
```

And add to the returned object:

```ts
    correctiveActions: cappedCorrectiveActions,
    correctiveActionSummary,
    omittedCorrectiveActionPhotoCount,
```

- [ ] **Step 5: Render the section**

In `renderFieldScorecardPdf`, immediately AFTER the `formVersion === 2` Signatures block and BEFORE the
`const evidenceGroups: EvidenceGroup[] = ...` line, add:

```ts
  // ── Corrective actions ──
  // Placed after the signed card body and before the original-evidence pages, so each item renders
  // self-contained: its status, response and photos stay adjacent instead of being split across the report.
  if (data.correctiveActions.length > 0) {
    doc.addPage();
    heading(doc, "Corrective Actions");
    doc.font("Helvetica").fontSize(10).fillColor(BRAND_MUTED).text(
      data.correctiveActionSummary ?? "",
      PAGE.margin,
      doc.y,
      { width: CONTENT_WIDTH },
    );
    doc.moveDown(0.6);
    for (const item of data.correctiveActions) {
      drawCorrectiveAction(doc, item);
    }
    if (data.omittedCorrectiveActionPhotoCount > 0) {
      doc.moveDown(0.4);
      doc.font("Helvetica-Oblique").fontSize(9).fillColor(BRAND_MUTED).text(
        `${data.omittedCorrectiveActionPhotoCount} additional response photo${data.omittedCorrectiveActionPhotoCount === 1 ? "" : "s"} available in the CRM.`,
        PAGE.margin,
        doc.y,
        { width: CONTENT_WIDTH },
      );
    }
  }
```

Add the drawing helper beside `drawSignature`:

```ts
// Bound one response comment so a long dictation cannot run away; the full text lives in the CRM.
const CORRECTIVE_ACTION_COMMENT_MAX_HEIGHT = 72;

function drawCorrectiveAction(doc: PDFKit.PDFDocument, item: ScorecardPdfCorrectiveAction): void {
  const resolved = item.status === "resolved";
  // Keep the label with at least its status line rather than orphaning it at a page foot.
  if (doc.y + 64 > PAGE.height - PAGE.margin) doc.addPage();

  doc.font("Helvetica-Bold").fontSize(11).fillColor(BRAND_BLACK).text(item.itemLabel, PAGE.margin, doc.y, {
    width: CONTENT_WIDTH,
  });
  doc.font("Helvetica-Bold").fontSize(9).fillColor(resolved ? "#16A34A" : BRAND_RED).text(
    resolved ? "RESOLVED" : "OPEN",
    PAGE.margin,
    doc.y + 2,
    { width: CONTENT_WIDTH },
  );

  if (resolved) {
    const who = item.responderName?.trim();
    const when = item.respondedAt ? formatDate(item.respondedAt) : null;
    const attribution = [who, when].filter(Boolean).join(" · ");
    if (attribution) {
      doc.font("Helvetica").fontSize(9).fillColor(BRAND_MUTED).text(attribution, PAGE.margin, doc.y + 2, {
        width: CONTENT_WIDTH,
      });
    }
    const comment = item.responseComment?.trim();
    if (comment) {
      doc.font("Helvetica").fontSize(10).fillColor(BRAND_BLACK).text(comment, PAGE.margin, doc.y + 4, {
        width: CONTENT_WIDTH,
        height: CORRECTIVE_ACTION_COMMENT_MAX_HEIGHT,
        ellipsis: true,
      });
    }
    drawCorrectiveActionPhotos(doc, item.photos);
  }

  doc.moveDown(0.8);
  hairline(doc);
}

/** Response photos in a 2-up grid, reusing the evidence tile geometry and its placeholder for a bad object. */
function drawCorrectiveActionPhotos(
  doc: PDFKit.PDFDocument,
  photos: ScorecardPdfCorrectiveActionPhoto[],
): void {
  if (photos.length === 0) return;
  doc.moveDown(0.4);
  for (let index = 0; index < photos.length; index += 2) {
    const row = photos.slice(index, index + 2);
    if (doc.y + EVIDENCE_ROW_HEIGHT - EVIDENCE_SUBTITLE_HEIGHT > PAGE.height - PAGE.margin) doc.addPage();
    const rowTop = doc.y;
    row.forEach((photo, column) => {
      const x = PAGE.margin + column * (EVIDENCE_IMAGE_WIDTH + 16);
      if (photo.image) {
        try {
          doc.image(photo.image, x, rowTop, { fit: [EVIDENCE_IMAGE_WIDTH, EVIDENCE_IMAGE_HEIGHT], align: "center" });
        } catch {
          drawEvidencePlaceholder(doc, x, rowTop);
        }
      } else {
        drawEvidencePlaceholder(doc, x, rowTop);
      }
      if (photo.caption) {
        doc.font("Helvetica").fontSize(8).fillColor(BRAND_MUTED).text(
          photo.caption,
          x,
          rowTop + EVIDENCE_IMAGE_HEIGHT + 4,
          { width: EVIDENCE_IMAGE_WIDTH, height: 20, ellipsis: true },
        );
      }
    });
    doc.y = rowTop + EVIDENCE_IMAGE_HEIGHT + 26;
  }
}
```

> If the existing placeholder helper is not named `drawEvidencePlaceholder`, use whatever the file already
> defines around `scorecard-pdf.ts:505` (the "Image unavailable" box) rather than adding a second one.

- [ ] **Step 6: Run the test to verify it passes**

Run: `TZ=UTC npx vitest run server/tests/modules/field/scorecard-pdf.test.ts`
Expected: PASS

- [ ] **Step 7: Raise the known-marginal render test's timeout**

`server/tests/modules/field/scorecard-pdf.runtime.test.ts > renders a large multi-photo report` already
takes ~4.7s against vitest's 5s default and times out under full-suite parallel load. This task adds work
to that path. Give it an explicit timeout as the third argument to that `it(...)`:

```ts
  }, 30_000);
```

- [ ] **Step 8: Verify the whole field PDF suite**

Run: `TZ=UTC npx vitest run server/tests/modules/field/`
Expected: PASS, including `scorecard-pdf.runtime.test.ts`

- [ ] **Step 9: Commit**

```bash
git add server/src/modules/field/scorecard-pdf.ts server/tests/modules/field/scorecard-pdf.test.ts server/tests/modules/field/scorecard-pdf.runtime.test.ts
git commit -m "feat(scorecards): render the corrective-action record in the PDF"
```

---

### Task 7: Load corrective actions into the artifact render

**Files:**
- Modify: `server/src/modules/field/scorecards-service.ts` (`renderAndStoreFieldScorecardArtifacts`)

- [ ] **Step 1: Load the corrective-action rows and their photos**

In `renderAndStoreFieldScorecardArtifacts`, inside the `runInOffice` read block, after `photoRows`:

```ts
    const correctiveActionRows = await db
      .select({
        id: scorecardCorrectiveActions.id,
        itemType: scorecardCorrectiveActions.itemType,
        itemRef: scorecardCorrectiveActions.itemRef,
        itemLabel: scorecardCorrectiveActions.itemLabel,
        status: scorecardCorrectiveActions.status,
        responderName: scorecardCorrectiveActions.responderName,
        respondedAt: scorecardCorrectiveActions.respondedAt,
        responseComment: scorecardCorrectiveActions.responseComment,
      })
      .from(scorecardCorrectiveActions)
      .where(eq(scorecardCorrectiveActions.scorecardId, scorecardId));

    // Response photos, keyed by item. These are DELIBERATELY excluded from the evidence query above
    // (corrective_action_id IS NULL) — the original-evidence pages and the corrective-action section are
    // separate sets, and the publish-time recheck fingerprint applies the same exclusion. Widening either
    // one alone produces a spurious SCORECARD_EVIDENCE_CHANGED on every regeneration.
    const correctiveActionPhotoRows = correctiveActionRows.length === 0 ? [] : await db
      .select({
        correctiveActionId: fieldScorecardPhotos.correctiveActionId,
        fileId: files.id,
        caption: files.description,
        r2Key: files.r2Key,
        thumbnailR2Key: files.thumbnailR2Key,
        mimeType: files.mimeType,
        isActive: files.isActive,
        deletedAt: files.deletedAt,
      })
      .from(fieldScorecardPhotos)
      .innerJoin(files, eq(files.id, fieldScorecardPhotos.fileId))
      .where(
        and(
          eq(fieldScorecardPhotos.scorecardId, scorecardId),
          isNotNull(fieldScorecardPhotos.correctiveActionId),
          eq(files.isActive, true),
          isNull(files.deletedAt),
        ),
      )
      // Deterministic order so the photo cap keeps the SAME photos across renders.
      .orderBy(fieldScorecardPhotos.createdAt, fieldScorecardPhotos.id);

    return { card, itemRows, photoRows, correctiveActionRows, correctiveActionPhotoRows, deal: deal ?? null };
```

Update the destructure below to include the two new arrays, and add `isNotNull` +
`scorecardCorrectiveActions` to the file's imports.

- [ ] **Step 2: Resolve the response-photo images**

After the existing evidence `photos` loading loop, add:

```ts
  // Resolve response-photo bytes through the SAME thumbnail-first pipeline as evidence, so a transient
  // storage failure stays retryable (503) and a permanently bad object renders a placeholder rather than
  // making the report unexportable. Reuses the retryable/permanent handling already applied below.
  const correctiveActionPhotos: Array<{ correctiveActionId: string; caption: string | null; resolution: Awaited<ReturnType<typeof resolveScorecardEvidenceImage>> }> = [];
  for (let index = 0; index < correctiveActionPhotoRows.length; index += PDF_EVIDENCE_DOWNLOAD_CONCURRENCY) {
    const batch = correctiveActionPhotoRows.slice(index, index + PDF_EVIDENCE_DOWNLOAD_CONCURRENCY);
    correctiveActionPhotos.push(
      ...(await Promise.all(
        batch.map(async (photo) => ({
          correctiveActionId: photo.correctiveActionId as string,
          caption: photo.caption ?? null,
          resolution: await resolveScorecardEvidenceImage(photo),
        })),
      )),
    );
  }
```

Then extend the two existing failure scans to cover both sets. Replace:

```ts
  const retryableFailure = photos.find((photo) => photo.resolution.failure?.retryable);
```
with
```ts
  const allResolvedPhotos = [...photos, ...correctiveActionPhotos];
  const retryableFailure = allResolvedPhotos.find((photo) => photo.resolution.failure?.retryable);
```

and change `const permanentFailures = photos` to `const permanentFailures = allResolvedPhotos`.

- [ ] **Step 3: Pass them to the renderer**

Add to the `buildScorecardPdfData({ ... })` call:

```ts
    correctiveActions: correctiveActionRows.map((row) => ({
      itemType: row.itemType,
      itemRef: row.itemRef,
      itemLabel: row.itemLabel,
      status: row.status,
      responderName: row.responderName ?? null,
      respondedAt: toIso(row.respondedAt),
      responseComment: row.responseComment ?? null,
      photos: correctiveActionPhotos
        .filter((photo) => photo.correctiveActionId === row.id)
        .map((photo) => ({ caption: photo.caption, image: photo.resolution.image })),
    })),
```

- [ ] **Step 4: Persist the content generation in the publish CAS**

In the guarded `UPDATE`, add to the `.set({...})`:

```ts
        pdfContentGeneration: card.updatedAt as Date,
```

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck --workspace=server
```
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/field/scorecards-service.ts
git commit -m "feat(scorecards): load corrective actions and response photos into the PDF render"
```

---

### Task 8: Bump `updated_at` on every resolve + re-finalize after a response

**Files:**
- Modify: `server/src/modules/field/corrective-actions-service.ts:118-131`
- Modify: `server/src/modules/field/corrective-action-api.ts`
- Test: new `server/tests/modules/field/scorecard-pdf-corrective-actions.runtime.test.ts`

- [ ] **Step 1: Write the failing regression test**

Create `server/tests/modules/field/scorecard-pdf-corrective-actions.runtime.test.ts`. Model the PGlite
setup on the existing `server/tests/modules/field/scorecard-corrective-actions.runtime.test.ts` (reuse its
schema bootstrap and seed helpers rather than writing new DDL). The behaviour to assert:

```ts
it("advances the scorecard generation when a NON-final item is resolved", async () => {
  // The reported bug: resolving item 1 of 2 left updated_at untouched, so the download path still
  // considered the submit-time PDF current and served a card with no corrective action on it.
  const { scorecardId, itemIds } = await seedBelowBandScorecard({ itemCount: 2 });
  const before = await readScorecardUpdatedAt(scorecardId);

  await resolveCorrectiveActionItem(db, {
    scorecardId,
    itemId: itemIds[0],
    responseComment: "Fixed",
    respondedBy: { userId: USER_ID, name: "Addy", email: "addy@trockgc.com" },
  });

  const after = await readScorecardUpdatedAt(scorecardId);
  expect(after.getTime()).toBeGreaterThan(before.getTime());

  // Still open — only one of two items answered.
  expect(await readScorecardStatus(scorecardId)).toBe("corrective_action_open");
});

it("advances the generation and closes on the final item", async () => {
  const { scorecardId, itemIds } = await seedBelowBandScorecard({ itemCount: 1 });
  const before = await readScorecardUpdatedAt(scorecardId);

  await resolveCorrectiveActionItem(db, {
    scorecardId,
    itemId: itemIds[0],
    responseComment: "Fixed",
    respondedBy: { userId: USER_ID, name: "Addy", email: "addy@trockgc.com" },
  });

  expect((await readScorecardUpdatedAt(scorecardId)).getTime()).toBeGreaterThan(before.getTime());
  expect(await readScorecardStatus(scorecardId)).toBe("corrective_action_closed");
});

it("does not advance the generation on an idempotent re-resolve", async () => {
  // A no-op must not invalidate the artifact — that would re-render on every duplicate submit.
  const { scorecardId, itemIds } = await seedBelowBandScorecard({ itemCount: 1 });
  await resolveCorrectiveActionItem(db, { scorecardId, itemId: itemIds[0], responseComment: "Fixed", respondedBy: { userId: USER_ID, name: "Addy", email: "addy@trockgc.com" } });
  const afterFirst = await readScorecardUpdatedAt(scorecardId);

  await resolveCorrectiveActionItem(db, { scorecardId, itemId: itemIds[0], responseComment: "Again", respondedBy: { userId: USER_ID, name: "Addy", email: "addy@trockgc.com" } });

  expect((await readScorecardUpdatedAt(scorecardId)).getTime()).toBe(afterFirst.getTime());
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TZ=UTC npx vitest run server/tests/modules/field/scorecard-pdf-corrective-actions.runtime.test.ts`
Expected: FAIL on the first case — `after` equals `before` (the non-final resolve does not touch the row).

- [ ] **Step 3: Bump `updated_at` on every successful resolve**

In `resolveCorrectiveActionItemTx`, replace the auto-close-only update with an unconditional generation
bump plus the conditional status flip:

```ts
  const stillOpen = await tx
    .select({ id: scorecardCorrectiveActions.id })
    .from(scorecardCorrectiveActions)
    .where(
      and(
        eq(scorecardCorrectiveActions.scorecardId, input.scorecardId),
        eq(scorecardCorrectiveActions.status, "open"),
      ),
    );

  // Advance the scorecard generation on EVERY winning resolve, not only on the auto-close. The stored PDF
  // artifact's staleness is keyed on updated_at (migration 0200), so without this a response to item 1 of 3
  // would leave the download serving the pre-corrective-action PDF — the reported bug. It is also what
  // makes finalizeFieldScorecardArtifacts' single-flight key (updated_at) start a fresh render instead of
  // coalescing onto the stale in-flight one.
  //
  // Reached only when `updated.length > 0` (an idempotent re-resolve returned false above), so a duplicate
  // submit does not churn the artifact.
  await tx
    .update(fieldScorecards)
    .set(
      stillOpen.length === 0
        ? { status: "corrective_action_closed", updatedAt: new Date() }
        : { updatedAt: new Date() },
    )
    .where(eq(fieldScorecards.id, input.scorecardId));

  return true;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TZ=UTC npx vitest run server/tests/modules/field/scorecard-pdf-corrective-actions.runtime.test.ts`
Expected: PASS

- [ ] **Step 5: Re-finalize the artifact after a response**

In `server/src/modules/field/corrective-action-api.ts`, after the transaction that wraps the
`resolveCorrectiveActionItemTx` call at `:369` has COMMITTED, add a post-commit background re-render.
Follow the existing pattern in `server/src/modules/field/routes.ts:1042`:

```ts
  // Refresh the stored PDF so a download right after a response already carries the corrective-action
  // record. Best-effort and post-commit: R2 I/O must never hold the transaction open, and a failure is
  // harmless because needsScorecardPdfRegeneration now detects the stale generation and re-renders on
  // demand. This only shortens the window where a download pays for the render.
  void finalizeFieldScorecardArtifacts(office, userId, scorecardId).catch((err) => {
    console.error("[CorrectiveAction] Post-response PDF refresh failed", { scorecardId, err });
  });
```

Import `finalizeFieldScorecardArtifacts` from `./scorecards-service.js`. Confirm the office and user id are
in scope at that point; if the token-authed path lacks a session user, pass the scorecard's `submitted_by`
(the same attribution the token upload path already uses — see the round-4 finding in the #947 notes).

- [ ] **Step 6: Run the corrective-action suites and typecheck**

```bash
npm run typecheck --workspace=server
TZ=UTC npx vitest run server/tests/modules/field/
```
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/field/corrective-actions-service.ts server/src/modules/field/corrective-action-api.ts server/tests/modules/field/scorecard-pdf-corrective-actions.runtime.test.ts
git commit -m "fix(scorecards): invalidate and refresh the PDF when a corrective action is answered"
```

---

### Task 9: Phase 2 full-gate checkpoint

- [ ] **Step 1: Run the complete pre-merge gate**

```bash
npm run build --workspace=@trock-crm/shared
npm run check:premerge
```
Expected: PASS. (Keyword-filtered vitest runs skip SQL-string-assertion tests, so the full gate is the only
trustworthy signal — this is the gotcha that produced a red gate on #866.)

- [ ] **Step 2: Run the server runtime suite**

```bash
TZ=UTC npm run test:runtime --workspace=server
```
Expected: PASS. `check:premerge` does NOT include this suite but CI does — the gotcha that produced a red
gate on #868. A new column-READ must exist in every hand-written PGlite `field_scorecards` DDL; if any
runtime test fails on a missing `pdf_content_generation`, add the column to that test's DDL.

- [ ] **Step 3: Commit any DDL fixes**

```bash
git add -A
git commit -m "test(scorecards): add pdf_content_generation to runtime-test schemas"
```

---

# Phase 3 — Oversight email

### Task 10: Migration + schema for the oversight stamps

**Files:**
- Create: `migrations/0201_field_scorecards_corrective_action_oversight_stamps.sql`
- Modify: `shared/src/schema/tenant/field-scorecards.ts`

- [ ] **Step 1: Write the migration**

```sql
-- Migration 0201: field_scorecards.corrective_action_oversight_opened_at / _closed_at — per-cycle
-- idempotency stamps for the OVERSIGHT notification (the FIELD_SCORECARD_EMAIL_RECIPIENTS watchers who are
-- told a corrective action opened and completed).
--
-- Deliberately SEPARATE from corrective_action_email_sent_at. That stamp governs the RESPONDER notification
-- state machine: it suppresses duplicate responder sends and gates the server reconcile's re-enqueue
-- decision. Letting an oversight-send failure write to it would corrupt responder delivery.
--
-- Both are cleared wherever a genuinely new cycle starts — i.e. every site that resets
-- corrective_action_email_sent_at to NULL (the reconcile enqueue and the shared restart helper behind
-- restartCorrectiveActionNotificationCycleForDeal / ...ForResponder) — so a reopen re-notifies oversight
-- while a queue retry never double-sends.
--
-- Per-tenant (office_* schemas), idempotent + guarded per schema.

DO $tenant$
DECLARE schema_name text;
BEGIN
  FOR schema_name IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^office_' ORDER BY nspname LOOP
    IF to_regclass(format('%I.field_scorecards', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format(
      'ALTER TABLE %I.field_scorecards
         ADD COLUMN IF NOT EXISTS corrective_action_oversight_opened_at timestamptz,
         ADD COLUMN IF NOT EXISTS corrective_action_oversight_closed_at timestamptz',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.field_scorecards
  ADD COLUMN IF NOT EXISTS corrective_action_oversight_opened_at timestamptz,
  ADD COLUMN IF NOT EXISTS corrective_action_oversight_closed_at timestamptz;
-- TENANT_SCHEMA_END
```

- [ ] **Step 2: Add the Drizzle columns**

In `shared/src/schema/tenant/field-scorecards.ts`, after `correctiveActionCycleNonce`:

```ts
    /**
     * Per-cycle idempotency stamps for the OVERSIGHT notification (migration 0201) — the
     * FIELD_SCORECARD_EMAIL_RECIPIENTS watchers, told once when a corrective action opens and once when it
     * completes. Separate from correctiveActionEmailSentAt on purpose: that stamp drives the RESPONDER
     * state machine, and an oversight-send failure must not be able to corrupt responder delivery.
     * Cleared wherever a fresh cycle starts, so a reopen re-notifies but a retry never doubles.
     */
    correctiveActionOversightOpenedAt: timestamp("corrective_action_oversight_opened_at", { withTimezone: true }),
    correctiveActionOversightClosedAt: timestamp("corrective_action_oversight_closed_at", { withTimezone: true }),
```

- [ ] **Step 3: Rebuild shared, verify migration**

```bash
npm run build --workspace=@trock-crm/shared
TZ=UTC npx vitest run server/tests/modules/field/scorecards-migration.runtime.test.ts
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add migrations/0201_field_scorecards_corrective_action_oversight_stamps.sql shared/src/schema/tenant/field-scorecards.ts
git commit -m "feat(scorecards): add corrective-action oversight notification stamps"
```

---

### Task 11: The oversight email worker job

**Files:**
- Create: `worker/src/jobs/scorecard-corrective-action-oversight-email.ts`
- Create: `worker/tests/jobs/scorecard-corrective-action-oversight-email.test.ts`
- Modify: `worker/src/jobs/index.ts`

Read `worker/src/jobs/scorecard-corrective-action-email.ts` and
`worker/src/jobs/field-scorecard-email.ts` first — reuse their helpers (`resolveFieldScorecardRecipients`,
`dedupeEmails`, `isBasicValidEmail`, `sendSystemEmailWithMetadata`, `escapeHtml`, `normalizeText`,
`isSafeTenantSchema`, `resolveFrontendUrl`, `TROCK_LOGO_EMAIL_URL`) rather than reimplementing them.

- [ ] **Step 1: Write the failing test**

Create `worker/tests/jobs/scorecard-corrective-action-oversight-email.test.ts`. Model the harness on the
existing `worker/tests/jobs/scorecard-corrective-action-email.test.ts` (injected `query` + `sendEmail`
deps, no real DB). Behaviours:

```ts
describe("handleScorecardCorrectiveActionOversightEmail", () => {
  it("sends the opened notice to the configured recipients", async () => { /* asserts one send, subject names the project + 'Corrective action required' */ });

  it("sends the completed notice with the scorecard PDF attached", async () => { /* phase: 'closed', asserts an attachment is present */ });

  it("degrades to a no-attachment send when the PDF object is unavailable", async () => { /* still sends */ });

  it("NEVER includes a corrective-action token in the body", async () => {
    // The responder email carries a per-recipient token that AUTHORIZES answering. An oversight watcher
    // must never receive one. This is the invariant that makes a separate email mandatory over a CC.
    const html = capturedSend.mock.calls[0][2];
    expect(html).not.toMatch(/token=/i);
    expect(html).not.toMatch(/\/scorecards\/[0-9a-f-]+\/corrective-actions\?/i);
  });

  it("subtracts the cycle's responders from the oversight recipient list", async () => {
    // A superintendent who is also on FIELD_SCORECARD_EMAIL_RECIPIENTS gets "please fix this", not both.
  });

  it("logs and returns without throwing when no recipients are configured", async () => {
    // Supplementary notification: responders were already told by their own job, so a dead-letter is noise.
    await expect(handle(payload, null, deps)).resolves.toBeUndefined();
    expect(capturedSend).not.toHaveBeenCalled();
  });

  it("skips when the phase stamp is already set (retry does not double-send)", async () => { /* opened_at set -> no send */ });

  it("does NOT skip when the stored cycle nonce has moved on", async () => {
    // The responder job's worker-side self-repair path rotates corrective_action_cycle_nonce and
    // re-enqueues itself. A pending oversight job minted with the older nonce must STILL send — gating on
    // a nonce match here would silently strand the opened notice. Dedup is the stamp, not the nonce.
    await handle({ ...payload, cycleNonce: OLD_NONCE }, null, deps);
    expect(capturedSend).toHaveBeenCalledTimes(1);
  });

  it("uses a phase- and cycle-scoped Resend idempotency key", async () => {
    expect(capturedSend.mock.calls[0][3].idempotencyKey).toBe(
      `corrective-action-oversight-office_dallas-${SCORECARD_ID}-opened-cycle-${CYCLE_NONCE}`,
    );
  });

  it("stamps only its own phase column", async () => { /* opened run must not write closed_at */ });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TZ=UTC npx vitest run worker/tests/jobs/scorecard-corrective-action-oversight-email.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the handler**

Create `worker/src/jobs/scorecard-corrective-action-oversight-email.ts`:

```ts
export const SCORECARD_CORRECTIVE_ACTION_OVERSIGHT_EMAIL_JOB =
  "scorecard_corrective_action_oversight_email";

export interface ScorecardCorrectiveActionOversightEmailPayload {
  tenantSchema?: string;
  scorecardId?: string;
  dealId?: string;
  officeId?: string | null;
  /** 'opened' when the corrective action opened; 'closed' when the last item was answered. */
  phase?: "opened" | "closed";
  /** The cycle nonce active at enqueue. Used ONLY as the Resend idempotency-key dimension. */
  cycleNonce?: string;
}
```

Handler contract, in order:

1. Validate `tenantSchema` (`isSafeTenantSchema`), `scorecardId`, and `phase`. Invalid → log + return.
2. `SELECT` the scorecard: status, project/deal fields, score, rating, week_of, `pdf_r2_key`, and BOTH
   oversight stamps. Missing row → log + return.
3. **Dedup on the phase's stamp only.** `opened` reads `corrective_action_oversight_opened_at`, `closed`
   reads `corrective_action_oversight_closed_at`. Already set → return without sending.
   **Do NOT compare `payload.cycleNonce` against the stored nonce.** The responder job's self-repair path
   rotates the stored nonce and re-enqueues itself; a nonce gate here would strand the notice.
4. Resolve recipients: `resolveFieldScorecardRecipients(env)` minus the cycle's responder emails
   (resolved with the same SQL the responder job uses — reuse `recipientResolutionSql`). Empty → log and
   return, do NOT throw.
5. Load the corrective-action items for the body. For `closed`, also fetch the PDF from
   `pdf_r2_key`; a missing/unfetchable object degrades to a no-attachment send (logged), matching
   `handleFieldScorecardEmail`.
6. Send ONE email to the deduped recipient list with idempotency key
   `corrective-action-oversight-${tenantSchema}-${scorecardId}-${phase}-cycle-${cycleNonce ?? "none"}`.
7. Stamp ONLY the phase's own column: `UPDATE ... SET corrective_action_oversight_<phase>_at = NOW()
   WHERE id = $1 AND corrective_action_oversight_<phase>_at IS NULL`. Use a fixed column name chosen by a
   literal switch on `phase` — never interpolate the phase string into SQL.
8. On send failure, throw so the queue retries (max_attempts, then dead-letter).

Body content — `opened`: project name, project number, week of, score + rating band, the flagged items,
the names of who was asked to respond, and a link to the deal's Scorecards tab via `resolveFrontendUrl`.
`closed`: the same header plus, per item, the responder, timestamp, comment and photo count.
**Neither body contains a token or a `/scorecards/:id/corrective-actions` responder link.**

- [ ] **Step 4: Register the job type**

In `worker/src/jobs/index.ts`, register `SCORECARD_CORRECTIVE_ACTION_OVERSIGHT_EMAIL_JOB` →
`handleScorecardCorrectiveActionOversightEmail`, following exactly how
`scorecard_corrective_action_email` is registered.

- [ ] **Step 5: Run the test to verify it passes**

Run: `TZ=UTC npx vitest run worker/tests/jobs/scorecard-corrective-action-oversight-email.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/jobs/scorecard-corrective-action-oversight-email.ts worker/tests/jobs/scorecard-corrective-action-oversight-email.test.ts worker/src/jobs/index.ts
git commit -m "feat(scorecards): oversight email job for corrective-action open and completion"
```

---

### Task 12: Enqueue both phases and clear the stamps on a fresh cycle

**Files:**
- Modify: `server/src/modules/field/corrective-actions-service.ts`
- Test: `server/tests/modules/field/scorecard-corrective-actions.runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/tests/modules/field/scorecard-corrective-actions.runtime.test.ts`:

```ts
it("enqueues an oversight 'opened' job alongside the responder job when a cycle starts", async () => {
  const { scorecardId } = await seedBelowBandScorecard({ itemCount: 2 });
  const jobs = await readQueuedJobs(scorecardId);

  const oversight = jobs.filter((j) => j.job_type === "scorecard_corrective_action_oversight_email");
  expect(oversight).toHaveLength(1);
  expect(JSON.parse(oversight[0].payload).phase).toBe("opened");
  // Same cycle as the responder job — the Resend key dimension must agree.
  const responder = jobs.find((j) => j.job_type === "scorecard_corrective_action_email");
  expect(JSON.parse(oversight[0].payload).cycleNonce).toBe(JSON.parse(responder!.payload).cycleNonce);
});

it("enqueues an oversight 'closed' job when the last item is answered", async () => {
  const { scorecardId, itemIds } = await seedBelowBandScorecard({ itemCount: 1 });
  await clearQueuedJobs(scorecardId);

  await resolveCorrectiveActionItem(db, { scorecardId, itemId: itemIds[0], responseComment: "Fixed", respondedBy: { userId: USER_ID, name: "Addy", email: "addy@trockgc.com" } });

  const jobs = await readQueuedJobs(scorecardId);
  const oversight = jobs.filter((j) => j.job_type === "scorecard_corrective_action_oversight_email");
  expect(oversight).toHaveLength(1);
  expect(JSON.parse(oversight[0].payload).phase).toBe("closed");
});

it("does NOT enqueue a closed job when a non-final item is answered", async () => {
  const { scorecardId, itemIds } = await seedBelowBandScorecard({ itemCount: 2 });
  await clearQueuedJobs(scorecardId);

  await resolveCorrectiveActionItem(db, { scorecardId, itemId: itemIds[0], responseComment: "Fixed", respondedBy: { userId: USER_ID, name: "Addy", email: "addy@trockgc.com" } });

  const jobs = await readQueuedJobs(scorecardId);
  expect(jobs.filter((j) => j.job_type === "scorecard_corrective_action_oversight_email")).toHaveLength(0);
});

it("clears BOTH oversight stamps when a fresh cycle starts", async () => {
  // A reopen must re-notify oversight. Clearing at the reconcile site but not the restart helper (or vice
  // versa) leaves responders re-notified while oversight stays silent.
  const { scorecardId } = await seedBelowBandScorecard({ itemCount: 1 });
  await stampOversight(scorecardId, { opened: true, closed: true });

  await restartCorrectiveActionNotificationCycleForDeal(db, DEAL_ID);

  const row = await readScorecardOversightStamps(scorecardId);
  expect(row.corrective_action_oversight_opened_at).toBeNull();
  expect(row.corrective_action_oversight_closed_at).toBeNull();
});

it("does NOT enqueue an oversight job when an edit cancels the cycle above band", async () => {
  // A card lifted above band walks to `submitted` and deletes its items — a cancellation, not a
  // correction. Nothing was fixed, so there is nothing to report.
  const { scorecardId } = await seedBelowBandScorecard({ itemCount: 1 });
  await clearQueuedJobs(scorecardId);

  await editScorecardAboveBand(scorecardId);

  const jobs = await readQueuedJobs(scorecardId);
  expect(jobs.filter((j) => j.job_type === "scorecard_corrective_action_oversight_email")).toHaveLength(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TZ=UTC npx vitest run server/tests/modules/field/scorecard-corrective-actions.runtime.test.ts`
Expected: FAIL — no oversight jobs are enqueued.

- [ ] **Step 3: Enqueue the `opened` phase**

In `reconcileScorecardCorrectiveActions`, inside the existing
`if (transitioningIntoOpen || alreadyOpenGainedWork || alreadyOpenResponderChanged) { ... }` block, after
the responder job is enqueued, enqueue the oversight job with the SAME `cycleNonce` and
`phase: "opened"`, in the same transaction.

Extend the `.set({ correctiveActionEmailSentAt: null, correctiveActionCycleNonce: cycleNonce })` at `:521`
to also clear both oversight stamps:

```ts
      .set({
        correctiveActionEmailSentAt: null,
        correctiveActionCycleNonce: cycleNonce,
        // A fresh cycle must re-notify oversight too. See migration 0201.
        correctiveActionOversightOpenedAt: null,
        correctiveActionOversightClosedAt: null,
      })
```

- [ ] **Step 4: Clear the stamps at the OTHER reset site**

Apply the same two null-outs to the restart helper's `.set({...})` at `:660` (the one behind
`restartCorrectiveActionNotificationCycleForDeal` and `restartCorrectiveActionNotificationCycleForResponder`).
Verify with:

```bash
grep -n "correctiveActionEmailSentAt: null" server/src/modules/field/corrective-actions-service.ts
```
Every hit must now also null both oversight stamps.

- [ ] **Step 5: Enqueue the `closed` phase**

In `resolveCorrectiveActionItemTx`, inside the `stillOpen.length === 0` branch (same transaction as the
status flip), enqueue the oversight job with `phase: "closed"`, reading the scorecard's current
`corrective_action_cycle_nonce` for the payload.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `TZ=UTC npx vitest run server/tests/modules/field/scorecard-corrective-actions.runtime.test.ts server/tests/modules/field/scorecard-pdf-corrective-actions.runtime.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/field/corrective-actions-service.ts server/tests/modules/field/scorecard-corrective-actions.runtime.test.ts
git commit -m "feat(scorecards): notify oversight when a corrective action opens and completes"
```

---

### Task 13: Phase 3 full-gate checkpoint

- [ ] **Step 1: Full gate + runtime suite**

```bash
npm run build --workspace=@trock-crm/shared
npm run check:premerge
TZ=UTC npm run test:runtime --workspace=server
TZ=UTC npx vitest run worker/
```
Expected: all PASS. Fix any hand-written PGlite `field_scorecards` DDL missing the new columns.

- [ ] **Step 2: Commit any fixes**

```bash
git add -A
git commit -m "test(scorecards): add oversight stamp columns to runtime-test schemas"
```

---

# Phase 4 — Review and drive to green

### Task 14: Adversarial pre-PR review

Per the standing working agreement, run a heavy multi-lens adversarial review BEFORE `gh pr create`. This
is the ONLY place subagents are used, and they are **read-only**: point each at SHAs (`git show <sha>` —
the object DB is shared across worktrees) or at this worktree's absolute path. No subagent may edit or
commit.

- [ ] **Step 1: Dispatch review subagents with distinct lenses**

Run concurrently, each returning findings with file:line evidence:

1. **Correctness + concurrency** — the `resolveCorrectiveActionItemTx` generation bump under the FOR UPDATE
   lock; the publish CAS with `pdf_content_generation` added; two responders closing the final two items;
   the single-flight key vs a concurrent resolve.
2. **Idempotency / state machine** — oversight stamps vs the responder `corrective_action_email_sent_at`
   machine; the deliberate absence of a nonce gate; reopen/cancel/restart transitions; retry double-send.
3. **DB integrity + rollout** — migrations 0200/0201 (tenant DO-loop AND `TENANT_SCHEMA_START/END`);
   NULL semantics on every new column; behaviour of an old server instance during a rolling deploy against
   the new columns; the monotonic `pdf_render_version` write.
4. **Security** — that no corrective-action token or responder link can reach an oversight recipient by any
   path; that no unvalidated `data:` URI reaches an `<img src>` or `doc.image()`; that `phase` is never
   interpolated into SQL.
5. **Reconciliation consistency** — both artifact-state readers updated together (deal tab AND field
   surface); the evidence-vs-response photo filter symmetry between the initial read and the publish
   recheck; PDF item ordering matching the deal-thread ordering.
6. **Refute pass** — a skeptic told to REFUTE the other agents' findings, defaulting to refuted when
   uncertain.

- [ ] **Step 2: Verify each surviving finding against current code, then fix it**

Do not blind-fix. Confirm with evidence, fix genuinely-open findings with a real fix (never a `.skip`), and
add a runnable test per substantive finding. Record any finding skipped and why.

- [ ] **Step 3: Re-run the full gate and commit fixes**

```bash
npm run build --workspace=@trock-crm/shared
npm run check:premerge
TZ=UTC npm run test:runtime --workspace=server
```

---

### Task 15: Open the PR

- [ ] **Step 1: Push and open**

```bash
git push -u origin feat/scorecard-corrective-action-followups
gh pr create --base main --title "fix(scorecards): corrective-action follow-ups — signatures, PDF record, oversight email" --body "<body>"
```

PR body must cover: the three reported symptoms; root cause per symptom; the render-version bump and what
it repairs on existing artifacts; both migrations; the deliberate no-CC / separate-email decision and why;
the deliberate absence of a nonce gate on the oversight job; and the fact that oversight recipients reuse
`FIELD_SCORECARD_EMAIL_RECIPIENTS` (so a watcher also receives every routine submitted scorecard).

Include the trailer:
```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01Fmgbdvhku1QU7XcPZj4vwJ
```

- [ ] **Step 2: Trigger the review bots**

```bash
gh pr comment <N> --repo <owner/repo> --body "@codex review"
gh pr comment <N> --repo <owner/repo> --body "@coderabbitai review"
```
Greptile reviews automatically. **Do NOT trigger `@macroscope-app` — retired 2026-07-25.**

---

### Task 16: Drive to green autonomously

- [ ] **Step 1: Poll until all signals settle on the EXACT pushed tip**

Poll the build gate, Codex (`chatgpt-codex-connector`), CodeRabbit, and Greptile. Re-anchor by
`created_at`, not `commit_id`.

Two traps:
- **A failed Codex run looks exactly like a pending one.** Read the summary TEXT — `Codex Review: Something
  went wrong… Unknown error` is a failure, not a queue. Treat silence as unreviewed, never as approval.
- **Codex lags, sometimes several commits behind.** Check the `Reviewed commit: <sha>` it names before
  treating a finding as current.
- **CodeRabbit rate-limits** and still reports the check as `pass` while limited.

- [ ] **Step 2: Fix every genuinely-open finding**

Verify against current code with evidence first — some will already be addressed. Real fixes only, a test
per substantive finding. Push to the same PR.

- [ ] **Step 3: Re-trigger and repeat**

Re-comment `@codex review` and `@coderabbitai review` on the new tip. Wait for the new round. Repeat
fix → validate → push → re-trigger until one full round is 0-open and the gate is green.

- [ ] **Step 4: Surface only when clean**

Report: `100% clean on <tip>: gate green, Codex 0 open, CodeRabbit 0 open, Greptile 0 open` plus a
one-line summary of what the final round resolved. Surface mid-cycle ONLY for a genuine decision or to push
back on a finding with evidence. Do not self-merge — Adnaan merges.

---

## Post-merge follow-ups (NOT part of this PR)

- The v3 render-version bump means the first download of every existing scorecard pays for a re-render.
  Expected and self-limiting, but worth watching for 503 `SCORECARD_PDF_REGENERATION_FAILED` rates after
  deploy.
- If oversight watchers find the routine per-scorecard email noisy, split oversight onto its own env var
  (`CORRECTIVE_ACTION_OVERSIGHT_RECIPIENTS`) — a small, self-contained change.
