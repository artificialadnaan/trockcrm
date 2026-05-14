# Discovery: Description Column on Deals and Leads List Views

Date: 2026-05-14
Branch: `feat/list-views-description-column`
Worktree: `/Users/adnaaniqbal/projects/trockcrm/.worktrees/feat-list-views-description-column`

## Branch setup

- Source of truth repo checkout at `/Users/adnaaniqbal/projects/trockcrm` was dirty on `fix/estimator-notes-backspace`.
- To avoid touching unrelated local changes, this work was started in an isolated git worktree from `origin/main`:
  - branch: `feat/list-views-description-column`
  - path: `/Users/adnaaniqbal/projects/trockcrm/.worktrees/feat-list-views-description-column`

## List view locations

### Deals

- Page shell: `client/src/pages/deals/deal-list-page.tsx`
- Actual list/table renderer: `client/src/components/deals/deals-list-section.tsx`
- Shared table primitive: `client/src/components/pipeline/pipeline-stage-table.tsx`

The deals page renders a kanban board plus a lower “Pipeline records” table section. The Description column belongs in the lower table, not the kanban board.

### Leads

- Page and list renderer: `client/src/pages/leads/lead-list-page.tsx`

The leads page is not using the shared table primitive for its “Recent open leads” list. It renders a row-based responsive grid inline in the page component.

## Schema check

### Deals schema

- File: `shared/src/schema/tenant/deals.ts`
- Field present: `description: text("description")`

### Leads schema

- File: `shared/src/schema/tenant/leads.ts`
- Field present: `description: text("description")`

Result: both entities already have a persisted `description` field. No schema change is needed.

## API / client data availability

### Deals

- Client hook type `Deal` in `client/src/hooks/use-deals.ts` already includes:
  - `description: string | null`
- `/api/deals` route in `server/src/modules/deals/routes.ts` returns `getDeals(...)` and redacts the deal list, but does not strip `description`.

Result: description is already on the wire for deals list rows.

### Leads

- Client hook type `LeadRecord` in `client/src/hooks/use-leads.ts` already includes:
  - `description: string | null`
- `listLeads(...)` in `server/src/modules/leads/service.ts` performs `select().from(leads)` and `decorateLeads(...)`, so `description` is already included in the rows returned to `/api/leads`.

Result: description is already on the wire for leads list rows.

## Existing rendering pattern

### Deals

- The primary “Deal” cell currently renders:
  - name
  - project/deal number
  - company/location secondary line
- This cell already uses a stacked primary/secondary text pattern.
- The shared table primitive applies fixed `TableHead` / `TableCell` classes, so per-column responsive behavior will need to be handled inside `PipelineStageTable` by allowing column-level head/cell class names or similar minimal extension.

### Leads

- The “Recent open leads” rows render as a responsive grid:
  - name/company
  - owner
  - value
  - source
  - icons
- This is already a custom responsive layout, so hiding Description on smaller viewports can be done directly with `hidden md:block` style classes in the row grid.

## Scope decision

Minimal implementation scope:

- `client/src/components/pipeline/pipeline-stage-table.tsx`
  - small extension to support per-column responsive/head/cell classes
- `client/src/components/deals/deals-list-section.tsx`
  - add Description column immediately after Deal/Name
- `client/src/pages/leads/lead-list-page.tsx`
  - add Description column immediately after Name in the recent-open-leads list
- tests:
  - `client/src/components/deals/deals-list-section.test.tsx`
  - `client/src/pages/leads/lead-list-page.test.tsx`

Out of scope and not needed:

- server projections / DTO reshaping
- deal detail pages
- lead detail pages
- forms
- `server/src/modules/deals/service.ts`
