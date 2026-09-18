# Pending RFP: surface the deals that need action

**Date:** 2026-09-18
**Status:** revised after adversarial review — awaiting approval
**Surface:** `/deals` kanban, the synthetic **Pending RFP** column

## Problem

The Pending RFP column holds two materially different things and shows them identically:

| Sub-state | Statuses | Prod (Dallas, 2026-09-18) | Meaning |
|---|---|---|---|
| `attention` | `send_failed`, `declined`, `conflict` | 8 | **someone must act** |
| `awaiting` | `pending`, `pending_outbox` | 19 | parked on an approver |

Every card is white with a slate border, and the column is ordered by request age
(`server/src/modules/deals/service.ts:4521`, `asc(rfpApprovalRequestedAt), desc(id)`), so the 8 that
need work are scattered through 27 look-alike cards.

### What this is NOT

The request called the parked deals "on hold". This deliberately uses neither that field nor that word:

- **`deals.on_hold` is the wrong field.** Zero of the 27 carry the stored flag; only 2 are *effectively*
  held. Colouring by hold state would colour almost nothing.
- **"On Hold" is taken.** It already means the amber `OnHoldBadge` and the $0 value-zeroing that travels
  with it. Reusing the word for "waiting on an approver" would collide with a live concept.

The state being described is what `/deals/pending-rfp` already calls **"Awaiting approval"**.

## Design

Three parts. The first is the one that solves the stated problem.

### 1. Rank attention first (server)

`getPendingRfpDeals` orders by request age. Add a leading sort key so attention states come first,
then oldest-first within each group:

```
ORDER BY (rfp_approval_status = ANY(<PENDING_RFP_ATTENTION_STATUSES>)) DESC,
         rfp_approval_requested_at ASC,
         id DESC
```

Built from the shared constant, never a literal list, so it cannot drift from membership.

**This must be server-side.** The column's cards are a capped slice; re-sorting client-side would
reorder only the cards that already made the cut and leave attention deals beyond the cap invisible.
Sorting in the `ORDER BY` also changes *which* cards make the slice — attention deals now always do.
That is the point, and it is a deliberate behaviour change.

The `/deals/pending-rfp` page already ranks this way (`pending-rfp-page.tsx:137-143`) and labels it in
the UI ("Needs attention shown first"). This makes the board agree with it.

### 2. Mark only the attention cards (client)

Reuse the card's **existing** attention idiom rather than inventing one. `DecoratedKanbanCard` already
renders a top accent bar plus a labelled chip for `billingAttentionRequired`
(`decorated-kanban-card.tsx:100-113`).

That idiom is **structurally free on this column**: `billingAttentionRequired` is computed only for
Won-family columns (`service.ts:4563`) and the Pending RFP cards come from a separate projection
(`service.ts:4489-4546`) that never sets it. So there is no collision to design around, and no corner
overlap between a top bar and anything else.

Attention cards get the bar + a chip carrying the page's own label and colour:

| Status | Chip label | Tone |
|---|---|---|
| `send_failed` | "Send failed" | red |
| `declined` | "Declined" | rose |
| `conflict` | "Conflict" | amber |

**Awaiting cards get nothing.** 8 marked cards among 19 plain ones is the signal; 27 marked cards is
wallpaper.

Colour is never load-bearing — every marked card carries the word too, matching the card's own
precedent (billing bar + chip, On Hold / At Risk / Change Order all labelled `Badge`s).

### 3. One presentation map, two consumers (client)

New `client/src/lib/pending-rfp-presentation.ts`: status → `{ label, tone }`, imported by **both**
`decorated-kanban-card.tsx` and `pending-rfp-page.tsx` (which currently hardcodes the same mapping
inline at `pending-rfp-page.tsx:42-57`).

This is the drift-proofing the previous draft only claimed. It lives in `client/`, not `shared/`,
because both consumers are client-side and `shared/` should not carry Tailwind class names.
`pendingRfpSubStateForStatus` stays where it is — this map sits beside it, not inside it.

### Gating

The board stamps `stageSlug={column.stage.slug}` (`deal-list-page.tsx:1130`) and the synthetic column is
`slug: "pending_rfp"` (`canonical-deal-board.ts:363`). No DB stage shares that slug, so the gate cannot
over-fire. Marking shows iff `stageSlug === "pending_rfp"` and the sub-state is `attention`.

No new prop. `rfpApprovalStatus` already reaches board cards via `...getTableColumns(deals)` and is
declared on the client `Deal` type (`use-deals.ts:237-245`).

