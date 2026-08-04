# Close-date accuracy — design proposal

**Status: proposal, awaiting approval. Nothing here is implemented.**

The ask, verbatim: *"We've been tracking close dates, but it seems like we're not tracking close date
accuracy. We want to brainstorm and come up with a way to document who's accurately predicting their close
dates, who seems to be off, and whose close dates seem to continue to move."*

This document reports what the data can actually answer today, proposes precise definitions and metrics,
and recommends a deliberately small v1. Every column, table and file cited below was read in this
repository at commit `a4a56e073`. Where something could not be verified — in particular anything that
requires querying the production database — it is labelled **unverified**.

---

## 1. What the data actually supports

### 1.1 The forecast field is genuinely rep-owned

`deals.expected_close_date` is a `DATE`, nullable, present since `migrations/0001_initial.sql:451`. It has
exactly five writers in the entire monorepo:

| Writer | File |
|---|---|
| Deal create | `server/src/modules/deals/service.ts:2616` |
| Deal update (the normal edit path, and the Move Close Date dialog) | `server/src/modules/deals/service.ts:2912` |
| Inline stage-advance prompt | `server/src/modules/deals/stage-change.ts:308` |
| Lead → deal conversion | `server/src/modules/leads/conversion-service.ts:351` |
| Dev demo seed | `server/src/modules/auth/service.ts:552` |
| Bulk export / re-import campaign (raw SQL) | `scripts/lib/close-date-workflow.ts:485` |

No sync path writes it. Bid Board sync (`server/src/modules/bid-board-sync/service.ts`), SyncHub
(`server/src/modules/procore/synchub-routes.ts`) and the worker's Procore reverse sync
(`worker/src/jobs/procore-sync.ts`) all write `actual_close_date`, `won_closed_date`, `lost_at` and
`stage_entered_at`, but **none of them touches `expected_close_date`**. That matters: unlike
`awarded_amount` on a Bid-Board-owned deal, a close date is never overwritten by a machine. Every value in
the column was typed by a person or came from the spreadsheet campaign.

The stage-advance writer is additionally guarded (`stage-change.ts:290-314`): it persists the date only
when the target stage's gate checklist actually lists `expectedCloseDate` as a required field *and* the
supplied value is today-or-future. An unrelated stage move can never overwrite or clear the forecast.

### 1.2 Every change is captured, with actor and timestamp — by a database trigger

This is the backbone, and it is stronger than expected.

`migrations/0001_initial.sql:757-759` creates, inside the `-- TENANT_SCHEMA_START` / `-- TENANT_SCHEMA_END`
block (so the office provisioner at `server/src/modules/office/service.ts:120` replays it for every new
tenant schema):

```sql
CREATE TRIGGER audit_deals
  AFTER INSERT OR UPDATE OR DELETE ON deals
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_func();
```

`audit_trigger_func()` (defined at `0001_initial.sql:303`, replaced without behavioural change by
`0029_schema_qualified_audit_trigger.sql`, `0033_qualify_tenant_audit_trigger.sql`,
`0034_fix_audit_action_enum_cast.sql`, `0035_fix_public_audit_enum_cast.sql`) loops every column of the
row, compares `OLD` and `NEW` as `::TEXT`, and on any difference inserts one `audit_log` row:

```sql
INSERT INTO <schema>.audit_log (table_name, record_id, action, changed_by, changes, created_at)
VALUES ('deals', NEW.id, 'update',
        NULLIF(current_setting('app.current_user_id', true), '')::UUID,
        changed_fields, NOW())
```

with `changed_fields` built as `jsonb_build_object(col_name, jsonb_build_object('old', old_val, 'new', new_val))`.

**Concretely, a close-date move lands as:**

```json
{"expected_close_date": {"old": "2026-01-15", "new": "2026-03-01"},
 "updated_at":          {"old": "2026-01-02 ...", "new": "2026-01-09 ..."}}
```

- Key is the **snake_case column name**, values are `old`/`new` as text; a `DATE` renders `YYYY-MM-DD`, a
  NULL renders as JSON null (so `->>'old'` yields SQL NULL).
- `created_at` is the timestamp of the move.
- `changed_by` is the actor, from `app.current_user_id`.
- The trigger fires on **every** write path, including raw SQL from scripts and the worker. This is why it
  is the right backbone and the app-level logger is not.

The deal INSERT is captured too, with the full row: `action = 'insert'`, `full_row` = `to_jsonb(NEW)`, so
the date a deal was born with is `full_row->>'expected_close_date'`. Migration
`0028_deal_forecast_milestones.sql` already reads exactly that expression, so the shape is proven in
production SQL, not assumed.

### 1.3 There is a *second*, different audit row for the same change — do not double-count

The application also writes its own audit row through `logActivity`
(`server/src/modules/audit/audit-logger.ts:102-130`, invoked from
`server/src/modules/deals/service.ts:3131` and `server/src/modules/deals/stage-change.ts:434`).
`"expectedCloseDate"` is in the tracked-field list at `service.ts:3119`. That row has a **different JSON
shape**:

- `changes` uses the **camelCase** property name and `from`/`to` keys: `{"expectedCloseDate": {"from": "2026-01-15", "to": "2026-03-01"}}`
- `field_changes_jsonb` is an **array** of formatted objects — `{key, label, fromDisplay, toDisplay, fromFull, toFull, transition, masked}` — produced by `server/src/modules/audit/field-formatters.ts:224`. `expectedCloseDate` is registered as a `date` field with the label `"Expected Close Date"` (`field-formatters.ts:85`), so `toDisplay` is a human string like `"March 1, 2026"`, not a parseable date.

