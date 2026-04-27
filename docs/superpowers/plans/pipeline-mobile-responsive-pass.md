# Pipeline mobile responsive pass

## Problem
The `/pipeline` kanban board (rebuilt in the UI cleanup pass) remains a
horizontally-scrolling 320px-wide column board on viewports below `md` (768px).
On a phone this means side-scrolling through 7+ columns to find a deal.

The desktop rebuild was deliberately scoped to scroll model + visual cleanup —
mobile responsive treatment was explicitly out of scope.

## Suggested fix
Pick one direction:

1. **Stage selector + single column view (preferred)** — on `< md`, render a
   horizontal stage chip rail at the top and show one column at a time. Tap a
   chip to switch. Drag-and-drop disabled; tapping a card opens detail.
2. **Compact stacked view** — collapse the board into a stack of stage sections,
   each with the count + $ total header and the cards beneath. No horizontal
   scroll. Drag-and-drop disabled.

Either way: hide the synced top horizontal scrollbar proxy on mobile (it's
unnecessary in both options).

## Files affected
- `client/src/pages/pipeline/pipeline-page.tsx` (board layout)
- Possibly a new `pipeline-mobile-board.tsx` component if option 1 grows
- Tailwind breakpoint usage: `md:` prefix on the existing kanban container
