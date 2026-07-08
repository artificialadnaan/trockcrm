# Deal Archiving + RFP Denial Auto-Archive — Design

**Date:** 2026-07-08
**Branch/worktree:** `feat/deal-archive-with-reason` → `/Users/adnaaniqbal/Developer/trockcrm-wt-archive`
**Status:** Approved design, pending spec review → implementation plan.

**Goal:** Reframe deal soft-delete as "Archive": reps can archive an **opportunity-stage** deal they own with a **required reason** that is prepended to the deal's description; and when an RFP denial is reconfirmed by a reviewer (Adam or Takashi), the deal **auto-archives** with the accumulated denial notes prepended to the description.

**Architecture:** No schema migration. Everything rides existing columns — `deals.is_active` (soft-delete marker, already surfaced as the "Removed" status filter), `deals.description`, and the existing RFP override columns. One shared pure helper builds the prepended "archive block"; both the manual-archive path (`deleteDeal` via `DELETE /api/deals/:id`) and the RFP reconfirm path (`reconfirmRfpDecline`) call it. The `is_active=false` write mechanism is unchanged; we add a reason + description write + (for reps) a stage gate on top of it.

**Tech Stack:** Express + Drizzle (per-office Postgres schemas), React + Base UI/Tailwind (client), PGlite runtime tests + Vitest, Jest (mobile — not touched here).

---

## Locked decisions

1. **Who triggers RFP auto-archive:** **Either** reviewer (Adam OR Takashi) reconfirming the denial triggers it. Reuse the existing single-reviewer `reconfirmRfpDecline` path — no new dual-sign-off state.
2. **Description write:** **Prepend, keep original.** Add an archive block on top; the deal's original description survives.
3. **Rep manual-archive stage scope:** **Opportunity stage only.** Non-admin reps may archive only deals in the `opportunity` stage that they own. Admins keep the any-stage escape hatch.
4. **Reviewer reason:** **Required.** Adam/Takashi must provide a reason when reconfirming a denial (mirrors the already-enforced voter rule). That reason joins the notes written into the description.

---

## Current state (verified in code)

- **Soft-delete = archive already works.** `DELETE /api/deals/:id` (`server/src/modules/deals/routes.ts:3814-3861`) gates on `assertDealOwnerRouteAccess(req, dealId, { allowAdmin: true })` (owner **or** admin), rejects non-admins only for change-order **children** (`routes.ts:3825-3833`), then calls `deleteDeal(tenantDb, dealId, "admin", userId)` with a **hardcoded** `"admin"` (`routes.ts:3835`). `deleteDeal` (`service.ts:2939-3021`) sets `is_active=false` (+`on_hold=true` for CO children), cascades to CO children / project mirror / dismisses tasks, and its own `if (userRole !== "admin") throw` (`service.ts:2940`) is a **dead stub** because the route always passes `"admin"`.
- **Client archive control:** deal detail "⋯" menu shows red **"Delete Deal"** when `viewerOwnsDeal || user.role === "admin"` (`client/src/pages/deals/deal-detail-page.tsx:953-960`); `handleDelete` (`:441-454`) is a bare `window.confirm("… This action can be undone by an admin.")` → `apiDeleteDeal(deal.id)`. **No restore path actually exists**, so that copy is misleading.
- **Status filter "Removed":** exactly one UI string — `client/src/components/filters/filter-bar.tsx:63` `{ value: "inactive", label: "Removed" }` — mapping to server `status=inactive` → `is_active=false` (`server/src/modules/deals/deal-filter-predicates.ts:202-203`).
- **RFP denial + escalation already exist.** 2-of-3 voter rejection (`shared/src/lib/rfpVoteState.ts:25-62`) → `applyRfpDeclineToDeal` sets `rfp_approval_status='declined'`, `rfp_declined_reason` = aggregated voter reasons (`buildRfpVoteDeclineReason`, `rfp-vote-service.ts:309`), `rfp_declined_at` (`rfp-decline-service.ts:30-42`) → escalation email to **Adam + Takashi** (`RFP_REJECTION_EMAIL_RECIPIENTS`; `ashaw@trockgc.com`, `tyamashita@trockgc.com`) with a `/rfp-review/{dealId}` link (`worker/src/jobs/rfp-vote-outcome.ts`). On that page they can override-approve (→ Bid Board) or `reconfirmRfpDecline` (`rfp-override-service.ts:332-414`), which today only stamps `rfpOverrideDecision='denial_reconfirmed'` — **no archive, no description write**.
- **Voter reason on deny:** already required, client + server (`rfp-vote-service.ts:158-161` throws `RFP_VOTE_REASON_REQUIRED`; `rfp-vote-page.tsx:117-119` disables submit). Feature "C" is done except for the reviewer side (folded into Feature B).
- **Columns:** `deals.description = text("description")` (`shared/src/schema/tenant/deals.ts:89`), distinct from `name` (`:70`). Opportunity stage slug is canonical `"opportunity"` (`shared/src/types/workflow.ts`); a deal's slug resolves via the `pipeline_stage_config.slug` join already used in the deals query.

