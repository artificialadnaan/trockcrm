# T Rock CRM Admin And Director Dashboard Redesign

**Date:** 2026-04-20  
**Status:** Draft for review  
**Scope:** Rebuild the shared admin/director dashboard foundation so it is easier to scan, easier to act from, and safe to use with 500 seeded reps without losing existing dashboard functionality

## Goal

Replace the current busy, mixed-priority dashboard with a role-aware operating surface that:

- keeps the existing shell, routes, drill-downs, and supporting charts
- gives directors a clean team-performance workspace
- gives admins a clean operational-control workspace
- removes the endless rep scrolling problem
- uses space more productively without turning the page into another navigation menu

The redesign should improve readability and task completion first. A visual refresh matters, but only if the page becomes faster to operate.

## Current Problems

The current shared dashboard has four main issues:

### 1. Too many competing priorities

The page tries to be:

- a KPI summary
- a rep browsing surface
- an alerts page
- a charting page
- an activity report

Those jobs all compete for the same visual weight, so the user has to do their own prioritization every time they load the page.

### 2. Rep data is duplicated and unbounded

The rep set appears in multiple sections, and both surfaces can expand with every rep in the office. With 500 seeded reps, this creates long scanning time, weak hierarchy, and unnecessary rendering volume.

### 3. Admin and director jobs are different

Directors need:

- team comparison
- stale work visibility
- pipeline visibility
- rep drill-downs

Admins need:

- operational triage
- system health
- queue monitoring
- audit and configuration visibility

One undifferentiated layout forces both roles into a compromise.

### 4. The shell already provides navigation

The sidebar already exposes the major product surfaces. The dashboard should summarize and route work, not duplicate the left rail with another grid of navigation cards.

## Approaches Considered

### 1. Single shared dashboard

Keep one layout for admins and directors and improve spacing, styling, and table behavior.

**Pros**

- lowest implementation cost
- least route churn
- simplest mental model

**Cons**

- keeps the role conflict
- likely stays busy even after cleanup
- encourages continued section sprawl

### 2. Fully separate admin and director dashboards

Build two unrelated dashboard surfaces with independent layouts and data contracts.

**Pros**

- best role fit
- simplest information hierarchy per role

**Cons**

- higher maintenance cost
- duplicated concepts and components
- higher risk of design drift

### 3. Shared dashboard system with role-aware home layouts

Keep one dashboard foundation and shared design language, but make the home surface change based on role.

**Pros**

- clean role fit without fragmenting the product
- shared components and visual system
- easier to preserve existing functionality
- gives a clear place for rep pagination and admin triage

**Cons**

- more design work than a simple cleanup
- requires explicit boundaries between shared and role-specific sections

## Recommendation

Build a shared dashboard system with role-aware home layouts.

Design rules:

- one dashboard foundation
- one shared visual language
- one common top summary pattern
- role-specific main workspace
- supporting context below the fold

This keeps the product coherent while letting the home surface match the user’s actual job.

## Canonical Surface Boundary

### Shared shell

The redesign keeps:

- the existing sidebar
- the existing topbar
- the existing page container inside `AppShell`

The dashboard must not become a second navigation system.

### Route behavior

The current root route already resolves by role:

- reps land on the rep dashboard
- directors land on the director dashboard
- admins also land on the director dashboard

After the redesign:

- reps continue landing on the existing rep dashboard
- directors land on the new director-focused home dashboard
- admins land on the new admin-focused home dashboard
- `/director` remains available to admins and directors as the explicit team-performance lens

This preserves director access for admins without forcing admin home to lead with sales-rep browsing.

Sidebar rule:

- the shared `Dashboard` nav item continues to point to `/` for every role
- the `Director` nav item continues to point to `/director` for admins and directors
- for admins, `/` is the operational home and `/director` is the explicit team-performance lens
- for directors, `/` and `/director` may resolve to the same director-focused dashboard surface in V1

### Functional preservation boundary

This redesign does not remove:

- date presets
- rep drill-down navigation
- pipeline charting
- win-rate trend charting
- the existing performance trends comparison table
- the existing director blind-spot summary surface
- the current dashboard quick actions, though they may be restyled or renamed for clarity
- links into reports, pipeline, deals, AI actions, interventions, migration, audit, sync, and merge queue

The redesign changes hierarchy and interaction model, not product capability.

## Product Outcome

The new dashboard system should answer three questions immediately:

### For directors

- how is the team performing right now
- which reps or deals need attention
- who should I drill into next

### For admins

- what requires action right now
- is the system operating normally
- where do I go to resolve the current queue or failure

### For both roles

- what changed since the last visit
- what is safe to ignore
- what is the fastest next action

## Shared Dashboard Foundation

Both roles use the same three-band structure:

### 1. Primary status band

This is the first row of high-signal KPIs.

Rules:

- only 4 cards maximum
- each card must communicate one number and one sentence of scope
- cards should be scannable in under five seconds
- no decorative hero treatment

