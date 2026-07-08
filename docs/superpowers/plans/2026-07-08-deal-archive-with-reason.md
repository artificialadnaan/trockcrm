# Deal Archiving + RFP Denial Auto-Archive — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reframe deal soft-delete as "Archive" — a rep can archive an opportunity-stage deal they own with a required reason prepended to the description; and when an RFP denial is reconfirmed by either reviewer (Adam/Takashi), the deal auto-archives with the voter+reviewer notes prepended to the description.

**Architecture:** No schema migration — rides existing `deals.is_active`, `deals.description`, and the RFP override columns. One shared pure helper `buildArchivedDescription` prepends an archive block; both the manual path (`deleteDeal`) and the RFP path (`reconfirmRfpDecline`) call it and record a `deal_history` description entry via the existing `recordDescriptionHistoryChange`. Delivered as two PRs (A then B).

**Tech Stack:** Express + Drizzle (per-office Postgres schemas), React + Base UI/Tailwind, Vitest + PGlite runtime tests.

**Spec:** `docs/superpowers/specs/2026-07-08-deal-archive-with-reason-design.md`

**Worktree:** `/Users/adnaaniqbal/Developer/trockcrm-wt-archive` on branch `feat/deal-archive-with-reason` (off `origin/main`).

---

## File Structure

**PR 1 — Feature A (manual archive + rename)**
- Create `server/src/modules/deals/archive-description.ts` — pure `buildArchivedDescription` + `businessDateStamp` (America/Chicago).
- Create `server/src/modules/deals/archive-description.test.ts` — unit tests for the helper.
- Modify `server/src/modules/deals/service.ts` — `deleteDeal` new signature (options object), remove dead admin stub, opportunity stage gate for non-admins, required reason, description write + history record.
- Modify `server/src/modules/deals/routes.ts` — `DELETE /:id` threads real role + required reason.
- Create `server/tests/modules/deals/archive-deal.runtime.test.ts` — PGlite gate for the archive rules.
- Modify `client/src/hooks/use-deals.ts` — client `deleteDeal(dealId, reason)`.
- Create `client/src/pages/deals/deal-archive-eligibility.ts` — pure `canArchiveDeal(deal, user)`.
- Create `client/src/pages/deals/deal-archive-eligibility.test.ts` — unit tests.
- Modify `client/src/pages/deals/deal-detail-page.tsx` — "Archive Deal" menu (gated), reason modal, accurate copy.
- Modify `client/src/components/filters/filter-bar.tsx` — status label "Removed" → "Archived".

**PR 2 — Feature B (RFP reconfirm auto-archive)**
- Modify `server/src/modules/deals/routes.ts` — reconfirm route requires the reviewer note.
- Modify `server/src/modules/deals/rfp-override-service.ts` — `reconfirmRfpDecline` auto-archives + prepends combined notes + history record.
- Create `server/tests/modules/deals/rfp-reconfirm-archive.runtime.test.ts` — PGlite gate.
- Modify `client/src/pages/rfp-review/rfp-review-page.tsx` — require note before reconfirm.

---

# PR 1 — Feature A: Archive rename + manual rep archive with reason

### Task 1: Shared `buildArchivedDescription` helper