So a single close-date edit through the API produces **two** `audit_log` rows. The discriminator is clean
and worth stating in code: `changes ? 'expected_close_date'` selects **only** the trigger rows;
`changes ? 'expectedCloseDate'` selects only the application rows. The spec uses the trigger rows for the
timeline and the application rows only for actor display (they carry `actor_name`, `actor_role`,
`actor_system_process`, which the trigger rows do not).

Application-level rich audit rows only exist from `migrations/0117_audit_log_phase1_rich_entries.sql`
(commit `b5251bf2b`, 2026-05-14) onward. Trigger rows go back to the creation of the office schema.

### 1.4 Audit coverage: how far back, honestly

- The `audit_deals` trigger ships in migration `0001`, first committed **2026-04-01** (`3c3a233c3`). Every
  deal `UPDATE` since the office schema was created should therefore have a trigger row.
- **Nothing prunes `audit_log`.** An exhaustive search of `server/`, `worker/` and `scripts/` finds no
  `DELETE FROM ... audit_log` outside test and smoke fixtures
  (`scripts/smoke-file-attachments-expansion.ts:220,234`). Retention machinery exists for
  `usage_heartbeat` / `usage_view_event` (`server/src/modules/usage/constants.ts:6`, 14 days) and for
  daily-summary emails, but not for audit. `server/src/modules/usage/read-service.ts:199` says it outright:
  *"actions are never pruned"*.
- Indexes support the query: `audit_record_idx (table_name, record_id, created_at)` from
  `0001_initial.sql:743` and `0032_ensure_tenant_audit_log.sql:24`.

**Unverified, and it must be checked before anyone publishes an all-time number:** the earliest actual
`audit_log.created_at` for `table_name = 'deals'` in the production `office_dallas` schema. I could not
query production. Until someone runs `SELECT min(created_at) FROM office_dallas.audit_log WHERE table_name='deals'`,
this report must be **period-scoped** and must not claim to cover all history. A metric that silently only
covers recent history is exactly the trap this section exists to prevent.

### 1.5 `deal_forecast_milestones` — built for this, and dead

`migrations/0028_deal_forecast_milestones.sql:156-181` creates a table that stores, per deal, a snapshot at
each of four milestones (`initial`, `qualified`, `estimating`, `closed_won`) including
`expected_close_date`, `assigned_rep_id`, `stage_id`, `workflow_route`, the value estimates,
`captured_at`, `captured_by`, and `capture_source` (`live` | `audit_backfill`). UNIQUE on
`(deal_id, milestone_key)`.

It answers "what did the forecast look like at each stage gate" — which is close to what we want.

**It has had no runtime writer since 2026-04-23.** The capture functions
(`captureInitialForecastMilestone`, `captureStageDrivenForecastMilestone`, `insertForecastMilestone` in
`server/src/modules/reports/forecast-milestones-service.ts`) are called **only from
`server/tests/modules/reports/forecast-variance.test.ts`**. Commit `f9450ad71` removed the two production
call sites (from `deals/service.ts` and `deals/stage-change.ts`) and they were never reinstated. Today the
table contains only what migrations `0028` and `0036` backfilled.

The consequence is live in the product. `GET /api/reports/forecast-variance`
(`server/src/modules/reports/routes.ts:536`, director-only, rendered by
`client/src/components/reports/forecast-variance-section.tsx`) publishes a per-rep column
`avg_close_drift_days`, computed at `server/src/modules/reports/service.ts:471` as:

```sql
COALESCE(AVG(ABS(actual_close_date - expected_close_date))
  FILTER (WHERE actual_close_date IS NOT NULL AND expected_close_date IS NOT NULL), 0)
```

…where `actual_close_date` is `cw.captured_at::date` from the `closed_won` milestone. Three problems:
it is **unsigned** (`ABS`), so a rep who is systematically 40 days optimistic and one who is 40 days
pessimistic score identically; it is **Won-only**; and its driving JOIN
(`JOIN deal_forecast_milestones cw ON cw.milestone_key = 'closed_won'`, `service.ts:451`) can never match
a deal that reached Won after 2026-04-23, so the number is a **frozen April snapshot** that quietly ages.

Shipping a second close-date-accuracy number next to this one without addressing it creates exactly the
kind of half-applied reconciliation this codebase has been burned by. See §7.

### 1.6 `deal_stage_history` and `deal_history` — neither records the forecast

`deal_stage_history` (created `0001_initial.sql:464`; `changed_by` made nullable by
`0207_stage_history_actor_no_rep_fallback.sql`) has exactly these columns:

```
id, deal_id, from_stage_id, to_stage_id, changed_by, is_backward_move,
is_director_override, override_reason, duration_in_previous_stage, created_at
```

There is **no `expected_close_date` column and no migration ever added one**. It gives us stage-entry and
stage-exit timestamps and backward-move detection — useful as a secondary axis — but the forecast date at
the moment of a stage move is recoverable only by replaying `audit_log`.

Note for actor use: `0207` deliberately removed the `assigned_rep_id` fallback for `changed_by`, so machine
stage moves now record `changed_by = NULL` rather than misattributing to the rep. Rows written **before**
0207 were deliberately not backfilled and keep the old misattribution. Do not treat
`deal_stage_history.changed_by` as reliable across the whole history.