### Where this renders

Not one view — **six**. `pending_rfp` is `isTerminal: false`, so the column appears on `/deals`,
`?filter=active`, `active_pipeline`, `closing_soon`, and the `at_risk*`/`stale` views. `won`,
`opportunities` and `bid_board` drop it.

Marking only attention states is what makes this safe: on an at-risk view, a marked card means "needs
action", consistent with the view's premise. The rejected rail design would have painted a *calm* sky
stripe on at-risk cards beside their own red At Risk badge.

## What the review changed

The first draft proposed a sky/rose left **rail** on every card in the column. Three reviewers
independently rejected it:

- **`bg-rose-500` + `inset-y-0 left-0 w-1` is already At Risk's "Past due" marker**
  (`at-risk-page.tsx:36,147`) — same idiom, same colour, different meaning, one click away.
- **The "colours reused verbatim" claim was false.** `bg-sky-400`/`bg-rose-500` appear nowhere in
  `pending-rfp-page.tsx`; the page uses 50-level chips, and its attention family is rose (`declined`)
  / amber (`conflict`, and the "Needs attention" aggregate) / red (`send_failed`) — not one rose.
- **It marked all 27 cards**, so nothing receded, and it left the age ordering untouched — the actual
  cause of the complaint.
- **`bg-sky-400` fails WCAG 1.4.11** (2.14:1 vs white; 3:1 required for meaning-bearing graphics).
- **It would have been the card's first colour-only signal.**
- **Card↔drawer disagreement**: `declined` would be loudest on the board but neutral slate on the deal
  page (`deal-detail-page.tsx:1912`).

## Testing

Cases go in the **existing** `client/src/components/deals/decorated-kanban-card.test.tsx`. Not a new
`*.runtime.test.*` file: the client CI gate runs `test:ci` → `vitest.ci.config.ts`
(`include: src/**/*.{test,spec}.{ts,tsx}`, quarantine empty), so every client test already runs, and a
second file would duplicate the 70-field `makeDeal` fixture and let it drift.

**Table-drive over the shared constants — never a hand-listed pair of statuses:**

1. `for (const s of PENDING_RFP_ATTENTION_STATUSES)` + `stageSlug="pending_rfp"` → bar + chip, with
   that status's label
2. `for (const s of PENDING_RFP_AWAITING_STATUSES)` + `stageSlug="pending_rfp"` → **no** marking
3. `rfpApprovalStatus: null` / omitted + `stageSlug="pending_rfp"` → no marking
4. any attention status + `stageSlug="opportunity"` → no marking (the gate)
5. accessible name carries the state for a marked card
6. server: `getPendingRfpDeals` returns attention before awaiting, oldest-first within each group

Case 2 is the one that matters: hand-listing `pending` alone would let
`status === "pending" ? … : attention` pass while every **`pending_outbox`** card is mismarked as
needing action — the exact inversion this feature prevents.

**Three named mutations, each must fail a specific case** (a "delete the code and see" proof is vacuous
for cases 2-4, which pass trivially when the feature is absent):

- delete the marking JSX → case 1 fails
- delete the `stageSlug === "pending_rfp"` gate → case 4 fails
- invert the sub-state branch → cases 1 **and** 2 fail

## Implementation notes

- The worktree needs `npm install` at root **and** `npm run build --workspace=shared` before any
  typecheck or test run, or `@trock-crm/shared/types` resolves to the main checkout and lies.
- `cn` is `twMerge(clsx(...))`. If a conditional class is added to the root, append it — do not remove
  `p-3` from the base and re-add a partial, which collapses the other three sides to 0.
- `muted-text-contrast.test.ts:89` ratchets this file at 1 `text-slate-400` occurrence and resolves
  module-level class constants by name. The new chip carries no `text-slate-400`, so the count holds.

## Out of scope

- Changing `on_hold` semantics, `OnHoldBadge`, or value-zeroing.
- The pre-existing card↔drawer colour mismatch on `deal-detail-page.tsx`'s RFP block (worth its own
  pass; this change does not widen it, since the board now uses the page's labels).
- The pre-existing scope-vs-office count divergence between the column and the cross-rep queue.
- The deferred Opportunity drill-down over-show (`pending-rfp-bucket` follow-up #1).

## Risk

Low, with one real one: **the sort changes which cards appear** in a capped column. That is intended,
but it means the column's visible set shifts on deploy. Everything else is one presentational branch
on one component, gated to one synthetic column.