**Files:**
- Create: `server/src/modules/deals/archive-description.ts`
- Test: `server/src/modules/deals/archive-description.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/modules/deals/archive-description.test.ts
import { describe, expect, it } from "vitest";
import { buildArchivedDescription, businessDateStamp } from "./archive-description.js";

const AT = new Date("2026-07-08T18:00:00Z"); // 1pm America/Chicago (CDT)

describe("businessDateStamp", () => {
  it("formats the America/Chicago calendar day as YYYY-MM-DD", () => {
    expect(businessDateStamp(AT)).toBe("2026-07-08");
    // 00:30 UTC on Jul 9 is still Jul 8 in Chicago
    expect(businessDateStamp(new Date("2026-07-09T00:30:00Z"))).toBe("2026-07-08");
  });
});

describe("buildArchivedDescription", () => {
  it("prepends an archive block above the existing description", () => {
    expect(buildArchivedDescription("Roof scope, 3 buildings.", "Lost to competitor", AT)).toBe(
      "[Archived 2026-07-08 — Lost to competitor]\n\nRoof scope, 3 buildings."
    );
  });

  it("returns just the block when there is no prior description", () => {
    expect(buildArchivedDescription(null, "Duplicate", AT)).toBe("[Archived 2026-07-08 — Duplicate]");
    expect(buildArchivedDescription("   ", "Duplicate", AT)).toBe("[Archived 2026-07-08 — Duplicate]");
  });

  it("trims the reason", () => {
    expect(buildArchivedDescription(null, "  spaced  ", AT)).toBe("[Archived 2026-07-08 — spaced]");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/modules/deals/archive-description.test.ts`
Expected: FAIL — "Cannot find module './archive-description.js'".

- [ ] **Step 3: Write the implementation**

```ts
// server/src/modules/deals/archive-description.ts
import { BUSINESS_TIMEZONE } from "../../lib/period.js";

/** "YYYY-MM-DD" for the America/Chicago calendar day of `at` (DST-safe via Intl; en-CA yields YYYY-MM-DD). */
export function businessDateStamp(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * Prepend an archive block to a deal's description, preserving the original.
 * Empty/whitespace `existing` → just the block (no leading blank lines). `reason` is trimmed;
 * callers guarantee it is non-empty.
 */
export function buildArchivedDescription(
  existing: string | null | undefined,
  reason: string,
  at: Date,
): string {
  const block = `[Archived ${businessDateStamp(at)} — ${reason.trim()}]`;
  const prior = (existing ?? "").trim();
  return prior.length > 0 ? `${block}\n\n${prior}` : block;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/modules/deals/archive-description.test.ts`
Expected: PASS (5 assertions).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/deals/archive-description.ts server/src/modules/deals/archive-description.test.ts
git commit -m "feat(deals): add buildArchivedDescription archive-block helper"
```

---

### Task 2: `deleteDeal` — required reason, stage gate, description write

**Files:**
- Modify: `server/src/modules/deals/service.ts:2939-3021` (`deleteDeal`)
- Test: `server/tests/modules/deals/archive-deal.runtime.test.ts` (create)

**Context:** `deleteDeal`'s only caller is `routes.ts:3835`. Its `if (userRole !== "admin") throw` (line 2940) is dead (route passes hardcoded `"admin"`) — replace it. `existing` is loaded `FOR UPDATE` and has `.description`, `.stageId`, `.isChangeOrder`. Add imports at the top of `service.ts`: `buildArchivedDescription` from `./archive-description.js`, `pipelineStageConfig` from `@trock-crm/shared/schema` (already exported; used by auth/reporting services). `recordDescriptionHistoryChange` is already imported (`service.ts:73`).

- [ ] **Step 1: Write the failing runtime test**

```ts
// server/tests/modules/deals/archive-deal.runtime.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { deleteDeal } from "../../../src/modules/deals/service.js";

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const REP = U("re01");
const OPP_STAGE = U("50a1");
const AWARDED_STAGE = U("50a2");
const D_OPP = U("d001");
const D_AWARDED = U("d002");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text NOT NULL);
    INSERT INTO pipeline_stage_config (id, slug) VALUES
      ('${OPP_STAGE}', 'opportunity'), ('${AWARDED_STAGE}', 'awarded');
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text, deal_number text, project_number text,
      stage_id uuid NOT NULL, description text, is_active boolean NOT NULL DEFAULT true,
      is_change_order boolean NOT NULL DEFAULT false, parent_deal_id uuid,
      assigned_rep_id uuid, updated_at timestamptz DEFAULT now()
    );
    INSERT INTO deals (id, name, stage_id, description, assigned_rep_id) VALUES
      ('${D_OPP}', 'Opp Deal', '${OPP_STAGE}', 'Original scope.', '${REP}'),
      ('${D_AWARDED}', 'Awarded Deal', '${AWARDED_STAGE}', 'Original scope.', '${REP}');
    CREATE TABLE deal_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid NOT NULL, field_name text NOT NULL,
      old_value text, new_value text, changed_by uuid NOT NULL, source text, changed_at timestamptz DEFAULT now()
    );
    CREATE TABLE tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid, status text, is_overdue boolean);
    CREATE TABLE projects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_deal_id uuid, is_active boolean, updated_at timestamptz);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => { await pg?.close?.(); });

