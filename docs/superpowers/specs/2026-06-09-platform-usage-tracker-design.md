# Platform Usage Tracker — Design Spec

**Date:** 2026-06-09
**Status:** Approved design (pre-implementation)
**Owner:** Adnaan
**Next step:** writing-plans → implementation plan

## 1. Goal

A new **Platform Usage** page under Reports that breaks down, per sales rep, on a
**daily and weekly** basis:

- **Time spent** — active time in the CRM (not just logged-in time).
- **How much they did** — actions taken: creating, editing, stage moves, uploads, notes, etc.
- **How much they used it** — sessions, days active, and views (navigating/looking at records).

Scope is **all CRM usage** — changing stuff, entering stuff, viewing stuff — not only logged
sales activities.

### Access model

- **Directors / admins:** see all reps.
- **Reps:** see only their own daily/weekly activity.

Scoping is **server-enforced**, never UI-only.

### "Time spent" definition (approved)

Count time while the CRM tab is open, the user is authenticated, the browser tab is **visible**,
and there has been **recent interaction**. Stop counting after **5 minutes** with no
mouse/keyboard/navigation activity (idle). Resume on next interaction.

## 2. Approach (chosen: Hybrid — "A")

Reuse the existing server-side `auditLog` for **write/action counts** (it already records
`deal.create`, `deal.update`, `deal.stage_transition`, `lead.create`, `lead.convert`, etc. with
actor, action, entity, IP, user-agent). Add **one lightweight client→server telemetry channel**
for the two things `auditLog` does not capture: **active time** (heartbeats) and **views**
(reads/navigation). A single shared aggregation function folds all sources into per-rep daily
rollups.

Rejected alternatives:

- **Pure client telemetry** — duplicates the reliable server audit trail and makes action counts
  spoofable/lossy.
- **Server-only, no heartbeat** — cannot honor the approved active-time definition (overcounts
  idle tabs left open all day).

## 3. Data model (migration `0157`)

Four tables, **tenant-scoped per-office schema** (via `search_path`, like all CRM tables).

### `usage_session`
One row per browser session.

| column | notes |
|---|---|
| `id` | pk |
| `user_id` | the rep (the **real** actor; see impersonation) |
| `started_at` | server-stamped |
| `last_heartbeat_at` | server-stamped, updated each heartbeat |
| `ended_at` | nullable; best-effort via `sendBeacon`, else inferred stale |
| `active_seconds` | accrued for this session (denormalized convenience; truth is the merge) |
| `user_agent` | device label |
| `impersonator_id` | **nullable; stamped at session-start if the session is impersonated** (see §8) |

**`session_count` semantics — "sessions started" (not "real sessions").** A session row exists
the moment `session/start` is called, regardless of whether any heartbeat follows. So a tab opened
and immediately abandoned (laptop slammed shut) still counts as 1 session. This is intentional and
keeps `session_count` cheap and unambiguous; we do **not** apply a min-heartbeat/min-duration floor
in v1. Note that such an abandoned session contributes **0** to `active_seconds` because the
interval-merge only accrues time from actual heartbeats capped at `HEARTBEAT_INTERVAL_S +
HEARTBEAT_GRACE_S`, so abandoned sessions inflate `session_count` only — never time.

**`ended_at` (stale-session inference) — scoped out of v1.** `ended_at` is set best-effort when the
client fires `sendBeacon` on `pagehide`. We do **not** define a server-side stale-session sweep in
v1: `ended_at` may remain null indefinitely for abandoned sessions, and nothing downstream depends
on it (time comes from heartbeats, not from `ended_at − started_at`; `session_count` counts started
sessions). A future enhancement could backfill `ended_at = last_heartbeat_at` during rollup, but it
is not required and is explicitly out of scope here.

### `usage_heartbeat` — append-only, **14-day retention**
| column | notes |
|---|---|
| `id` | pk |
| `session_id` | fk → usage_session |
| `user_id` | denormalized for query |
| `at` | **server-stamped** receipt time |

Each row = one confirmed active window. Enables time-of-day drilldown. Pruned after 14 days
**only once the day is folded into `usage_daily`** (see §5).

### `usage_view_event` — append-only, **14-day retention**
| column | notes |
|---|---|
| `id` | pk |
| `user_id` | denormalized |
| `session_id` | fk |
| `at` | **server-stamped** |
| `entity_type` | `deal` \| `lead` \| `report` \| `page` |
| `entity_id` | nullable (null for generic pages) |
| `route` | the client route/path |
| `label_snapshot` | human label at time of view (e.g. deal name) |

