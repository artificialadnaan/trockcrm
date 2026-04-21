# Dashboard And Pipeline Performance Pass Design

## Goal

Make the dashboard and pipeline surfaces load quickly and feel snappy without removing functionality, while keeping the role split intact:

- reps use a sales-showcase dashboard with their board as the hero
- admins and directors use operator-console dashboards
- deals and leads use one shared board grammar

The performance target is not just lower total load time. The product should show meaningful content quickly, avoid full-page blocking states, and move heavy detail behind paginated stage pages and deferred secondary panels.

## Problem Summary

The current slowdown is structural.

### Client-side bottlenecks

- `/` routes both admins and directors to the same `DirectorDashboardPage` in `client/src/App.tsx`.
- `DirectorDashboardPage` blocks on the full director payload before rendering usable content.
- `RepDashboardPage` and other dashboard surfaces still use page-level loading gates instead of section-level loading.
- Leads and deals use different data and interaction models, so the product pays for multiple code paths and teaches inconsistent navigation.

### Server-side bottlenecks

- `getDirectorDashboard()` in `server/src/modules/dashboard/service.ts` aggregates a broad multi-section payload in one request.
- `getDealsForPipeline()` in `server/src/modules/deals/service.ts` fetches up to 500 active deals and groups them in memory for the board.
- leads still come from `listLeads()` in `server/src/modules/leads/service.ts`, which returns a decorated list rather than a board-ready summary contract.

### UX bottlenecks

- Major routes still use full-page loading states instead of layered rendering.
- Boards try to behave as both overview and exhaustive detail view.
- Secondary context like charts, trends, and watchlists can hold the page hostage even when the primary workspace is enough to start working.

## Design Principles

1. Render in layers, not all at once.
2. Treat first paint as a product feature.
3. Keep the working surface above the fold and unblock it first.
4. Load overview data separately from detail data.
5. Use preview payloads for boards and paginated payloads for stage pages.
6. Preserve all stage-gate rules and workflow behavior.
7. Prefer one consistent board grammar for leads and deals.

## Route Strategy

### Home routing

- `rep` users continue to land on the rep dashboard.
- `director` users land on the director dashboard.
- `admin` users land on a separate admin dashboard instead of sharing the director home surface.

This removes the current overloading of `DirectorDashboardPage` as the default home for both admins and directors.

### Canonical working routes

- `/deals` remains the canonical deals workspace.
- `/leads` becomes the canonical leads workspace.
- `/pipeline` remains supported, but acts as a compatibility route to the canonical deal board.
- dedicated stage routes remain the place for full-stage inspection and pagination.

## Loading Architecture

Every major surface should render in three layers.

### Layer 1: shell

Render immediately:

- page title
- breadcrumb or parent navigation
- primary actions
- board frame or dashboard section shells

This layer should not depend on heavy API aggregation.

### Layer 2: primary workspace

Load next:

- rep board on rep dashboard
- team board and top-line team status on director dashboard
- operational triage and system health on admin dashboard
- stage counts and preview cards on board routes

This layer is the minimum required for a user to orient and act.

### Layer 3: secondary context

Load after the workspace is usable:

- trends
- charts
- stale watchlists
- blind spots
- activity breakdowns
- recent activity feeds
- secondary summary tables

No Layer 3 panel may block Layer 1 or Layer 2 from rendering.

## Dashboard Contracts

### Rep dashboard

The rep dashboard becomes board-first in both hierarchy and loading order.

First-paint data:

- personal board summary
- preview cards by stage
- task urgency counts
- stale follow-up signal

Deferred data:

- activity breakdown
- compliance trend
- secondary charts

The rep dashboard should answer:

- what is in my pipeline right now
- what is stuck
- what needs action today

### Director dashboard

The director dashboard becomes a team pipeline console.

First-paint data:

- team board summary
- stage pressure counts
- top-line pipeline and DD totals
- compact rep workspace preview

Deferred data:

- win-rate trend
- activity by rep deep view
- stale deals table
- stale leads table
- blind spot feed

The director dashboard should answer:

- where pressure is building
- which stages are backing up
- which reps or stages need intervention

### Admin dashboard

The admin dashboard becomes an operations console.

First-paint data:

- needs attention
- system health
- workspace changes
- compact team snapshot
- operations workspace entry points

Deferred data:

- recent activity feed
- detailed queue summaries
- secondary sales context panels

The current admin fan-out should be replaced with one lightweight summary endpoint for Layer 2, plus deferred follow-on requests for deeper modules.

## Board Contracts

### Shared board model

Deals and leads should use the same board contract shape:

- stage metadata
- count
- aggregate value when the entity supports it
- aging or risk signal
- preview cards limited per stage

The board response is an overview contract, not an exhaustive list.

### Preview cards

Each stage returns only the first small slice of cards for board rendering.