`deal_history` (created per-tenant at `0067_project_type_and_intended_number.sql:78-96`, extended with
`source` and `reason` by `0115_bid_board_estimate_writeback_reporting.sql:39-53`) has:

```
id, deal_id, field_name, old_value, new_value, changed_by, changed_at, source, reason
```

It is live, but only for four fields: `description`, `project_type`, `rfp_approval_status`, `bid_estimate`.
It has **never** recorded `expected_close_date`. It is however the natural home for a first-class
close-date reason — it already has `source` and `reason` columns and an index
`deal_history_source_changed_at_idx`. See §5.1.

(Naming trap: `server/src/modules/deals/service.ts:3145` writes an `audit_log` row whose `table_name` string
is `"deal_history"` for rep reassignment. That is an audit row, not a `deal_history` insert.)

### 1.7 Move Close Date — a real reason exists, in a fragile place

`client/src/components/deals/move-close-date-dialog.tsx` is mounted from
`client/src/components/activities/entity-activity-tab.tsx:203` and
`client/src/pages/reports/monday-showcase/evidence-drawer.tsx:418`. What it does, exactly:

1. Requires a non-empty reason and a date `>=` business today (`America/Chicago`), enforced in `canSave`
   at line 80 and `min={businessToday}` at line 203.
2. `await updateDeal(dealId, { expectedCloseDate: date }, { officeId })` — the load-bearing write; a
   failure aborts and shows an error (lines 99-104).
3. **Best-effort** `createActivity({ type: "note", subject: "Close target moved to <Mon D, YYYY>",
   body: "Close target moved to <Mon D, YYYY>.\n\n<reason>", dealId })` — lines 109-119, wrapped in
   `catch {}`. A failure here is swallowed; the date is already saved.
4. The remove path (lines 133-177) writes `expectedCloseDate: null` plus a note with subject
   `"Close target removed"`.

So the user-supplied reason lands in `activities.body` (`shared/src/schema/tenant/activities.ts`:
`subject varchar(500)`, `body text`, `deal_id`, `occurred_at`, `created_at`, `responsible_user_id`,
`performed_by_user_id`). It is **free text with no reason code**, it is **best-effort** (a swallowed
failure is indistinguishable from a rep who never explained), and — most importantly — **any close-date
edit made through the normal deal edit form produces no note at all**. The dialog is one of several ways to
change the date, not the only one.

That is still valuable evidence and v1 should surface it: match a `note` activity on the same deal whose
`subject` starts with `Close target moved to` and whose `occurred_at` is within a short window of the audit
event. It is **not** a reliable denominator and must never be used as one.

### 1.8 Canonical outcome dates

- **Won.** The canonical helper is `aliasedWonHsClosedWonDateSql(alias)` at
  `server/src/modules/shared/deal-value-sql.ts:530`. It emits a bare `<alias>.won_closed_date` — there is
  deliberately **no COALESCE at read time**. The fallback chain lives at *write* time in
  `server/src/modules/shared/won-close-date.ts`: `resolveWonClosedDateWriteThrough` (contract-signed date
  wins when present, else the stage-driven date) and `effectiveContractSignedDate`
  (`COALESCE(contract_signed_at::date, contract_signed_date)`), applied by
  `server/src/modules/deals/stage-change.ts:387` and `server/src/modules/deals/service.ts:4222`. The
  module docstring records why: a prior read-time COALESCE silently moved one surface off the reconciled
  basis. **This spec reads `won_closed_date` through the helper and adds no COALESCE of its own.**
  Companion guard: `aliasedHasUsableWonDateSql(alias)` (`server/src/modules/deals/service.ts:1373`) —
  `won_closed_date IS NOT NULL`. A Won deal with a NULL won date is excluded, matching every other Won read.
- **Lost.** `deals.lost_at` (timestamptz), stamped at `server/src/modules/deals/stage-change.ts:410`.
  `server/src/modules/shared/deal-date-scope.ts:54` uses `deals.lost_at::date` as the canonical `lostDate`.
  Use that expression.
- **Never `actual_close_date`.** Migration `0141_won_closed_date_reporting_column.sql` records that it is
  reseed-contaminated (mass-stamped by a Bid Board reseed) and must never be used for period gating. The
  existing forecast-variance report's use of `cw.captured_at::date` under the alias `actual_close_date`
  (§1.5) is a different thing again and is not canonical either.
- Won and Lost stage membership: `WON_STAGE_SLUGS` / `LOST_STAGE_SLUGS` / `TERMINAL_STAGE_SLUGS` from
  `server/src/modules/shared/pipeline-terminal-stages.ts`, which re-export the shared workflow contracts
  (`shared/src/types/workflow.ts:309-315`) and include the genuine alias slugs. Use these, not hand-written
  slug lists.

### 1.9 Period slicing

`server/src/lib/period.ts` is the single canonical server-side period source (its own header says so). Its
API, verified:

```ts
export const BUSINESS_TIMEZONE = "America/Chicago";
export type WeekMode = "to_date" | "completed" | "mtd" | "ytd";
export function sundayWeekStart(isoDate: string): string;
export function getWtdPeriod(mode: WeekMode, now?: Date): { from: string; to: string };  // both inclusive, YYYY-MM-DD
export function sundayWeekBucketSql(tsExpr: string): SQL;
export function businessToday(now?: Date): string;
export function shiftBusinessDate(isoDate: string, days: number): string;
export function businessWeekDates(anchorIso: string): string[];  // 7 dates, Sun..Sat
```

