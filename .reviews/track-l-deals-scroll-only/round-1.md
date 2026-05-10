# Round 1 — code-reviewer

**Verdict:** LGTM. No blocking, important, or notable issues.

## Coverage

All 5 scope items verified:
1. Redirect reverted; sub-routes intact.
2. navigate("/pipeline") → navigate("/deals") in deal-detail (2×), deal-edit, deal-new with label revert.
3. Scroll cap `max-h-[44rem]` correctly constrains the column; combined with `overflow-hidden` on section and inner `overflow-y-auto` engages internal scroll.
4. Sidebar distinct: Deals→/deals, Pipeline→/pipeline. No active-state conflict (paths don't share prefix).
5. Tests cover layout, scroll cap, and ?scope=team deep link.

## No issues raised

- Imports clean (useLocation, Navigate still used by BoardAliasRedirect; DealListPage actively consumed again).
- getNavItemKey now harmless but not dead code (still called).
- Scroll cap CSS structurally correct: column max-h wins over h-full → overflow-hidden clips → inner overflow-y-auto scrolls.

## Decision

No round-2 needed. Proceed to push + PR + Codex review.