---

## Shared core — `buildArchivedDescription`

New pure helper (new file `server/src/modules/deals/archive-description.ts`), unit-tested in isolation:

```ts
/** Prepend an archive block to a deal's existing description, preserving the original. */
export function buildArchivedDescription(
  existing: string | null | undefined,
  reason: string,
  at: Date
): string {
  const stamp = formatBusinessDate(at); // YYYY-MM-DD in America/Chicago (reuse existing tz helper)
  const block = `[Archived ${stamp} — ${reason.trim()}]`;
  const prior = (existing ?? "").trim();
  return prior.length > 0 ? `${block}\n\n${prior}` : block;
}
```

- Empty/whitespace `existing` → just the block (no leading blank lines).
- `reason` is trimmed; callers guarantee it is non-empty (validated upstream).
- Timezone stamp uses the same business-tz date helper the reporting code already uses (America/Chicago), not raw UTC.

---

## Feature A — Rep manual archive (opportunity-only, reason required)

### Rename
- `filter-bar.tsx:63` label `"Removed"` → `"Archived"` (value stays `"inactive"`; update the adjacent comment). Server contract unchanged.

### Client (`deal-detail-page.tsx`)
- Menu item **"Delete Deal" → "Archive Deal"**. Enabled when `admin || (viewerOwnsDeal && dealStageSlug === "opportunity")`. For an owner on a non-opportunity stage: render the item **disabled with a tooltip** ("Only opportunity-stage deals can be archived — ask an admin"), so it stays discoverable.
- Replace the `window.confirm` with a small **modal**: a required "Reason for archiving" textarea + Cancel/Archive. Archive is disabled until the reason is non-empty (mirrors the RFP vote-reason UX). On submit call the archive API with `{ reason }`.
- Fix the misleading copy: the modal states the deal will be archived and hidden from active lists (no false "undone by an admin" promise; restore is out of scope).

### Server (`routes.ts` DELETE `/:id` + `deleteDeal`)
- Thread the **real** caller role and a **reason** instead of the hardcoded `"admin"`. New signature (options object to avoid a positional churn):
  `deleteDeal(tenantDb, dealId, { actorRole, actorId, reason, enforceOpportunityStageForNonAdmin: true })`.
- **Stage gate:** after loading the deal row `FOR UPDATE`, resolve its stage slug (via `pipeline_stage_config.slug` for `existing.stageId`). If `actorRole !== "admin"` and slug `!== "opportunity"` → `AppError(403, "Only opportunity-stage deals can be archived by reps.", "DEAL_ARCHIVE_STAGE_FORBIDDEN")`. Admins bypass the stage check.
- **Reason required:** empty/whitespace reason → `AppError(400, "A reason is required to archive a deal.", "DEAL_ARCHIVE_REASON_REQUIRED")`.
- **Description write:** in the same update that sets `is_active=false`, also set `description = buildArchivedDescription(existing.description, reason, now)`.
- Route keeps `assertDealOwnerRouteAccess({ allowAdmin: true })` (owner-or-admin) and the CO-child admin-only reject. It now passes `req.user.role` through instead of `"admin"`. The dead `userRole !== "admin"` stub in `deleteDeal` is removed (replaced by the real gate above).
- The existing `logActivity({ action: "soft_delete" })` gains the `description` field-change alongside `isActive`.

### Non-goals for A
- CO-child cascade, project mirror, task dismissal, commission removal: **unchanged**.
- Non-opportunity archiving by admins: **still allowed** (escape hatch).

---