All period slicing in this report goes through it. "Today" in every day-math expression is
`(now() AT TIME ZONE 'America/Chicago')::date`, the same literal used by
`server/src/modules/reports/at-risk-service.ts:16` and `scripts/lib/close-date-workflow.ts:76`.

---

## 2. Definitions

### 2.1 The prediction

The prediction is the value of `deals.expected_close_date`, reconstructed **as of a point in time** from
the `audit_log` trigger timeline (§1.2). Two anchors, both computed:

- **P₃₀ — the standing prediction.** The value the field held 30 calendar days before the outcome date. If
  the deal's entire recorded life was shorter than 30 days, P₃₀ is the *first* value ever recorded for the
  deal. **This is the headline.**
- **P_final — the final call.** The value the field held at the outcome instant. Reported as a secondary
  column.

Why the headline is P₃₀ and not P_final: a close date is a planning instrument. Its value is that it was
right *far enough ahead for someone to act on it*. A rep who re-dates a deal to "this Friday" on Thursday
scores a perfect P_final and has forecast nothing. Reporting both makes the pattern legible: strong
P_final with weak P₃₀ means "reactive but honest"; the reverse is rare and worth a look.

30 days is a proposal, not a derived number. It is one month of forward visibility and it is the horizon at
which the MTD/YTD vocabulary in `period.ts` starts to matter. It should be re-tuned once the first real
distribution is visible.

### 2.2 The outcome

| Deal state | Outcome date | Expression |
|---|---|---|
| Won | canonical Won-close date | `aliasedWonHsClosedWonDateSql('d')`, guarded by `aliasedHasUsableWonDateSql('d')` |
| Lost | loss stamp | `d.lost_at::date` (as in `deal-date-scope.ts:54`) |
| Open, date in the past | **no outcome yet** — right-censored | see §2.4 |
| Open, date today or future | **not yet judgeable** | excluded from error metrics, counted in coverage |
| Open, no date at all | **no prediction** | counted as a coverage failure, never as a hit or a miss |

`signed_error_days = outcome_date - prediction_date`, in whole days.

**Positive = closed later than predicted (optimistic). Negative = closed earlier (pessimistic).** Signed,
never absolute — a team whose errors are +40 and −40 has a very different problem from a team whose errors
are +40 and +40, and `ABS` erases the distinction. That erasure is the concrete defect in the existing
`avg_close_drift_days` (§1.5).

### 2.3 What counts as accurate

**Proposed tolerance: ±14 days.** A landed deal is a *hit* when `|signed_error_days| <= 14`.

Justification, such as it is:

- 14 days is two of the platform's Sunday-anchored reporting weeks (`period.ts` week grain), so a hit means
  the deal landed in the reporting fortnight it was pointed at.
- It sits an order of magnitude below `CLOSE_TARGET_HOLD_HORIZON_DAYS = 90`
  (`shared/src/types/deal-hold-risk.ts:137`), which is the platform's existing "this isn't real yet"
  threshold. A tolerance anywhere near 90 would make the metric vacuous.
- In commercial construction a two-week slip rarely moves a quarter; a four-week slip often does.

Report a **±30-day band alongside** ("landed in the right month") so leadership can choose which one they
want to manage to without a schema change. Both come from the same query at no extra cost.

Be honest in the UI: 14 is an assumption. The first thing to do after v1 lands is look at the actual error
distribution and re-tune. Do not present it as derived.

### 2.4 Deals that never closed — the most important bucket

Open deals with a long-past close date are the strongest signal in the whole dataset and the easiest thing
to accidentally drop. They are not dropped here. Every deal in scope lands in exactly one bucket:

1. **Landed** — Won or Lost with a usable outcome date. Contributes to hit rate and to mean/median signed
   error.
2. **Overdue-open** — `is_active = true`, stage not terminal, `expected_close_date < business today`. The
   error is **right-censored**: we know it is *at least* `today − prediction` days and it will only grow.
   These get their own columns (`overdue_open_n`, `median_days_overdue`) and are **never** folded into the
   landed mean, because doing so would let a rep improve their average by leaving deals open. They are also
   never counted as hits.
3. **Undated-open** — `is_active = true`, stage not terminal, `expected_close_date IS NULL`. Not an error;
   a **coverage** failure. Counted in the coverage denominator and reported as its own number.
4. **Not yet judgeable** — open with a today-or-future date. Counted in coverage (favourably), excluded
   from error metrics.

Buckets 2 and 3 are exactly the `stale_dated` and `no_date` reasons already produced by
`server/src/modules/reports/at-risk-service.ts:63`. Reusing that scope means the coverage number on this
report reconciles to the existing At-Risk watchlist rather than becoming a second, differing count of the
same thing.

### 2.5 Scope and exclusions

Base population, per tenant schema:

- `d.is_active = true`
- `COALESCE(d.is_test_data, false) = false`
- Owner = `d.assigned_rep_id` (§3)
- Period-scoped on the **outcome date** for landed deals; on business-today for overdue/undated ones

Explicit decisions on the two populations the brief asked about:

**HubSpot-imported deals — exclude by construction, no special flag needed.**
`scripts/hubspot-deals-reimport.ts:797-833` inserts deals with a column list that does **not include
`expected_close_date`**; it sets `source = 'hubspot_deals_reimport_2026_05_14'` and
`hubspot_deal_id`. Imported deals therefore begin with **no prediction at all**, and their pre-CRM history
was never imported. They only enter the metric if a human later typed a date into the CRM — at which point
that date *is* a genuine CRM prediction and should count. The rule that makes this correct without a
special case is: **a deal contributes only if it has at least one recorded prediction whose timestamp
precedes its outcome date.** A HubSpot deal that was already Won before the CRM existed has no such
prediction and contributes nothing. State this rule in the code; do not rely on `source` string matching.

