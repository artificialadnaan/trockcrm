# Seed `awarded_amount` on Won-transition + Restrict Editing to Admin/Director — Spec & Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a deal enters Won with a blank `awarded_amount`, seed it from `bid_estimate` (only-if-empty, all win paths); and restrict editing `awarded_amount` to admin/director roles, enforced server-side and reflected in the UI.

**Architecture:** A single pure helper `awardedAmountSeedOnWin(currentAwarded, bidEstimate)` is called at every Won-transition site (manual stage change, CRM bid-board poll, Procore SyncHub mirror). A change-detecting role guard in `updateDeal` rejects rep edits to `awarded_amount`. No backfill of the existing 29 nulls — forward behavior only.

**Tech Stack:** TypeScript, Drizzle, raw `pg` (bid-board paths), Vitest (fake-db capture + PGlite `.runtime` + pure-fn tests), Express RBAC middleware (`req.user.role`).

---

## Spec

### S1. Behavior

1. **Seed-on-win, only-if-empty.** On entry to a genuine Won stage, if `awarded_amount` is `NULL` at that moment and `bid_estimate` is present (`> 0`), set `awarded_amount = bid_estimate`. Never overwrite a non-null `awarded_amount`.
2. **No bid → leave blank, silently.** If `bid_estimate` is `NULL` or `<= 0`, leave `awarded_amount` null. No prompt, no block on the win.
3. **Edit restricted to admin/director.** Changing `awarded_amount` is allowed only for `admin`/`director`, enforced in the API (not just UI) and reflected in the deal form.

### S2. Seed value semantics (the helper)

```ts
// server/src/modules/deals/awarded-amount-seed.ts
/**
 * Seed value for awarded_amount on a Won-transition, only-if-empty.
 * Returns the bid_estimate to write when awarded_amount is blank and bid is a
 * usable positive value; returns null when no seed should occur (awarded already
 * present, or bid missing / <= 0). Mirrors writeEstimateIfNeeded's "<= 0 skip".
 */
export function awardedAmountSeedOnWin(
  currentAwarded: string | number | null | undefined,
  bidEstimate: string | number | null | undefined,
): string | null {
  const awardedPresent =
    currentAwarded != null && String(currentAwarded).trim() !== "";
  if (awardedPresent) return null;
  if (bidEstimate == null) return null;
  const bidNum = typeof bidEstimate === "string" ? Number(bidEstimate) : bidEstimate;
  if (!Number.isFinite(bidNum) || bidNum <= 0) return null;
  return String(bidEstimate);
}
```

`bid <= 0` deliberately does not seed — confirmed against prod: deal `DFW-4-14126-ah` (project number) has `bid_estimate = 0.00` and must stay blank.

### S3. Won-transition paths — enumeration + seed placement

The diagnosis found multiple Won writers. Enumerated exhaustively; **3 require the seed, 3 are excluded with reasons.**

| # | Path | File:line | Seed? | Why / how |
|---|------|-----------|-------|-----------|
| A | `changeDealStage` (manual / UI chokepoint) | `server/src/modules/deals/stage-change.ts:364-393` | **YES** | Full row locked `FOR UPDATE` as `currentDeal[0]`; `.awardedAmount` + `.bidEstimate` in scope. Seed inside the `isWonOutcomeStage(...)` block. |
| B | `writeStageIfSafe` (CRM bid-board poll, direct SQL UPDATE) | `server/src/modules/bid-board-sync/service.ts:839-878` | **YES** | Raw `UPDATE`; `deal.bid_estimate` available on the `DealMatch`. Seed as an extra `SET` column using SQL `COALESCE(awarded_amount, $seed)` — atomic only-if-empty. |
| C | `buildBidBoardMirrorUpdate` (Procore SyncHub webhook mirror) | `server/src/modules/procore/bidboard-mirror-service.ts:443-478` | **YES** | Pure builder; **`MirrorableDeal` lacks `bidEstimate`/`awardedAmount`** (lines 98-118) — must thread them in (caller already loads them, `synchub-routes.ts:367`). Seed in the `canonicalTargetStageSlug === "won"` block. |
| — | Lead conversion | `server/src/modules/leads/conversion-service.ts:223-412` | no | Creates deals at **Opportunity**, never Won (line ~305). Nothing to seed. |
| — | Change-order child creation | `server/src/modules/deals/change-order-service.ts:301-316` | no | Always inserts `awarded_amount = <CO amount>` (never null); COs carry no `bid_estimate`. Seeding would be wrong. |
| — | `setDealContractSignedDate` | `server/src/modules/deals/service.ts:3094-3271` | no | Operates on **already-Won** deals (writes `won_closed_date`); not a transition *into* Won. A pre-existing null-awarded won deal touched here is the backfill's job (out of scope). |

