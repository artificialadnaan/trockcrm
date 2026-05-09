# Track F2 Internal Review Response 1

Reviewer result: P2 issues found, no P1s.

## Findings

1. Photo grid cards lost the delete action.
2. Sort-by selection was no longer reachable.
3. Hover-hidden action buttons were keyboard-hostile.
4. Upload close icon button lacked an accessible name.

## Fixes Applied

- Added delete action to photo cards.
- Made sort field reachable by cycling Date -> Name -> Size.
- Added a separate sort-direction toggle.
- Added `group-focus-within:opacity-100` and focus rings to hidden action regions.
- Added `aria-label="Close upload panel"`.
- Added tests for sort cycling and photo delete flow.