**Bid-Board-owned deals — include, but flag.** `d.is_bid_board_owned` / `d.is_read_only_mirror`. The
existing close-date campaign deliberately includes them: `scripts/lib/close-date-workflow.ts:311-316`
records that BB-owned deals *"ARE included (they count toward coverage and a close-date write on them
persists)"*, and §1.1 confirms no sync path overwrites the field. So the prediction on a BB-owned deal is a
real rep prediction. The *outcome*, however, can be driven by the mirror rather than by the rep
(`bid_board_stage_slug` can go terminal while the CRM stage is still open — see
`server/src/modules/shared/deal-value-sql.ts:389-406`). Recommendation: include them, and show
`bid_board_owned_n` as a column on the rep row so a book that is mostly mirror deals is visible as such.

**Deals whose date was set by the spreadsheet campaign — flag, and see §5.4.**

---

## 3. Per-rep rollup and attribution

**A rep filter means the rep OWNS the deal.** This is the codebase convention and this report follows it.
Use `buildAliasedOwnedRepSql(alias, repId)` (`server/src/modules/deals/deal-filter-predicates.ts:143`) or
its unaliased twin `buildOwnedRepCondition` (`:112`), which emit `<alias>.assigned_rep_id = $repId`. The
docstring at `:99-110` states the reason and it applies here verbatim: `deals.estimator_user_id` is
populated far beyond the handful of real estimators, so an estimator-OR filter shows a rep dozens of deals
that are somebody else's book, **and one deal would land on two people's rows and could not reconcile with
any surface that groups BY assigned rep**. A per-rep accuracy scorecard is precisely such a surface. The
estimator link is not consulted.

The Unassigned sentinel maps to `assigned_rep_id IS NULL` and gets its own row — an unowned deal with a
rotting close date is a real finding, not a null to hide.

**Known limitation, stated on the report:** `assigned_rep_id` is the **current** owner. A deal reassigned
mid-life attributes its whole prediction history to whoever holds it now. This is not a data gap —
reassignments are recorded, both as `changes ? 'assigned_rep_id'` on the trigger rows and as the dedicated
`audit_log` row with `table_name = 'deal_history'` written at `server/src/modules/deals/service.ts:3145` —
it is a v1 simplification. Owner-at-prediction-time is deferred (§6). To keep it visible rather than
silent, v1 reports `moves_by_other_actor`: the count of the deal's close-date events whose `changed_by` is
someone other than the current owner.

---

## 4. Metrics

Each metric below is a column on the per-rep row. All of them come from one query builder.

### 4.0 The shared timeline CTE

Everything else is built on this. Note the `changes ? 'expected_close_date'` predicate: snake_case selects
**only** the database-trigger rows, which is what makes the timeline universal and what prevents
double-counting against the application's camelCase twin (§1.3).

```sql
-- Every recorded change to a deal's forecast date, from the universal audit_deals trigger.
WITH close_date_events AS (
  SELECT a.record_id                                            AS deal_id,
         a.created_at                                           AS changed_at,
         a.changed_by                                           AS actor_user_id,
         NULLIF(a.changes->'expected_close_date'->>'old','')::date AS old_date,
         NULLIF(a.changes->'expected_close_date'->>'new','')::date AS new_date
  FROM audit_log a
  WHERE a.table_name = 'deals'
    AND a.action     = 'update'
    AND a.changes ? 'expected_close_date'      -- snake_case = DB trigger rows only

  UNION ALL

  -- The date the deal was born with (0028 already reads this exact expression).
  SELECT a.record_id, a.created_at, a.changed_by,
         NULL::date,
         NULLIF(a.full_row->>'expected_close_date','')::date
  FROM audit_log a
  WHERE a.table_name = 'deals'
    AND a.action     = 'insert'
    AND a.full_row IS NOT NULL
    AND NULLIF(a.full_row->>'expected_close_date','') IS NOT NULL
),
```

Index support: `audit_record_idx (table_name, record_id, created_at)`.

```sql
outcomes AS (
  SELECT d.id                       AS deal_id,
         d.assigned_rep_id          AS rep_id,
         CASE WHEN psc.slug IN (:won_slugs)  THEN 'won'
              WHEN psc.slug IN (:lost_slugs) THEN 'lost'
              ELSE 'open' END       AS outcome_kind,
         CASE WHEN psc.slug IN (:won_slugs)  THEN <aliasedWonHsClosedWonDateSql('d')>
              WHEN psc.slug IN (:lost_slugs) THEN d.lost_at::date
              ELSE NULL END         AS outcome_date,
         d.expected_close_date      AS current_close_date,
         COALESCE(d.is_bid_board_owned, false) OR COALESCE(d.is_read_only_mirror, false) AS bid_board_owned,
         psc.is_terminal
  FROM deals d
  JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
  WHERE d.is_active = true
    AND COALESCE(d.is_test_data, false) = false
),
```

`:won_slugs` / `:lost_slugs` are parameterised from `WON_STAGE_SLUGS` / `LOST_STAGE_SLUGS`
(`server/src/modules/shared/pipeline-terminal-stages.ts`).