The "viewing stuff" drilldown source. Pruned after 14 days, gated on rollup (see §5).

### `usage_daily` — the **forever** rollup
One row per `(user_id, date)`.

| column | notes |
|---|---|
| `user_id`, `date` | composite key |
| `active_seconds` | from interval-merged heartbeat windows |
| `session_count` | |
| `view_count` | |
| `action_count` | |
| `breakdown` | JSONB. Views: `deal_views, lead_views, report_views, page_views`. Actions (multi-source, see §5): `creates, edits` (auditLog), `stage_moves` (deal_stage_history), `uploads` (files/photo_tags), `activities` (an object sub-keyed by `activities.type`: note/call/meeting/email/site_visit/follow_up/…) |
| `first_active_at`, `last_active_at` | |
| `rolled_up_at` | **stamp proving the day was folded; gates retention prune** |

## 4. Collection (client → server)

A single `usePlatformUsageTracker` hook mounted **once** in the authenticated app shell.

- **Session start:** on load → `POST /api/usage/session/start` → returns `sessionId`. If the
  current request is impersonated, the server stamps `impersonator_id` on the new
  `usage_session` row (see §8).
- **Heartbeat (time):** every `HEARTBEAT_INTERVAL_S` (30s), send `POST /api/usage/heartbeat`
  **only if** `document.visibilityState === "visible"` **and** last interaction
  < 5 min ago. Interaction = throttled `mousemove/keydown/click/scroll` + route change.
  Idle ≥ 5 min or tab hidden → stop sending (time stops accruing); resume on next interaction.
- **Views:** route changes and record-detail opens are batched and flushed
  (`POST /api/usage/events`) every ~10s and on navigation; `navigator.sendBeacon` flushes the
  buffer on `pagehide`.
- **Server stamps all times.** Client timestamps are ignored for accrual; the client only
  signals active/visible. This neutralizes clock skew.

## 5. The shared aggregation function (the spine)

`computeUsageDaily(input) → UsageDailyShape` — **pure, no I/O**, in
`server/src/modules/usage/aggregate.ts`. Operates on already-fetched raw rows for **one
`(user_id, date)`**.

```
input:  { sessions[], heartbeats[], viewEvents[], auditRows[] }
output: { active_seconds, session_count, view_count, action_count,
          breakdown{...}, first_active_at, last_active_at }
```

### Pinned constants (deterministic, unit-testable)
- `HEARTBEAT_INTERVAL_S = 30`
- `HEARTBEAT_GRACE_S = 5`

### Interval-merge lives **inside** this function
Per session, build active windows from consecutive heartbeats: each heartbeat contributes
`min(at − prev_at, HEARTBEAT_INTERVAL_S + HEARTBEAT_GRACE_S)` seconds (so idle gaps are capped
out and never counted). Then **merge overlapping windows across all of the user's sessions for
the day** and sum merged length → `active_seconds`. Because the merge is inside the shared
function, multi-tab dedup applies identically to the live "today" path and the nightly rollup.

### Action counts via a multi-source registry (single source of truth)

**Correction (verified against the real schema):** `auditLog.action` is a *generic* enum
(`insert | update | delete | soft_delete | legacy_cleanup_scope_change`) keyed by `table_name` +
`changed_by` + `created_at` + `impersonator_id` — there are **no** dotted action strings like
`deal.stage_transition`. `auditLog` reliably yields **creates** (`insert`) and **edits**
(`update`), but the other breakdown buckets live in **purpose-built tables, not `auditLog`**.
The action count is therefore **multi-source**:

| Breakdown key | Source table | Selector | Has `impersonator_id`? |
|---|---|---|---|
| `creates` | `auditLog` | `action = 'insert'` | ✅ |
| `edits` | `auditLog` | `action = 'update'` | ✅ |
| `stage_moves` | `deal_stage_history` | rows by `changed_by`, `created_at` | ❌ |
| `activities` (sub-keyed by `type`: note/call/meeting/email/site_visit/follow_up/…) | `activities` | rows by author, `occurred_at`/`created_at` | ❌ |
| `uploads` | `files` (+ `photo_tags`) | rows by `uploaded_by` / `created_by_user_id`, `created_at` | ❌ |

