# leads-kanban-truncation-bug Diagnosis

## Surface

- Leads kanban page: `client/src/pages/leads/lead-list-page.tsx`
- Board hook/API call: `client/src/hooks/use-leads.ts`
- Backend endpoint: `GET /api/leads/board` in `server/src/modules/leads/routes.ts`
- Backend board service: `server/src/modules/leads/service.ts`

## Root Cause

The truncation is server-side, triggered by a client-requested preview cap.

- `client/src/hooks/use-leads.ts:691` called `/leads/board?scope=${scope}&previewLimit=8`.
- `server/src/modules/leads/routes.ts:71` passed that query value into `readBoardInput`.
- `server/src/modules/leads/service.ts:983` clamped the preview limit to `1..12`, defaulting to `8`.
- `server/src/modules/leads/service.ts:1016` returned `cards: column.cards.slice(0, previewLimit)`.

The server computed `count` from the full grouped card set before slicing returned cards. That explains the production evidence where the "New Lead" header showed `24` while only `8` card records were available to render.

## Client Rendering Check

The leads column did not have a client-side card slice. `client/src/pages/leads/lead-list-page.tsx` renders `cards.map(...)` inside a `min-h-0 flex-1 ... overflow-y-auto` container.

The shared deals scroll component exists at `client/src/components/deals/kanban-scroll-column.tsx` and is used by the deals board. The leads board does not use that component, but its local column body already has internal vertical overflow styling. The missing records were not reachable because they were not returned in the leads board payload.

## Fix Direction

Minimal fix:

- Stop requesting `previewLimit=8` from `useLeadBoard`.
- Remove the leads board service's returned-card cap so the column header count and returned `cards.length` match.
- Keep the existing leads column internal scroll behavior.

Backend change is in scope because Phase 1 proves the cap is server-side.