### 2. Main workspace band

This is the dominant area of the page.

Rules:

- one primary job only
- controls live directly above the working surface
- this area gets the most vertical space

### 3. Secondary context band

This supports monitoring and deeper context.

Rules:

- charts and watchlists move here
- only show sections that help interpretation or follow-up
- avoid repeating the same metric in a second visual form unless it adds a different decision angle

## Director Home Layout

### Primary status band

Directors see:

- `True pipeline`
- `DD pipeline`
- `Total pipeline`
- `Stale deals`

These KPIs preserve the current DD-versus-pipeline operating view while removing less important top-row competition.

### Main workspace band

The primary director workspace is the rep performance table.

This area becomes the center of the page and replaces the current pattern of:

- one full rep table
- one additional full “activity by rep” list

The director workspace includes:

- search by rep name
- sort control
- page-size control
- pagination controls
- row click-through into the current rep detail page
- a compact header action row preserving quick access to reports and AI actions

### Secondary context band

Directors then see:

- a compact stale-lead summary
- pipeline by stage
- win-rate trend
- the existing performance trends comparison table in a lower-priority section
- a compact activity summary
- a concise stale-work alert panel
- the existing director blind-spot summary surface

Placement rule:

- `ddVsPipeline` lives in the director primary KPI band
- the performance trends comparison table and director blind-spot summary stay on the director page, but below the rep workspace
- the old full activity-by-rep list does not return

The existing activity-by-rep section is reduced to a summary block rather than another unbounded list.

## Admin Home Layout

### Primary status band

Admins see:

- `Needs attention`
- `System health`
- `Workspace changes`
- `Team snapshot`

Definitions:

- `Needs attention` = the sum of open AI Actions, open Intervention cases, open Merge Queue items, and migration review items requiring action
- `System health` = the count of currently unhealthy operational sources, starting with Procore sync plus any active migration or admin process failures surfaced by existing admin data
- `Workspace changes` = the count of recent admin-facing audit events for users, offices, and pipeline configuration over a fixed trailing 24-hour window
- `Team snapshot` = one lightweight commercial-health metric, recommended as total pipeline value with active deal count in the supporting label

Counting rule:

- in V1, these KPIs are source-based summaries, not deduplicated entity counts
- if the same deal appears in both AI Actions and Interventions, each source still contributes to its own KPI because they represent different queues
- each KPI must show its source breakdown in supporting text so the total is explainable
- `System health` shows `0` when all monitored sources are healthy and a positive count when one or more monitored sources are failing; the supporting label names the failing sources

### Main workspace band

The primary admin workspace is an operations triage board.

This is not a second analytics dashboard. It is a prioritized entry point into admin work.

The board summarizes and links into:

- AI Actions
- Interventions
- Process Disconnects
- Migration
- Audit Log
- Procore Sync
- Merge Queue

Each tile or row shows:

- current count or status
- one short description of why it matters
- one direct action link

Priority rule:

- tiles are ordered by operational urgency, not alphabetically
- the first row should surface the sources contributing to `Needs attention` before lower-urgency oversight surfaces

The board should make “what needs action first” obvious without embedding full page replicas.

### Secondary context band

Admins then see:

- a compact team performance snapshot
- pipeline trend context
- a recent operational activity strip showing the newest queue or system changes surfaced by existing admin data

This keeps the admin home role-aware without hiding overall business health.

## Rep Performance Workspace

### Table columns

The director table should display:

- rep
- active deals
- pipeline
- win rate
- activity
- stale deals
- stale leads

### Sorting

V1 supports sorting by:

- pipeline
- stale risk
- activity
- win rate
- active deals
- rep name

Default sort:

- `pipeline desc`

### Search

V1 search is name-based and client-side against the current rep payload.

### Pagination

V1 uses client-side pagination on the existing rep-card payload.

Explicit choices:

- default page size: `25`
- additional page sizes: `50`, `100`
- current page resets to page 1 when search, sort, or page size changes

Rationale:

- shipping client-side pagination first solves the usability problem immediately
- it avoids expanding the dashboard API during the first redesign pass
- it keeps implementation risk low while still handling 500 seeded reps cleanly in the UI

### Follow-up threshold

If real usage shows the rep payload itself becoming slow or expensive, a later phase can move search, sort, and pagination server-side on `/dashboard/director`. That is explicitly out of scope for the first pass.

## Activity Summary Change

The current full activity-by-rep section should no longer render the entire rep set as a second workspace.

V1 replacement:

- team activity total
- most active rep
- activity mix
- a top-5 rep spotlight ranked by current activity total

Rule:

- no second full rep list on the page

## Supporting Charts And Alerts

### Charts

Keep:

- pipeline by stage
- win-rate trend

Move both below the primary workspace and present them as supporting context rather than co-equal competing surfaces.

### Alerts

Replace the current oversized strategic alert presentation with a smaller, more direct alert panel.

Alert panel rules:

- max 3 surfaced items
- each item must state what is wrong, who owns it, and where to go
- no decorative filler copy
- if there are no issues, show one calm empty state instead of dead space

## Component Architecture

The redesign should be implemented through a small number of focused components.

### Shared components

- `DashboardKpiBand`
- `DashboardSectionFrame`
- `DashboardEmptyState`
- `DashboardQuickActionList`

### Director-specific components

- `DirectorRepWorkspace`
- `DirectorAlertsPanel`
- `DirectorActivitySummary`

### Admin-specific components

- `AdminOperationsWorkspace`
- `AdminSystemHealthSummary`
- `AdminWorkspaceChangesSummary`
- `AdminTeamSnapshot`

### Page-level structure

The current `DirectorDashboardPage` should be split so that page-level routing and role selection are separate from the actual dashboard sections.

Recommended structure:

- a shared role-aware dashboard entry component for `/`
- a director-focused page component for `/director`
- smaller section components under `components/dashboard` or a role-specific dashboard folder

The main architectural goal is to stop one page file from owning every section, control, and role concern at once.

## Data Strategy

### Director data

Use the current director dashboard response as the starting contract.

V1 does not require a new backend endpoint for rep pagination because pagination is client-side.

The director page can continue using:

- rep cards
- pipeline by stage
- win-rate trend
- performance comparison data for the current performance trends table
- stale deals
- stale leads
- DD versus pipeline summary in the primary KPI band
- director blind-spot summary data for the lower-priority blind-spot section

### Admin data

V1 uses existing admin hooks and existing route data rather than introducing a new monolithic admin dashboard backend.

The admin home should aggregate from current admin-facing data sources and derive dashboard summaries in the client for the first pass.

## State And Interaction Rules

### Date presets

Keep the existing date preset control for director-facing performance context.

Admin home does not show the shared date preset control in V1. The admin primary status band is current-state operational data, not time-window reporting.

### Quick actions

The current scattered action buttons should become a tighter action row near the page header.

Rules:

- show only actions that matter for the active role
- prefer plain labels over icon-only affordances for the primary actions
- keep the number of always-visible quick actions low

Preservation rule:

- the director-facing quick action row must keep direct access to Reports and AI Actions in V1
- the admin-facing quick action row should prioritize Interventions, AI Actions, and Audit or Sync depending on which status source is currently failing

### Drill-down behavior

Row selection from the rep table continues to navigate to the current rep detail route.

No new modal drill-down is introduced in V1.

## Visual Direction

The visual direction should feel like an operating console:

- restrained
- dense where needed
- calm surface hierarchy
- fewer decorative treatments
- stronger typography and spacing

Specific rules:

- use fewer card borders that all compete equally
- reserve accent color for action, alert state, and active controls
- avoid large ornamental dark panels unless they improve scanning
- prefer clean table and section layouts over repeated bento-card patterns

## Responsive Behavior

### Desktop

Desktop should prioritize:

- one dominant workspace
- compact top metrics
- side-by-side supporting sections only when both are clearly readable

### Tablet and mobile

On smaller screens:

- KPI cards stack
- the primary workspace keeps search and pagination controls visible
- wide data tables scroll horizontally when necessary rather than collapsing into unreadable mini-cards
- supporting sections stack after the main workspace

The mobile version should still preserve the core operating flow:

- scan
- filter
- select
- drill in

## Loading, Empty, And Error States

### Loading

Use compact skeletons that preserve final layout shape. Avoid giant placeholder blocks that make the dashboard feel heavier than it is.

### Empty states

Every section needs a useful empty state:

- no reps found for current search
- no stale work right now
- no queue items requiring action
- no chart data for selected period

Empty states should say what happened and what to try next.

### Errors

Errors should be section-scoped where possible. A stale alert failure should not blank the entire page if the rep workspace and KPIs loaded correctly.

## Testing Strategy

### Unit and component tests

Add or update tests for:

- role-based dashboard selection
- rep table pagination behavior
- search and sort interactions
- page reset when filters change
- admin workspace rendering of action counts and links

### Regression checks

Verify:

- director drill-down navigation still works
- existing date presets still change director metrics correctly
- charts still render with current data contracts
- no existing admin routes are orphaned by the new home surface

### Manual verification

Manual review should confirm:

- 500 seeded reps do not produce an endless-scroll experience
- the first screen is readable on laptop-width layouts
- admins and directors see different priorities without losing access to shared tools

## Non-Goals

This redesign does not include:

- changing the rep dashboard
- rewriting the sidebar
- building a server-side paginated rep API in V1
- replacing existing admin pages with embedded dashboard replicas
- removing the explicit `/director` route

## Final Recommendation

Build a role-aware dashboard system with:

- a shared layout foundation
- a director home centered on a paginated rep workspace
- an admin home centered on operational triage
- supporting charts and alerts below the primary workspace
- no duplicated full rep lists

This is the smallest redesign that meaningfully fixes readability, usability, and space efficiency while preserving the current platform’s capabilities.