> **The risk the spec calls out:** a seed wired only into A leaves the 18 bid-board-owned nulls unfixed forever. B **and** C are both bid-board surfaces (CRM poll vs SyncHub webhook) and both must seed. This plan wires all three (A, B, C) and proves each with a dedicated test (Tasks 2–5).

### S4. Only-if-empty guard — at the right layer per path

- **A:** the row is read under `SELECT … FOR UPDATE`; the seed reads `currentDeal[0].awardedAmount` from that locked snapshot and writes in the same transaction's `dealUpdates`. Atomic — a concurrent writer is serialized behind the lock.
- **B:** the seed is expressed **in the SQL** as `awarded_amount = CASE WHEN $stageSlug = 'won' THEN COALESCE(awarded_amount, $seed::numeric) ELSE awarded_amount END`. `COALESCE(awarded_amount, …)` can only fill a NULL — it can **never** overwrite a present (e.g. director-confirmed) value, even under a race.
- **C:** the seed is computed in the pure builder from the loaded row and only when the webhook payload carries **no** `awardedAmount`; the existing final SQL `awarded_amount = COALESCE(${updates.awardedAmount}, awarded_amount)` (`synchub-routes.ts:140`) then writes the seed into a NULL column. Because a seed is computed only when the loaded `awardedAmount` is null AND payload-awarded is absent, a director's confirmed value is never the seed target. (The mirror is serialized per-deal, as it already relies on for `won_closed_date`.)

**Result:** a re-sync or a second Won-transition over an already-populated `awarded_amount` is a no-op at all three sites. The seed only ever fills blanks.

> **Explicitly out of scope:** the separate "bid-board re-sync reverts a director's `awarded_amount` from the Procore *payload*" issue (the value-revert problem) is NOT addressed here — that is a fix-at-source decision tracked separately. This PR's only-if-empty seed neither causes nor fixes payload-driven overwrites.

### S5. Edit permission — admin/director only

**Role model** (`shared/src/types/enums.ts:1`): `admin`, `director`, `rep`, `construction`, `field_contractor`. `director` is a real role value.

**Server — update path (authoritative).** `updateDeal(tenantDb, dealId, input, userRole, userId, officeId?)` already receives `userRole` (`server/src/modules/deals/service.ts:1992`). Add a **change-detecting** guard before the `awardedAmount` write (`service.ts:2122`), mirroring the existing `assignedRepId` guard (`service.ts:2052-2061`) and the CO `touchesAmount` pattern (`service.ts:2016-2049`):

```ts
const touchesAwarded =
  input.awardedAmount !== undefined &&
  String(input.awardedAmount ?? "") !== String(existing.awardedAmount ?? "");
if (touchesAwarded) {
  const isDirectorOrAdmin = userRole === "admin" || userRole === "director";
  if (!isDirectorOrAdmin) {
    throw new AppError(
      403,
      "Only admins and directors can edit the awarded amount",
      "AWARDED_AMOUNT_RESTRICTED",
    );
  }
}
```

