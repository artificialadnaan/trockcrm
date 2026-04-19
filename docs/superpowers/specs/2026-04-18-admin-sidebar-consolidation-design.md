# Admin Sidebar Consolidation

## Goal

Reduce admin-navigation sprawl in the left sidebar without removing any routes or capabilities.

This slice is navigation cleanup only. It does not change route behavior, page ownership, or permissions.

## Problem

The current sidebar has already been improved at the page level:

- `/admin/interventions` is the execution workspace
- `/admin/intervention-analytics` is the manager console
- `/admin/sales-process-disconnects` is the upstream signals page

But the sidebar still presents related admin routes as one flat list. That creates three problems:

1. intervention-related routes still read like separate products
2. AI/admin routes are visually crowded
3. admins must scan a long list of unrelated destinations with weak grouping

## Desired Outcome

Keep every existing route, but reorganize admin navigation into collapsible groups with a clearer operating model.

The sidebar should communicate:

- `Operations` for day-to-day queue, signals, and manager monitoring
- `AI` for AI-specific review and operations surfaces
- `System` for configuration, audit, sync, reporting, and migration

## Scope

In scope:

- sidebar information architecture for admin/director users
- collapsible admin route groups
- sensible default open/closed behavior
- active-state handling for grouped admin routes
- preserving existing route labels or tightening them where it improves clarity

Out of scope:

- deleting routes
- changing route permissions
- changing page layouts
- moving functionality between pages
- introducing a brand-new top-level nav system

## Navigation Model

### Global Sections

Keep the top-level sidebar structure:

- general app routes
- `Director`
- `Admin`
- `Help`

Only the `Admin` section changes in this slice.

### Admin Groups

Replace the flat `Admin` list with collapsible groups:

#### Operations

Default state:

- open by default for `admin`
- open by default for `director`

Routes:

- `/admin/sales-process-disconnects` → `Process Disconnects`
- `/admin/interventions` → `Interventions`
- `/admin/intervention-analytics` → `Intervention Analytics`
- `/admin/merge-queue` → `Merge Queue`

Reasoning:

- these are the most operationally active admin/director surfaces
- they should remain immediately visible without extra clicks

#### AI

Default state:

- collapsed by default

Routes:

- `/admin/ai-actions` → `AI Actions`
- `/admin/ai-ops` → `AI Ops`

Reasoning:

- these are related, but not the main daily intervention operating surfaces

#### System

Default state:

- collapsed by default

Routes:

- `/admin/offices` → `Offices`
- `/admin/users` → `Users`
- `/admin/pipeline` → `Pipeline Config`
- `/admin/procore` → `Procore Sync`
- `/admin/data-scrub` → `Data Scrub`
- `/admin/audit` → `Audit Log`
- `/admin/cross-office-reports` → `Cross-Office Reports`
- `/admin/migration` → `Migration`

Reasoning:

- these are lower-frequency administration and system-management destinations

## Route Ownership Notes

This slice must reinforce the page split already established:

- `Process Disconnects` = source signals
- `Interventions` = execution
- `Intervention Analytics` = manager console

The sidebar should support that separation rather than flattening those routes into an undifferentiated admin list.

## Interaction Rules

### Collapse Behavior

- each admin group is toggleable
- clicking a group header expands/collapses only that group
- multiple groups may be open at once
- groups are not accordion-exclusive

### Active-State Behavior

- the active route still uses the existing selected-nav styling
- if the active route belongs to a collapsed group, that group must auto-expand on render
- if the current route is inside `Operations`, `AI`, or `System`, the owning group must visibly indicate active context

### Persistence

For v1:

- no local-storage persistence is required
- open/closed state can be derived from default rules plus current route

This keeps the slice small and avoids state drift bugs.

## Labels and Naming

Keep current route labels unless there is a strong clarity gain.

Approved group labels:

- `Operations`
- `AI`
- `System`

Route labels should remain:

- `Process Disconnects`
- `Interventions`
- `Intervention Analytics`
- `Merge Queue`
- `AI Actions`
- `AI Ops`
- `Offices`
- `Users`
- `Pipeline Config`
- `Procore Sync`
- `Data Scrub`
- `Audit Log`
- `Cross-Office Reports`
- `Migration`

## Visual Direction

This is not a visual redesign, but the grouped nav should feel intentionally structured.

Requirements:

- preserve existing sidebar color system and active-state styling
- use compact group headers that fit the current sidebar visual language
- keep icon + label readability strong
- avoid adding heavy card/chrome styling inside the sidebar

## Accessibility

Collapsible group headers must be keyboard accessible.

Requirements:

- group toggles are real buttons
- expanded/collapsed state is exposed semantically
- focus treatment remains visible in the existing sidebar style

## Success Criteria

This slice is successful if:

1. all current admin routes remain reachable
2. the `Admin` area is shorter and easier to scan
3. intervention-related destinations are clearly grouped under `Operations`
4. AI/admin/system destinations are visually separated without route loss
5. users can tell where to go for signals, execution, and manager monitoring

## Verification

Must verify:

- admin sidebar renders grouped `Admin` navigation
- director sidebar renders only the allowed grouped entries
- active route auto-expands the correct group
- `Operations` is open by default
- `AI` and `System` are collapsed by default unless active
- every grouped route still navigates correctly
- no existing non-admin sidebar sections regress