A single `USAGE_ACTION_SOURCES` registry (the one source of truth) declares, per breakdown key,
**which table + which selector** feeds it. `computeUsageDaily` counts only what the registry
declares; nothing is inferred. A **per-source contract test** asserts each registry entry's
table/column actually exists in the schema and that the enum/selector values are real (registry
drift fails the build).

`action_count` = sum of all breakdown keys. The `activities` source intentionally reuses the same
table the existing Rep Activity report reads, so the two reports reconcile.

### Both callers are thin
- **Live "today":** the `GET` handler fetches today's raw rows for the requested rep(s),
  calls `computeUsageDaily`, returns. Never touches `usage_daily`.
- **Nightly cron:** fetches a **completed** day's raw rows, calls `computeUsageDaily`, **upserts**
  into `usage_daily` and stamps `rolled_up_at`.

### Invariant (corrected — "today" is a moving target)
The invariant is **NOT** "live(today) == rollup(today)". `active_seconds` and `last_active_at`
grow intraday, so a live snapshot of an open day will never equal a rollup computed after the day
closes. The real invariant is:

> **Given the same raw rows for a completed day, the live path and the rollup path produce
> byte-identical `UsageDailyShape`.**

The byte-identical test feeds a **closed-day (frozen) fixture** to both code paths and asserts
equality. It must **not** compare a live "today" snapshot against a later rollup. The spec
self-review explicitly confirms the test uses a closed-day fixture.

## 6. Rollup & retention

- **Live "today":** the API computes the current day on-read directly from the raw tables via the
  shared function — accurate intraday, no job lag.
- **Nightly rollup** (new Railway cron service running a script, like `hubspot-refresh-nightly`;
  jobs are Railway cron services, not in-app node-cron): for each completed day not yet rolled
  up, fetch raw rows → `computeUsageDaily` → upsert `usage_daily` + stamp `rolled_up_at`.
- **Per-office fan-out (required).** Usage tables are per-office-schema, so the rollup script
  **must iterate every office schema** — `office_dallas`, `office_atlanta`, `office_pwauditoffice`,
  and any future office — the same way the existing nightly HubSpot job enumerates tenant schemas
  (discover via `information_schema.schemata` / the shared tenant-schema list, set `search_path`
  per office, roll up, prune). A rollup that only hits the default schema would silently never roll
  up Atlanta (and the gated prune would correctly never delete Atlanta's raw rows, so they'd grow
  unbounded). The prune (below) runs **inside the same per-office loop**, after that office's
  rollup succeeds.
- **Backfill:** action counts for **past** dates can be backfilled from existing `auditLog`;
  time/views cannot (no historical raw rows). Pre-launch days show "—" for time/views.

### Retention prune (gated on rollup success)
Prune runs **after** the rollup and deletes raw `usage_heartbeat` / `usage_view_event` rows for a
date `D` **only if** `usage_daily` has a `rolled_up_at` row for `(user_id, D)` **and**
`D < today − 14 days`. Never by wall-clock age alone. A failed or skipped rollup leaves raw rows
intact for the next run to fold — a missed rollup can never delete un-rolled data.

## 7. API

- `GET /api/reports/platform-usage` — params `grain=day|week`, `date` (anchor), optional `rep`.
  - **Server-enforced scoping:** role `rep` is forced to `rep = self`; `admin`/`director` may
    request all reps or one specific rep.
  - Returns: team summary, per-rep leaderboard rows, and (when `rep` set) that rep's per-day
    breakdown.
  - Historical days read from `usage_daily`; the current day computed live via the shared
    function; **a week = mix of rolled-up days + live current day, summed.**
- `GET /api/reports/platform-usage/drilldown` — params `rep, date, type` → raw
  `usage_view_event` rows.
  - **Same server-enforced scoping as the summary**: role `rep` is forced to `rep = self`; a rep
    cannot read another rep's view history by editing the `rep` param.
  - Only within the 14-day window; older returns "counts only — drilldown expired".
- Collection endpoints (§4): `POST /api/usage/session/start`, `/heartbeat`, `/events`.

## 8. Impersonation handling

`auditLog` already carries `impersonatorId`. For **time and views**, the exclusion only works if
the merge can identify impersonated windows — and heartbeats are written by the client hook, which
does not know it is impersonated. Therefore:

- **`usage_session.impersonator_id` is stamped at session-start** from the server's request
  context whenever the session is impersonated.
