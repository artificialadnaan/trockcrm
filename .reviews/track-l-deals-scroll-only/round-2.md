# Round 2 — Codex

**Verdict:** LGTM with one NICE finding.

## Findings

**NICE** — `client/src/pages/deals/deal-list-page.test.tsx` scroll-cap test name overclaims. It asserts class strings (`max-h-[44rem]`, `overflow-y-auto`), not actual layout/scroll behavior. Fine as a class-regression test, but the name implied a stronger assertion than the body delivers.

**Action taken:** Renamed test to "emits scroll-cap classes on kanban columns so internal scroll can engage" and added a one-line comment clarifying the body is a class-string regression, with actual behavior covered by the browser smoke test.

## Positive

- `/deals` mounts `DealListPage`; sub-routes intact.
- Scroll cap CSS structurally sound: `max-h` clamps, `overflow-hidden` clips, inner `min-h-0 flex-1 overflow-y-auto` scrolls.
- Sidebar active state can't double-highlight — `/deals` and `/pipeline` don't share a prefix.

## Decision

Round-2 fix applied. No round-3 needed. Ship.