Change-detection is required so a rep using the partial-save flow (PR #636) who re-submits the form with `awarded_amount` **unchanged** is not falsely blocked. The system-initiated seed (S2/S3) never flows through `input.awardedAmount`, so it is unaffected by this gate.

**Server — create path (close the end-run).** `createDeal(tenantDb, input)` writes `awardedAmount: input.awardedAmount ?? null` (`service.ts:1903`) and takes **no** `userRole`, so a rep could hand-set the awarded amount at creation. Thread the actor's role through `CreateDealInput` (the input already carries `actorUserId`; the two route call sites — `routes.ts:1852`, `routes.ts:1923` — have `req.user!.role`) and gate before the create write. On create there is no prior value to diff against, so the rule is simply "a non-blank awarded amount requires admin/director":

```ts
// CreateDealInput gains: actorRole: string;
const setsAwarded = input.awardedAmount != null && String(input.awardedAmount).trim() !== "";
if (setsAwarded && !(input.actorRole === "admin" || input.actorRole === "director")) {
  throw new AppError(
    403,
    "Only admins and directors can set the awarded amount",
    "AWARDED_AMOUNT_RESTRICTED",
  );
}
```

Both route call sites must pass `actorRole: req.user!.role`. (Lead-conversion deals are created at Opportunity via their own path and do not set `awarded_amount`, so they are unaffected.)

**UI (reflects the rule).** The editable control is the `awardedAmount` `<Input>` in `client/src/components/deals/deal-form.tsx:641-659` (the Estimates *card* is display-only). Disable for non-admin/director and reuse `FieldLockLabel`:

```tsx
const canEditAwarded = user?.role === "admin" || user?.role === "director";
// ...
<FieldLockLabel
  htmlFor="awardedAmount"
  label="Awarded Amount ($)"
  locked={isBidBoardOwned || !canEditAwarded}
  message={
    isBidBoardOwned
      ? "Awarded amount is mirrored from Bid Board after estimating handoff."
      : "Only admins and directors can edit the awarded amount."
  }
/>
<Input id="awardedAmount" /* ... */ disabled={isBidBoardOwned || !canEditAwarded} />
```

Note (non-blocking): `client/src/lib/auth.tsx` `User.role` lists `sales_manager` and omits `field_contractor` vs the shared enum — pre-existing drift; the admin/director check is unaffected.

### S6. Out of scope (forward-behavior only)

- **No backfill** of the existing 29 nulls (separate decision).
- **No** correction of the two leadership-named deals (separate two-record patch).
- **No** change to bid-board payload-overwrite behavior (S4 note).

---

## File Structure

- **Create** `server/src/modules/deals/awarded-amount-seed.ts` — the pure helper (S2).
- **Create** `server/tests/modules/deals/awarded-amount-seed.test.ts` — helper unit tests.
- **Modify** `server/src/modules/deals/stage-change.ts:364-393` — seed in path A.
- **Modify** `server/src/modules/bid-board-sync/service.ts:839-878` — seed in path B (SQL).
- **Modify** `server/src/modules/procore/bidboard-mirror-service.ts` — extend `MirrorableDeal` + seed in path C.
- **Modify** `server/src/modules/procore/synchub-routes.ts:427, 672` — pass `bidEstimate`/`awardedAmount` into the mirror builder (already loaded at `:367`).
- **Modify** `server/src/modules/deals/service.ts:~2118` — server role guard on update (S5).
- **Modify** `server/src/modules/deals/service.ts` `createDeal` + `CreateDealInput` (`:1850`, `:1903`) and `server/src/modules/deals/routes.ts:1852,1923` — `actorRole` + create-path role guard (S5).
- **Modify** `client/src/components/deals/deal-form.tsx:641-659` — UI role gate (S5).
- **Modify tests:** `stage-change.test.ts` (A), `bid-board-sync/service.test.ts` or `won-closed-date-mirror.runtime.test.ts` (B), `procore/bidboard-mirror-service.test.ts` (C), and a `deals` service test (S5 auth).

---

## Tasks (TDD; stop-for-review before execution)

### Task 1: Pure seed helper

**Files:** Create `server/src/modules/deals/awarded-amount-seed.ts`; Test `server/tests/modules/deals/awarded-amount-seed.test.ts`

- [ ] **Step 1 — failing tests**

```ts
import { describe, it, expect } from "vitest";
import { awardedAmountSeedOnWin } from "../../../src/modules/deals/awarded-amount-seed.js";

describe("awardedAmountSeedOnWin", () => {
  it("seeds bid when awarded is null and bid > 0", () => {
    expect(awardedAmountSeedOnWin(null, "6317.62")).toBe("6317.62");
  });
  it("does NOT seed when awarded already present", () => {
    expect(awardedAmountSeedOnWin("54691.45", "6317.62")).toBeNull();
  });
  it("does NOT seed when bid is null", () => {
    expect(awardedAmountSeedOnWin(null, null)).toBeNull();
  });
  it("does NOT seed when bid is zero or negative", () => {
    expect(awardedAmountSeedOnWin(null, "0.00")).toBeNull();
    expect(awardedAmountSeedOnWin(null, "-5")).toBeNull();
  });
  it("treats empty-string awarded as blank and seeds", () => {
    expect(awardedAmountSeedOnWin("", "100")).toBe("100");
  });
});
```

- [ ] **Step 2 — run, expect FAIL** `npx vitest run server/tests/modules/deals/awarded-amount-seed.test.ts` → fails (module missing).
- [ ] **Step 3 — implement** the helper exactly as in spec S2.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `feat(deals): add awardedAmountSeedOnWin only-if-empty helper`.

### Task 2: Path A — `changeDealStage` seed

**Files:** Modify `server/src/modules/deals/stage-change.ts:364-393`; Test `server/tests/modules/deals/stage-change.test.ts`

- [ ] **Step 1 — failing test** (mirror existing FakeDeal capture style): a deal with `awardedAmount: null, bidEstimate: "1234.56"` moved into Won captures `dealUpdates.awardedAmount === "1234.56"`; a deal with `awardedAmount: "999"` is unchanged; a deal with `bidEstimate: null` stays null. Assert against the captured `update().set(...)` payload.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** inside the `if (isWonOutcomeStage(...))` block (after line 392), add:

```ts
const awardedSeed = awardedAmountSeedOnWin(
  currentDeal[0].awardedAmount,
  currentDeal[0].bidEstimate,
);
if (awardedSeed !== null) {
  dealUpdates.awardedAmount = awardedSeed;
}
```

and import the helper at the top of the file.

- [ ] **Step 4 — run, expect PASS** (and full `stage-change.test.ts` green).
- [ ] **Step 5 — commit** `feat(deals): seed awarded_amount from bid on manual Won transition`.

### Task 3: Path B — `writeStageIfSafe` seed (SQL)

**Files:** Modify `server/src/modules/bid-board-sync/service.ts:839-878`; Test `server/tests/modules/bid-board-sync/service.test.ts` (+ `won-closed-date-mirror.runtime.test.ts` PGlite if SQL-level proof needed)

- [ ] **Step 1 — failing test:** assert the won-transition `UPDATE` sets `awarded_amount` via `COALESCE(awarded_amount, $seed)` and binds the seed = `deal.bid_estimate` when null-awarded + bid>0; binds `null` (no fill) when bid `<= 0`; and never overwrites when awarded present (COALESCE guarantees). Use the file's existing capture/`extractSqlText` or PGlite runtime pattern.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** compute the seed in JS and add one `SET` clause + bind param:

```ts
const awardedSeed = targetIsWon
  ? awardedAmountSeedOnWin(deal.awarded_amount, deal.bid_estimate)
  : null;
// in the UPDATE SET list:
//   awarded_amount = COALESCE(awarded_amount, $12::numeric),
// append awardedSeed as $12 in the params array.
```

(Confirm `deal.awarded_amount` is selected in the `findDealMatches` query alongside `deal.bid_estimate`; add it to the SELECT if absent.)

- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `feat(bid-board-sync): seed awarded_amount on Won poll (only-if-empty SQL)`.

### Task 4: Path C — `buildBidBoardMirrorUpdate` seed

**Files:** Modify `server/src/modules/procore/bidboard-mirror-service.ts` (type + `:443-478`) and `server/src/modules/procore/synchub-routes.ts:427,672`; Test `server/tests/modules/procore/bidboard-mirror-service.test.ts`

- [ ] **Step 1 — failing tests** (pure builder): won target + `deal.awardedAmount: null` + `deal.bidEstimate: "500"` ⇒ `result.updates.awardedAmount === "500"`; `deal.awardedAmount: "900"` ⇒ no seed; `deal.bidEstimate: null` ⇒ no seed; **payload carries `awardedAmount`** ⇒ seed does not fire (payload value preserved).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:**
  - Extend `MirrorableDeal` (lines 98-118) with `bidEstimate?: string | null;` and `awardedAmount?: string | null;`.
  - In the `canonicalTargetStageSlug === "won"` block (after line 477), seed from the **resolved** awarded/bid (so a payload that explicitly sends `awardedAmount: null` still seeds, and an incoming payload bid is honored):

```ts
const resolvedAwarded =
  updates.awardedAmount !== undefined ? updates.awardedAmount : input.deal.awardedAmount;
const resolvedBid =
  updates.bidEstimate !== undefined ? updates.bidEstimate : input.deal.bidEstimate;
const awardedSeed = awardedAmountSeedOnWin(resolvedAwarded, resolvedBid);
if (awardedSeed !== null) {
  updates.awardedAmount = awardedSeed; // final SQL: COALESCE(updates.awardedAmount, awarded_amount)
}
```

  - In `synchub-routes.ts`, the update call site (`:427`) already loads `bid_estimate`/`awarded_amount` from the DB at `:367` — pass them into the **`deal:`** object (lines 429-450): `bidEstimate: currentDeal.bid_estimate, awardedAmount: currentDeal.awarded_amount`. **CRM-internal only — the `payload:` contract (lines 466-484, from the webhook body) is unchanged; SyncHub sends nothing new.** For the new-deal insert call site (`:672`), `deal.id === "new"` so `input.deal.awardedAmount`/`bidEstimate` are null and the seed correctly falls back to the payload-resolved values.

- [ ] **Step 4 — run, expect PASS** (+ full `bidboard-mirror-service.test.ts`).
- [ ] **Step 5 — commit** `feat(procore): seed awarded_amount on SyncHub mirror Won (only-if-empty)`.

### Task 5: Server edit guard (admin/director)

**Files:** Modify `server/src/modules/deals/service.ts:~2118`; Test `server/tests/modules/deals/` (new `update-deal-awarded-guard.test.ts` or extend existing)

- [ ] **Step 1 — failing tests:** `updateDeal` with `userRole: "rep"` and a **changed** `awardedAmount` throws `AppError(403, "AWARDED_AMOUNT_RESTRICTED")`; with `"admin"` and `"director"` succeeds; with `"rep"` and `awardedAmount` **equal to existing** does NOT throw (partial-save safety).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the update-path guard from S5 immediately before `if (input.awardedAmount !== undefined) updates.awardedAmount = input.awardedAmount;` (line 2122).
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `feat(deals): restrict awarded_amount edits to admin/director (server-authoritative)`.

### Task 5b: Create-path edit guard (close the rep end-run)

**Files:** Modify `server/src/modules/deals/service.ts` (`CreateDealInput` + `createDeal` `:1850-1903`) and `server/src/modules/deals/routes.ts:1852,1923`; Test alongside Task 5's deals test

- [ ] **Step 1 — failing test:** `createDeal` with `actorRole: "rep"` and a non-blank `awardedAmount` throws `AppError(403, "AWARDED_AMOUNT_RESTRICTED")`; with `"admin"`/`"director"` it persists; with `"rep"` and **no** `awardedAmount` it creates normally.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** add `actorRole: string;` to `CreateDealInput`, add the create-path guard from S5 before the insert (before line 1903), and pass `actorRole: req.user!.role` at both route call sites (`routes.ts:1852`, `:1923`).
- [ ] **Step 4 — run, expect PASS** (+ existing createDeal/routes tests green).
- [ ] **Step 5 — commit** `feat(deals): require admin/director to set awarded_amount on create`.

### Task 6: UI role gate

**Files:** Modify `client/src/components/deals/deal-form.tsx:641-659`

- [ ] **Step 1 — implement** the `canEditAwarded` gate + `FieldLockLabel`/`disabled` from S5 (UI-only; verify with the existing client test suite + a manual render check — no new client unit test required unless the file already has one).
- [ ] **Step 2 — run** client typecheck/tests `npx vitest run` (client) and confirm no regression.
- [ ] **Step 3 — commit** `feat(deals): hide awarded_amount edit from non-admin/director in deal form`.

---

## Test Plan (maps to the spec's required cases)

| Required case | Task | Test home | Style |
|---|---|---|---|
| seed fires when empty | 1,2,3,4 | helper + each path test | fake-db / PGlite / pure |
| seed does NOT overwrite present value | 1,2,3,4 | helper + each path | COALESCE / capture assertion |
| no bid → leaves blank | 1,2,3,4 | helper + each path | bid null/≤0 ⇒ no write |
| **one test per Won path** (A, B, C) | 2,3,4 | stage-change / bid-board-sync / mirror | proves seed fires on each |
| non-admin/director cannot edit (API-level) | 5 | deals service test | throws 403, not UI-only |
| rep partial-save unchanged value not blocked | 5 | deals service test | change-detection guard |

---

## Sequencing / branch hygiene (gated discipline) — CONFIRMED

- **No migration.** This PR is code-only (seed hooks, a TS type extension, auth gates, UI). No new column, so no migration number to claim. (Latest on `main` is `0157_usage_tracking`.)
- **CO collision cleared.** #657 (Part 1, migration 0156), #662 (PR2+PR4, windowless fix-forward migration), and #659 (PR3 UI) are **all merged to `origin/main`**; no open CO PRs. The file surface on `main` already reflects final CO state — no live collision.
- **Branch off fresh `origin/main`** — current branch `feat/trock-cam-ux-polish` is unrelated (mobile camera UX, already merged via #683). New branch e.g. `feat/awarded-amount-seed-on-win`, in an isolated worktree.
- Same gated PR discipline: single owner, never merge own PR, and if the PR base is non-default, manually request `@coderabbitai review` + `@codex review`.

## Self-review

- **Spec coverage:** seed-on-win (Tasks 1–4), only-if-empty guard layer (S4 + Tasks 2–4), all Won paths enumerated incl. excluded ones with reasons (S3), server auth (Task 5), UI (Task 6), every required test case mapped (Test Plan). ✓
- **Type consistency:** helper signature `awardedAmountSeedOnWin(currentAwarded, bidEstimate): string | null` used identically in Tasks 2/3/4; `MirrorableDeal` extension named `bidEstimate`/`awardedAmount` consistent with `synchub-routes` locals `bid_estimate`/`awarded_amount`. ✓
- **No placeholders:** all steps carry concrete code/commands. ✓
- **No backfill / no data patch** included — forward behavior only. ✓