Recommended defaults:

- 8 preview cards per stage on desktop
- 5 preview cards per stage on smaller viewports

If a stage contains more cards, the column header includes a clear `View all` action with the total count.

### Stage detail pages

Clicking a stage opens a dedicated paginated stage page.

Stage pages support:

- pagination
- search
- sort
- stage-scoped filters
- back navigation to the parent board

Stage pages are read-only for stage movement. Drag-and-drop remains on the board only.

## Data Delivery Changes

### New lightweight dashboard endpoints

Add or split endpoints so the first visible content does not depend on large multi-section payloads.

Recommended shape:

- rep dashboard summary endpoint
- director dashboard summary endpoint
- admin dashboard summary endpoint
- separate deferred endpoints for trends, watchlists, and secondary modules

These summary endpoints should return only the data needed for Layer 2.

### Deal board optimization

Replace the current full-column payload behavior with a board preview contract.

Current problem:

- `getDealsForPipeline()` reads a large active-deal set and returns full stage arrays.

Target behavior:

- stage summaries and preview slices come from a preview-oriented query path
- full stage contents are only loaded through paginated stage detail requests
- terminal-stage summaries remain available, but do not overload the main board

### Lead board optimization

Introduce a true lead board contract instead of treating the lead list as the board.

Current problem:

- leads are fetched as a decorated list, then searched and paginated client-side

Target behavior:

- add a lead board summary endpoint
- add lead stage detail pagination on the server
- keep lead conversion rules unchanged

## Client Architecture Changes

### Section-level loading

Replace page-level `if (loading)` gates on dashboard and board routes with section-level loading ownership.

Examples:

- KPI band can load independently from charts
- board shell can load independently from secondary panels
- alert tiles can load independently from recent activity

### Route-level code splitting

Large routes should be lazy-loaded so visiting one workspace does not preload the whole app.

Priority candidates:

- `/director`
- `/deals`
- `/leads`
- admin operational pages

The app shell stays eager; heavyweight route modules become lazy.

### Navigation feel

The new model should make navigation feel faster even when data is still loading:

- route shell appears immediately
- page controls are interactive early
- section skeletons match final layout
- transitions between board and stage pages preserve context

## UI Direction

### Reps: sales showcase

- board is the hero
- personal pipeline pressure is visually obvious
- supporting stats sit below the board
- secondary panels appear after the working surface is ready

### Admins and directors: operator console

- calmer palette
- denser signal
- less card sprawl
- more table and board rhythm
- stronger information hierarchy

### Leads and deals

Use one visual grammar:

- same column header anatomy
- same count/value/risk line
- same preview-card density
- same stage-click affordance
- same loading and empty states

## Functional Guarantees

The performance pass must not remove or weaken existing behavior.

Preserve:

- all existing stage-gate rules
- drag-and-drop behavior on the board
- stage detail routes
- admin operational modules
- director drill-down paths
- lead conversion boundary and explicit conversion flow

Only the data delivery, loading sequence, and layout hierarchy change.

## Success Criteria

The work is successful when:

- dashboard routes show meaningful first content quickly
- a slow secondary panel does not block the page
- deals and leads feel like one product family
- boards load as overviews instead of exhaustive long-scroll dumps
- stage detail pages remain the place for full inspection
- admin and director homes feel structured and readable instead of overloaded

## Implementation Boundaries

This pass includes:

- client loading-state redesign for dashboard and board routes
- dashboard endpoint splitting or slimming for first-paint data
- deal board preview contract
- lead board contract and stage detail pagination
- route-level code splitting for major surfaces
- UI alignment between leads and deals

This pass does not include:

- changing stage-gate business rules
- changing deal or lead lifecycle semantics
- removing existing modules from admin or director workflows
- inventing new analytics that are unrelated to the loading and usability goals

## Risks And Mitigations

### Risk: fragmented loading feels jarring

Mitigation:

- use stable section skeletons
- keep layout dimensions consistent while data arrives
- prefer a small number of meaningful sections over many tiny loaders

### Risk: preview cards hide too much information

Mitigation:

- make counts explicit in each stage
- make `View all` prominent
- keep dedicated stage pages fast and paginated

### Risk: endpoint proliferation increases maintenance

Mitigation:

- split contracts around user intent: summary, board preview, stage detail
- reuse common summarization helpers on the server
- avoid one-off role-specific data shapes unless the role truly differs

## Testing Strategy

The implementation plan should cover:

- client unit tests for layered loading behavior and route fallbacks
- client tests for board preview rendering and stage-page transitions
- client tests for lazy-loaded route shells
- server tests for dashboard summary endpoints
- server tests for deal board preview payloads
- server tests for lead board preview and paginated stage detail payloads
- Playwright checks for dashboard and board responsiveness, navigation, and preserved stage flows