The prediction in force at an instant is a LATERAL:

```sql
-- prediction_at(deal, T): the last non-null value set strictly before T
LEFT JOIN LATERAL (
  SELECT e.new_date
  FROM close_date_events e
  WHERE e.deal_id = o.deal_id AND e.changed_at < <T>
  ORDER BY e.changed_at DESC
  LIMIT 1
) p_at ON TRUE
```

applied twice per deal: `T = outcome_date` (P_final) and `T = outcome_date - interval '30 days'` (P₃₀),
with the documented fallback that when no event precedes `outcome_date − 30d`, P₃₀ takes the **earliest**
event's `new_date` instead.

### 4.1 Coverage rate

**Plain English:** of the rep's currently-open, reportable deals, what share carry a today-or-future close
date. This is the "does this person forecast at all" number.

```sql
coverage_rate = count(*) FILTER (WHERE outcome_kind='open' AND NOT is_terminal
                                   AND current_close_date >= <business today>)
              / NULLIF(count(*) FILTER (WHERE outcome_kind='open' AND NOT is_terminal), 0)
```

The complement is exactly the At-Risk watchlist count (`no_date` + `stale_dated`) from
`at-risk-service.ts:53-75`, so the two surfaces reconcile. Build it on the same scope — including
`aliasedReportableDealFilterSql('d')` (`server/src/modules/shared/deal-value-sql.ts:464`, which resolves to
`COALESCE(d.on_hold, false) = false`) — or the numbers will differ and one of them will be wrong.

### 4.2 Hit rate within tolerance

**Plain English:** of the deals that actually landed in the period, what share landed within ±14 days of
the standing prediction.

```sql
hit_rate_14d = count(*) FILTER (WHERE landed AND abs(signed_error_p30) <= 14)
             / NULLIF(count(*) FILTER (WHERE landed), 0)
```

Also emit `hit_rate_30d` (same shape, `<= 30`) and `hit_rate_14d_final` (same shape against P_final).

### 4.3 Mean and median signed error

**Plain English:** on average, how many days late (positive) or early (negative) does this rep's forecast
turn out to be. Both statistics, because the mean is where the long optimistic tail shows up and the median
is the number you can defend to a rep.

```sql
mean_signed_error_days   = avg(signed_error_p30)                             FILTER (WHERE landed)
median_signed_error_days = percentile_cont(0.5) WITHIN GROUP (ORDER BY signed_error_p30) FILTER (WHERE landed)
p90_signed_error_days    = percentile_cont(0.9) WITHIN GROUP (ORDER BY signed_error_p30) FILTER (WHERE landed)
```

Never `ABS`. A rep whose median is +38 has a specific, coachable bias; `ABS` would hide the sign and make
them look identical to someone who closes early.

### 4.4 Move count

**Plain English:** how many times the close date on this rep's deals was changed.

```sql
move_count  = count(*) FILTER (WHERE e.old_date IS NOT NULL AND e.new_date IS NOT NULL
                                 AND e.new_date IS DISTINCT FROM e.old_date)
set_count   = count(*) FILTER (WHERE e.old_date IS NULL     AND e.new_date IS NOT NULL)
clear_count = count(*) FILTER (WHERE e.old_date IS NOT NULL AND e.new_date IS NULL)
```

Three counters, not one. A *set* (first time a date appears) is not a slip. A *clear* is a distinct
behaviour that deserves its own column — see §5.5. Report `moves_per_deal = move_count / landed_n` so a
rep with a big book is not penalised for volume.

### 4.5 Total days slipped

**Plain English:** adding up every time a close date got pushed, how many days of slippage did this rep's
book accumulate.

```sql
total_days_slipped = sum(e.new_date - e.old_date)
                     FILTER (WHERE e.old_date IS NOT NULL AND e.new_date IS NOT NULL)
days_pushed_out    = sum(greatest(e.new_date - e.old_date, 0)) FILTER (…)
days_pulled_in     = sum(least(e.new_date - e.old_date, 0))    FILTER (…)
```

Signed total plus the two one-sided sums, so a rep who pushes 200 days and pulls 190 back is not shown as
"+10, basically fine".

### 4.6 Chronic mover

**Plain English:** a deal whose close date keeps moving, and a rep who has a lot of them.

- **Deal-level flag:** `move_count >= 3 AND days_pushed_out >= 60`. Both conditions, because three
  ±2-day adjustments is diligence and one 200-day push is a single decision; the pattern worth naming is
  repeated, substantial, one-directional pushing.
- **Rep-level:** `chronic_mover_rate = chronic_mover_deals / (landed_n + overdue_open_n)`.

3 and 60 are proposals. Make them constants in one place so they can be tuned after the first real
distribution is visible.

### 4.7 Silent misses

**Plain English:** deals whose date was set once and never touched, and which then missed badly.

```sql
silent_miss_n = count(*) FILTER (WHERE landed AND move_count = 0 AND abs(signed_error_p30) > 14)
```

Without this, "never moves the date" reads as stability on every other column. It is often the opposite:
nobody maintained the forecast at all. This column is what stops the report from rewarding neglect.

---

## 5. Data gaps — what cannot be measured today

### 5.1 There is no reason code for a slip

**Gap.** The only reason capture is free text inside `activities.body`, written best-effort by one dialog
(§1.7). Close-date edits made from the normal deal form produce no reason at all, and a failed note write
is indistinguishable from a rep who declined to explain.

