# Awarded-Amount Manual Override on Bid-Board-Owned Deals — Spec & Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admin/director manually edit `awarded_amount` on bid-board-owned deals and make that edit permanently sticky — the Procore mirror sync must never overwrite a human-set awarded amount — while the automatic #688 seed continues to work and `bid_estimate`/`dd_estimate` stay Procore-owned and locked.

**Architecture:** Add a boolean `awarded_amount_overridden` to `deals`, set ONLY on a genuine admin/director manual edit (the `createDeal`/`updateDeal` user-input paths — never the seed). The Procore mirror (`buildBidBoardMirrorUpdate`) skips `awarded_amount` entirely when the flag is set. Unlock the field by removing `awardedAmount` from the bid-board read-only field set (the #688 RBAC gate already restricts it to admin/director).

**Tech Stack:** Postgres (per-tenant `office_*` schemas), Drizzle, raw `pg` (sync paths), Vitest, React (deal form).

---

## Spec

### S1. Behavior
1. **Unlock `awarded_amount` for admin/director on bid-board-owned deals.** Reps still cannot edit it (the #688 `AWARDED_AMOUNT_RESTRICTED` gate). `bid_estimate` and `dd_estimate` stay locked for everyone (including admin) — Procore-managed.
2. **A manual edit is permanently sticky.** When admin/director sets `awarded_amount` through the deal-update (or create) path, mark the deal `awarded_amount_overridden = true`. The Procore mirror then never writes `awarded_amount` for that deal again, regardless of payload — permanent.
3. **The #688 seed must NOT set the flag.** The won-transition seed (`awarded = bid_estimate`) is automatic, not a human edit; if it set the flag, the first auto-seed would freeze the field and break seed-forward. The flag is set ONLY on a genuine admin/director manual edit through user input.

### S2. Override mechanism + migration — RECOMMENDATION: boolean

Use a boolean **`awarded_amount_overridden`** (`NOT NULL DEFAULT false`), not a timestamp.
- The behavior is binary ("was this human-set? → defer forever"). A boolean is the exact predicate the mirror needs (`= true`).
- Who/when is already captured by `audit_log` (deal updates are audited), so a denormalized `*_overridden_at` timestamp would duplicate it without adding behavior. (If a future need wants the override time on the row for reporting, add the timestamp then — YAGNI now.)

**Migration `0159_awarded_amount_overridden.sql`** (next free number — `origin/main` already has two `0158_*` files: `daily_summary_snapshots` + `files_deal_id_fk`; do NOT add a third 0158). Mirror the per-tenant idempotent pattern from `0156`:

```sql
-- Migration 0159: manual-override marker for awarded_amount on bid-board-owned deals.
-- Set only by a genuine admin/director manual edit (createDeal/updateDeal user input); the
-- #688 won-transition seed never sets it. The Procore mirror skips awarded_amount when true.
-- Per-tenant (office_*) + the new-tenant template. Idempotent / replayable.
DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.deals', schema_name)) IS NULL THEN CONTINUE; END IF;
    EXECUTE format(
      'ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS awarded_amount_overridden boolean NOT NULL DEFAULT false',
      schema_name
    );
  END LOOP;
END
$tenant$;

-- New-tenant template (match the TENANT_SCHEMA block convention used by 0156 if this repo seeds new
-- tenants from a template file; the engineer must locate that template and add the same column there).
```

Drizzle schema (`shared/src/schema/tenant/deals.ts`, after line 78 `awardedAmount`):
```ts
awardedAmountOverridden: boolean("awarded_amount_overridden").notNull().default(false),
```
(Confirm `boolean` is imported in that file; it is used by other columns.)

### S3. Where the mirror checks the flag and skips awarded

**File `server/src/modules/procore/bidboard-mirror-service.ts`.**

1. Extend `MirrorableDeal` (the type ~lines 98-120) with:
```ts
awardedAmountOverridden?: boolean | null;
```
2. Gate the payload staging of awarded (currently ~line 418 `if (input.payload.awardedAmount !== undefined) updates.awardedAmount = input.payload.awardedAmount;`):
```ts
const awardedLocked = input.deal.awardedAmountOverridden === true;
// ...
if (!awardedLocked && input.payload.awardedAmount !== undefined) {
  updates.awardedAmount = input.payload.awardedAmount;
}
```
3. Gate the won-seed block (the `if (canonicalTargetStageSlug === "won")` resolve+seed added in #688) so it only runs `if (!awardedLocked)`. When locked, `updates.awardedAmount` is never set, so the persist `awarded_amount = COALESCE(${updates.awardedAmount}, awarded_amount)` (`synchub-routes.ts:140`) preserves the human value.

**File `server/src/modules/procore/synchub-routes.ts`:** add `awarded_amount_overridden` to the `currentDeal` SELECT (~line 367) and pass `awardedAmountOverridden: currentDeal.awarded_amount_overridden` into the `deal:` object at the UPDATE call site; pass `awardedAmountOverridden: false` at the new-deal insert call site (`deal.id === "new"` — a brand-new deal has no human override).

**Path B (bid-board poll, `writeStageIfSafe`) needs NO override check:** its only awarded write is the only-if-empty seed `CASE WHEN ... awarded_amount IS NULL ...`, which by construction never touches a present (overridden) value. (Confirm by inspection during implementation — no other awarded write exists in that UPDATE.)

### S4. Seed vs manual-edit distinction (the critical invariant)

The flag is set ONLY in the two user-input paths; the three seed paths write `awarded_amount` directly and never touch the flag:

| Path | Sets `awarded_amount`? | Sets `awarded_amount_overridden`? |
|---|---|---|
| `updateDeal` manual edit (`touchesAwarded`) | yes (`input.awardedAmount`) | **YES → true** |
| `createDeal` manual set (`setsAwarded`, admin/director) | yes (`input.awardedAmount`) | **YES → true** |
| Seed A — `changeDealStage` won block | yes (`dealUpdates.awardedAmount`) | no |
| Seed B — `writeStageIfSafe` SQL CASE | yes (SQL) | no |
| Seed C — `buildBidBoardMirrorUpdate` won seed | yes (`updates.awardedAmount`) | no |

`updateDeal` (set right after the awarded write, ~line 2166):
```ts
if (input.awardedAmount !== undefined) updates.awardedAmount = input.awardedAmount;
if (touchesAwarded) updates.awardedAmountOverridden = true; // genuine admin/director manual change
```
`createDeal` (in the insert `.values({...})`, ~line 1903): `awardedAmountOverridden: setsAwarded` (true only when admin/director set a non-blank awarded at creation — the role guard above already rejected reps; covers an admin-created deal that later gets bid-board-matched).

**Decision point for review:** the flag is set on a *genuine change* (`touchesAwarded`), consistent with #688's change-detection. A no-op re-save of the same value does NOT flip it. If you want "an admin opening + saving the deal confirms/locks the seeded value," that's a different rule — flag it and I'll switch to "set whenever `input.awardedAmount` is a non-blank value provided by admin/director." Recommending genuine-change (matches the spec's "manually sets").

### S5. Unlock logic (server + UI)

**Server (`server/src/modules/deals/service.ts`):** remove `awardedAmount: "Awarded amount",` from `BID_BOARD_OWNED_UPDATE_FIELD_LABELS` (lines 472-478). After removal: a rep changing awarded on a bid-board deal is still blocked by the #688 `AWARDED_AMOUNT_RESTRICTED` gate (fires earlier); admin/director pass that gate and are no longer blocked by `BID_BOARD_OWNED_FIELD_READ_ONLY`; `bidEstimate`/`ddEstimate` remain in the map → stay locked for everyone. (Verify `BID_BOARD_OWNED_UPDATE_FIELD_LABELS` is referenced ONLY by the guard loop before removing — grep it.)

**Client (`client/src/components/deals/deal-form.tsx`):**
- Awarded input (~lines 642-657): change `disabled={isBidBoardOwned || !canEditAwarded}` → `disabled={!canEditAwarded}`; `FieldLockLabel locked={!canEditAwarded}` with message `"Only admins and directors can edit the awarded amount."` (drop the bid-board mirror message for awarded). `canEditAwarded` already exists from #688 (`user?.role === "admin" || user?.role === "director"`).
- `bidEstimate`/`ddEstimate` inputs: unchanged — keep `disabled={isBidBoardOwned}` and their bid-board mirror labels.
- Submit payload (~lines 273-277): split so awarded is sent independent of bid-board ownership:
```ts
if (!isBidBoardOwned) {
  payload.ddEstimate = formData.ddEstimate || null;
  payload.bidEstimate = formData.bidEstimate || null;
}
if (canEditAwarded) {
  payload.awardedAmount = formData.awardedAmount || null;
}
```

### S6. Interaction with #688 — confirmed non-conflicting
- **Seed still fires** when awarded is blank: a blank awarded means the deal was never manually set → `awarded_amount_overridden = false` → the seed (A/B/C) runs as in #688. The override only ever guards a *present, human-set* value.
- **Finding-G still holds:** the mirror's "resolve staged value only when non-blank" logic is unchanged; the override is a *stronger, earlier* check — when overridden, the mirror skips awarded entirely (no staging, no seed) regardless of payload, so finding-G never even evaluates.
- **RBAC reused:** this PR does not add a new role check — it removes awarded from the bid-board lock and relies on #688's `AWARDED_AMOUNT_RESTRICTED` gate (admin/director only). Same gate, broader surface.

### S8. Override indicator (deal detail UI)
When `awarded_amount_overridden = true`, show a small, factual badge near the Awarded Amount row on the deal detail Estimates card: **"Manually set — not synced from Procore."** Shown ONLY when the flag is true (a normal state, not an alert). Requires threading the flag to the client:
- Server: add `awardedAmountOverridden: row.awarded_amount_overridden` to the deal response mapper(s) where `awardedAmount` is mapped (`server/src/modules/deals/service.ts:1308`, and any sibling list mapper that maps `awardedAmount`).
- Client `Deal` type: add `awardedAmountOverridden?: boolean | null`.
- Render: in `client/src/components/deals/deal-estimates-card.tsx` (Awarded Amount row, ~line 108), render the badge when `deal.awardedAmountOverridden` is truthy.

### S7. Out of scope
`bid_estimate` and `dd_estimate` stay Procore-owned and locked for everyone (incl. admin) — unchanged. No backfill of `awarded_amount_overridden` (all existing rows default `false`, correctly meaning "not human-overridden" — seeded/synced values remain sync-managed until a human edits them).

---

## File Structure
- **Create:** `migrations/0159_awarded_amount_overridden.sql` — per-tenant column add.
- **Modify:** `shared/src/schema/tenant/deals.ts` — Drizzle column.
- **Modify:** `server/src/modules/deals/service.ts` — set flag on manual edit (updateDeal) + create (createDeal); remove awarded from `BID_BOARD_OWNED_UPDATE_FIELD_LABELS`.
- **Modify:** `server/src/modules/procore/bidboard-mirror-service.ts` — `MirrorableDeal` field + `awardedLocked` gate on staging + seed.
- **Modify:** `server/src/modules/procore/synchub-routes.ts` — SELECT + thread flag into both `deal:` call sites.
- **Modify:** `client/src/components/deals/deal-form.tsx` — unlock awarded for admin/director; split submit.
- **Tests:** `awarded-amount-edit-guard.test.ts` (flag set on manual, admin-on-bid-board allowed, bid_estimate still locked), `bidboard-mirror-service.test.ts` (override skips awarded; non-override = finding-G), `stage-change.test.ts` (seed does NOT set flag), migration test.

---

## Tasks (TDD)

### Task 1: Migration + schema column
**Files:** Create `migrations/0159_awarded_amount_overridden.sql`; Modify `shared/src/schema/tenant/deals.ts:78`
- [ ] **Step 1 — write the migration** exactly as in S2 (per-tenant `DO` block; locate and update the new-tenant template the way 0156 does — find it via `grep -rl "TENANT_SCHEMA\|CREATE TABLE.*deals" migrations/ | tail`).
- [ ] **Step 2 — add the Drizzle column** (S2 snippet) after `awardedAmount`.
- [ ] **Step 3 — verify** `npx tsc -p server/tsconfig.typecheck.json --noEmit` clean; if a migration runtime test exists (`server/tests/modules/migration/`), add/run one asserting the column exists post-migration. Otherwise apply 0159 against a PGlite/local DB and `\d office_test.deals`.
- [ ] **Step 4 — commit** `feat(deals): add awarded_amount_overridden column (migration 0159)`.

### Task 2: Set the override flag on manual edits (never the seed)
**Files:** Modify `server/src/modules/deals/service.ts`; Test `server/tests/modules/deals/awarded-amount-edit-guard.test.ts`
- [ ] **Step 1 — failing tests:** (a) `updateDeal` admin changes awarded → captured update includes `awardedAmountOverridden: true`; (b) `updateDeal` admin no-op (same value) → `awardedAmountOverridden` NOT set; (c) `createDeal` admin with non-blank awarded → inserted row has `awardedAmountOverridden: true`; (d) `createDeal` admin with NO awarded → `awardedAmountOverridden` false/absent.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** in `updateDeal`, after `if (input.awardedAmount !== undefined) updates.awardedAmount = input.awardedAmount;` add `if (touchesAwarded) updates.awardedAmountOverridden = true;`. In `createDeal` `.values({...})` add `awardedAmountOverridden: setsAwarded,`.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — seed-does-not-set-flag test** in `stage-change.test.ts`: a deal seeded on won-transition (awarded null + bid present) → captured update has no `awardedAmountOverridden` (stays default false). Run, expect PASS (the seed code is untouched).
- [ ] **Step 6 — commit** `feat(deals): mark awarded_amount_overridden on genuine admin/director edits`.

### Task 3: Unlock awarded on bid-board-owned deals (server)
**Files:** Modify `server/src/modules/deals/service.ts:472-478`; Test `awarded-amount-edit-guard.test.ts`
- [ ] **Step 1 — failing tests:** (a) admin `updateDeal` changing awarded on a deal with `isBidBoardOwned: true` → succeeds (no `BID_BOARD_OWNED_FIELD_READ_ONLY`, no `AWARDED_AMOUNT_RESTRICTED`), and `updates.awardedAmountOverridden === true`; (b) rep changing awarded on a bid-board deal → still 403 `AWARDED_AMOUNT_RESTRICTED`; (c) admin changing `bidEstimate` on a bid-board deal → still 403 `BID_BOARD_OWNED_FIELD_READ_ONLY`.
- [ ] **Step 2 — run, expect FAIL** (admin-on-bid-board currently 403s).
- [ ] **Step 3 — implement:** delete the `awardedAmount: "Awarded amount",` line from `BID_BOARD_OWNED_UPDATE_FIELD_LABELS`. First `grep -n "BID_BOARD_OWNED_UPDATE_FIELD_LABELS" server/src` to confirm it's used only by the guard loop.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `feat(deals): allow admin/director to edit awarded_amount on bid-board-owned deals`.

### Task 4: Mirror defers to the override
**Files:** Modify `server/src/modules/procore/bidboard-mirror-service.ts`, `server/src/modules/procore/synchub-routes.ts`; Test `bidboard-mirror-service.test.ts`
- [ ] **Step 1 — failing tests** (pure `buildBidBoardMirrorUpdate`): (a) `deal.awardedAmountOverridden: true` + payload `awardedAmount: "777"` + Won target → `result.updates.awardedAmount` is undefined (NOT "777", NOT seeded); (b) `awardedAmountOverridden: false` + payload `awardedAmount: "777"` → `result.updates.awardedAmount === "777"` (existing behavior preserved); (c) `awardedAmountOverridden: true` + awarded blank + bid present + Won → still NOT seeded (`updates.awardedAmount` undefined).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** add `awardedAmountOverridden?: boolean | null` to `MirrorableDeal`; compute `const awardedLocked = input.deal.awardedAmountOverridden === true;`; gate the payload-awarded staging with `!awardedLocked` and wrap the won-seed block in `if (!awardedLocked)`. In `synchub-routes.ts`: add `awarded_amount_overridden` to the currentDeal SELECT and pass `awardedAmountOverridden: currentDeal.awarded_amount_overridden` (UPDATE call site) / `awardedAmountOverridden: false` (new-deal insert).
- [ ] **Step 4 — run, expect PASS;** also `npx vitest run tests/modules/procore/` (no sibling break).
- [ ] **Step 5 — commit** `fix(procore): never overwrite a human-overridden awarded_amount on mirror sync`.

### Task 5: UI unlock (deal form)
**Files:** Modify `client/src/components/deals/deal-form.tsx`
- [ ] **Step 1 — implement** the S5 client changes (awarded `disabled={!canEditAwarded}` + role message; split submit so awarded is sent when `canEditAwarded`; bid/dd stay `isBidBoardOwned`-locked).
- [ ] **Step 2 — verify** `npx tsc --noEmit` (client) clean for deal-form; run client vitest if a deal-form test exists.
- [ ] **Step 3 — commit** `feat(deals): let admin/director edit awarded amount on bid-board deals in the form`.

### Task 6: Override indicator on the deal detail Estimates card
**Files:** Modify `server/src/modules/deals/service.ts` (deal response mapper(s)), the client `Deal` type, `client/src/components/deals/deal-estimates-card.tsx`; Test the card.
- [ ] **Step 1 — server:** add `awardedAmountOverridden: row.awarded_amount_overridden` wherever `awardedAmount: row.awarded_amount` is mapped (`:1308` + grep for any sibling mapper). Add `awardedAmountOverridden?: boolean | null` to the client `Deal` type (grep `awardedAmount` in `client/src/types`/`client/src/lib` to find the canonical type).
- [ ] **Step 2 — failing test** (`deal-estimates-card` test, jsdom/RTL like sibling card tests): with a deal `{ awardedAmountOverridden: true, awardedAmount: "6317.62", ... }` the card shows the text "Manually set — not synced from Procore."; with `awardedAmountOverridden: false`/absent it does NOT. (If no test file exists for this card, create `deal-estimates-card.test.tsx` mirroring an existing card test's render harness.)
- [ ] **Step 3 — run, expect FAIL.**
- [ ] **Step 4 — implement** the badge in `deal-estimates-card.tsx` near the Awarded Amount row (~line 108):
```tsx
{deal.awardedAmountOverridden ? (
  <span className="text-xs text-muted-foreground">Manually set — not synced from Procore.</span>
) : null}
```
(place it under/beside the Awarded Amount value; match the card's existing badge/label styling.)
- [ ] **Step 5 — run, expect PASS;** `npx tsc --noEmit` (client + server) clean.
- [ ] **Step 6 — commit** `feat(deals): show "manually set — not synced from Procore" indicator when awarded_amount is overridden`.

---

## Test matrix (maps to spec)
| Scenario | Task | Expectation |
|---|---|---|
| admin sets awarded on bid-board deal | 2,3 | allowed; `awarded_amount_overridden = true` |
| → then mirror sync sends a different Procore value | 4 | awarded **unchanged** (override defers) |
| seed fires on blank bid-board deal (won) | 2 | awarded seeded; `awarded_amount_overridden` stays **false** |
| → later mirror sync (not overridden) | 4 | finding-G logic applies (payload non-blank wins) |
| rep edits awarded on bid-board deal | 3 | 403 `AWARDED_AMOUNT_RESTRICTED` |
| admin edits `bid_estimate` on bid-board deal | 3 | 403 `BID_BOARD_OWNED_FIELD_READ_ONLY` (locked, Procore-owned) |
| override=true + blank awarded + Won | 4 | seed does NOT fire (no resurrection of a cleared override) |
| deal detail with `awardedAmountOverridden = true` | 6 | shows "Manually set — not synced from Procore." badge |
| deal detail with flag false/absent | 6 | badge NOT shown |

## Sequencing / branch hygiene
- **Branch off current `origin/main`** (3a69557c, #688 merged) — fresh worktree. This touches the same hot files as #688 (`deals/service.ts`, `bidboard-mirror-service.ts`, `synchub-routes.ts`, `deal-form.tsx`), which are now on main, so no in-flight conflict; rebase before PR if main moves.
- **Migration `0159`** — confirm no other branch claims 0159 at branch time (main already double-booked 0158). Migrations auto-run on API/server deploy.
- Same gated discipline: single owner, never self-merge, base = main (default) → standard CodeRabbit/Codex auto-review.

## Self-review
- **Spec coverage:** unlock (S5/Tasks 3,5), sticky override (S2/S3/Tasks 1,2,4), seed-never-flags (S4/Task 2 incl. seed test), mirror skip (S3/Task 4), #688 interaction (S6), migration number picked (S2). ✓
- **Type consistency:** `awardedAmountOverridden` (camel) ↔ `awarded_amount_overridden` (snake) used consistently across schema/service/mirror/synchub; `awardedLocked` local in mirror only. ✓
- **No placeholders:** every task has concrete code/commands (the only deferred lookup is the new-tenant template location, with the exact grep to find it). ✓
- **YAGNI:** boolean over timestamp; no backfill; no path-B override check (only-if-empty already protects). ✓
