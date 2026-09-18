# Pending RFP board cards: colour by sub-state

**Date:** 2026-09-18
**Status:** awaiting review
**Surface:** `/deals` kanban, the synthetic **Pending RFP** column only

## Problem

Every card in the Pending RFP column looks identical — white, slate border. There are 27 of them in
Dallas today and they are two materially different things:

| Sub-state | Statuses | Today | Meaning |
|---|---|---|---|
| `attention` | `send_failed`, `declined`, `conflict` | 8 | **someone must act** |
| `awaiting` | `pending`, `pending_outbox` | 19 | parked, waiting on an approver |

You cannot tell them apart without opening each deal, so the 8 that need work are hidden among the 19
that need nothing.

### What this is NOT

The request described the parked deals as "on hold". This spec deliberately does **not** use that term
or that data field:

- **`deals.on_hold` is the wrong field.** Zero of the 27 Pending RFP deals carry the stored flag, and
  only 2 are *effectively* held (far-out close target). Colouring on hold-state would colour nothing.
- **"On Hold" is a taken word.** It already means a specific thing — the amber `OnHoldBadge` and the
  $0 value-zeroing that travels with it (`isDealValueEffectivelyOnHold`). Reusing the label for
  "waiting on an approver" would collide with a load-bearing concept and the two would drift apart.

The state actually being described is the one the `/deals/pending-rfp` page already calls
**"Awaiting approval"**. This spec adopts that existing name and its existing colours.

## Design

A **left edge rail** on the card, coloured by sub-state, shown only in the Pending RFP column.

```
┌─────────────────────────────┐
│▌ DFW-1-15426-AB     $439,121│   ▌ rose  = needs action
│▌ The Onyx                   │   ▌ sky   = awaiting approval
│▌ Dallas · 12d in stage      │   (no rail anywhere else)
└─────────────────────────────┘
```

**Attention is the colour that pops.** The original request was to colour the parked deals, but the
stated goal was spotting what needs action. Tinting the 19 parked cards draws the eye to the deals that
need nothing. The `/deals/pending-rfp` page already resolves this the right way — calm sky for awaiting,
rose/red for attention — and the board should match.

### Colours — reused, not invented

Taken verbatim from `pending-rfp-page.tsx`'s existing `StatusMeta` chips so the two surfaces cannot
drift:

| Sub-state | Rail |
|---|---|
| `awaiting` | `bg-sky-400` |
| `attention` | `bg-rose-500` |

Per-status differentiation (declined vs conflict vs send_failed) is deliberately **not** carried onto
the rail — at 4px wide, three reds are indistinguishable. The card keeps one attention colour; the page
remains the place for per-status detail.

### Why a left rail and not a top bar or a tint

- The card **already has a top bar**: `absolute inset-x-0 top-0 h-1 bg-red-600` for
  `billingAttentionRequired`. A second top bar would fight it. A left rail coexists.
- A full background tint on 27 cards makes the column loud and clashes with the At Risk / On Hold /
  Change Order badges, which carry their own colours on the same card.

### Placement

`client/src/components/deals/decorated-kanban-card.tsx` — the component the board actually renders
(`deal-list-page.tsx:1130`). Mirrors the existing billing bar:

```jsx
{rfpSubState ? (
  <span
    className={cn("absolute inset-y-0 left-0 w-1", RFP_RAIL[rfpSubState])}
    aria-hidden="true"
  />
) : null}
```

The card is already `relative overflow-hidden rounded-md`, so the rail clips to the corner radius with
no extra work. The existing `GripVertical` sits at the card's left padding; the rail needs the content
to shift right by the rail width when present, so the root gains `pl-4` in that case (`p-3` otherwise).

### Gating — no new predicate

The board stamps its column slug onto every card: `<DecoratedKanbanCard stageSlug={column.stage.slug}>`,
and the synthetic column is `slug: "pending_rfp"` (`canonical-deal-board.ts:363`). Membership was
already decided upstream by the shared `isPendingRfpBoardCard`.

So the rail shows iff `stageSlug === "pending_rfp"`, and its colour comes from the shared
`pendingRfpSubStateForStatus(deal.rfpApprovalStatus)`.

This **reuses the already-applied predicate's result** rather than re-deriving membership on the card.
Re-running `isPendingRfpBoardCard` here would be a second evaluation that could disagree with the column
it is drawn in. One decision, one place.

`rfpApprovalStatus` already reaches board cards via `getDealsForPipeline`'s `...getTableColumns(deals)`.
**No server change, no API change, no new prop.**

### Accessibility

Colour alone must not carry the meaning. The sub-state is added to the card's existing `accessibleName`
("Awaiting approval" / "Needs action") and to a `title` tooltip. No new visible chip — the request was
for colour, and the card already carries three badges.

## Testing

`decorated-kanban-card.substate-rail.runtime.test.tsx` (`*.runtime.test.*` so the CI gate executes it):

1. `pending` + `stageSlug="pending_rfp"` → sky rail present
2. `send_failed` + `stageSlug="pending_rfp"` → rose rail present
3. `pending` + `stageSlug="opportunity"` → **no rail** (the gate)
4. `approved` + `stageSlug="pending_rfp"` → no rail (sub-state null)
5. A billing-attention Pending RFP card → **both** the top bar and the left rail render
6. Accessible name carries the sub-state for both states

Each must fail with the rail code removed (mutation-checked, not assumed).

## Out of scope

- The `/deals/pending-rfp` page — already has chips.
- Any change to `on_hold` semantics, the `OnHoldBadge`, or value-zeroing.
- Per-status rail colours.
- The deferred Opportunity drill-down over-show (`pending-rfp-bucket` follow-up #1).

## Risk

Very low. One presentational component, no data or server change, gated to one synthetic column.
Worst case the rail renders on the wrong cards, which is visible immediately and reverts cleanly.