**To close it going forward:** write a first-class row on every `expected_close_date` change with an enum
`reason_code` (e.g. `client_delay`, `scope_change`, `permitting`, `budget_cycle`, `our_delay`,
`initial_estimate_wrong`, `other`) plus optional free text. The cheapest correct home is the existing
`deal_history` table — it already has `field_name`, `old_value`, `new_value`, `changed_by`, `changed_at`,
`source` and `reason` (`0067` + `0115`), and a live writer seam. Adding `field_name = 'expected_close_date'`
to `server/src/modules/deals/service.ts` alongside the existing `project_type` writer (`:898`) requires no
migration. Making the reason mandatory on the deal edit form as well as the dialog is a product decision,
not a technical one.

### 5.2 No snapshot of the forecast at stage entry

**Gap.** `deal_stage_history` has no `expected_close_date` (§1.6), and `deal_forecast_milestones` — which
was built exactly for this — has had no runtime writer since 2026-04-23 (§1.5). "What did this rep think
when the deal entered Estimating" is answerable only by replaying `audit_log`, and only as far back as
audit coverage actually goes (§1.4).

**To close it:** either restore the two deleted `deal_forecast_milestones` capture calls (the service
already exists and is tested), or add `expected_close_date` to `deal_stage_history`'s insert. The first is
less new surface area and would also un-freeze the existing forecast-variance report.

### 5.3 Actor is NULL for machine and some script writes

**Gap.** `changed_by` on trigger rows comes from `current_setting('app.current_user_id')`, which is set per
API request at `server/src/middleware/tenant.ts:101` but is **not** set by `bid-board-sync/service.ts`,
`procore/synchub-routes.ts`, or `worker/src/jobs/procore-sync.ts`. Those writes land with a NULL actor.

**Impact on this report: small.** Since no sync path writes `expected_close_date` (§1.1), close-date events
should essentially always carry a real actor. The gap matters for the "who moved it" evidence column, not
for the headline, which rolls up by owner. Do not assume it is empty — surface NULL actors as
"Unattributed" rather than dropping the event.

### 5.4 Bulk campaign writes are indistinguishable from thoughtful edits

**Gap.** `scripts/lib/close-date-workflow.ts:485` updates the column via raw SQL. The trigger records it
faithfully, and `changed_by` is whatever `--attribute` supplied (`close-date-workflow.ts:584`) or NULL. A
campaign in which a rep filled a spreadsheet with 40 dates in one sitting looks, in the timeline,
approximately like 40 individual forecast decisions.

**Partially closeable today:** the events arrive in a tight timestamp cluster within one transaction per
tenant. Whether that cluster is a reliable discriminator in the real data is **unverified** — I could not
check production. **To close it properly:** have the re-import stamp a distinguishable actor (a dedicated
system user) or write a `deal_history` row with `source = 'close_date_reimport'`, which the 0115 schema
already supports.

### 5.5 There is no "I re-affirmed this date" signal

**Gap.** A date that has sat unchanged for 200 days and is still 30 days in the future might be a
well-maintained forecast or an untouched one. The system records changes, not confirmations, and
`filterNoopFieldChanges` (`server/src/modules/audit/pg-activity-logger.ts:22`) plus the trigger's
`IS DISTINCT FROM` both correctly drop no-op writes.

**To close it:** a lightweight "confirm close date" action that writes a dated confirmation even when the
value does not change. Worth doing only if leadership actually wants to manage forecast freshness.

### 5.6 Audit coverage floor is unverified

See §1.4. Until `min(created_at)` for `table_name='deals'` is checked against production, this report must
be period-scoped and must not claim all-time coverage.

---

## 6. Fairness and gaming

The failure mode this report must not have: **a rep who never sets a close date, or who parks everything in
2028, scores better than a rep who predicts and misses.** Four defences, in order of importance.

### 6.1 Not forecasting is the worst score, not a blank

Coverage rate (§4.1) is a **first-class column**, shown next to accuracy, always. A rep with zero
predictions shows `coverage 0%`, `hit rate —`, `undated_open n`. The hit rate renders as an em dash and is
**excluded from sorting** — a null must never float to the top of a descending sort and read as a clean
sheet. The scorecard's default sort is on coverage, then hit rate, so "doesn't forecast" sinks.

If leadership wants one number, define it as `coverage_rate × hit_rate_14d` and label it "Forecast
reliability". Zero coverage yields zero. Do not let anyone rank on hit rate alone.

### 6.2 Far-future dating is already penalised, and this report should not undo it

The platform has an existing lever: `CLOSE_TARGET_HOLD_HORIZON_DAYS = 90`
(`shared/src/types/deal-hold-risk.ts:137`). An open, non-terminal deal whose close target is more than 90
CT-days out is **effectively on hold** (`aliasedEffectiveOnHoldConditionSql`,
`server/src/modules/shared/deal-value-sql.ts:430`), which **zeroes its value** in every effective-value
chain. So parking a deal in 2028 already removes its dollars from the rep's forecast.

Precision matters here: the far-out rule zeroes **value**; it does **not** remove the row from
`reportableDealSqlPredicate` (`shared/src/types/deal-reporting.ts:28`), which tests the stored `on_hold`
flag only. The deal is still on the board with a $0 value.

For this report: a prediction that was more than 90 days beyond the deal's `stage_entered_at` at the time
it was made is **parked**. Report `parked_prediction_n` in its own column, and **exclude parked predictions
from `hit_rate`** while still counting them in `move_count`, `days_pushed_out` and the chronic-mover flag.
Without that exclusion the winning strategy is "push everything to 2028, then set an accurate date the week
it closes" — a perfect hit rate on a forecast nobody could plan with.