## Feature B — RFP reconfirm-denial → auto-archive (+ reviewer reason)

### `reconfirmRfpDecline` (`rfp-override-service.ts:332-414`)
- **Require a reviewer reason:** empty → `AppError(400, "A reason is required to reconfirm a denial.", "RFP_REVIEW_REASON_REQUIRED")`. (Reuse the existing reviewer-note field on this path; no new column.)
- After stamping `rfpOverrideDecision='denial_reconfirmed'` (unchanged), in the **same transaction**:
  - Set `is_active=false` (archive) — guarded so a re-run/idempotent reconfirm doesn't double-write.
  - `description = buildArchivedDescription(existing.description, combinedNotes, now)` where
    `combinedNotes = "RFP denied. " + rfp_declined_reason + " · Final review (" + reviewerEmail + "): " + reviewerReason` (voter reasons already aggregated in `rfp_declined_reason`; append the reviewer's reason).
- **Either** reviewer triggers it (per decision 1); the existing WHERE-clause guard on `reconfirmRfpDecline` already prevents a double reconfirm.
- Write an audit-log `soft_delete` row (isActive + description change), consistent with the manual path.

### Untouched
- Override-**approve** path (still creates Bid Board via `enqueueRfpBidBoardCreate`).
- Voter-side reason enforcement (already done).
- Escalation email / `/rfp-review` gating (`requireRfpReviewer`).

### Edge cases
- Deal already `is_active=false` when reconfirm runs → archive write is a no-op guard; description not re-prepended.
- Deal stage at reconfirm is whatever it was (RFP is opportunity-triggered); no stage gate on this path — it's a reviewer/admin action.

---

## Out of scope (flagged, not built)
- **Restore / un-archive** for deals (no `is_active=true` write path exists today; `getDealById.includeInactive` is dormant infra). Separate future feature. We only correct the misleading "undone by an admin" copy.
- **Leads archive UI** — leads have the soft-delete backend but no button/filter; separate work.
- Changing the voter model, thresholds, or the approve-override path.

---

## Testing

**Unit (`archive-description.test.ts`):** prepend with existing text; empty/whitespace original → block only; business-tz date stamp; reason trimming.

**Server runtime (PGlite — these run in the CI gate; name `*.runtime.test.ts`):**
- Manual archive: rep owner + opportunity → `is_active=false` **and** description prepended; rep owner + non-opportunity → 403 `DEAL_ARCHIVE_STAGE_FORBIDDEN`; non-owner → 403; admin + non-opportunity → archives; empty reason → 400.
- RFP reconfirm: empty reviewer reason → 400 `RFP_REVIEW_REASON_REQUIRED`; reconfirm by either reviewer → `is_active=false` + description contains both voter reasons and reviewer reason; override-approve → NOT archived; already-archived deal → guarded no-op.

**Client:** archive menu item gating by stage+ownership (disabled tooltip off-stage); reason modal blocks submit until non-empty; filter label reads "Archived".

**Validation gate:** run `check:premerge` **and** server `test:runtime` before pushing (the premerge gate does not run `test:runtime`).

---

## Risks / implementation checks (the plan must resolve)
- **Required `reason` on `DELETE /:id` could break a non-UI caller.** Grep for every caller of `DELETE /api/deals/:id`; confirm the client archive action is the only one. If another path deletes without a reason, either make `reason` required only for the archive UI or supply a sensible default there — do not silently 400 an existing flow.
- **All `deleteDeal` call sites must move to the new options-object signature.** Grep for `deleteDeal(` across server; update each (route + any admin/CO paths) so none pass the old positional `userRole` string.
- **Stage-slug resolution.** `deleteDeal` currently loads `existing` via `select().from(deals)` (no slug). Add a `pipeline_stage_config.slug` lookup for `existing.stageId` (or join it into the `FOR UPDATE` load) so the opportunity gate reads a real slug, not `stage_id`.
- **Reviewer "note" field reuse.** `reconfirmRfpDecline` already accepts/stores a reviewer note (`rfp-override-service.ts:341-352`); make it required rather than adding a column.

## Delivery
- **PR 1 (Feature A):** rename + shared `buildArchivedDescription` + manual rep archive (opportunity gate, reason → description) + copy fix.
- **PR 2 (Feature B):** RFP reconfirm-denial auto-archive + required reviewer reason, built on PR 1's helper.