describe("deleteDeal archive rules", () => {
  it("rejects an empty reason", async () => {
    await expect(deleteDeal(tdb, D_OPP, { actorRole: "rep", actorId: REP, reason: "  " })).rejects.toMatchObject({
      statusCode: 400, code: "DEAL_ARCHIVE_REASON_REQUIRED",
    });
  });

  it("blocks a rep archiving a non-opportunity deal", async () => {
    await expect(
      deleteDeal(tdb, D_AWARDED, { actorRole: "rep", actorId: REP, reason: "no", enforceOpportunityStageForNonAdmin: true })
    ).rejects.toMatchObject({ statusCode: 403, code: "DEAL_ARCHIVE_STAGE_FORBIDDEN" });
  });

  it("archives an opportunity deal for a rep, prepending the reason to the description", async () => {
    const row = await deleteDeal(tdb, D_OPP, {
      actorRole: "rep", actorId: REP, reason: "Lost to competitor", enforceOpportunityStageForNonAdmin: true,
    });
    expect(row?.isActive).toBe(false);
    expect(row?.description).toMatch(/^\[Archived \d{4}-\d{2}-\d{2} — Lost to competitor\]\n\nOriginal scope\.$/);
    const hist = await pg.query(`SELECT field_name, source FROM deal_history WHERE deal_id = '${D_OPP}'`);
    expect(hist.rows).toContainEqual({ field_name: "description", source: "deal_archive" });
  });

  it("lets an admin archive a non-opportunity deal", async () => {
    const row = await deleteDeal(tdb, D_AWARDED, {
      actorRole: "admin", actorId: REP, reason: "Admin cleanup", enforceOpportunityStageForNonAdmin: true,
    });
    expect(row?.isActive).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run tests/modules/deals/archive-deal.runtime.test.ts`
Expected: FAIL — `deleteDeal` still has the old `(tenantDb, dealId, userRole, userId)` signature, so the options object is read as `userRole` and the admin stub throws / no reason validation exists.

- [ ] **Step 3: Rewrite the `deleteDeal` signature + head (replace lines 2939-2962)**

Replace the current signature/guard/soft-delete-values block:

```ts
export async function deleteDeal(
  tenantDb: TenantDb,
  dealId: string,
  opts: {
    actorRole: string;
    actorId?: string | null;
    reason: string;
    enforceOpportunityStageForNonAdmin?: boolean;
  },
) {
  const reason = typeof opts.reason === "string" ? opts.reason.trim() : "";
  if (reason.length === 0) {
    throw new AppError(400, "A reason is required to archive a deal.", "DEAL_ARCHIVE_REASON_REQUIRED");
  }

  // Lock the deal row FOR UPDATE so a concurrent change-order create on this parent serializes against the
  // archive (loadParentForChildCreate takes the same lock).
  const [existing] = await tenantDb.select().from(deals).where(eq(deals.id, dealId)).limit(1).for("update");
  if (!existing) {
    throw new AppError(404, "Deal not found");
  }
  if (!existing.isActive) {
    return null;
  }

  // Non-admins may only archive opportunity-stage deals (admins keep the any-stage escape hatch).
  if (opts.enforceOpportunityStageForNonAdmin && opts.actorRole !== "admin") {
    const [stageRow] = await tenantDb
      .select({ slug: pipelineStageConfig.slug })
      .from(pipelineStageConfig)
      .where(eq(pipelineStageConfig.id, existing.stageId))
      .limit(1);
    if ((stageRow?.slug ?? null) !== "opportunity") {
      throw new AppError(403, "Only opportunity-stage deals can be archived by reps.", "DEAL_ARCHIVE_STAGE_FORBIDDEN");
    }
  }

  const archivedDescription = buildArchivedDescription(existing.description, reason, new Date());

  // is_active=false stays the canonical archive marker; a CO child also gets the on_hold TOMBSTONE
  // (several Won rollups filter on_hold but not is_active).
  const softDeleteValues: { isActive: boolean; description: string; onHold?: boolean } = {
    isActive: false,
    description: archivedDescription,
  };
  if (existing.isChangeOrder === true) {
    softDeleteValues.onHold = true;
  }
```

Then AFTER the existing `const result = await tenantDb.update(deals).set(softDeleteValues)...returning();` + its `if (result.length === 0)` check (lines 2964-2972, unchanged), insert the history record:

```ts
  if (opts.actorId) {
    await recordDescriptionHistoryChange(tenantDb, {
      dealId,
      oldDescription: existing.description,
      newDescription: archivedDescription,
      changedBy: opts.actorId,
      source: "deal_archive",
    });
  }
```

Everything below (CO children cascade, task dismissal using `userId ?? null` → change to `opts.actorId ?? null`, project mirror, CO commission removal, `return result[0]`) stays — but replace the two `userId ?? null` references (lines ~2977 and ~3017) with `opts.actorId ?? null`. Add the imports at the top of `service.ts`:

```ts
import { buildArchivedDescription } from "./archive-description.js";
import { pipelineStageConfig } from "@trock-crm/shared/schema";
```

(Confirm `pipelineStageConfig` isn't already imported; if the barrel path differs, copy the import line used in `server/src/modules/commissions/reporting-service.ts`.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run tests/modules/deals/archive-deal.runtime.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/deals/service.ts server/tests/modules/deals/archive-deal.runtime.test.ts
git commit -m "feat(deals): archive requires reason + opportunity gate for reps, writes description"
```

---

### Task 3: `DELETE /:id` route — thread real role + required reason

**Files:**
- Modify: `server/src/modules/deals/routes.ts:3814-3861`

- [ ] **Step 1: Update the route body**

Replace the `deleteDeal(...)` call at line 3835 (and add the reason guard just above it, after the existing CO-child admin check):

```ts
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (reason.length === 0) {
      throw new AppError(400, "A reason is required to archive a deal.", "DEAL_ARCHIVE_REASON_REQUIRED");
    }
    const deal = await deleteDeal(req.tenantDb!, dealId, {
      actorRole: req.user!.role,
      actorId: req.user!.id,
      reason,
      enforceOpportunityStageForNonAdmin: true,
    });
```

Leave `assertDealOwnerRouteAccess(req, dealId, { allowAdmin: true })` and the CO-child admin-only reject unchanged. Leave the `logActivity({ action: "soft_delete", fieldChanges: { isActive: { from: true, to: false } } })` block as-is — the description change is captured by `recordDescriptionHistoryChange` in the service.

- [ ] **Step 2: Update any other server callers**

Run: `grep -rn "deleteDeal(" server/src server/tests | grep -v "function deleteDeal"`
Expected: only `routes.ts` (now updated) and possibly test files. Update any test caller to the new options-object signature. If a non-route caller exists that shouldn't stage-gate, pass `enforceOpportunityStageForNonAdmin: false`.

- [ ] **Step 3: Typecheck**

Run: `cd server && npx tsc -p tsconfig.json --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/deals/routes.ts
git commit -m "feat(deals): DELETE /:id passes real role + required archive reason"
```

---

### Task 4: Client — archive eligibility helper + API param

**Files:**
- Create: `client/src/pages/deals/deal-archive-eligibility.ts`
- Test: `client/src/pages/deals/deal-archive-eligibility.test.ts`
- Modify: `client/src/hooks/use-deals.ts:857-859`

- [ ] **Step 1: Write the failing helper test**

```ts
// client/src/pages/deals/deal-archive-eligibility.test.ts
import { describe, expect, it } from "vitest";
import { canArchiveDeal } from "./deal-archive-eligibility";

const deal = (stageSlug: string, assignedRepId: string) => ({ stageSlug, assignedRepId });

describe("canArchiveDeal", () => {
  it("admins can archive any stage", () => {
    expect(canArchiveDeal(deal("awarded", "r1"), { id: "r2", role: "admin" })).toBe(true);
  });
  it("an owner rep can archive an opportunity deal", () => {
    expect(canArchiveDeal(deal("opportunity", "r1"), { id: "r1", role: "rep" })).toBe(true);
  });
  it("an owner rep cannot archive a non-opportunity deal", () => {
    expect(canArchiveDeal(deal("awarded", "r1"), { id: "r1", role: "rep" })).toBe(false);
  });
  it("a non-owner non-admin cannot archive", () => {
    expect(canArchiveDeal(deal("opportunity", "r1"), { id: "r2", role: "rep" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && npx vitest run src/pages/deals/deal-archive-eligibility.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

```ts
// client/src/pages/deals/deal-archive-eligibility.ts
export function canArchiveDeal(
  deal: { stageSlug?: string | null; assignedRepId?: string | null },
  user: { id?: string | null; role?: string | null } | null | undefined,
): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  const isOwner = !!deal.assignedRepId && deal.assignedRepId === user.id;
  return isOwner && deal.stageSlug === "opportunity";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd client && npx vitest run src/pages/deals/deal-archive-eligibility.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the `reason` param to the client API**

In `client/src/hooks/use-deals.ts`, replace `deleteDeal` (lines 857-859):

```ts
export async function deleteDeal(dealId: string, reason: string) {
  return api<{ success: boolean }>(`/deals/${dealId}`, { method: "DELETE", json: { reason } });
}
```

(If the `api` helper does not forward `json` on `DELETE`, send the body the same way the codebase does for other body-bearing requests — verify against `client/src/lib/api.ts`.)

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/deals/deal-archive-eligibility.ts client/src/pages/deals/deal-archive-eligibility.test.ts client/src/hooks/use-deals.ts
git commit -m "feat(deals): client archive-eligibility helper + reason param on delete API"
```

---

### Task 5: Client — Archive menu, reason modal, label rename, copy fix

**Files:**
- Modify: `client/src/pages/deals/deal-detail-page.tsx` (`handleDelete` ~441-454; menu ~953-960; imports)
- Modify: `client/src/components/filters/filter-bar.tsx:63`

- [ ] **Step 1: Rename the status filter label**

In `client/src/components/filters/filter-bar.tsx`, change line 63 and its comment:

```ts
  // value stays "inactive" (server contract = is_active=false); the label reads "Archived"
  // because this bucket is soft-deleted/archived deals.
  { value: "inactive", label: "Archived" },
```

- [ ] **Step 2: Replace `handleDelete` with a reason-modal archive flow**

In `deal-detail-page.tsx`, add state near the other `useState` hooks:

```tsx
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveReason, setArchiveReason] = useState("");
  const [archiving, setArchiving] = useState(false);
```

Replace `handleDelete` (lines 441-454) with:

```tsx
  const handleArchiveSubmit = async () => {
    if (!deal || archiveReason.trim().length === 0) return;
    setArchiving(true);
    try {
      await apiDeleteDeal(deal.id, archiveReason.trim());
      navigate("/deals");
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to archive deal");
    } finally {
      setArchiving(false);
    }
  };
```

- [ ] **Step 3: Gate + rename the menu item, and render the modal**

Replace the delete menu item (lines 953-960) using the eligibility helper (import `canArchiveDeal` from `./deal-archive-eligibility`):

```tsx
          {canArchiveDeal({ stageSlug: deal.stageSlug ?? currentStage?.slug ?? null, assignedRepId: deal.assignedRepId }, user) ? (
            <DropdownMenuItem onClick={() => setArchiveOpen(true)} className="text-red-600">
              <Trash2 className="h-4 w-4 mr-2" />
              Archive Deal
            </DropdownMenuItem>
          ) : viewerOwnsDeal ? (
            <DropdownMenuItem disabled title="Only opportunity-stage deals can be archived — ask an admin">
              <Trash2 className="h-4 w-4 mr-2" />
              Archive Deal
            </DropdownMenuItem>
          ) : null}
```

Add the modal near the component's other dialogs (use the app's existing Dialog + Textarea components — mirror the RFP vote reason UX):

```tsx
      <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive deal</DialogTitle>
            <DialogDescription>
              This archives the deal and removes it from active lists (it will appear under Status → Archived).
              The reason below is added to the top of the deal description.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={archiveReason}
            onChange={(e) => setArchiveReason(e.target.value)}
            placeholder="Why are you archiving this deal?"
            rows={4}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setArchiveOpen(false)} disabled={archiving}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={handleArchiveSubmit}
              disabled={archiving || archiveReason.trim().length === 0}
            >
              {archiving ? "Archiving…" : "Archive"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
```

(Import `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`, `Textarea`, `Button` from the same UI paths used elsewhere in this file / `@/components/ui/*`.)

- [ ] **Step 4: Typecheck + run the deal-detail tests**

Run: `cd client && npx tsc -p tsconfig.json --noEmit && npx vitest run src/pages/deals/deal-detail-page.test.tsx`
Expected: exit 0; existing deal-detail tests pass (update any test asserting the old "Delete Deal" label to "Archive Deal").

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/deals/deal-detail-page.tsx client/src/components/filters/filter-bar.tsx
git commit -m "feat(deals): Archive Deal menu (opportunity-gated) + reason modal + Archived label"
```

---

### Task 6: PR 1 validation + open PR

- [ ] **Step 1: Full gate**

Run from repo root: `npm run check:premerge`
Then: `cd server && npm run test:runtime`
Expected: both green. (`check:premerge` runs `test:ci` but NOT `test:runtime` — run both.)

- [ ] **Step 2: Push + open PR (do not self-merge; Adnaan merges)**

```bash
git push -u origin feat/deal-archive-with-reason
gh pr create --title "feat(deals): archive rename + rep archive-with-reason (opportunity-gated)" --body "..."
```

- [ ] **Step 3: Trigger review bots**

Comment `@codex review`, `@coderabbitai review`, `@macroscope-app review` on the PR.

---

# PR 2 — Feature B: RFP reconfirm-denial auto-archive

**Base this on PR 1's branch (it uses `buildArchivedDescription`).** Create `feat/rfp-denial-auto-archive` off `feat/deal-archive-with-reason` (or off `main` after PR 1 merges).

### Task 7: Reconfirm route requires the reviewer note

**Files:**
- Modify: `server/src/modules/deals/routes.ts:1828-1849`

- [ ] **Step 1: Require the note in the reconfirm route**

Replace the `reconfirmRfpDecline({...})` call (lines 1830-1836) with a guarded version:

```ts
    const note = normalizeRfpOverrideNote(req.body?.note);
    if (!note) {
      throw new AppError(400, "A reason is required to reconfirm a denial.", "RFP_REVIEW_REASON_REQUIRED");
    }
    const result = await reconfirmRfpDecline({
      tenantDb: req.tenantDb!,
      dealId: req.params.id as string,
      actor: { userId: req.user!.id, name: req.user!.displayName, role: req.user!.role },
      note,
      officeId: req.user!.activeOfficeId ?? req.user!.officeId ?? null,
    });
```

(The override-**approve** route at ~1814 keeps its optional note — do not change it.)

- [ ] **Step 2: Typecheck**

Run: `cd server && npx tsc -p tsconfig.json --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/deals/routes.ts
git commit -m "feat(rfp): require a reviewer reason to reconfirm an RFP denial"
```

---

### Task 8: `reconfirmRfpDecline` auto-archives + writes description

**Files:**
- Modify: `server/src/modules/deals/rfp-override-service.ts:332-414`
- Test: `server/tests/modules/deals/rfp-reconfirm-archive.runtime.test.ts` (create)

**Context:** The guarded first UPDATE returns `updated` (all columns, incl. `description`, `rfpDeclinedReason`, `isActive`). `updated.isActive` is still `true` (the first UPDATE doesn't touch it). Either reviewer's reconfirm triggers the archive; the WHERE-clause guard already makes a second reconfirm a no-op.

- [ ] **Step 1: Write the failing runtime test**

```ts
// server/tests/modules/deals/rfp-reconfirm-archive.runtime.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { reconfirmRfpDecline } from "../../../src/modules/deals/rfp-override-service.js";

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const ADAM = U("ada1");
const DEAL = U("d001");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  // NOTE: create the full column set reconfirmRfpDecline reads/writes (mirror the deals columns it touches:
  // rfp_override_*, rfp_approval_*, rfp_declined_reason, description, is_active, name, deal_number, project_number,
  // updated_at) + deal_history + job_queue + deal override-history table. See rfp-override-service.ts for the
  // exact set; seed a 'declined', reviewable, is_active=true deal with rfp_declined_reason populated.
  await pg.exec(`/* create tables + seed as described above */`);
  tdb = drizzle(pg);
});
afterAll(async () => { await pg?.close?.(); });

describe("reconfirmRfpDecline auto-archive", () => {
  it("archives the deal and prepends voter+reviewer notes to the description", async () => {
    const res = await reconfirmRfpDecline({
      tenantDb: tdb, dealId: DEAL,
      actor: { userId: ADAM, name: "Adam Shaw", role: "admin" },
      note: "Confirmed no-go — margin too thin", officeId: null,
    });
    expect(res.ok).toBe(true);
    const row = await pg.query(`SELECT is_active, description FROM deals WHERE id = '${DEAL}'`);
    expect(row.rows[0].is_active).toBe(false);
    expect(row.rows[0].description).toContain("[Archived ");
    expect(row.rows[0].description).toContain("Confirmed no-go — margin too thin");
    const hist = await pg.query(`SELECT source FROM deal_history WHERE deal_id = '${DEAL}' AND field_name = 'description'`);
    expect(hist.rows).toContainEqual({ source: "rfp_reconfirm_denial" });
  });

  it("is a no-op on a second reconfirm (already reconfirmed / archived)", async () => {
    const res = await reconfirmRfpDecline({
      tenantDb: tdb, dealId: DEAL,
      actor: { userId: ADAM, name: "Adam Shaw", role: "admin" }, note: "again", officeId: null,
    });
    expect(res.ok).toBe(false);
  });
});
```

(Seed exactly the columns `reconfirmRfpDecline` reads — read `rfp-override-service.ts:341-411` + `overrideActionableConditions` + `writeOverrideHistory` and create the referenced tables in the PGlite `exec`.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run tests/modules/deals/rfp-reconfirm-archive.runtime.test.ts`
Expected: FAIL — deal stays `is_active=true`, description unchanged.

- [ ] **Step 3: Add the archive block to `reconfirmRfpDecline`**

After the `if (!updated) { return { ok: false, reason: "not_actionable" }; }` guard and the existing `writeOverrideHistory` + `logActivity` calls (i.e., just before the email-enqueue `if (updated.rfpApprovalRequestId == null)` block), insert:

```ts
  // Auto-archive on denial reconfirm (either reviewer): soft-delete the deal and prepend the voter + reviewer
  // notes to the description. Guarded on the current is_active so a redundant call never re-prepends.
  if (updated.isActive) {
    const reviewerReason = (input.note ?? "").trim();
    const voterNotes = (updated.rfpDeclinedReason ?? "").trim();
    const combined =
      `RFP denied.${voterNotes ? ` ${voterNotes}` : ""} · Final review ` +
      `(${input.actor.name ?? input.actor.userId}): ${reviewerReason}`;
    const archivedDescription = buildArchivedDescription(updated.description, combined, new Date());
    await input.tenantDb.update(deals).set({ isActive: false, description: archivedDescription }).where(eq(deals.id, input.dealId));
    await recordDescriptionHistoryChange(input.tenantDb, {
      dealId: input.dealId,
      oldDescription: updated.description,
      newDescription: archivedDescription,
      changedBy: input.actor.userId,
      source: "rfp_reconfirm_denial",
    });
  }
```

Add imports at the top of `rfp-override-service.ts`:

```ts
import { buildArchivedDescription } from "./archive-description.js";
import { recordDescriptionHistoryChange } from "./deal-description-history.js";
```

(Confirm `deals` and `eq` are already imported in this file — they are used by the existing UPDATE.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run tests/modules/deals/rfp-reconfirm-archive.runtime.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/deals/rfp-override-service.ts server/tests/modules/deals/rfp-reconfirm-archive.runtime.test.ts
git commit -m "feat(rfp): reconfirm-denial auto-archives the deal + prepends notes to description"
```

---

### Task 9: Client review page — require the note before reconfirm

**Files:**
- Modify: `client/src/pages/rfp-review/rfp-review-page.tsx` (note label ~279/310; reconfirm buttons ~302/324)

- [ ] **Step 1: Relabel the note + gate the reconfirm button**

In both panels, change the note label from `Note (optional)` to `Note (required to deny)`, and change each "Re-confirm denial" button's `disabled={busy}` to:

```tsx
                <Button variant="destructive" onClick={onReconfirm} disabled={busy || note.trim().length === 0}>
                  {submitting === "reconfirm" ? "Confirming…" : "Re-confirm denial"}
                </Button>
```

Leave the approve button unchanged (approve ignores the note).

- [ ] **Step 2: Add/adjust the client test**

In `client/src/pages/rfp-review/rfp-review-page.test.tsx`, add a case: when the note is empty the "Re-confirm denial" button is `disabled`; typing a note enables it. Run:

`cd client && npx vitest run src/pages/rfp-review/rfp-review-page.test.tsx`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/rfp-review/rfp-review-page.tsx client/src/pages/rfp-review/rfp-review-page.test.tsx
git commit -m "feat(rfp): require a reason before reconfirming an RFP denial"
```

---

### Task 10: PR 2 validation + open PR

- [ ] **Step 1: Full gate**

Run from repo root: `npm run check:premerge` then `cd server && npm run test:runtime`
Expected: both green.

- [ ] **Step 2: Push + open PR (Adnaan merges) + trigger `@codex` / `@coderabbitai` / `@macroscope-app`.**

---

## Notes for the implementer
- **is_active-only reconciliation:** archiving flips `is_active=false`; the "Archived" filter (`status=inactive`) already reads that. Do not add parallel status columns.
- **No restore is being built.** The manual modal copy is written to avoid promising an undo. A real restore flow is a separate future feature.
- **Reviewer path is not stage-gated** — it's an admin/CFO action on an opportunity-triggered RFP; only the rep manual path enforces the opportunity stage.
- **Run BOTH** `check:premerge` and server `test:runtime` before every push — the premerge gate does not run runtime tests, and these features are gated by `*.runtime.test.ts`.