### 6.3 Late re-dating is caught by the P₃₀ headline

§2.1. The headline error is measured against the standing prediction 30 days out, not the final call. A rep
who only gets it right in the last week shows a good `hit_rate_14d_final` and a bad `hit_rate_14d`, and both
are on the row.

### 6.4 Small denominators do not rank

A rep with two landed deals and two hits is not the best forecaster in the company. Require a minimum
denominator — proposed **5 landed deals in the period** — to appear in the ranking. Below it, show the row
with the real numbers and an "insufficient volume" marker, excluded from sort order. This is the same
discipline `at-risk-service.ts` applies by making every row its own evidence.

### 6.5 Clearing a date does not reset history

A clear (`new_date IS NULL` on a deal that had one) is counted as a `clear_count` event and becomes a
coverage failure from that instant. It **does not** remove the deal's prior moves from `move_count`,
`days_pushed_out` or the chronic-mover flag. Deleting the evidence must not delete the record.

---

## 7. Recommended v1

Small enough to build and review in one pass, and complete enough to answer the actual question.

**Scope**

- One director-gated read endpoint, `GET /api/reports/close-date-accuracy`, alongside the existing report
  routes in `server/src/modules/reports/routes.ts` (mirror the `requireDirector` guard used by
  `/forecast-variance` at `:536`).
- One service module, `server/src/modules/reports/close-date-accuracy-service.ts`, built on the query
  shapes in §4 and following the evidence discipline of `at-risk-service.ts`: **the summary equals the
  listed rows**.
- One client section rendering a per-rep table plus an evidence drill.

**Per-rep columns (v1)**

| Column | §  |
|---|---|
| Coverage % (open deals with a today-or-future date) | 4.1 |
| Landed n | 2.4 |
| Hit rate ±14d (against P₃₀) | 4.2 |
| Median signed error (days) | 4.3 |
| Mean signed error (days) | 4.3 |
| Overdue-open n / median days overdue | 2.4 |
| Moves per landed deal | 4.4 |
| Chronic movers n | 4.6 |
| Silent misses n | 4.7 |

Sorted by coverage, then hit rate. Reps below the volume floor shown but unranked (§6.4).

**Evidence drill.** Clicking any cell opens the deal list behind it. Per deal: the full close-date timeline
from `audit_log` — `changed_at`, `old_date → new_date`, actor (display name, or "Unattributed"), and the
matching Move Close Date note body when one exists within a short window of the event (§1.7). Every number
on the summary row is reachable this way.

**Conventions v1 must follow**, restated so they are not lost in implementation:

1. Won date **only** through `aliasedWonHsClosedWonDateSql`; Lost date as `d.lost_at::date`. No new
   COALESCE (§1.8).
2. Rep filter = `buildAliasedOwnedRepSql` — **owner, never estimator** (§3).
3. All period slicing through `server/src/lib/period.ts` (§1.9).
4. Timeline from the **trigger** rows only, selected by `changes ? 'expected_close_date'` (§1.3).
5. Coverage built on the same scope as `at-risk-service.ts` so the two reconcile (§4.1).
6. Stage membership from `WON_STAGE_SLUGS` / `LOST_STAGE_SLUGS`, never hand-written slug lists (§1.8).

**One companion decision v1 must make, not defer.** The existing Forecast Variance report publishes
`avg_close_drift_days` — unsigned, Won-only, and structurally frozen since 2026-04-23 (§1.5). Shipping a
second, differing close-date-accuracy number beside it produces exactly the kind of half-applied
reconciliation that has bitten this codebase before. Pick one when v1 lands: remove the
`avg_close_drift_days` column from the forecast-variance surface, or restore the
`deal_forecast_milestones` capture calls so it is live again and label the two as measuring different
things. Doing neither is not an option.

**Deferred, deliberately**

- Owner-at-prediction-time attribution (§3). v1 uses the current owner and reports
  `moves_by_other_actor` so the simplification is visible.
- First-class `reason_code` on close-date changes (§5.1). Highest-value follow-up; unblocks "*why* do this
  rep's dates move".
- Restoring or replacing `deal_forecast_milestones` capture (§5.2), beyond the decision above.
- Worker rollup / materialisation. v1 queries live. If it is slow, the natural home is a job in
  `worker/src/jobs/` writing a rollup table — but measure first; `audit_record_idx` already covers the
  access pattern.
- Trend over time (is this rep improving), alerting on regressions, and the per-deal accuracy badge on the
  deal detail page.
- The Lost-side question: is a Lost deal's close date a forecast in the same sense as a Won deal's? v1
  includes Lost and shows the Won/Lost split so the answer becomes visible in the data. Revisit once it is.
- Distinguishing spreadsheet-campaign writes from individual edits (§5.4).

---

## 8. Open questions for the approver

1. **±14 days** — is that the tolerance the business would manage to, or is "landed in the right month"
   (±30) the real bar? Both are computed; only one should be the headline.
2. **P₃₀ as the headline** — is 30 days the forward visibility that matters, or is it 60 (a quarter's
   planning horizon)?
3. **Lost deals** — in or out of the accuracy number?
4. **Bid-Board-owned deals** — proposal is include-and-flag (§2.5). Confirm.
5. **Volume floor of 5 landed deals** for ranking — right number for a team this size?
