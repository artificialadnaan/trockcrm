# My Cleanup Inline Deal Editor

## Goal

Allow sales reps to fix cleanup-item deal data directly from the `My Cleanup` queue without leaving the queue page.

This applies only to cleanup rows where `recordType === "deal"`.

Lead cleanup rows remain routed through the existing gated lead workflow and are not editable inline.

## Current State

- [`client/src/pages/pipeline/my-cleanup-page.tsx`](../../../../tmp/trock-phase1-merge/client/src/pages/pipeline/my-cleanup-page.tsx) renders cleanup rows as static cards.
- Reps can see why a record needs cleanup, but cannot resolve the record in-place.
- The repo already has a reusable full deal editor in [`client/src/components/deals/deal-form.tsx`](../../../../tmp/trock-phase1-merge/client/src/components/deals/deal-form.tsx).

## Approved Approach

Use an in-place modal editor on the `My Cleanup` page for `deal` cards.

- Clicking a deal cleanup card, or its explicit `Edit Deal` action, opens a dialog.
- The dialog contains the existing `DealForm` loaded with the selected deal.
- Saving updates the deal in-place, closes the dialog, and refreshes the cleanup queue.
- Resolved cleanup rows disappear automatically after refresh because the queue is derived from live record state.

## Scope

### In Scope

- Add a modal editor for `deal` cleanup rows on `/pipeline/my-cleanup`
- Reuse the existing `DealForm` for editing
- Load the selected deal record before opening the form
- Refresh the cleanup queue after save
- Keep the rep on the cleanup page after save
- Preserve existing lead-row behavior

### Out of Scope

- Inline editing for `lead` cleanup rows
- New deal-specific cleanup APIs
- Bulk edit behavior from the rep queue
- Reworking lead gates or lead-stage validation

## UX Behavior

### Deal rows

- Deal rows show an `Edit Deal` action.
- Clicking the row or the button opens a modal dialog.
- The dialog title references the selected deal.
- The modal uses the existing full deal form, not a reduced cleanup-only form.
- Save success closes the modal and refreshes the queue.
- Save failure leaves the modal open and uses existing form error handling.

### Lead rows

- Lead rows do not open the in-place editor.
- Lead rows continue to point users toward the gated lead flow.

## Technical Design

### Queue page

Update `MyCleanupPage` to manage:

- selected cleanup row
- selected deal data
- modal open/close state
- loading state while fetching deal details

### Deal loading

Use the existing deal detail fetch path so the modal form receives a complete `Deal` object compatible with `DealForm`.

### Editing

Render `DealForm` inside a shared dialog component.

- pass `deal`
- pass `onSuccess`
- in `onSuccess`, close modal and call queue `refetch()`

### Navigation

Do not redirect to `/deals/:id` after save when editing from cleanup.

The dialog flow keeps the rep inside `/pipeline/my-cleanup`.

## Risks

- `DealForm` is page-oriented and may need minor container sizing adjustments inside a dialog.
- Cleanup queue freshness depends on a post-save refresh; the queue should not attempt optimistic local removal.

## Validation

- Rep can open `My Cleanup`
- Rep can open a `deal` cleanup item in a modal
- Rep can edit deal fields and save successfully
- Queue refreshes after save
- Resolved deal rows disappear when underlying cleanup reasons are satisfied
- `lead` cleanup rows do not open the deal editor
