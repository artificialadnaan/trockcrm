# Shell And Header Uniformity Design

## Goal

Make the application frame feel uniform across routes by standardizing:

- the desktop shell proportions
- the T Rock brand lockup and logo sizing
- the topbar height, spacing, and control alignment
- the page-level header pattern used for titles, counts, supporting copy, and actions

This is a visual systems cleanup, not a feature redesign. The outcome should be a calmer, tighter workspace where moving between routes no longer changes the perceived size or weight of the app chrome.

## Current Problems

The current layout drift comes from two places:

1. The sidebar brand block uses an oversized cropped logo image that does not fit the shell rhythm cleanly.
2. Page headers are authored ad hoc. Some pages use `space-y-4`, some add their own `p-6 max-w-5xl mx-auto`, some place dense controls directly against the top edge, and some use title rows with different font weights and spacing.

The topbar itself is already a fixed height, but the surrounding page composition makes it appear to change from page to page.

## Design Direction

The workspace should feel like a single operational product surface:

- dark, disciplined navigation on the left
- a restrained top rail with quiet controls
- page titles and actions aligned to one repeatable pattern
- consistent vertical spacing from shell chrome into page content

The red brand accent remains present but sparse. Visual hierarchy comes from spacing, typography, contrast, and alignment rather than heavier borders or larger controls.

## Scope

In scope:

- desktop sidebar brand treatment
- desktop topbar styling and spacing
- shared main-content container rhythm
- a reusable page-header component for list, admin, and dashboard pages
- migration of the most visible route-level headers to that shared component
- responsive behavior to preserve coherence on smaller screens

Out of scope:

- mobile navigation redesign
- changing route structure or information architecture
- redesigning page-specific cards, charts, or tables beyond spacing needed for header consistency
- replacing brand assets

## Shared Shell Changes

### Sidebar

The sidebar keeps its current width and dark color family, but the brand block becomes a properly bounded identity lockup.

Changes:

- Replace the oversized cropped logo presentation with a stable square mark container.
- Render the logo inside that container with `object-contain` rather than zoomed crop behavior.
- Tighten the lockup spacing between mark and wordmark.
- Keep the current `T ROCK / CRM` wordmark, but align it to the same vertical center as the mark.
- Use consistent top and bottom padding for the brand block so it visually anchors the nav without appearing taller than the topbar.

### Topbar

The topbar remains the app-wide action rail.

Changes:

- Keep a single explicit height across routes.
- Strengthen the background and border treatment just enough to separate it from page content without reading as a second card.
- Normalize horizontal padding to match the main content gutter.
- Align search, notifications, and avatar to a single control height.
- Ensure the search trigger has a stable width and does not visually collapse on pages with different content below it.

### Main Content Frame

The `main` region should provide one inherited rhythm for all routed pages.

Changes:

- Use one default page gutter for desktop routes.
- Add a shared page stack spacing so headers and first content blocks land at the same distance beneath the topbar.
- Avoid route-level wrapper padding when the shell already provides it, except where a route intentionally uses a narrower reading width.
- Preserve the existing mobile bottom padding for the mobile nav.

## Page Header System

Introduce a shared page-header component for route-level orientation.

The component supports:

- `title`
- optional `eyebrow`
- optional `description`
- optional `meta` line for counts or status
- optional `actions`
- optional secondary content row for filters, tabs, or controls

Layout behavior:

- The title block and primary actions share one row on desktop.
- On smaller widths, actions wrap beneath the title without collapsing spacing.
- Supporting text sits directly beneath the title block and uses a smaller muted style.
- Secondary controls sit in a separate row with a smaller top gap than the transition from topbar to title.

Visual rules:

- Title size and weight are consistent across routes.
- Counts such as “509 active · 1 inactive” or “23 deals” use the same `meta` style.
- Primary actions align to the top edge of the title block, not the supporting copy.
- Page headers do not introduce their own card chrome.

## Route Migration Plan

Convert representative high-traffic pages first so the system is visible across the app:

- dashboard
- deals list
- contacts list
- admin users

These pages cover:

- dashboard greeting with support copy
- list page with count and primary action
- admin table page with count and utility action

If the shared component fits these cleanly, it will fit the majority of remaining routes without special casing.

## Responsive Behavior

- Desktop preserves the sidebar and topbar structure.
- Tablet and smaller desktop widths allow page-header actions to wrap cleanly.
- Mobile keeps the existing mobile nav. The page-header component collapses to a one-column stack with consistent gaps.
- The logo mark must remain legible at reduced sizes without cropping.

## Accessibility

- Logo image keeps meaningful alt text.
- Title hierarchy remains one route-level heading per page.
- Buttons and search controls maintain current tap target standards.
- Color adjustments must preserve contrast for muted text, badges, and nav states.

## Testing And Verification

Implementation is complete when:

- the logo no longer appears cropped or oversized
- the topbar height and control alignment read the same across the sampled routes
- dashboard, deals, contacts, and admin users share the same page-header rhythm
- no route shows doubled top padding from shell and page wrappers
- responsive behavior remains intact on desktop and mobile widths

Verification steps:

- run client typecheck/build if required by existing workflow
- visually inspect the shared shell and sampled routes
- use browser-based checks to compare at least dashboard, deals, contacts, and admin users

## Risks

### Route-level wrapper collisions

Some pages may carry their own outer padding or width constraints. When converting to the shared page-header system, those wrappers may need trimming so the shell remains the source of truth for spacing.

### Header action wrapping

Pages with many controls can create awkward action wrapping. The shared component must support a secondary row instead of forcing every control into the title row.

### Sidebar asset fit

If the existing logo asset has unusual whitespace, `object-contain` may reveal it. If that happens, the container size should be tuned rather than returning to cropped scaling.