- The interval-merge / aggregation **excludes sessions where `impersonator_id IS NOT NULL`** from
  the impersonated rep's time and view metrics (the activity is attributed to no one for usage
  purposes), so a director "viewing as rep" never inflates that rep's numbers.
- Action counts inherit `auditLog`'s existing `impersonatorId` handling.

Without the session-level stamp, the exclusion would silently fail for exactly the two metrics
(time, views) this feature is about — hence it is a hard requirement.

### Documented caveat — impersonation on the three non-audit write sources
Impersonation exclusion is **complete** for the three primary metrics: **time** and **views**
(via `usage_session.impersonator_id`) and the **audited `creates`/`edits`** (via
`auditLog.impersonator_id`). It is **incomplete** for `stage_moves`, `activities`, and `uploads`:
`deal_stage_history`, `activities`, and `files` carry **no impersonator column**, so a write made
while impersonating attributes to the impersonated rep in those three buckets. This is an accepted
v1 limitation — impersonation is admin-rare and the inflation is bounded to those three write
buckets (never time, never views, never audited creates/edits). v1 does **not** add impersonator
columns to those tables. The Platform Usage page footnotes this limitation.

## 9. UI — `/reports/performance/platform-usage`

- Route gated `RequireRole [admin, director, rep]`; **server** scopes reps to self. Nav entries on
  the Reports index + `/reports/performance`.
- **Headline:** team summary strip (active time · actions · N/M reps active today) → ranked
  leaderboard (sortable: active time, actions, days). **Daily / Weekly toggle** + date nav,
  reusing the existing FilterBar period plumbing.
- **"Active today" is defined as ≥1 heartbeat** (i.e. `active_seconds > 0`), and this single
  definition drives the "N/M reps active" count consistently. **Views carry no active-time
  requirement** — they flush every ~10s and on `pagehide`, independent of the 5-min idle gate — so
  it is possible (and intended) for a rep to have `view_count > 0` while `active_seconds = 0`
  (e.g. a quick glance under the heartbeat cadence). Such a rep is **not** counted in "N/M reps
  active" (no heartbeat) but still appears in the leaderboard with their view count. This is
  deliberate: the active-rep count measures sustained presence; `view_count` measures looking.
- **Leaderboard time sort:** pre-launch "—" (no time data) is treated as **absent, sorted last** —
  never as zero — so backfilled-only reps don't outrank reps with real active time. A rep with
  views but zero heartbeats this period also sorts under "—" on the time axis (absent time), while
  still ranking normally on the actions/views axes.
- **Rep detail** (click a row): per-day timeline, action/view breakdown, and the recent-views
  drilldown list (last 14 days).

## 10. Testing

- `computeUsageDaily` unit tests: idle-gap capping (uses `HEARTBEAT_INTERVAL_S`/`_GRACE_S`),
  multi-tab interval merge across sessions, registry mapping, empty day.
- **Registry contract test (per-source):** every `USAGE_ACTION_SOURCES` entry names a table +
  selector that exists in the schema, and enum/selector values are real (`auditLog` insert/update,
  `deal_stage_history`, `activities.type` values, `files`/`photo_tags`); drift fails the build.
- **Byte-identical test:** feed a **closed-day fixture** to both the live path and the rollup
  path; assert identical `UsageDailyShape`. (Self-review confirms closed-day, not live snapshot.)
- **Prune-gated-on-rollup test:** raw rows for an un-rolled day are not deleted; rows for a
  rolled-up day older than 14d are.
- **Per-office fan-out test:** the rollup script enumerates and rolls up every office schema
  (Dallas, Atlanta, audit office), not just the default — a second non-default schema with raw
  rows produces a `usage_daily` row.
- **Scoping tests (both endpoints):** rep role forced to self on `GET /platform-usage` **and**
  `GET /platform-usage/drilldown` (no-DB capture-WHERE pattern).
- **Impersonation exclusion test:** impersonated session's time/views excluded from the rep.
- **Client hook tests:** idle/visibility gating, batching, `sendBeacon` flush (vitest fake timers).

## 11. Out of scope (YAGNI)

- IP-address storage on usage rows (auditLog already keeps it where needed; not required here).
- Real-time/live-updating dashboard (page is request/refresh, not streaming).
- Per-record view tracking beyond the 14-day drilldown window (older = counts only, by design).
- Alerting/flagging low-usage reps (informational page only for v1).
