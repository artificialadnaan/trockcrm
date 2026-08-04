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

### 1.1 Who writes the forecast field — and yes, a machine does

`deals.expected_close_date` is a `DATE`, nullable, present since `migrations/0001_initial.sql:451`.

**Correction (2026-08-04).** An earlier draft of this spec claimed the column had no machine writer and
that every value in it was typed by a person. **That was wrong**, and it was load-bearing — it was the
reason the draft argued attribution was automatically fair. `scripts/refresh-from-hubspot.ts` overwrites
the column from HubSpot's `closedate`. The original sweep missed it because that script never contains a
literal `SET expected_close_date`: it builds the assignment dynamically
(`${change.fieldName} = $${index + 1}`, `refresh-from-hubspot.ts:686`) and the column name appears only in
a field allowlist. A grep for write-shaped SQL cannot find it. The corrected list below was built by
listing every file that mentions the field at all and reading each one.

**Human / API paths — these are genuine rep predictions:**

| Writer | File |
|---|---|
| Deal create | `server/src/modules/deals/service.ts:2616` |
| Deal update (the normal edit form, and the Move Close Date dialog) | `server/src/modules/deals/service.ts:2912` |
| Inline stage-advance prompt (guarded, see below) | `server/src/modules/deals/stage-change.ts:308` |
| Lead → deal conversion | `server/src/modules/leads/conversion-service.ts:351` |

**Machine / script paths — these are NOT rep predictions:**

| Writer | File | What it writes |
|---|---|---|
| **HubSpot refresh** | `scripts/refresh-from-hubspot.ts:326-338`, applied at `:686-699` | **Overwrites** the CRM date with HubSpot's `closedate` whenever the two differ |
| Migration promotion | `scripts/migration-promote.ts:372, 462` | Seeds `expected_close_date` in the deal INSERT from migration data (`ON CONFLICT (hubspot_deal_id)`) |
| Bulk export / re-import campaign | `scripts/lib/close-date-workflow.ts:485` | Applies dates reps filled into a spreadsheet — rep-sourced values, machine-applied (§5.4) |
| Dev/test seed | `server/src/modules/auth/service.ts:552`, `scripts/seedTestUsersAndData.ts` | Excluded anyway via `is_test_data` |

What remains true from the original claim, verified again: **no sync service writes it.** Bid Board sync
(`server/src/modules/bid-board-sync/service.ts`), SyncHub (`server/src/modules/procore/synchub-routes.ts`)
and the worker's Procore reverse sync (`worker/src/jobs/procore-sync.ts`) all write `actual_close_date`,
`won_closed_date`, `lost_at` and `stage_entered_at`, but none touches `expected_close_date`. The
contamination comes from one offline script, not from continuous background sync — which is what makes it
tractable.

#### 1.1.1 What the HubSpot refresh actually does

`scripts/refresh-from-hubspot.ts` is present on `main`, aliased as `npm run refresh:hubspot`
(`package.json:36`), and hardcoded to one tenant (`const TENANT_SCHEMA = "office_dallas"`, line 48). In
`buildDealUpdatePlan` (lines 326-338) it parses HubSpot's `closedate` and, when it differs from the CRM
value, queues a `FieldChange` with reason `hubspot_closedate` (or `hubspot_closedate_<warning>`).
`applyDealChanges` (lines 661-741) then issues a raw
`UPDATE office_dallas.deals SET expected_close_date = $n, ..., last_synced_from_hubspot_at = ...`.

Two facts bound the risk:

- It **defaults to dry run**: `dryRun: process.env.DRY_RUN !== "false"` (line 438). It writes only when an
  operator explicitly sets `DRY_RUN=false`.
- It is **actively maintained** — last changed 2026-07-28 by `2da9b0845` ("stop the HubSpot refresh
  parking deals on a retired stage", #987). A script being fixed six days before this spec was written is
  not a script nobody runs.

**Unverified, and it needs a production check before v1 ships:** how many times this has run with
`DRY_RUN=false`, and how many `expected_close_date` rows it touched. This answers it exactly:

```sql
SELECT count(*), count(DISTINCT deal_id), count(DISTINCT run_id), min(created_at), max(created_at)
FROM public.hubspot_refresh_log
WHERE field_name = 'expected_close_date';
```

Until someone runs that, **the size of the contamination is unknown**. If it returns zero rows the P1 is
moot in practice and the exclusion below is a cheap insurance policy; if it returns thousands, the
exclusion is the difference between a fair report and a defamatory one.

I also could **not corroborate** the reported deletion of a HubSpot refresh *service* around 2026-07-30.
There is no such deletion in this repository's history, and no undo/reversal script exists under
`scripts/`. What is certain is that the **script** is present, npm-aliased and recently maintained. If a
reversal did happen it was itself a write, and any date it restored is also a machine-written value the
exclusion must catch.

#### 1.1.2 HubSpot-written dates ARE distinguishable — three independent signals

This was the open question the correction raised, and the answer is better than feared. The refresh script
leaves three separate marks:

1. **`public.hubspot_refresh_log` — the decisive one.** Created by
   `migrations/0064_hubspot_refresh_audit.sql:30-40` (so it exists in production whether or not the script
   ever ran), with columns `id, run_id, tenant_schema, deal_id, field_name, old_value, new_value, reason,
   created_at`. `applyDealChanges` writes one row per changed field (`refresh-from-hubspot.ts:711-715`).
   **Rows with `field_name = 'expected_close_date'` are exactly the machine-written close-date events**,
   carrying the deal, both values, the reason and the timestamp. This is a purpose-built, durable,
   migration-backed ledger — far better evidence than any heuristic.
2. **`audit_log.actor_system_process = 'HubSpot Refresh'`.** The script calls `logActivityWithPgClient`
   with `buildAuditActorFromSystem({ systemProcess: HUBSPOT_REFRESH })`
   (`refresh-from-hubspot.ts:726-739`); the constant is `"HubSpot Refresh"`
   (`server/src/modules/audit/system-processes.ts:2`). That row uses the **camelCase** key
   `expectedCloseDate` (mapped by `auditFieldKeyForRefreshColumn`, line 653).
3. **`deals.last_synced_from_hubspot_at`** is stamped on the row (added by `0064`, written at
   `refresh-from-hubspot.ts:688-689`). Per-deal and overwritten every run, so it is a weak signal — useful
   for narrowing a population, useless for pinpointing an event.

**The trap, and it is why the P1 has teeth:** the raw `UPDATE` also fires the `audit_deals` trigger (§1.2),
producing an ordinary **snake_case** `changes ? 'expected_close_date'` row — precisely what §4.0's timeline
CTE selects. That row carries **no system-process marker at all**: the trigger populates only `changed_by`,
from `current_setting('app.current_user_id')`, and the script never calls
`set_config('app.current_user_id', ...)` (verified — the string does not appear in the file). So the
trigger row lands with `changed_by = NULL` and is otherwise **indistinguishable in shape from a rep's own
edit**. Without an explicit exclusion, every HubSpot-imported date is scored as a rep prediction.

One correction to how this risk was described to me: **the audit trigger does not fall back to the assigned
rep.** `audit_trigger_func()` uses `NULLIF(current_setting('app.current_user_id', true), '')::UUID` with no
`COALESCE` — verified in all four versions (`0001_initial.sql:303`, `0029`, `0033`, `0035`). The
assigned-rep fallback existed in the **`deal_stage_history` backstop trigger**
(`migrations/0143_reenable_forward_stage_history.sql:53-58`), and
`migrations/0207_stage_history_actor_no_rep_fallback.sql:82-83` removed it precisely because it misdirected
two production investigations. So a HubSpot-written close date is recorded with a **NULL** actor, not
falsely attributed to the rep. That is materially better — a gap, not a lie — but still not self-evident,
because plenty of legitimate rows also carry a NULL actor. **The exclusion must key on
`hubspot_refresh_log`, never on `changed_by IS NULL`.**

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
- **One inherited caveat, stated as a deliberate choice rather than silently carried.** `lost_at` is a
  `timestamptz` and `deal-date-scope.ts:54` casts it with a bare `::date`, which resolves in the *session*
  timezone rather than `America/Chicago`. **Concrete consequence:** a loss stamped after 19:00 CT reads as
  the next calendar day under a UTC session, so the deal can land in the wrong reporting period and both
  its P₃₀ and P_final anchors (§4.0.3) shift by a day. This spec **keeps the canonical expression anyway** —
  deviating would put it on a different Lost basis from every other surface and break the reconciliation
  §4.1 depends on, which is a worse problem than a rare one-day shift. It is recorded here so the
  inconsistency with §4.0.6's timezone rule reads as a *choice*: that rule governs expressions this report
  introduces, and correcting the canonical helper is its own change with its own blast radius.
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

- **P₃₀ — the standing prediction.** The value the field held at the **end of the business day 30 calendar
  days before the outcome date**. If the deal itself was created inside that 30-day window — so its entire
  life sits after the anchor — P₃₀ falls back to the *first* value ever recorded for the deal. **This is
  the headline.**
- **P_final — the final call.** The value the field held at the **end of the outcome business date**.
  Reported as a secondary column.

**Why "end of the business date" and not "at the outcome instant".** There is no outcome instant available:
`won_closed_date` is a `DATE` column and the Lost stamp is read as `lost_at::date`, so the data records
*which day* a deal closed and never *what time*. Within the closing day we cannot order a forecast edit
against the win. Two readings are possible and only one is defensible: excluding same-day edits would
penalise a rep for updating the forecast on the morning of a win that was recorded that afternoon, for no
reason other than a missing timestamp. So the last value written on the closing day counts. An earlier
draft said "at the outcome instant" while the SQL compared against midnight at the *start* of that date —
the definition and the implementation meant different things, and the implementation is what would have
shipped. The boundary is specified concretely in §4.0.3.

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
| Lost | loss stamp | `d.lost_at::date` — inherited verbatim from `deal-date-scope.ts:54` |
| Open, date in the past | **no outcome yet** — right-censored | see §2.4 |
| Open, date today or future | **not yet judgeable** | excluded from error metrics, counted in coverage |
| Open, no date at all | **no prediction** | counted as a coverage failure, never as a hit or a miss |

`signed_error_days = outcome_date - prediction_date`, in whole days.

**Positive = closed later than predicted (optimistic). Negative = closed earlier (pessimistic).** Signed,
never absolute — a team whose errors are +40 and −40 has a very different problem from a team whose errors
are +40 and +40, and `ABS` erases the distinction. That erasure is the concrete defect in the existing
`avg_close_drift_days` (§1.5).

### 2.3 What counts as accurate

**Proposed tolerance: ±14 days** (`TOLERANCE_DAYS`, §6.4). A landed deal is a *hit* when
`|signed_error_days| <= TOLERANCE_DAYS`.

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
to accidentally drop. They are not dropped here.

Two conventions govern this whole section, both defined once in §4 and referenced everywhere else:

- **"Open" means `outcome_kind = 'open'`** (§4.0.5) — the test that consults `bid_board_stage_slug` as well
  as the CRM stage. Using `pipeline_stage_config.is_terminal = false` instead would classify a Bid-Board
  deal already won or lost in the mirror as an open deal with a rotting forecast, and charge its rep for a
  coverage failure on a deal that has closed.
- **"The date" for any *current-open* bucket means `cov_state` / `cov_prediction`** (§4.1) — the
  provenance-**resolved** pair — never the pre-resolution `pnow_state`, and never the raw column *directly*
  (`coverage_resolution` reads it once, on everyone's behalf, per convention 10's carve-out). The state
  distinguishes a rep's date from a machine's, from a deliberate clear, from no record at all, and those
  four cases belong in four different buckets. Keying some buckets on `pnow_state` and others on
  `cov_state` splits one population in two: an audit-gap deal with a past raw date resolves to
  `rep_prediction` and lands in `at_risk_n`, while a `pnow_state`-keyed overdue bucket would call the same
  deal undated and omit it from `overdue_open_n` — the numerator/denominator class one layer up. Historical
  anchors (P₃₀, P_final) still use their own `p30_*` / `pfinal_*` state; resolution applies to *now* only,
  for the reason given in §4.1.

Every deal in scope lands in exactly one bucket:

1. **Landed** — Won or Lost with a usable outcome date (`D_landed`). Contributes to hit rate and error
   statistics *if* it also carried a usable rep prediction — `D_score`, defined in §4.2.
2. **Overdue-open** — open, `cov_state = 'rep_prediction'`, `cov_prediction` earlier than business today. The
   error is **right-censored**: at least `today − prediction` days, and it will only grow. Own columns
   (`overdue_open_n`, `median_days_overdue`), **never** folded into the landed mean — doing so would let a
   rep improve their average by leaving deals open — and never counted as hits.
3. **Undated-open** — open, `cov_state ∈ {cleared, no_event}`. Not an error; a **coverage** failure.
4. **Parked-open** — open, `cov_state = 'rep_prediction'`, `cov_prediction` more than 90 days out (§4.1). Not
   yet judgeable *and* not covered: a date beyond the platform's own hold horizon forecasts nothing.
5. **Live-open** — open, `cov_state = 'rep_prediction'`, `cov_prediction` between today and +90 days. Counted in
   coverage favourably, excluded from error metrics until it lands.
6. **Machine-dated open** — open, `cov_state = 'machine'`. Held out of the coverage rate entirely
   (§4.1): the standing value is not the rep's, so it can neither credit nor charge them.
7. **Terminal-no-date** — won or lost with no usable outcome date (`D_nodate`, §4.0.5). Not scoreable and
   not open; surfaced as a diagnostic so the drop is visible rather than silent.

Buckets 2–6 partition `D_open`; buckets 1 and 7 are `D_landed` and `D_nodate`.

Buckets 2 and 3 together are §4.1's `at_risk_n`, and correspond to the `stale_dated` and `no_date` reasons
produced by `server/src/modules/reports/at-risk-service.ts:63`. They do **not** equal that watchlist's
count: two correction terms apply, one for provenance and one for the watchlist's mirror-terminal blind
spot. The identity is stated in full, once, in §4.1 — do not restate it here or anywhere else.

Bucket 4 is *not* part of the At-Risk watchlist at all: the platform does not flag a far-future date as
at-risk, it zeroes the deal's value instead (§6.2). So `parked_n` is additional to that reconciliation, not
part of it.

### 2.5 Scope and exclusions

Base population, per tenant schema:

- `d.is_active = true`
- `COALESCE(d.is_test_data, false) = false`
- Owner = `d.assigned_rep_id` (§3)
- Period-scoped on the **outcome date** for landed deals; on business-today for overdue/undated ones

Explicit decisions on the populations the brief asked about. Note that **two different HubSpot problems**
exist and they need two different answers — conflating them is what the first draft got wrong.

**(a) HubSpot-imported *deals* — excluded by construction, no special flag needed.**
`scripts/hubspot-deals-reimport.ts:797-833` inserts deals with a column list that does **not include
`expected_close_date`**; it sets `source = 'hubspot_deals_reimport_2026_05_14'` and `hubspot_deal_id`.
Imported deals therefore begin with **no prediction at all**, and their pre-CRM history was never imported.
They enter the metric only if a human later typed a date into the CRM — at which point that date *is* a
genuine CRM prediction and should count. The rule that makes this correct without a special case is:
**a deal contributes only if it has at least one non-HubSpot recorded prediction whose timestamp precedes
its outcome date.** A HubSpot deal already Won before the CRM existed has no such prediction and
contributes nothing. State this rule in the code; do not rely on `source` string matching.

**(b) HubSpot-written *dates on ordinary deals* — a different set, and it must be excluded explicitly.**
This is the population the deal-level rule in (a) does **not** catch. `scripts/refresh-from-hubspot.ts`
overwrites `expected_close_date` on any deal carrying a `hubspot_deal_id`, including deals a rep has been
actively working in the CRM (§1.1.1). Those events are rep-shaped in the trigger timeline and would sail
straight through a deal-level HubSpot filter.

**Decision: mark HubSpot-written close-date events as `source = 'machine'` in the timeline, at the event
level.** Not the deal — the *event*; and **marked, not deleted**. A deal whose date was overwritten by the
refresh in March and then genuinely re-forecast by its rep in June keeps the June prediction and is
unscoreable only at anchors where March was the last word. Excluding the whole deal would throw away real
rep behaviour; excluding the whole *rep* would be worse; and *deleting* the machine row would silently
resurrect the rep's superseded March forecast — see §4.0.0, which explains why this is a classification and
not a filter. The classifier is in §4.0.2.

Additionally, **report machine-written event counts on the rep row — split by arm, not merged.** The
§4.0.2 classifier maps two very different writers to `source = 'machine'`: the HubSpot refresh (arm a) and
the `migration-promote` seed (arm b). A single column labelled "HubSpot-written" would report seed events
as refresh events, and a book containing seeds but no refresh writes would appear contaminated by a script
that never ran against it.

That is not a cosmetic mislabel. §7 makes the `hubspot_refresh_log` census the **prerequisite for building
this report at all** — the one number the build decision rests on. A diagnostic that inflates it with
migration seeds would corrupt exactly that decision. So emit `hubspot_refresh_events_n` and
`migration_seed_events_n` separately, carrying the matched arm through the classifier as a
`machine_source` label alongside `source`. If both are zero across the board — the likely outcome if the
refresh has only ever run dry (§1.1.1) — the columns cost nothing and prove the report is clean.

**(c) Bid-Board-owned deals — include, but flag.** `d.is_bid_board_owned` / `d.is_read_only_mirror`. The
existing close-date campaign deliberately includes them: `scripts/lib/close-date-workflow.ts:311-316`
records that BB-owned deals *"ARE included (they count toward coverage and a close-date write on them
persists)"*, and no sync service overwrites the field (§1.1). So the prediction on a BB-owned deal is a
real rep prediction. The *outcome*, however, can be driven by the mirror rather than by the rep — a
BB-owned deal can be terminal in `bid_board_stage_slug` while its CRM `stage_id` is still open
(`server/src/modules/shared/deal-value-sql.ts:383-393`). §4.0's outcome CASE must therefore consult
`bid_board_stage_slug` as well as the CRM stage, or those deals silently land in the "open" bucket and get
counted as coverage failures instead of as the closed deals they are. Recommendation: include them, resolve
the outcome from both signals, and show `bid_board_owned_n` on the rep row so a book that is mostly mirror
deals is visible as such.

**(d) Deals whose date was set by the spreadsheet campaign — flag, and see §5.4.**

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

### 4.0 The shared timeline, and the one provenance model

Everything in §4 is built on this section. Read it before any metric.

#### 4.0.0 Provenance is a property of an event, never a reason to delete one

Three separate P1s in review came from the same modelling mistake: treating "this write was not the rep's"
as *remove the row from the timeline*. That is wrong, and it fails in a specific, damaging way.

Deleting a machine event makes `prediction_at` fall through to the **previous rep event**, reporting a
forecast the machine had already replaced as though it still stood. A rep forecasts 1 March; the HubSpot
refresh overwrites it to 1 September; the deal closes 5 September. With the machine row deleted the deal
scores against 1 March and the rep takes a 188-day miss for a value that was not on the record at the time.
Deletion does not neutralise a machine write — it back-dates the rep's own superseded forecast into the
present.

It also spawned the other two defects: because rows were missing, coverage could not use the timeline and
read the raw column instead (round-3 P1); and because each writer was excluded by its own bespoke clause,
the migration seeds were never covered at all (round-4 finding 3).

**The model, stated once:**

> The timeline contains **every** recorded change to `expected_close_date`. Each event carries a `source`.
> A machine write can **end** a rep's standing forecast without **becoming** one.

Every consumer — coverage, P₃₀, P_final, churn — reads the same timeline and the same `source`. Adding a
future machine writer means adding one `WHEN` arm to the classifier in §4.0.2, and nothing else changes.

#### 4.0.1 Raw events

```sql
-- Every recorded change to a deal's forecast date. Nothing is filtered out here.
-- `event_kind` is load-bearing: the machine-seed test in §4.0.2 must apply to INSERT seeds only,
-- or it also catches the rep spreadsheet campaign (§5.4), which produces the same NULL-actor shape
-- on an UPDATE.
WITH raw_close_date_events AS (
  SELECT a.id                                                   AS audit_log_id,   -- tie-breaker, see below
         a.record_id                                            AS deal_id,
         a.created_at                                           AS changed_at,
         a.changed_by                                           AS actor_user_id,
         'update'::text                                         AS event_kind,
         NULLIF(a.changes->'expected_close_date'->>'old','')::date AS old_date,
         NULLIF(a.changes->'expected_close_date'->>'new','')::date AS new_date
  FROM audit_log a
  WHERE a.table_name = 'deals'
    AND a.action     = 'update'
    AND a.changes ? 'expected_close_date'      -- snake_case = DB trigger rows only (§1.3)

  UNION ALL

  -- The date the deal was born with (0028 already reads this exact expression).
  SELECT a.id, a.record_id, a.created_at, a.changed_by,
         'insert'::text,
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

**`audit_log_id` is not decoration.** The `audit_deals` trigger stamps `created_at` with `NOW()`, which in
Postgres is **transaction-stable**: two writes to the same deal inside one transaction receive an
*identical* `changed_at`. `ORDER BY changed_at DESC` alone can then return either row, which means
`state_at` is not a function — the same inputs can yield different answers between runs. `audit_log.id` is
`BIGSERIAL PRIMARY KEY` in both the public and tenant definitions (`0001_initial.sql:731`,
`0032_ensure_tenant_audit_log.sql:12` and `:50`), so it is always available as a tie-breaker.

**Correction (round 10): `changed_at` must not be the primary sort key at all, and an earlier draft of this
paragraph claimed a guarantee it does not have.**

`NOW()` is **transaction-start** time, not statement time. Two overlapping requests can therefore commit in
one order while carrying `changed_at` values in the *opposite* order:

| | begins | writes | `changed_at` | `audit_log_id` |
|---|---|---|---|---|
| Txn A | 10:00:00 | 10:00:05 | **10:00:00** | 500 |
| Txn B | 10:00:02 | 10:00:03 | **10:00:02** | 499 |

B wrote first and A wrote last, so A holds the final value — but `ORDER BY changed_at DESC` picks **B**,
and the `audit_log_id` tie-breaker never engages because the timestamps are not tied. The earlier claim
that the tie-breaker delivers "insertion order in the case that matters" was exactly backwards: this
concurrent-overlap case *is* the case that matters, and it is the one `changed_at` gets wrong.

**Decision: order same-deal state by `audit_log_id` alone.**

```sql
ORDER BY t.audit_log_id DESC     -- NOT changed_at; see above
```

Why `audit_log_id` is faithful here specifically: the trigger's INSERT fires as part of the `UPDATE` on
`deals`, and concurrent updates to the **same deal row** are serialised by Postgres's row lock — the second
writer blocks until the first commits, then writes. So for one deal the trigger inserts occur in true write
order, and a `BIGSERIAL` drawn at insert time records that order. This depends on the sequence not being
cached; `BIGSERIAL` defaults to `CACHE 1`, so values are handed out in request order (verified against
`0001_initial.sql:731` and `0032_ensure_tenant_audit_log.sql:12`, both plain `BIGSERIAL PRIMARY KEY`).
A cached sequence would break it, so do not add `CACHE > 1` to that sequence.

`changed_at` is still used for the **anchor bound** (`< business_day_end_exclusive(...)`), where an error of
seconds is immaterial except for an event written within seconds of midnight in a long transaction. That
residual exposure is accepted and recorded rather than engineered away.

**The thorough fix is a trigger change, and it is deliberately out of scope.** Stamping
`clock_timestamp()` instead of `NOW()` in `audit_trigger_func()` would make `changed_at` a true statement
time. But that function is shared by **eight** audited tables (`deals`, `contacts`, `change_orders`,
`deal_approvals`, `emails`, `activities`, `files`, `tasks` — `0001_initial.sql:757-808`), it would need a
migration replayed per tenant, and it would leave every historical row on the old semantics, so the
ordering rule above is still required for existing data. Recorded as a follow-up in §7, not adopted here.

#### 4.0.2 The classifier — the single place provenance is decided

```sql
close_date_timeline AS (
  SELECT e.audit_log_id,          -- REQUIRED downstream: §4.0.3's total order. Do not drop this.
         e.deal_id, e.changed_at, e.actor_user_id, e.event_kind, e.old_date, e.new_date,
         -- machine_source names WHICH arm matched; `source` is the coarse rep/machine split every
         -- consumer reads. Both are projected because the §4.0.6 diagnostics must tell the two
         -- machine writers apart AFTER this block has collapsed them to one `source`.
         CASE
           WHEN <arm (a) matched> THEN 'hubspot_refresh'
           WHEN <arm (b) matched> THEN 'migration_seed'
           ELSE NULL
         END AS machine_source,
         CASE
           -- (a) HubSpot refresh overwrite (§1.1.1). Matched against the purpose-built ledger.
           WHEN EXISTS (
             SELECT 1 FROM public.hubspot_refresh_log l
             WHERE l.tenant_schema = :tenant_schema
               AND l.deal_id       = e.deal_id
               AND l.field_name    = 'expected_close_date'
               AND l.old_value IS NOT DISTINCT FROM to_char(e.old_date, 'YYYY-MM-DD')
               AND l.new_value IS NOT DISTINCT FROM to_char(e.new_date, 'YYYY-MM-DD')
               AND l.created_at BETWEEN e.changed_at - interval '1 minute'
                                    AND e.changed_at + interval '1 minute'
           ) THEN 'machine'
           -- (b) migration-promote.ts insert seed (§5.3). INSERT only, actorless, HubSpot-linked.
           WHEN e.event_kind = 'insert'
            AND e.actor_user_id IS NULL
            AND d.hubspot_deal_id IS NOT NULL          THEN 'machine'
           ELSE 'rep'
         END AS source
  FROM raw_close_date_events e
  JOIN deals d ON d.id = e.deal_id
),
```

In the real query the two arm predicates are written once and reused (a `LATERAL` or a repeated `CASE`);
they are shown as `<arm (a) matched>` above only to keep the two projections readable. The invariant that
matters: **`machine_source IS NOT NULL` exactly when `source = 'machine'`**, and it names which arm. Pin
that as a test — if the two ever disagree, the contamination census reads the wrong number.

Arm (a) is the HubSpot refresh; arm (b) is the migration promotion. Both collapse to `source = 'machine'`
so all downstream logic is uniform, while `machine_source` preserves the distinction the diagnostics need.
An earlier draft projected only `source`, which made the §4.0.6 split **unimplementable**: once both arms
had been collapsed there was nothing left to split on, and a book carrying migration seeds but no refresh
writes would have reported HubSpot contamination that did not exist — sending someone to chase a problem
they do not have, or to dismiss one they do (§1.1.1).

On arm (b)'s three conjuncts: `event_kind = 'insert'` is what stops it catching the spreadsheet re-import,
which writes UPDATEs and is rep-sourced (§5.4); `actor_user_id IS NULL` distinguishes
`scripts/migration-promote.ts` (never calls `set_config('app.current_user_id', ...)`) from an API deal
create (always does, `server/src/middleware/tenant.ts:101`); `hubspot_deal_id IS NOT NULL` bounds it to
imported deals. A rep who sets the close date while creating a deal in the CRM has a real actor and stays
`'rep'` — that is a genuine forecast path (§1.1) and the source of the cleanest first-call predictions.

On the ±1 minute window in arm (a): both rows are written inside `applyDealChanges` (the `UPDATE` at
`refresh-from-hubspot.ts:686-699`, the log INSERT at `:711-715`), so when they share a transaction their
`NOW()`-derived timestamps are identical. The window is slack for the case where they do not; the match is
really carried by `(deal_id, old_value, new_value)`. Verify against real data before shipping. If the
§1.1.1 census returns no rows, arm (a) is inert.

Index note: `hubspot_refresh_log`'s only usable index is
`hubspot_refresh_log_run_idx (run_id, tenant_schema, deal_id)` — leading on `run_id`, so a per-deal probe
cannot use it. Materialise the `field_name = 'expected_close_date'` subset once per report run rather than
probing per event. If it turns out to be large, add an index — that is a migration, and say so.

#### 4.0.3 State at an instant — one function, four outcomes, never NULL

**Anchor precision, stated before the SQL because it is a definitional choice, not an implementation
detail.** Two of the three anchors are derived from `outcome_date`, which is a **DATE** — `won_closed_date`
is a `DATE` column and `lost_at::date` is a cast to one. The underlying data does not record *what time* a
deal was won. So an anchor expressed as a bare date silently means **midnight at the start** of that day,
and a rep who updated the forecast at any hour of the closing day would be excluded from P_final — despite
§2.1 defining P_final as the prediction held *at the outcome instant*.

**P_final and P₃₀ are therefore defined as the state at the END of their business date**, implemented with
an exclusive next-day boundary. This is the honest reading of the available precision: within the closing
day we cannot order a forecast edit against the win, so we credit the rep with the last thing they wrote
that day. State this limitation in the report's own documentation; do not leave it to be inferred from a
comparison operator.

```sql
-- business_day_end_exclusive(d) -- the instant business date `d` ends, i.e. the start of the next
-- business day, in America/Chicago (BUSINESS_TIMEZONE, §1.9). Compare a timestamptz strictly BELOW this
-- to mean "at any point on or before business date d".
--   ((d + 1)::date::timestamp AT TIME ZONE 'America/Chicago')
-- The explicit AT TIME ZONE is required: comparing a timestamptz against a bare date resolves in the
-- SESSION timezone, which is not guaranteed to be the business timezone.
```

```sql
-- state_at(deal, T): what stood as of T.
-- Takes the LATEST event at-or-before T REGARDLESS OF SOURCE. A machine write is not skipped: it
-- supersedes whatever the rep had entered, which is the whole point of §4.0.0.
LEFT JOIN LATERAL (
  SELECT CASE
           WHEN t.source = 'machine'   THEN 'machine'
           WHEN t.new_date IS NULL     THEN 'cleared'
           ELSE 'rep_prediction'
         END        AS state,
         t.new_date AS prediction,
         t.changed_at,
         t.source
  FROM close_date_timeline t
  WHERE t.deal_id = o.deal_id
    AND t.changed_at < <T_exclusive_upper_bound>
  ORDER BY t.audit_log_id DESC          -- write order, NOT changed_at; see §4.0.1
  LIMIT 1
) p ON TRUE
```

`<T_exclusive_upper_bound>` per anchor:

| Anchor | Bound | Why |
|---|---|---|
| `pfinal` | `business_day_end_exclusive(outcome_date)` | Includes edits made on the closing day (the fix above) |
| `p30` | `business_day_end_exclusive(outcome_date - STANDING_ANCHOR_DAYS)` | Same convention, so the two anchors are comparable |
| `pnow` | `now()` | A true instant, not a date — no day-boundary question arises, and no event can be in the future |

`pnow` deliberately does **not** use the helper. It is the only anchor that is genuinely an instant rather
than a date, so `< now()` is exact; wrapping it in a day boundary would add nothing and would invite the
reader to think a date is involved.

and every consumer reads the **coalesced** state, never the raw lateral columns:

```sql
COALESCE(p.state, 'no_event') AS p_state
```

| `p_state` | Meaning | Scoreable? |
|---|---|---|
| `rep_prediction` | A rep-authored date stood at T | **Yes** |
| `machine` | The last write before T was HubSpot's or a migration seed — the rep's forecast, if any, had been superseded | No |
| `cleared` | The rep explicitly removed the date | No |
| `no_event` | No recorded event before T — outside the audit window, or never forecast | No |

**`p_state` is a non-null enum by construction, and that is deliberate.** The earlier draft exposed a
nullable boolean `had_event` and wrote `NOT p30.had_event`. Under three-valued logic that expression is
NULL when the lateral produces no row, and a NULL predicate inside `FILTER (WHERE ...)` counts nothing — so
landed deals with no prediction incremented *no* shortfall bucket and silently vanished from the very
invariant meant to catch silent drops. Comparing a coalesced enum to a literal cannot reproduce that class
of bug. **Do not reintroduce a nullable boolean here.** See the NULL-safety rule in §4.0.6.

Evaluated at three anchors:

| Anchor | `T` | Used by |
|---|---|---|
| `p30` | `outcome_date - STANDING_ANCHOR_DAYS` (with the §4.0.4 fallback) | headline hit rate, all error stats |
| `pfinal` | `outcome_date` | `hit_rate_14d_final` (§4.2) |
| `pnow` | `now()` | coverage (§4.1) |

Coverage reads `pnow` — the same timeline as everything else. There is no separate "standing date" concept
and **no metric reads `d.expected_close_date` directly — with the single bounded exception of the
`coverage_resolution` CTE (§4.1), which needs it to resolve provenance and is convention 10's stated
carve-out. Do not delete that join as a violation.** Any other raw read is how the exclusion leaked in
round 3, and the unified state function removes the need for it entirely.

#### 4.0.4 The P₃₀ fallback, gated on the deal's life

§2.1 allows falling back to the deal's first recorded prediction **only when the deal's whole life was
shorter than 30 days**. The gate is the deal's own age, not its first close-date event:

```sql
p30 = CASE
        WHEN <an event exists below business_day_end_exclusive(outcome_date - STANDING_ANCHOR_DAYS)>
          THEN state_at(deal, business_day_end_exclusive(o.outcome_date - STANDING_ANCHOR_DAYS))
        -- The DEAL is younger than the anchor: its whole life sits inside the window, so its earliest
        -- recorded state is all there is. Same tz-explicit boundary as everywhere else (§4.0.3).
        WHEN o.deal_created_at >= business_day_end_exclusive(o.outcome_date - STANDING_ANCHOR_DAYS)
          THEN <earliest event state, see below>
        ELSE 'no_event'                        -- long-lived, forecast late: NOT scoreable
      END
```

The "earliest event" arm needs the same order as `state_at`, in the other direction — **and the same
outcome cap.** `expected_close_date` stays editable after a deal closes (§4.0.5), so an uncapped
earliest-event lookup can return a post-close cleanup edit and make a genuinely no-prediction deal
scoreable. `E` was capped at the outcome for churn in round 5b; that cap did not reach this lookup:

```sql
WHERE t.deal_id = o.deal_id
  AND t.changed_at < business_day_end_exclusive(o.outcome_date)   -- no post-close edit may become P30
ORDER BY t.audit_log_id ASC           -- write order, NOT changed_at; see §4.0.1
LIMIT 1
-- no row -> 'no_event'. A deal whose only close-date write came after it closed never had a prediction.
```

A deal created and forecast twice within one transaction would otherwise resolve its *first* prediction
non-deterministically — the mirror of the §4.0.1 problem, and just as easy to miss because it only bites on
same-transaction writes.

An earlier draft gated on `min(changed_at)` over the deal's *events*. That is circular: a deal created in
January and first forecast on 20 July, closing on 30 July, has `min(changed_at)` after the anchor, so the
guard passed and the ten-day-old date became P₃₀ — scoring a last-minute guess as a confident month-ahead
forecast. The deal's `created_at` is the honest measure of how long the rep had to form a view.

Both arms use `STANDING_ANCHOR_DAYS` (§6.4), not a literal `30`. Open question 2 invites the approver to
move the anchor to 60; an implementation copied from a snippet with `30` baked in would keep scoring at 30
while the constants table said 60. Note that `STANDING_ANCHOR_DAYS` and `WIDE_TOLERANCE_DAYS` currently
*share* the value 30 — they are independent settings that happen to coincide, and moving one must not move
the other.

**The gate compares against the anchor itself, not one day earlier.** An intermediate draft used
`outcome_date - 31`, which is the *start* of day `outcome_date - STANDING_ANCHOR_DAYS` rather than its end. A deal created
during the P₃₀ business date, carrying no close date, and first forecast after that day ended would slip
through: it demonstrably existed at the anchor with no prediction — precisely the `no_event` case — yet
the fallback fired and promoted the late forecast. Both arms use the identical
`business_day_end_exclusive(outcome_date - STANDING_ANCHOR_DAYS)` expression; two spellings of "the
anchor" is how the off-by-one got in.

#### 4.0.5 Outcomes and populations

```sql
-- The terminal test consults the Bid Board mirror as well as the CRM stage, because a BB-owned deal can
-- be won/lost in bid_board_stage_slug while its CRM stage_id is still open
-- (server/src/modules/shared/deal-value-sql.ts:383-393).
outcomes AS (
  SELECT d.id                       AS deal_id,
         d.assigned_rep_id          AS rep_id,
         d.created_at               AS deal_created_at,      -- §4.0.4 gate
         CASE
           WHEN psc.slug IN (:won_slugs)
             OR COALESCE(d.bid_board_stage_slug,'') IN (:won_slugs)  THEN 'won'
           WHEN psc.slug IN (:lost_slugs)
             OR COALESCE(d.bid_board_stage_slug,'') IN (:lost_slugs) THEN 'lost'
           ELSE 'open'
         END                        AS outcome_kind,
         CASE
           WHEN psc.slug IN (:won_slugs)
             OR COALESCE(d.bid_board_stage_slug,'') IN (:won_slugs)
             THEN <aliasedWonHsClosedWonDateSql('d')>
           WHEN psc.slug IN (:lost_slugs)
             OR COALESCE(d.bid_board_stage_slug,'') IN (:lost_slugs)
             THEN d.lost_at::date
           ELSE NULL
         END                        AS outcome_date,
         -- Terminal stage-entry business date, for D_nodate deals that have no outcome_date at all
         -- (§4.0.7 event_window_end). Mirrors HOW outcome_kind was derived: if the CRM stage is the
         -- terminal signal, use the CRM stage entry; if the Bid Board mirror is, use the mirror entry --
         -- a mirror-terminal deal's CRM stage_entered_at reflects its still-open CRM stage, not the
         -- transition that made it terminal. Real columns: deals.stage_entered_at (NOT NULL) and
         -- deals.bid_board_stage_entered_at (nullable). Timezone-explicit per §4.0.6.
         CASE
           WHEN psc.slug IN (:won_slugs) OR psc.slug IN (:lost_slugs)
             THEN (d.stage_entered_at AT TIME ZONE 'America/Chicago')::date
           ELSE (COALESCE(d.bid_board_stage_entered_at, d.stage_entered_at)
                   AT TIME ZONE 'America/Chicago')::date
         END                        AS terminal_entry_date,
         -- D_reopened membership (§4.0.5). Produced HERE so Block A's in_d_cov can consume it; the
         -- stage-history row into a Won/Lost stage survives the reopen even though the terminal date
         -- fields do not (stage-change.ts:357-362). Non-null boolean, so `NOT` on it is safe (§4.0.6).
         --
         -- NOT gated on the deal being open TODAY. A deal that landed in-window, reopened, and re-closed
         -- after `to` is currently terminal with an out-of-window outcome_date: its in-window landing is
         -- still missing from D_landed, but an `outcome_kind = 'open'` test would miss it entirely and
         -- drop it into D_outside unflagged. That is the common case for any period more than a few weeks
         -- old, so the test is "had an in-window landing that D_landed does not represent".
         EXISTS (
           SELECT 1 FROM deal_stage_history h
           JOIN public.pipeline_stage_config hp ON hp.id = h.to_stage_id
           WHERE h.deal_id = d.id
             AND (hp.slug IN (:won_slugs) OR hp.slug IN (:lost_slugs))
             -- BOTH ends on the same basis: the CT calendar date of the stage entry, inclusive.
             -- Matches ctDateInWindowSql (monday-showcase-service.ts:322-327), which already applies
             -- this rule to THIS column. Do not mix a bare `>= :from` with a converted upper bound.
             AND (h.created_at AT TIME ZONE 'America/Chicago')::date >= :from::date
             AND (h.created_at AT TIME ZONE 'America/Chicago')::date <= :to::date
           -- ...AND a later row moving OUT of a terminal stage. This is the positive evidence that a
           -- REOPEN happened. Without it the predicate proved only "landed in-window, and the landing
           -- is missing from D_landed", which a NULL outcome_date or a corrected out-of-window date
           -- also satisfies -- misreporting a data-quality problem as a workflow event, in a
           -- diagnostic people act on.
           AND EXISTS (
             SELECT 1
             FROM deal_stage_history reo
             JOIN public.pipeline_stage_config rf ON rf.id = reo.from_stage_id
             JOIN public.pipeline_stage_config rt ON rt.id = reo.to_stage_id
             WHERE reo.deal_id = d.id
               AND reo.created_at > h.created_at
               AND (rf.slug IN (:won_slugs) OR rf.slug IN (:lost_slugs))
               AND rt.slug NOT IN (:won_slugs) AND rt.slug NOT IN (:lost_slugs)
           )
         )
         AND NOT (
           -- ...and that landing is NOT already represented in D_landed for this period. A deal that
           -- reopened and RE-CLOSED inside the window has its landing represented by the reclose date,
           -- so it is not a lost landing and is not flagged.
           (psc.slug IN (:won_slugs) OR COALESCE(d.bid_board_stage_slug,'') IN (:won_slugs)
            OR psc.slug IN (:lost_slugs) OR COALESCE(d.bid_board_stage_slug,'') IN (:lost_slugs))
           AND <outcome_date> BETWEEN :from::date AND :to::date
         )                          AS is_reopened_after_landing,
         -- NOTE: expected_close_date is deliberately NOT selected. State comes from §4.0.3.
         COALESCE(d.is_bid_board_owned, false) OR COALESCE(d.is_read_only_mirror, false) AS bid_board_owned
  FROM deals d
  JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
  WHERE d.is_active = true
    AND COALESCE(d.is_test_data, false) = false
    AND ${aliasedReportableDealFilterSql('d')}   -- COALESCE(d.on_hold,false) = false
),
```

`:won_slugs` / `:lost_slugs` are parameterised from `WON_STAGE_SLUGS` / `LOST_STAGE_SLUGS`
(`server/src/modules/shared/pipeline-terminal-stages.ts`), the same list `aliasedTerminalDealBySlugSql`
uses — reuse that helper rather than re-deriving the OR by hand if the query shape allows.

The reportable filter (`server/src/modules/shared/deal-value-sql.ts:464`) belongs in the **base** CTE, not
bolted onto one metric: `at-risk-service.ts:69` applies it to the population this report reconciles with.
It excludes only **stored** `on_hold` deals — the far-out auto-park leg is deliberately not part of it
(§6.2), which is why parked deals stay in scope and are bucketed explicitly rather than silently filtered.

**Named populations**, all scoped to one rep (owner, §3):

| Name | Definition | Time basis |
|---|---|---|
| `D` | The base `outcomes` CTE above | current row state |
| `D_landed` | `D` ∩ `outcome_kind ∈ {won, lost}` ∩ `outcome_date IS NOT NULL` ∩ `outcome_date BETWEEN from AND to` (both inclusive) | period |
| `D_nodate` | `D` ∩ `outcome_kind ∈ {won, lost}` ∩ `outcome_date IS NULL` | — |
| `D_open` | `D` ∩ `outcome_kind = 'open'` | **today** (see below) |
| `D_reopened` | `D` ∩ a `deal_stage_history` row into a Won or Lost stage whose CT date is inside `[from, to]` ∩ **that landing is not represented in `D_landed`**. An **overlay**, not a partition member: it intersects `D_open` (reopened, still open) and `D_outside` (reopened, re-closed after `to`) | period |
| `D_outside` | `D` ∩ `outcome_kind ∈ {won, lost}` ∩ `outcome_date IS NOT NULL` ∩ `outcome_date` **outside** `[from, to]` — before `from` **or** after `to` | out of period |
| `D_book` | `(D_landed ∪ D_open) \ D_reopened` — the rep's book *for this period*. Denominator for churn rates. | mixed, stated |
| `D_score` | `D_landed` ∩ `p30_state = 'rep_prediction'` ∩ P₃₀ not parked-at-write (§6.2) | period |
| `D_score_final` | `D_landed` ∩ `pfinal_state = 'rep_prediction'` ∩ P_final not parked-at-write | period |
| `D_cov` | `D_open` ∩ `cov_state <> 'machine'` ∩ **not in `D_reopened`**, with `provenance_unknown` folded in as rep-authored (§4.1) | today |
| `E` | Events in `close_date_timeline` on deals in `D_book` (so never a reopened deal), `source = 'rep'`, `changed_at < event_window_end(deal)` | per-deal, see below |

**On `D_landed`'s period bounds:** `outcome_date` is a `DATE`, and `getWtdPeriod` returns `from`/`to` as
inclusive `YYYY-MM-DD` strings (§1.9), so `BETWEEN from AND to` is correct and needs no adjustment. Do
**not** import the timestamp convention from `deal-date-scope.ts` (`>= from::date` and
`< to::date + interval '1 day'`, §1.8) — that exclusive upper bound exists to cover a *timestamp* column's
intraday values, and applying it to a date column is harmless only by luck. Two different boundary
conventions in one query is how an off-by-one day enters.

**`D_outside` is why the partition is four-way, not three.** For any period narrower than all-time, a rep's
deals that closed *before* `from` are still in the base `outcomes` CTE — they are active, reportable, and
terminal — but they match neither `D_landed` (outcome date out of range), nor `D_open` (not open), nor
`D_nodate` (they have a date). Under the earlier three-way statement they were an unnamed remainder: the
invariant `|D_landed| + |D_open| + |D_nodate| = |D|` was **false for every rep with any older closed deal**,
so the test pinning it would fail on the first realistic dataset — or, worse, an implementer would "fix" the
test rather than name the population. `D_outside` is excluded from every metric; it exists so the partition
closes and the invariant is true as written.

**`D_reopened`'s window is CT-anchored on both ends**, matching `ctDateInWindowSql`
(`server/src/modules/reports/monday-showcase-service.ts:322-327`) — which already applies the
business-timezone rule to `deal_stage_history.created_at`, the same column. That existing helper is the
convention; a `business_day_start()` twin was not invented for it. Inclusive at both ends, consistent with
`D_landed`'s `BETWEEN from AND to` (§4.0.5).

An earlier draft compared `h.created_at >= :from` bare against a `business_day_end_exclusive(:to)` upper
bound — one end session-timezone-dependent, the other explicit, in the same window. **Blast radius, worth
stating because it is larger than it looks:** this boundary decides `is_reopened_after_landing`, which
gates `D_cov`, `machine_dated_n` and `reopened_after_landing_n` — so a terminal stage entry near midnight
moves a deal between three buckets *and* breaks the population tie-out in §4.0.6.

**What counts as a reopen.** Two pieces of positive evidence, both from `deal_stage_history`: a row
*into* a Won/Lost stage whose CT date falls in `[from, to]` (the landing), and a **later** row whose
`from_stage_id` is a Won/Lost stage and whose `to_stage_id` is not (the reopen). An earlier draft required
only the landing plus "the landing is absent from `D_landed`" — but absence has other causes. A deal whose
`outcome_date` is NULL (`D_nodate`, a mirror-terminal with no Won date) or whose Won date was later
corrected to fall outside the window both satisfy that predicate without ever having reopened, so a
data-quality problem was reported as a workflow event in a diagnostic people would act on.

**Residual:** `deal_stage_history.from_stage_id` is nullable (`0001_initial.sql:467`), and the
`0143`/`0207` backstop populates it only on the UPDATE branch. A reopen recorded with a NULL
`from_stage_id` is invisible to this test. Every reopen is an UPDATE so it should be populated, but this is
**unverified against production** — count `deal_stage_history` rows with a NULL `from_stage_id` before
trusting `reopened_after_landing_n` as complete.

**`D_reopened` is an overlay, not a member of the partition — and it is excluded from churn as well as
from coverage.**

It intersects `D_open` (reopened and still open) *and* `D_outside` (reopened and re-closed after `to`),
because both describe the same failure: an in-window landing that `D_landed` does not represent. So it is
reported as a diagnostic across both, while only its `D_open` slice participates in the coverage tie-out:

- `reopened_after_landing_n` = `|D_reopened|` — the full diagnostic, the number leadership should see.
- `reopened_open_n` = `|D_reopened ∩ D_open|` — the term in §4.0.6's `D_open` identity.

**Excluded from `E` and `D_book` too.** `D_book` previously included all of `D_open`, and the `open → now()`
branch of `event_window_end` runs the event window right through the interval when the deal was *closed* —
so close-date edits made while it was closed counted as forecast churn, inflating `move_count`,
`total_days_slipped` and the chronic-mover flag. That is precisely the post-outcome churn removed in round
5b, reappearing through a population that did not exist then.

Two repairs were possible. Splitting the event window around the closed interval is more faithful — it
would keep the pre-landing churn, which is real forecasting — but it requires knowing when the deal closed
and reopened, which is the same landed-history reconstruction §4.0.5 already declines to attempt. Excluding
the deal is less informative and more honest: it says "this rep's churn number does not describe these
deals" rather than quietly computing a wrong one. **v1 excludes**, and the exclusion lifts if and when the
reconstruction lands (§7 follow-up). `reopened_after_landing_n` is what stops the exclusion being silent.

**It is a diagnostic, not a silent reclassification.** A deal
won or lost *inside* the period and later reopened has no terminal stage today, and `stage-change.ts:357-362`
clears `actual_close_date`, `won_closed_date`, `lost_at` and the lost-reason fields on any terminal change
or reopen. So the §4.0.5 CASE classifies it `open` and its landing vanishes from the period's landed and
error columns — a rep's closed deal disappearing from their record, exactly the class of quiet wrong this
document exists to prevent.

v1 does **not** reconstruct the outcome date from history: `won_closed_date` is gone, and
`deal_stage_history.created_at` is a different basis from the canonical Won date (§1.8), so folding it into
`D_landed` would put those deals on a second, unreconciled Won basis. Instead the deal is *detected* — the
stage-history row into a Won/Lost stage survives the reopen — reported as `reopened_after_landing_n`, and
**excluded from `D_cov`** so it is not silently counted as an ordinary open deal with a forecast obligation
either. Reconstructing landed outcomes for reopened deals is a stated §7 follow-up.

**Canonical relations block — the single declaration of how these populations relate.** Every set
assertion anywhere in this document must appear here; nothing else may *state* a relation, only cite one.
This exists because three separate audit-table cells asserted relations the SQL had already contradicted
and no check read them: the contents check verifies the *populations column* against the SQL and is blind
to prose in neighbouring cells.

```text
RELATIONS
  D_landed + D_open + D_nodate + D_outside = D      -- disjoint partition, four-way
  D_reopened subset of (D_open union D_outside)     -- OVERLAY: not a partition member, NOT subset of D_open
  D_cov   = D_open minus (machine-dated union D_reopened)
  D_book  = (D_landed union D_open) minus D_reopened
  D_score subset of D_landed
  D_score_final subset of D_landed
  E       = events on D_book only
  DISJOINT( D_cov , machine-dated-and-not-reopened , D_reopened-and-open )
```

**`D_outside` spans both directions.** `D` reflects current row state, so for any completed-period view
("last week", "last month") it contains deals that closed *after* `to` as well as before `from` — a deal
that landed yesterday is outside a period that ended last Saturday. If a before/after split is ever wanted
it is a trivial extra `FILTER`; the default is one correctly-named bucket. `D_nodate` exists because a mirror-won deal can
have a NULL `won_closed_date` (nothing stamps it while the CRM stage stays open): it is terminal, so not in
`D_open`, and has no outcome date, so not in `D_landed`. Without naming it, those deals fall out of every
population and the `mirror_terminal_no_date_n` diagnostic that is supposed to make the drop visible would
itself be drawn from a set that excludes them.

**`E` is capped per deal, not globally at `now()`.**

```sql
-- event_window_end(deal): the instant after which this deal's edits are no longer forecasting.
--   landed / no-date terminal : business_day_end_exclusive(outcome_date)   -- or, for D_nodate, stage entry
--   open                      : now()
```

`expected_close_date` remains editable after a deal closes — nothing in
`server/src/modules/deals/service.ts:2912` blocks it, and terminal-field clearing in `stage-change.ts`
resets `actual_close_date`, `won_closed_date`, `lost_at` and the lost-reason fields but deliberately
**not** the forecast date. So data cleanup, a correction, or a re-open/re-close cycle can all write the
column months after the outcome. Counting those as churn charges a rep for editing a forecast that was no
longer standing — inflating `move_count`, `total_days_slipped` and the chronic-mover flag for the reps
whose books get tidied. Capping at the outcome boundary uses the same
`business_day_end_exclusive` helper as the P_final anchor (§4.0.3), so a deal's last scoreable prediction
and its last countable move share one boundary rather than two conventions.

**`D_open` is a today snapshot, not an as-of-`to` reconstruction — v1 accepts this and labels it.** The
`outcomes` CTE reads the current `deals` row, so for a completed-week or completed-month view, deals
created after `to` but open today enter it, and deals open at `to` that have since landed leave it.
Reconstructing membership as of `to` needs a stage-history replay and is deferred (§7). The consequence:
**coverage and churn columns are always "as of today" regardless of the selected period, and the UI must
say so on the column header.** Only the landed/error columns are period-scoped. An earlier draft defined
`D_open` as as-of-`to` while computing it from today — a definition and a computation disagreeing, which is
worse than either choice made openly.

#### 4.0.6 The numerator/denominator audit

Most defects found in review of this document were one error: a numerator and a denominator describing
different sets. This table exists so that error is visible on the page. **Every metric in §4 must appear
here. Adding a metric without adding a row is the defect re-entering.**

| Metric | § | Numerator drawn from | Denominator | Same set? |
|---|---|---|---|---|
| `coverage_rate` | 4.1 | `D_cov` where `cov_state = 'rep_prediction'` and `cov_prediction` in `[today, today + CLOSE_TARGET_HOLD_HORIZON_DAYS]` | `D_cov` | Yes |
| `covered_n` / `parked_n` / `at_risk_n` | 4.1 | partition of `D_cov` | — | Sums to `\|D_cov\|` |
| `machine_dated_n` | 4.1 | `D_open` \ `D_cov` | — | Complement, reported |
| `hit_rate_14d`, `hit_rate_30d` | 4.2 | `D_score` within tolerance | `D_score` | Yes |
| `hit_rate_14d_final` | 4.2 | `D_score_final` within tolerance | **`D_score_final`** | Yes |
| `mean_signed_error_days`, `median_signed_error_days`, `p90_signed_error_days` | 4.3 | `D_score` | `D_score` | Yes |
| `landed_n` | 2.4 | `D_landed` | — | Count |
| `scoreable_n` | 4.2 | `D_score` | — | Count; `D_score ⊆ D_landed` |
| `no_prediction_n` / `cleared_n` / `machine_superseded_n` / `parked_prediction_n` | 4.2 | `D_landed` \ `D_score`, partitioned by `p30_state` | — | Partition of the shortfall |
| `overdue_open_n`, `median_days_overdue` | 2.4 | `D_open` past-due subset | — | Count |
| `move_count` / `set_count` / `clear_count` | 4.4 | `E` | — | Event counts |
| `moves_per_deal` | 4.4 | `E` (move events) | `\|D_book\|` | Yes — `E` is defined over `D_book` |
| `total_days_slipped`, `days_pushed_out`, `days_pulled_in` | 4.5 | `E` | — | Event sums |
| `chronic_mover_n` | 4.6 | deals in `D_book` meeting the flag | — | Count |
| `chronic_mover_rate` | 4.6 | `chronic_mover_n` | `\|D_book\|` | Yes |
| `silent_miss_n` | 4.7 | `D_score` with `deal_move_count = 0` and `abs(signed_error_p30) > TOLERANCE_DAYS` | — | Count |
| `forecast_reliability` | 6.1 | `COALESCE(coverage_rate,0) * COALESCE(hit_rate_14d,0)` | — | Composite; both operands coalesced so zero coverage yields zero |
| `scoreable_final_n` | 4.2 | `D_score_final` | — | Count; the `hit_rate_14d_final` volume floor (§6.4) |
| `cov_n` | 4.1 | `D_cov` | — | Count; the `coverage_rate` volume floor (§6.4) |
| `moves_by_other_actor` | 3 | `E` where `actor_user_id` is a user other than the owner (NULL ≠ "other") | — | Event count |
| `machine_written_events_n`, `hubspot_refresh_events_n`, `migration_seed_events_n` | 2.5(b) | `close_date_timeline` on `D_book`: `source='machine'` for the total, `machine_source='hubspot_refresh'` / `='migration_seed'` for the two arms | — | Diagnostic |
| `mirror_terminal_no_date_n` | 4.0.5 | **`D_nodate`** | — | Diagnostic |
| `bid_board_owned_n` | 2.5(c) | `D_book` | — | Diagnostic |
| `out_of_period_landed_n` | 4.0.5 | `D_outside` | — | Diagnostic; excluded from every other metric |
| `reopened_after_landing_n` | 4.0.5 | `D_reopened` (all of it, `D_open` ∪ `D_outside` slices) | — | Diagnostic |
| `reopened_open_n` | 4.0.5 | `D_reopened ∩ D_open` | — | The `D_open` tie-out term; excluded from `D_cov`, `D_book`, `E` |
| `provenance_unknown_n` | 4.0.6 | `D_open` with a non-null `expected_close_date` but `pnow_state = 'no_event'` | — | Integrity diagnostic |

`provenance_unknown_n` is computed inside the **coverage provenance-resolution block** (§4.1), the single
bounded place permitted to read the raw `expected_close_date` column — its entire job is to compare the
column against the timeline. A deal carrying a date with
no event behind it means the audit window does not reach as far back as §1.4 assumes. It should be
near-zero; if it is not, the coverage numbers are resting on an assumption that does not hold, and this is
the column that says so. Bucket such deals as `rep` for coverage purposes — the conservative choice, since
excluding them would let an unverifiable gap quietly shrink a rep's denominator.

Invariants to pin as tests — they are the point of the table:

1. `covered_n + parked_n + at_risk_n = |D_cov|`, and
   `|D_cov| + machine_dated_n + reopened_open_n = |D_open|`. The third term is the `D_open` **slice** of
   `D_reopened`, not the whole diagnostic — `reopened_after_landing_n` also counts re-closed deals sitting
   in `D_outside`, and using it here would over-subtract.

   **The three right-hand terms are disjoint by construction, and that is load-bearing.** `D_cov` requires
   neither machine-dated nor reopened; `reopened_after_landing_n` takes precedence; `machine_dated_n`
   carries `NOT is_reopened_after_landing`. Without that precedence a deal reopened after landing *and*
   later given a machine close-date write satisfies two predicates and is counted twice — an identity
   whose terms can overlap is not an identity, and this one was widened to fix a double-count while
   introducing one of its own. Assert disjointness in the test alongside the sum, not just the total.
2. `scoreable_n + no_prediction_n + cleared_n + machine_superseded_n + parked_prediction_n = landed_n`.
3. `|D_landed| + |D_open| + |D_nodate| + |D_outside| = |D|`. **Four terms, not three** — `D_outside`
   (deals that closed outside the selected period, in either direction) is the remainder that made the
   three-term form false for every rep with any closed deal outside the window.

**Two SQL rules that apply to every expression in this document:**

- **Cast before dividing.** `count(*)` is `bigint` and `bigint / bigint` truncates — `3 / 4` is `0`, not
  `0.75`. Every rate uses `count(...)::numeric / NULLIF(count(...), 0)`.
- **Never negate a nullable.** No `NOT <col>` or `<col> <> x` where `<col>` can be NULL — in particular
  anything from a `LEFT JOIN LATERAL`, which is NULL when no row matches. Under three-valued logic those
  are NULL, and a NULL predicate inside `FILTER (WHERE ...)` counts nothing, so rows disappear instead of
  landing in a bucket. The state enum in §4.0.3 is coalesced precisely so every downstream test is a
  positive equality against a non-null value. Where a negative test is unavoidable, write it as
  `<col> IS DISTINCT FROM x` or `<col> IS NOT TRUE`.
- **Both ends of a window must share a basis.** A range with one timezone-explicit bound and one bare
  bound is wrong by construction, whichever end is individually right — and unlike "is this bound correct?",
  that question is answerable from the text alone, so it is mechanical (§7 audit inventory). Round 5 swept
  bounds individually and found six; a seventh was introduced afterwards as a half-converted window and
  survived until the asymmetry itself was checked.
- **Never compare a `timestamptz` against a bare date, and never `::date` one without a timezone.** Both
  resolve in the *session* timezone, which is not guaranteed to be `America/Chicago`. Use
  `business_day_end_exclusive(d)` (§4.0.3) for an upper bound and
  `(<ts> AT TIME ZONE 'America/Chicago')::date` for a cast. A day-boundary error is invisible in test data
  seeded at midday and appears in production only for evening edits.
- **Order same-deal event lookups by `audit_log_id`, never by `changed_at`.** `NOW()` is transaction-start
  time, so `changed_at` can invert the true write order for concurrent overlapping requests, and no
  tie-breaker rescues it because the values are not tied (§4.0.1). `audit_log_id` is faithful because
  row-level locking serialises same-deal writes. A `LIMIT 1` over any other order is a query whose answer
  can be wrong, not merely unstable.
- **State the precision you actually have.** `outcome_date` is a `DATE`; the data does not record what time
  a deal was won. Where a bound is derived from it, say in prose which end of the day is meant rather than
  letting `<` versus `<=` carry a definition the reader has to reverse-engineer.

#### 4.0.7 Derived names, and the producer/consumer chain

Every round of review has fixed a defect by adding a name, and twice the name referred to something no
earlier block produced. Those are not logic errors — the query simply does not run, and the likely "fix" is
to delete the reference rather than add the projection, which silently reinstates the defect the name was
added for. This section exists so that class is checkable.

**The three anchor prefixes.** §4.0.3's `state_at` lateral is joined **three times**, once per anchor, and
each instance is aliased with a prefix. The lateral produces `state`, `prediction`, `changed_at`, `source`;
the prefixed names used throughout §4 are those columns qualified by the instance:

| Instance | Alias | Produces |
|---|---|---|
| `state_at(deal, business_day_end_exclusive(outcome_date - STANDING_ANCHOR_DAYS))` | `p30` | `p30_state`, `p30_prediction`, `p30_changed_at`, `p30_source` |
| `state_at(deal, business_day_end_exclusive(outcome_date))` | `pfinal` | `pfinal_state`, `pfinal_prediction`, `pfinal_changed_at`, `pfinal_source` |
| `state_at(deal, now())` | `pnow` | `pnow_state`, `pnow_prediction`, `pnow_changed_at`, `pnow_source` |

Each `*_state` is the **coalesced** form (§4.0.3) — `COALESCE(p.state, 'no_event')`, never the raw lateral
column. The convention was implicit for three rounds; stated here because otherwise every `p30_*` name in
§4 is formally unproduced.

**Derived scalars**, defined once here and consumed by name everywhere else:

**Two blocks, not one — the row-level scalars come BEFORE `E`, the churn aggregates AFTER.** An earlier
draft put all of these in a single block, which made the chain circular: `E` is filtered by
`event_window_end`, while `deal_move_count` aggregates over `E`. Implemented literally, each needed the
other. The split below is what makes the chain executable, and §4.0.7's table is ordered to match.

**Block A — row-level scalars (before `E`; consume only `outcomes` and the state anchors):**

```sql
-- Row-level predicates (per deal)
open       = (outcome_kind = 'open')                                       -- §4.0.5, mirror-aware
landed     = (outcome_kind IN ('won','lost') AND outcome_date IS NOT NULL
              AND outcome_date BETWEEN :from AND :to)                      -- membership in D_landed
-- THE definition of in_d_cov. Three conjuncts. §4.1 references this and must not restate it:
-- an earlier draft carried a two-conjunct copy here and a three-conjunct one in §4.1, so an
-- implementation either left reopened deals in coverage or failed to resolve the third name.
in_d_cov   = (open AND cov_state <> 'machine' AND NOT is_reopened_after_landing)

-- Signed error, in whole days. Positive = closed LATER than predicted (optimistic). Never ABS (§4.3).
signed_error_p30    = (outcome_date - p30_prediction)
signed_error_pfinal = (outcome_date - pfinal_prediction)

-- Parked-at-write flags. Row-level, so they belong here and not in §4.2 -- `scoreable` consumes them,
-- and §4.0.7 lists them as Block A output. COALESCE keeps them non-null so the `NOT` in `scoreable` is
-- safe (§4.0.6); the AT TIME ZONE and the strict `>` match the platform rule (§6.2).
p30_parked_at_write =
  COALESCE(p30_prediction > (p30_changed_at AT TIME ZONE 'America/Chicago')::date
                            + CLOSE_TARGET_HOLD_HORIZON_DAYS, false)
pfinal_parked_at_write =
  COALESCE(pfinal_prediction > (pfinal_changed_at AT TIME ZONE 'America/Chicago')::date
                               + CLOSE_TARGET_HOLD_HORIZON_DAYS, false)

-- Per-deal event cutoff. Consumed by E's definition, so it MUST be available before E exists.
event_window_end = CASE WHEN open THEN now()
                        ELSE business_day_end_exclusive(
                               COALESCE(outcome_date, terminal_entry_date)) END
```

**Block B — per-deal churn aggregates (after `E`; aggregate over it):**

```sql
-- DISTINCT from the rep-level totals in §4.4/§4.5 -- see the granularity note below.
deal_move_count       = count(*) FILTER (WHERE old_date IS NOT NULL AND new_date IS NOT NULL
                                           AND new_date IS DISTINCT FROM old_date)
deal_days_pushed_out  = COALESCE(sum(greatest(new_date - old_date, 0)), 0)
```

`signed_error_pfinal` and `landed` had **no definition at all** before this section; `signed_error_p30` was
defined only as prose in §2.2. All three were consumed by SQL in §4.2 and §4.7.

**`deal_move_count` / `deal_days_pushed_out` are new names for an old ambiguity.** §4.4 and §4.5 define
`move_count` and `days_pushed_out` as **rep-level** aggregates over all of `E`; §4.6's chronic-mover flag
and §4.7's silent-miss filter need the **per-deal** values. Both were previously written `move_count`, so
one identifier meant two different granularities depending on which section you read — a rep with 40 moves
across 20 deals would have tripped the `>= 3` chronic threshold on every one of them. §4.6 and §4.7 use the
`deal_`-prefixed names.

**The producer/consumer chain.** Every consumed name must be produced by an earlier row or be a real table
column. Re-run this check whenever a name is added:

| Block | Produces | Consumes (and from where) |
|---|---|---|
| `raw_close_date_events` (§4.0.1) | `audit_log_id`, `deal_id`, `changed_at`, `actor_user_id`, `event_kind`, `old_date`, `new_date` | `audit_log`: `id`, `record_id`, `created_at`, `changed_by`, `table_name`, `action`, `changes`, `full_row` — all real columns (§1.2) |
| `close_date_timeline` (§4.0.2) | `audit_log_id`, `deal_id`, `changed_at`, `actor_user_id`, `event_kind`, `old_date`, `new_date` **passed through**, plus `source`, `machine_source` | `raw_close_date_events.*`; `deals.hubspot_deal_id`; `public.hubspot_refresh_log.*` (§0064) |
| `outcomes` (§4.0.5) | `deal_id`, `rep_id`, `deal_created_at`, `outcome_kind`, `outcome_date`, `terminal_entry_date`, **`is_reopened_after_landing`**, `bid_board_owned` | `deals`: `stage_entered_at`, `bid_board_stage_entered_at`, `created_at`, `won_closed_date`, `lost_at`, `assigned_rep_id`, `stage_id`, `bid_board_stage_slug`, `is_active`, `is_test_data`, `is_bid_board_owned`, `is_read_only_mirror`, `on_hold`; `pipeline_stage_config`: `slug`, `is_terminal`; `deal_stage_history`: `deal_id`, `to_stage_id`, `created_at` |
| `state_at` ×3 (§4.0.3) *(contents: **convention-derived** — the block projects `state`, `prediction`, `changed_at`, `source`; the prefixes come from the three aliased instances in §4.0.7's anchor table, so an extractor sees a mismatch that is expected)* | `p30_state`, `p30_prediction`, `p30_changed_at`, `p30_source`; `pfinal_state`, `pfinal_prediction`, `pfinal_changed_at`, `pfinal_source`; `pnow_state`, `pnow_prediction`, `pnow_changed_at`, `pnow_source` — all `*_state` coalesced (§4.0.3) | `close_date_timeline`: `deal_id`, `changed_at`, **`audit_log_id`**, `source`, `new_date`; `outcomes.outcome_date` |
| `coverage_resolution` (§4.1) | `cov_state`, `cov_prediction`, `is_provenance_unknown` | `outcomes.deal_id`; `state_at(deal, now())`; **`deals.expected_close_date`** — the only block that joins `deals` for it, and the whole reason convention 10's exception is buildable |
| Derived scalars **block A** (§4.0.7) | `open`, `landed`, `in_d_cov`, `signed_error_p30`, `signed_error_pfinal`, `p30_parked_at_write`, `pfinal_parked_at_write`, `event_window_end` | `outcome_kind`, `outcome_date`, `terminal_entry_date`, `is_reopened_after_landing`, `deal_created_at`, `cov_state`, `cov_prediction`, `p30_prediction`, `p30_changed_at`, `pfinal_prediction`, `pfinal_changed_at` — deliberately nothing from the event set |
| `E` (§4.0.5) *(contents: **unverifiable** — defined in prose, no literal SQL fence)* | the event set for churn | `close_date_timeline`; `event_window_end` (block A) |
| Derived scalars **block B** (§4.0.7) | `deal_move_count`, `deal_days_pushed_out` | `E`: `old_date`, `new_date` |
| Metrics (§4.1–4.7) *(contents: **unverifiable** — many fences, no single block boundary)* | the report columns, incl. `cov_n`, `scoreable_n`, `scoreable_final_n` | everything above, by name only |

The `audit_log_id` row is bolded because it is the one that broke: §4.0.3 ordered by it while §4.0.2 did not
project it. The table makes that a one-line check instead of a review finding.

**The table's ordering is part of the check, and is verifiable from the table alone.**

> **Completeness rule:** every identifier a block's SQL *references* must appear in that row's *Consumes*
> column (or be produced by the block itself). This is the check the other two miss: the contents rule
> verifies names the table *claims*, and the ordering rule verifies names the table *lists* — a name that
> appears in the SQL and **nowhere in the table** falls through both. `is_reopened_after_landing` came
> through exactly that hole. Extractable by pulling referenced identifiers per fence and diffing against
> the column. **Glob entries defeat it**, which is why `outcomes.*`, `p30_*` and `pfinal_*` were expanded
> to explicit name lists — the fourth time a grouped label has blinded a mechanical check in this document.
>
> **Contents rule:** a row's *Produces* list must match the names its SQL block actually projects —
> `AS <name>` in a `SELECT`, or `<name> =` for a scalar block. This is extractable: pull the projected
> names from each ```sql fence and diff them against the column. Rows whose SQL is **prose-shaped rather
> than literal** cannot be extracted from and are marked **unverifiable** below; treat their contents as
> unchecked, not as checked.
>
> **Ordering rule:** a block may consume only names produced by blocks **strictly above** it. Read top to
> bottom, maintaining the set of names produced so far; every backticked name in a row's *Consumes* column
> must already be in that set, be a real table (`audit_log`, `deals`, `pipeline_stage_config`,
> `hubspot_refresh_log`) or one of its columns, or be a CTE named in an earlier *Block* cell. A row that
> fails is a cycle or a forward reference.

**Audit inventory — which checks in this document derive their inputs from the text, and which are read.**

Every audit here was added to catch a class of defect, and three of them have since certified something
untrue. The difference between the ones that hold and the ones that don't is not care — it is whether the
audit's inputs are *extracted* from the document or *recalled* by whoever last edited it. An audit checked
by the author against their memory of what they just changed will pass whenever the author is wrong in the
same way twice.

**Every mechanical check states what it does NOT cover.** A check that is wrong about its own scope reports
clean and stops anyone looking, which is worse than no check — the constants check did exactly that for a
full round, reporting "hardcoded thresholds: none" while `STANDING_ANCHOR_DAYS`' literal `30` sat in three
lines of P₃₀ date arithmetic it never scanned.

| Audit | What it checks | Inputs derived by | Status · **does NOT cover** |
|---|---|---|---|
| Three-table agreement (§4.0.6 / v1 / §6.0) | every metric appears in each table | **extraction** — backticked identifiers per table, set-differenced | mechanical · misses names not in backticks; says nothing about whether a row's *content* is right |
| §4.0.7 **ordering** rule | no block consumes a name produced below it | **extraction** — walk rows top-down, accumulate produced names | mechanical · misses names absent from the table entirely (that is the completeness rule's job) |
| §4.0.7 **contents** rule | a row's *Produces* matches what its SQL projects | **extraction** — `AS <name>` / `<name> =` per fence, diffed | mechanical · cannot read prose-shaped blocks (`E`, Metrics); flags convention-derived aliases (`state_at`) as expected mismatches |
| §4.0.7 **completeness** rule | every name a block's SQL references appears in its *Consumes* | **extraction** — referenced identifiers per fence, diffed | mechanical · defeated by glob entries; the §4.1 fence mixes a CTE with metrics so its boundary is approximate |
| Duplicate definitions | no scalar is defined twice with different bodies | **extraction** — collect `<name> =` across all fences, compare bodies | mechanical · misses definitions split between prose and SQL, and two names for one concept |
| Window both-ends basis | no range mixes an explicit bound with a bare one | **extraction** — pair comparisons on a shared left operand, classify each bound | mechanical · paired comparisons inside SQL fences only; a single-sided bound whose partner lives elsewhere is invisible |
| Convention restatement (§7) | no rule is half-amended across its copies | **extraction** — signature regex per convention, all hit lines listed | mechanical · a restatement that avoids the signature words is invisible |
| Constants (§6.4) — **inverted** | for each named constant, its literal value appears nowhere except its own definition row | **extraction** — value → literal search across SQL fences **and `code spans` in markdown table cells** | mechanical · ignores plain prose and identifier-embedded digits (`hit_rate_14d`); excludes the appendix, which quotes superseded literals on purpose; two constants sharing a value are reported against both names and a human assigns the right one |
| Rate casts / `NULLS LAST` | every rate casts, every ranked column sorts NULLs last | **extraction** — grep per pattern | mechanical · misses rates written in prose and sorts specified outside a fence |
| §6.0 falsifying inputs | each fairness claim names an input that would break it | **read** — a human must judge whether the input really falsifies | **memory-based** |
| §4.0.7 contents for `E` and Metrics | those two rows' *Produces* lists | not derivable — prose-shaped SQL | **unverifiable** |
| Population **names** (§4.0.5) | every `D_*` used anywhere has a table row, and every declared row is referenced by a fence or a table | **extraction** — name sets differenced across the normative body | mechanical *(added this round)* · checks NAMES only; a row whose set-notation definition drifts from its SQL predicate while the name stays put is invisible |
| Population **definitions** (§4.0.5) | that each `D_*` predicate matches the SQL implementing it | **read** — set notation is not an extractable expression | **memory-based** (residual of the row above) |
| Disjointness of tie-out terms | that summed buckets cannot overlap | **read** — set arithmetic a human must do | **memory-based** |
| Everything against production | census, coverage floor, mirror-terminal counts | not derivable — needs a database | **unverified** |

**The constants check now runs the other direction.** It previously grepped the specific literals it knew
about — 14, 3, 60 — inside *comparisons*, so it could not see a named constant used as a literal in **date
arithmetic** (`outcome_date - 30`). Inverted, it starts from the table: for each constant, assert its value
appears nowhere in SQL but its own row. That direction cannot miss a site. It found the three `30`s on its
first run, and surfaced a limitation worth stating — `STANDING_ANCHOR_DAYS` and `WIDE_TOLERANCE_DAYS` both
equal 30 (as do `MIN_RANKED_SCOREABLE` and `MIN_RANKED_COVERAGE` at 5), so the check reports both candidates
and a human assigns the right one.

Three checks were added in an earlier round, and two of them found defects on their first run that three
mechanical audits had already passed over. The completeness rule exists because a name in the SQL and
**nowhere in the table** falls through both earlier checks: the contents rule verifies names the table
*claims*, the ordering rule verifies names the table *lists*, and `is_reopened_after_landing` was in
neither. The duplicate-definition check was validated by running it against the previous commit, where it
correctly reports `in_d_cov` defined at two lines with different bodies.

Known extractor limits, stated rather than hidden: the §4.1 fence mixes a CTE with metric expressions, so
its block boundary is approximate and two names (`in_d_cov`, `pnow`) read as unlisted consumers; **glob
entries in the table defeat all three checks**, which is why `outcomes.*`, `p30_*`, `pfinal_*` and `flags`
were expanded to explicit lists this round — the fourth time a grouped label has blinded a mechanical check
here.

**Distrust the bottom five rows.** The §6.0 falsifying-input column makes a claim *checkable by a reader*,
which is a real improvement over an unadorned ✅, but nothing verifies that the stated input actually
falsifies the claim — that judgement is still a human one, and it is where a false ✅ could recur. The
population definitions are prose next to SQL with no extraction tying them together. Both are candidates
for the same treatment if this document takes another review round.

**Extraction result at the time of writing:** of the nine rows, six are verified by extraction, one
(`state_at`) is convention-derived and expected to differ, and two (`E`, Metrics) are unverifiable because
their SQL is prose-shaped. The extraction found three genuine overclaims that reading had not:
`coverage_resolution` claimed `cov_n` (an aggregate it cannot project, being per-deal) and Block A claimed
both parked flags (defined in §4.2 at the time). Both are now produced where the table says they are.

This rule is what the table was missing. An earlier version listed one combined "derived scalars" block
that both produced `event_window_end` (consumed by `E`) and consumed `E` (for `deal_move_count`) — a cycle
that no amount of reading the *contents* would reveal, because each individual entry looked correct. The
table certified an ordering that cannot execute. Splitting into blocks A and B breaks the cycle, and the
ordering rule makes the next one visible without needing to hold the whole chain in your head: a
producer/consumer table whose row order is not itself checked is a list, not a dependency check.

### 4.1 Coverage rate

**Plain English:** of the rep's open deals, what share carry a rep-authored close date that is usable —
in the future, but not parked so far out that it forecasts nothing.

Coverage reads `pnow_state` from §4.0.3, **resolved for provenance first — in its own CTE**:

```sql
-- coverage_resolution: THE bounded exception to convention 10, and the ONLY block that joins deals for
-- the raw forecast column. It exists as a named CTE precisely so the exception has somewhere to live:
-- the base `outcomes` CTE (§4.0.5) deliberately does NOT project expected_close_date, so without this
-- join the raw date is simply not in scope where the permission applies, and an implementer would be
-- forced into exactly the ad-hoc raw read convention 10 forbids.
--
-- §4.0.6 promises that an open deal carrying a date whose event predates the audit window is bucketed as
-- rep-authored, so an audit-window gap cannot quietly shrink a rep's denominator. This CTE is the SQL
-- that keeps that promise; without it every 'no_event' row fell into at_risk_n and the promise was prose.
coverage_resolution AS (
  SELECT o.deal_id,
         -- COALESCE FIRST. The LEFT JOIN LATERAL yields NULL when no event exists -- which is exactly the
         -- audit-window case this CTE is here to rescue. Testing pnow.state directly makes BOTH CASE arms
         -- NULL, so cov_state / cov_prediction / is_provenance_unknown all go NULL, in_d_cov goes NULL,
         -- and the deal falls out of EVERY coverage bucket -- reinstating the defect this CTE fixes.
         -- This is §4.0.3's coalescing rule, which the CTE must inherit rather than re-derive.
         CASE WHEN pnow_state = 'no_event' AND d.expected_close_date IS NOT NULL
              THEN 'rep_prediction' ELSE pnow_state END            AS cov_state,
         CASE WHEN pnow_state = 'no_event' AND d.expected_close_date IS NOT NULL
              THEN d.expected_close_date ELSE pnow.prediction END  AS cov_prediction,
         (pnow_state = 'no_event' AND d.expected_close_date IS NOT NULL) AS is_provenance_unknown
  FROM outcomes o
  JOIN deals d ON d.id = o.deal_id            -- the ONLY join to deals for expected_close_date
  LEFT JOIN LATERAL <state_at(o.deal_id, now())> pnow ON TRUE
  CROSS JOIN LATERAL (SELECT COALESCE(pnow.state, 'no_event') AS pnow_state) c
)
-- Downstream reads cov_state / cov_prediction / is_provenance_unknown by name. Nothing else touches
-- d.expected_close_date. `pnow_state` elsewhere in this section means `coverage_resolution.cov_state`'s
-- input, exposed here only for the diagnostic below.

provenance_unknown_n = count(*) FILTER (WHERE open AND is_provenance_unknown)

-- The three exclusions from D_cov, made DISJOINT BY CONSTRUCTION via a priority order. A deal that was
-- reopened after landing AND later given a machine close-date write satisfies both predicates; without
-- the NOT below it would be counted in both terms and the tie-out would double-count the very deal the
-- reopened bucket was added to stop double-counting.
reopened_after_landing_n = count(*) FILTER (WHERE is_reopened_after_landing)            -- all slices
reopened_open_n          = count(*) FILTER (WHERE open AND is_reopened_after_landing)   -- tie-out term

-- machine_dated_n leaves the rate on BOTH sides: charging it as at-risk blames the rep for a machine
-- write, counting it as covered credits them for one. Reopened takes precedence, so this is the
-- machine-dated portion of D_open \ D_reopened.
machine_dated_n = count(*) FILTER (WHERE open AND NOT is_reopened_after_landing
                                             AND cov_state = 'machine')

-- The coverage denominator, as a named metric: it is the §6.4 volume floor for coverage_rate and
-- forecast_reliability, so it must exist as a column rather than only as an inline NULLIF operand.
-- Aggregate, therefore produced HERE (Metrics) -- not by coverage_resolution, which is per-deal.
cov_n = count(*) FILTER (WHERE in_d_cov)

-- The remaining three partition D_cov (= D_open minus machine-dated).
covered_n  = count(*) FILTER (WHERE in_d_cov AND cov_state = 'rep_prediction'
                                             AND cov_prediction >= <business today>
                                             AND cov_prediction <= <business today> + CLOSE_TARGET_HOLD_HORIZON_DAYS)
parked_n   = count(*) FILTER (WHERE in_d_cov AND cov_state = 'rep_prediction'
                                             AND cov_prediction >  <business today> + CLOSE_TARGET_HOLD_HORIZON_DAYS)
at_risk_n  = count(*) FILTER (WHERE in_d_cov AND (cov_state IN ('cleared','no_event')
                                              OR (cov_state = 'rep_prediction'
                                                  AND cov_prediction < <business today>)))

coverage_rate = count(*) FILTER (WHERE in_d_cov AND cov_state = 'rep_prediction'
                                                AND cov_prediction >= <business today>
                                                AND cov_prediction <= <business today> + CLOSE_TARGET_HOLD_HORIZON_DAYS)::numeric
              / NULLIF(count(*) FILTER (WHERE in_d_cov), 0)
```

`open` is `outcome_kind = 'open'` (§4.0.5) — the mirror-aware test. **`in_d_cov` is defined once, in
§4.0.7 Block A**, with three conjuncts: open, not machine-dated, and not reopened-after-landing. It is not
restated here — an earlier draft carried a two-conjunct copy in Block A and a three-conjunct one in this
section, so an implementation either left reopened deals in ordinary coverage (following Block A) or failed
to resolve `is_reopened_after_landing` (following §4.1). After
resolution, `cov_state = 'no_event'` means the deal genuinely has no date at all, which is the at-risk
reading intended all along.

**The scoring anchors deliberately do NOT apply this resolution, and the asymmetry is intentional.** For
coverage the question is "does a usable date stand right now", and a bare column value answers it even
without an event behind it. For P₃₀ or P_final the question is "what did the rep believe at a past
instant", which a current column value cannot answer — the date on the row today says nothing about what it
was thirty days before close. So a landed deal with no recorded event stays `no_prediction_n` (§4.2) rather
than being credited with its present value. Folding it in would invent history.

Every branch tests `cov_state` positively and the buckets cover all four enum values, so no deal can fall
through unbucketed. That is invariant 1 in §4.0.6.

90 days is `CLOSE_TARGET_HOLD_HORIZON_DAYS` (`shared/src/types/deal-hold-risk.ts:137`), imported, never
hardcoded, so this report and the effective-value chains agree on what "parked" means.

`parked_n` is a **first-class column**, not a footnote — it is the only visible trace of the single most
effective way to game this metric (§6.2).

**Reconciliation with the At-Risk watchlist — an identity with two correction terms, not an equality.**

```
at_risk_n
  + (machine-dated open deals that are undated or past-due)     -- provenance: this report excludes, watchlist doesn't
  + (mirror-terminal deals with an open CRM stage that are undated OR past-due)  -- see below
  = At-Risk watchlist count (no_date + stale_dated) for the same rep
```

The second term is a genuine divergence and worth raising as a finding **about the existing watchlist**,
not as a caveat here. `at-risk-service.ts:71` filters `psc.is_terminal = false` and never inspects
`bid_board_stage_slug` (verified: zero occurrences in that file). So a Bid-Board-owned deal that is won or
lost in the mirror while its CRM stage is still open is **counted by the watchlist as an open deal with a
rotting forecast** — and it is counted under *either* watchlist reason, `no_date` **or** `stale_dated`,
since `futureDatedCloseDatePredicateSql` is negated over the raw column with no terminal awareness. The
correction term therefore covers both; an earlier draft named only the no-date case and would have left the
identity failing by exactly the mirror-terminal deals that still carry an old close date, when the codebase's own terminal-aware value logic
(`aliasedTerminalDealBySlugSql`, `deal-value-sql.ts:389-393`) treats it as realized. Whether that is
intentional in the watchlist is **unverified** — it may be deliberate, given the Bid Board dual-record
model. Raise it separately; do not silently adopt either behaviour to make a tie-out pass.

If the §1.1.1 census returns zero HubSpot writes and the office has no mirror-terminal-open deals, both
correction terms vanish and the identity collapses to plain equality. Write it as a test with the
correction terms explicit.

### 4.2 Hit rate within tolerance

**Plain English:** of the deals that landed in the period **and carried a real rep-authored prediction
beforehand**, what share landed within ±14 days of it.

```sql
-- D_score. All four state values are tested positively; none is a negated nullable (§4.0.6).
scoreable = landed
        AND p30_state = 'rep_prediction'
        AND NOT p30_parked_at_write            -- p30_parked_at_write is a non-null boolean, see below

hit_rate_14d = count(*) FILTER (WHERE scoreable AND abs(signed_error_p30) <= TOLERANCE_DAYS)::numeric
             / NULLIF(count(*) FILTER (WHERE scoreable), 0)
```

`p30_parked_at_write` is defined in §4.0.7 Block A, not here — it is a row-level scalar and §4.0.7's chain
table lists it as Block A output, so defining it in §4.2 would make that table wrong. Three things are
load-bearing in it. The `COALESCE` makes it a non-null boolean so the `NOT` in
`scoreable` is safe — as a bare comparison it would be NULL whenever there is no P₃₀ row, taking the whole
conjunct NULL rather than false (§4.0.6). The **explicit `AT TIME ZONE`** is required because
`p30_changed_at` is a `timestamptz` and a bare `::date` cast resolves in the *session* timezone, not the
business timezone — an event written late on a Chicago evening would land on the following date under a UTC
session and shift the horizon by a day. And the comparison is strict `>`, matching
`closeTargetFarOutSqlPredicate` (`shared/src/types/deal-reporting.ts:137`), so a prediction written exactly
90 days out is *not* parked in either world.

**The shortfall partition.** `D_landed \ D_score` splits by `p30_state`, and the four buckets are
exhaustive over the enum:

```sql
no_prediction_n       = count(*) FILTER (WHERE landed AND p30_state = 'no_event')
cleared_n             = count(*) FILTER (WHERE landed AND p30_state = 'cleared')
machine_superseded_n  = count(*) FILTER (WHERE landed AND p30_state = 'machine')
parked_prediction_n   = count(*) FILTER (WHERE landed AND p30_state = 'rep_prediction'
                                                      AND p30_parked_at_write)
-- invariant 2: scoreable_n + the four above = landed_n
```

The earlier draft wrote `no_prediction_n` as `count(*) FILTER (WHERE landed AND NOT p30.had_event)` over a
nullable boolean. When the lateral produced no row that expression was NULL, `FILTER` counted nothing, and
landed deals with no prediction incremented **no** bucket at all — silently breaking the very invariant
meant to catch silent drops. Positive equality against the coalesced enum is the structural fix, and
`machine_superseded_n` is a bucket that could not have existed under the old delete-the-row model at all:
those deals used to be scored against a resurrected older forecast (§4.0.0).

Report `landed_n` and `scoreable_n` as separate columns. A rep whose `scoreable_n` is far below their
`landed_n` is closing deals they never forecast — a real finding a single blended percentage would hide,
and the four shortfall columns say which kind.

**`hit_rate_14d_final` has its own denominator.**

```sql
-- Defined exactly like its P30 twin -- same COALESCE (so the NOT is safe, convention 12), same explicit
-- timezone, same strict `>`, same imported constant. An earlier draft used this identifier in `scoreable_final`
-- without ever defining it, leaving the reader to assume the guarantees carried over.
pfinal_parked_at_write =
  COALESCE(
    pfinal_prediction > (pfinal_changed_at AT TIME ZONE 'America/Chicago')::date
                        + CLOSE_TARGET_HOLD_HORIZON_DAYS,
    false)

scoreable_final = landed
              AND pfinal_state = 'rep_prediction'
              AND NOT pfinal_parked_at_write

hit_rate_14d_final = count(*) FILTER (WHERE scoreable_final
                                          AND abs(signed_error_pfinal) <= TOLERANCE_DAYS)::numeric
                   / NULLIF(count(*) FILTER (WHERE scoreable_final), 0)
```

It must **not** reuse `D_score`. That population requires a usable P₃₀, which excludes exactly the case
§6.3 says the final rate exists to reveal: a rep with no month-ahead forecast who set a correct date in the
final week would be dropped rather than shown as strong-final / weak-P₃₀. `D_score_final` is its own row in
§4.0.6 for that reason. `hit_rate_30d` uses `D_score` with `<= WIDE_TOLERANCE_DAYS` (the same P₃₀
measurement at a wider tolerance), so only the `_final` variant needs the separate population.

**Every threshold in these formulas is a named constant from the §6.4 table, never a literal.** The column
*names* keep their numbers — `hit_rate_14d` reads better than `hit_rate_tolerance` — but the *comparisons*
must reference the constants. An implementation copied from a snippet with `14` hardcoded keeps scoring
with a stale number after leadership re-tunes the tolerance (open question 1 invites exactly that), and the
constants table becomes decoration. If a re-tune makes a column name misleading, rename the column in the
same change.

### 4.3 Mean and median signed error

**Plain English:** on average, how many days late (positive) or early (negative) does this rep's forecast
turn out to be. Both statistics, because the mean is where the long optimistic tail shows up and the median
is the number you can defend to a rep.

```sql
mean_signed_error_days   = avg(signed_error_p30)                                         FILTER (WHERE scoreable)
median_signed_error_days = percentile_cont(0.5) WITHIN GROUP (ORDER BY signed_error_p30) FILTER (WHERE scoreable)
p90_signed_error_days    = percentile_cont(0.9) WITHIN GROUP (ORDER BY signed_error_p30) FILTER (WHERE scoreable)
```

**These are the one ordering in the document that deliberately needs no tie-breaker** (§4.0.6's total-order
rule). `percentile_cont` interpolates over the multiset of values and there is no `LIMIT`, so two rows with
an equal `signed_error_p30` produce an identical result in either order — the ordering selects a position
in a distribution, not a winning row. The rule exists for "pick the latest/earliest record" lookups, where
a tie decides *which row's data you read*; that is not what is happening here.

`scoreable`, not `landed` — same reason as §4.2. A landed deal with no standing prediction has a NULL
error; `avg` would skip it silently, but `count`-based columns beside it would not, and the row would stop
being internally consistent.

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
behaviour that deserves its own column — see §5.5 and §6.5.

Report a rate so a rep with a big book is not penalised for volume:

```sql
moves_per_deal = move_count::numeric / NULLIF(count(DISTINCT deal_id in D_book), 0)
```

**The denominator is `|D_book|` — every in-scope deal, landed and open alike.** `move_count` is summed over
`E`, which is defined over `D_book` (§4.0.5's populations table), so this is the only denominator that
describes the same set.

This is the second time this metric has been wrong, in two different ways, which is why the audit table now
exists. The first draft divided by `landed_n`. The fix changed it to `landed_n + overdue_open_n` — still
wrong, because `E` also contains events on live-open, parked and undated deals, so those moves counted in
the numerator while their deals were absent from the denominator. Worse, a rep all of whose moved deals are
still live would divide by zero and render NULL, which reads as "no churn" — the exact opposite of the
truth. Matching `E`'s own population is the fix that closes the class of error, not just this instance.

`::numeric` on the numerator (§4.0.6).

### 4.5 Total days slipped

**Plain English:** adding up every time a close date got pushed, how many days of slippage did this rep's
book accumulate.

```sql
-- COALESCE is required: sum() over an empty set returns NULL, not 0, so a rep who moved nothing would
-- render blank rather than zero -- and any arithmetic downstream would go NULL with it (§4.0.6).
total_days_slipped = COALESCE(sum(e.new_date - e.old_date)
                       FILTER (WHERE e.old_date IS NOT NULL AND e.new_date IS NOT NULL), 0)
days_pushed_out    = COALESCE(sum(greatest(e.new_date - e.old_date, 0)) FILTER (…), 0)
days_pulled_in     = COALESCE(sum(least(e.new_date - e.old_date, 0))    FILTER (…), 0)
```

Signed total plus the two one-sided sums, so a rep who pushes 200 days and pulls 190 back is not shown as
"+10, basically fine".

### 4.6 Chronic mover

**Plain English:** a deal whose close date keeps moving, and a rep who has a lot of them.

- **Deal-level flag**, computed per deal over that deal's events in `E`:

  ```sql
  chronic_mover = deal_move_count      >= CHRONIC_MIN_MOVES
              AND deal_days_pushed_out >= CHRONIC_MIN_PUSHED_DAYS   -- per-deal names, §4.0.7
  ```

  Both conditions, because three ±2-day adjustments is diligence and one 200-day push is a single
  decision; the pattern worth naming is repeated, substantial, one-directional pushing.

  NULL-safety lives in the §4.0.7 definitions, not here: `deal_days_pushed_out` is `COALESCE(...,0)` at
  source and `deal_move_count` is a `count(*)`, which returns 0 rather than NULL. That matters because a
  per-deal aggregate reached through a `LEFT JOIN` **is** NULL for a deal with no events, and `NULL >= 60`
  inside a `FILTER` counts nothing rather than reading as false (§4.0.6). Defining the guard once at the
  producer is what stops every consumer having to remember it — the same reasoning as the coalesced state
  enum in §4.0.3.
- **Rep-level:**

  ```sql
  chronic_mover_rate = count(*) FILTER (WHERE chronic_mover)::numeric
                     / NULLIF(count(*), 0)          -- both over D_book
  ```

Same denominator as `moves_per_deal` (§4.4) — `|D_book|` — because the flag is evaluated over every
in-scope deal, open ones included. A deal does not need to have closed to have been moved five times. Both
rate metrics now describe the same book, so a reader can compare them.

`::numeric` on the numerator (§4.0.6).

`CHRONIC_MIN_MOVES = 3` and `CHRONIC_MIN_PUSHED_DAYS = 60` — both proposals, both in the §6.4 constants
table so they can be re-tuned in one place once the first real distribution is visible.

### 4.7 Silent misses

**Plain English:** deals whose date was set once and never touched, and which then missed badly.

```sql
silent_miss_n = count(*) FILTER (WHERE scoreable
                                   AND deal_move_count = 0        -- per-deal, §4.0.7 (already COALESCEd)
                                   AND abs(signed_error_p30) > TOLERANCE_DAYS)
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
`initial_estimate_wrong`, `other`) plus optional free text.

The natural home is the existing `deal_history` table — it already has `field_name`, `old_value`,
`new_value`, `changed_by`, `changed_at`, `source` and `reason` (`0067` + `0115`), an index on
`(deal_id, changed_at DESC)`, and a live writer seam next to the existing `project_type` writer at
`server/src/modules/deals/service.ts:898`.

**An earlier draft claimed this needs no migration. That was wrong.**
`migrations/0067_project_type_and_intended_number.sql:85` declares
`changed_by uuid NOT NULL REFERENCES public.users(id)`. Every non-UI writer of the close date — the HubSpot
refresh, the spreadsheet re-import without `--attribute`, anything running without
`app.current_user_id` — has no user id to supply. Wiring reason capture into `deal_history` as it stands
would either throw on those paths or force them to be skipped, which loses coverage for exactly the writes
the DB trigger does catch, and would make `deal_history` and `audit_log` disagree about the same field.

Two honest options, pick one and say which:

1. **Make `changed_by` nullable or system-capable** — `ALTER TABLE ... ALTER COLUMN changed_by DROP NOT NULL`
   per tenant, plus a `TENANT_SCHEMA_START/END` replay block so new offices get it. **This is a migration.**
   It is the same move `migrations/0207_stage_history_actor_no_rep_fallback.sql` already made for
   `deal_stage_history.changed_by`, and for the same reason, so there is precedent and a template. Preferred.
2. **Scope the reason writer to user-initiated edits only** — no migration, but then `deal_history` covers
   only the UI paths and is silent for machine writes. Acceptable *only* if the report treats a missing
   reason on a machine-written event as expected rather than as a rep who declined to explain.

Making the reason mandatory on the deal edit form as well as the dialog is a product decision, not a
technical one.

### 5.2 No snapshot of the forecast at stage entry

**Gap.** `deal_stage_history` has no `expected_close_date` (§1.6), and `deal_forecast_milestones` — which
was built exactly for this — has had no runtime writer since 2026-04-23 (§1.5). "What did this rep think
when the deal entered Estimating" is answerable only by replaying `audit_log`, and only as far back as
audit coverage actually goes (§1.4).

**To close it:** either restore the two deleted `deal_forecast_milestones` capture calls (the service
already exists and is tested), or add `expected_close_date` to `deal_stage_history`'s insert. The first is
less new surface area and would also un-freeze the existing forecast-variance report.

### 5.3 Machine-written close dates, and the actor gap

**This is the most serious gap in the report, and the one an earlier draft got wrong.** It is stated in
full at §1.1.1 / §1.1.2; summarised here because it belongs on the gaps list.

**Gap.** `scripts/refresh-from-hubspot.ts` overwrites `expected_close_date` from HubSpot. Its DB-trigger
row is shape-identical to a rep's own edit and carries a NULL actor, because `changed_by` comes from
`current_setting('app.current_user_id')` — set per API request at `server/src/middleware/tenant.ts:101`,
never set by that script (nor by `bid-board-sync/service.ts`, `procore/synchub-routes.ts`, or
`worker/src/jobs/procore-sync.ts`, though none of those write this column).

**Closeable today, and the design does close it.** `public.hubspot_refresh_log` (migration 0064) is a
durable per-field ledger of exactly these writes, so §4.0.2 marks them `source = 'machine'` — they stay in
the timeline and supersede the rep's forecast without becoming one. What remains:

- **Unverified: whether the refresh has ever run with `DRY_RUN=false` in production, and on how many
  deals.** The query is in §1.1.1. Run it before v1 ships. If it returns rows, also spot-check that the
  classifier's ±1-minute window actually matches them.
- **Unverified: whether the reported 2026-07-30 "service deleted, damage reversed from `audit_log`" event
  touched close dates.** I found no such deletion and no reversal script in this repository. If a reversal
  ran, it was a write, and unless it also logged to `hubspot_refresh_log` the classifier will read it as a
  rep edit.
- **`scripts/migration-promote.ts` seeds — narrowly identifiable, not perfectly.** It seeds
  `expected_close_date` in the deal INSERT (`:372, :462`) with no dedicated ledger, and its `source` value
  is `lead.mappedSourceStage ?? "HubSpot"` — not a distinctive marker like the reimport's
  `hubspot_deals_reimport_2026_05_14`, so `source` cannot carry the test. The usable discriminator is the
  **actor**: that script never calls `set_config('app.current_user_id', ...)` (verified), so its INSERT
  audit row has `changed_by = NULL`, whereas every API deal-create runs through
  `server/src/middleware/tenant.ts:101` and always has a real actor. §4.0.2 arm (b) therefore treats
  *insert-seeded + NULL actor + `hubspot_deal_id` present* as a machine seed and everything else as a rep
  forecast.

  An earlier draft used "insert-only prediction" as the proxy and excluded all of them. That was too broad:
  a rep who sets the close date when creating a deal and never moves it is using a genuine forecast path
  (§1.1), and those deals are precisely the clean first-call predictions and the silent misses (§4.7) most
  worth measuring. The narrowed test keeps them.

  **Residual risk, unverified:** a migration-promoted deal could in principle be re-created through the API
  later, or a rep could create a deal while the actor is somehow unset. Neither is reachable from the code
  I read, but I could not rule them out without production data. The `provenance_unknown_n` diagnostic
  (§4.0.3's `no_event` state, surfaced as `provenance_unknown_n`) is where any such surprise would show
  up.

**Guidance for the evidence column:** surface NULL actors as "Unattributed" rather than dropping the
event — a NULL actor is a fact about the write, not a reason to hide it. But never infer "machine" from a
NULL actor alone, and never infer "rep" from a non-NULL one. The machine tests in §4.0.2 are conjunctions
for exactly this reason.

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
2028, scores better than a rep who predicts and misses.** Five defences, in order of importance.

### 6.0 Every protective claim, and the construct that enforces it

A fairness guarantee with nothing implementing it is worse than no guarantee, because it stops the reader
looking for the mechanism. Every protective claim in §6 is listed here with the exact construct that makes
it true. **A claim with no construct is not a claim — it is either implemented or deleted.**

| # | Claim | Enforced by | Falsifying input — what would break it | Status |
|---|---|---|---|---|
| 6.1a | A rep who forecasts nothing scores 0% coverage, not a blank | `coverage_rate` numerator requires `cov_state='rep_prediction'`; denominator is all of `D_cov`. Undated open deals land in `at_risk_n`, denominator-only → `0/N = 0` | An undated open deal excluded from `D_cov`, shrinking the denominator to 0 | ✅ |
| 6.1b | A rep with **no open deals at all** does not outrank one who forecasts badly | `\|D_cov\| = 0` → `NULLIF` → NULL; `NULLS LAST` **and** exclusion from the ranked set (§6.6) | A `DESC` sort without `NULLS LAST` anywhere in the stack | ✅ |
| 6.1c | A hit rate computed over fewer than `MIN_RANKED_SCOREABLE` deals never ranks, on any sort | §6.4 gates each rate on its own denominator; the default sort leads with `coverage_rate` | A user-initiated sort on a rate column that bypasses the floor | ✅ *(claim narrowed — see below)* |
| 6.1d | "Forecast reliability" is zero when coverage is zero | `COALESCE(coverage_rate,0) * COALESCE(hit_rate_14d,0)` — the bare product does **not** hold this | Either operand left un-coalesced (`0 * NULL = NULL`) | ✅ |
| 6.2a | Parking the book cannot buy coverage | `parked_n` branch removes `cov_prediction > today + CLOSE_TARGET_HOLD_HORIZON_DAYS` from the numerator while leaving it in the denominator | Parked deals dropped from `D_cov` entirely, which would *raise* the rate | ✅ |
| 6.2b | Parking cannot buy a hit rate | `p30_parked_at_write` conjunct in `scoreable` (§4.2) | `p30_parked_at_write` left un-coalesced, taking `scoreable` NULL instead of false | ✅ |
| 6.2c | Parked deals still count as churn | `E` filters on `source` and `event_window_end` only — no parked predicate | Adding a parked filter to `E` "for consistency" with §4.2 | ✅ |
| 6.3a | Last-minute re-dating is visible, not hidden | P₃₀ anchored 30 days out (§4.0.3); `D_score` requires a P₃₀; the deal lands in `no_prediction_n` and depresses `scoreable_n` vs `landed_n` | Dropping the shortfall columns, leaving only a hit rate over a shrunken denominator | ✅ |
| 6.3b | …and still shows a strong final call rather than vanishing | `D_score_final` is a separate population (§4.2) | Computing `hit_rate_14d_final` over `D_score` | ✅ |
| 6.3c | A short-lived deal's fallback cannot be gamed by a late re-date | Fallback selects the **earliest** state, `ORDER BY audit_log_id ASC`, capped below the outcome boundary (§4.0.4) | Reverting to the latest state, or removing the outcome cap so a post-close edit becomes P₃₀ | ✅ |
| 6.4 | **No rate ranks on fewer than `MIN_RANKED_SCOREABLE` underlying deals** | Every ranked rate gates on its own denominator count: `scoreable_n`, `scoreable_final_n`, `cov_n`; a **composite** gates on *all* its operands' denominators (§6.4) | A rate whose floor keys on a different population than its denominator — or a composite gated on neither operand | ✅ *(was ✗ — see below)* |
| 6.5a | Clearing a date does not erase prior churn | `E` is not truncated at a clear; `clear_count` is its own counter | Capping `event_window_end` at the clear instead of the outcome | ✅ |
| 6.5b | A cleared date does not keep counting as standing | `state_at` returns `'cleared'` from the latest event's NULL `new_date` (§4.0.3) | Adding `AND new_date IS NOT NULL` inside the `state_at` lateral | ✅ |
| 6.5c | Coverage treats a cleared deal as uncovered | `cov_state IN ('cleared','no_event')` → `at_risk_n` (§4.1) | `coverage_resolution` testing `pnow.state` un-coalesced, taking every branch NULL | ✅ *(was ✗ for the `no_event` arm)* |

**Every ✅ above was re-derived from the current SQL rather than from the intent that produced the row**, by
naming a falsifying input and checking whether the text admits it. Eleven of thirteen survived unchanged.
Two did not:

- **6.4 was a false ✅.** It claimed tiny denominators do not rank while `coverage_rate` was rankable at
  `|D_cov| = 1`, and `forecast_reliability` could rank a rep with a single scoreable hit because its
  `hit_rate_14d` operand was *coalesced* but never *volume-gated*. Coalescing turns NULL into 0; it does
  nothing about a rate computed over one deal. Fixed below.
- **6.1c was unfalsifiable as worded.** "Hit rate never carries the ranking on its own" describes the
  default sort, but any user-initiated sort makes some column carry the ranking — so the row could be read
  as true or false at will. Narrowed to a claim with a construct: *no rate ranks on fewer than
  `MIN_RANKED_SCOREABLE` underlying deals, on any sort.*

A row marked ✅ against a construct that does not deliver it is worse than a missing row: §6.0 exists so an
unenforced claim is visible, and a false ✅ is a false negative **in the check built to prevent false
negatives**. It stops the next reader looking, which is precisely the harm the table was created to remove.
The falsifying-input column is the structural answer — a row is now checkable against the text by anyone,
rather than resting on the author remembering what they meant.

Three rows were **prose-only** until an earlier pass — 6.1b, 6.1d and 6.4 — and 6.1d was actively false as
written. The claims that had no mechanism were indistinguishable, on the page, from the ones that did.

### 6.1 Not forecasting is the worst score, not a blank

Coverage rate (§4.1) is a **first-class column**, shown next to accuracy, always. A rep with zero
predictions shows `coverage 0%`, `hit rate —`, `at_risk_n`. The hit rate renders as an em dash and is
**excluded from sorting** — a null must never float to the top of a descending sort and read as a clean
sheet. The scorecard's default sort is on coverage, then hit rate, so "doesn't forecast" sinks.

Coverage is only safe as the primary sort key because §4.1 now **excludes parked dates from the numerator**.
Sorting first on a coverage number that counted any future date would have promoted the exact behaviour
§6.2 forbids. If the two ever drift apart again, the sort key is the thing that turns the bug into an
injustice.

If leadership wants one number, define it as **`COALESCE(coverage_rate, 0) * COALESCE(hit_rate_14d, 0)`**
and label it "Forecast reliability". Do not let anyone rank on hit rate alone.

The `COALESCE`s are not defensive noise — the bare product `coverage_rate * hit_rate_14d` **does not hold
the guarantee this metric exists for**. A rep who forecasts nothing has `coverage_rate = 0` and, having no
scoreable deals, `hit_rate_14d = NULL`; in SQL `0 * NULL` is `NULL`, not `0`. The composite would go blank
for precisely the rep it is meant to score zero, and then sort to the top under a default `DESC`
(§6.6). "Zero coverage yields zero" was true only once both operands are coalesced.

### 6.2 Far-future dating is already penalised, and this report should not undo it

The platform has an existing lever: `CLOSE_TARGET_HOLD_HORIZON_DAYS = 90`
(`shared/src/types/deal-hold-risk.ts:137`). An open, non-terminal deal whose close target is more than 90
CT-days out is **effectively on hold** (`aliasedEffectiveOnHoldConditionSql`,
`server/src/modules/shared/deal-value-sql.ts:430`), which **zeroes its value** in every effective-value
chain. So parking a deal in 2028 already removes its dollars from the rep's forecast.

Precision matters here: the far-out rule zeroes **value**; it does **not** remove the row from
`reportableDealSqlPredicate` (`shared/src/types/deal-reporting.ts:28`), which tests the stored `on_hold`
flag only. The deal is still on the board with a $0 value.

This report applies the horizon in **two** places, and both are required:

1. **Coverage (§4.1).** An open deal whose standing date is more than 90 days out is `parked_n`, not
   `covered_n`. Anchor: **business today**, matching `closeTargetFarOutSqlPredicate`
   (`shared/src/types/deal-reporting.ts:125-139`), which emits
   `(horizon) > CT_TODAY_SQL + INTERVAL '90 days'`. Same anchor, same strict `>`, so a deal exactly 90 days
   out is *not* parked in either world.
2. **Scoring.** A prediction is **parked-at-write** when it was more than 90 days beyond **the date it was
   written** — `new_date > (changed_at AT TIME ZONE 'America/Chicago')::date + CLOSE_TARGET_HOLD_HORIZON_DAYS`, the explicit-timezone
   form required by §4.0.6. Such a prediction is excluded from `scoreable` (§4.2)
   and from every error statistic, while still counted in `move_count`, `days_pushed_out` and the
   chronic-mover flag. Without this the winning strategy is "push everything to 2028, then set an accurate
   date the week it closes" — a perfect hit rate on a forecast nobody could plan with.

**The anchor for (2) is the write date, not `stage_entered_at`.** An earlier draft used `stage_entered_at`,
which is wrong in both directions. A deal that had sat in one stage for six months would have *every* new
prediction judged against a stale anchor: a forecast written on 1 Aug for 15 Aug — two weeks out, as
maintained as a forecast can be — would measure as 200+ days past a January stage entry and be discarded as
parked. Conversely a freshly re-entered stage would let a genuinely far-out date pass. The platform's own
rule compares the horizon to *now* (`deal-hold-risk.ts:233-237`, `deal-reporting.ts:137`); the faithful
historical translation of "is this more than 90 days out" is "was it more than 90 days out **when it was
written**", which is `changed_at`.

One deliberate divergence from the platform predicate, worth stating so nobody reads it as a bug: the
platform's `holdHorizonDateSql` uses `bid_due_date` instead of `expected_close_date` while a deal sits in
the genuine `estimating` stage (`deal-reporting.ts:110-113`). This report always uses
`expected_close_date`, because it is measuring the *close-date* forecast specifically. So a deal in
estimating can be "parked" here while the platform's value chain is looking at its bid date. That is
correct for this metric and wrong to copy anywhere else.

`parked_n` and `parked_prediction_n` are both columns on the rep row. Neither is a footnote: they are the
only visible trace of the single most effective way to game this metric.

### 6.3 Late re-dating is caught by the P₃₀ headline

§2.1. The headline error is measured against the standing prediction 30 days out, not the final call. A rep
who only gets it right in the last week shows a good `hit_rate_14d_final` and a bad `hit_rate_14d`, and both
are on the row.

### 6.4 Small denominators do not rank

A rep with two scored deals and two hits is not the best forecaster in the company. Require a minimum
denominator — proposed **5 deals in `D_score`** — to appear in the ranking. Below it, show the row with the
real numbers and an "insufficient volume" marker, excluded from sort order. This is the same discipline
`at-risk-service.ts` applies by making every row its own evidence.

**Each ranked rate is gated on its own denominator count — and a composite is gated on all of them.**

| Ranked column | Floor |
|---|---|
| `hit_rate_14d`, `hit_rate_30d` | `scoreable_n >= MIN_RANKED_SCOREABLE` |
| `hit_rate_14d_final` | `scoreable_final_n >= MIN_RANKED_SCOREABLE` |
| `coverage_rate` | `cov_n >= MIN_RANKED_COVERAGE` where `cov_n = \|D_cov\|` |
| `forecast_reliability` | **both** `cov_n >= MIN_RANKED_COVERAGE` **and** `scoreable_n >= MIN_RANKED_SCOREABLE` |
| `moves_per_deal`, `chronic_mover_rate` | `\|D_book\| >= MIN_RANKED_SCOREABLE` |
| signed-error columns | `scoreable_n >= MIN_RANKED_SCOREABLE` |

`coverage_rate` previously had only a `> 0` guard, which is not a floor — a rep with one open dated deal
scored 100% and ranked first. And `forecast_reliability` inherited *neither* operand's floor: coalescing
its operands (§6.1) fixes the `0 * NULL = NULL` hole but does nothing about sample size, so a rep with one
covered deal and one scoreable hit scored 1.0. **A composite must clear every floor its inputs clear**, or
it becomes the unguarded back door to the ranking.
Round 7 gave the final hit rate its own population (`D_score_final`) without giving it its own floor, so a
rep with a single scoreable-final deal who hit it could rank first on a one-deal sample — §6.4's exact
failure, reintroduced by the very fix that made the metric correct. A floor that keys on a *different*
population than the rate it guards is not a floor.

**Every tunable in this document, with a value.** A named constant with no assigned value is the same
failure as a claim with no construct: it reads as enforced and isn't, and an implementer must invent a
number — for `MIN_RANKED_COVERAGE` they could reasonably pick 1 and recreate the one-open-deal ranking bug
§6.4 exists to close.

| Constant | Value | Used by | Source |
|---|---|---|---|
| `MIN_RANKED_SCOREABLE` | **5** | hit-rate, signed-error and churn ranking floors (§6.4) | proposed here; open question 5 |
| `MIN_RANKED_COVERAGE` | **5** — deliberately the same number | `coverage_rate` and `forecast_reliability` floors (§6.4) | proposed here |
| `CLOSE_TARGET_HOLD_HORIZON_DAYS` | **90** | parked tests (§4.1, §4.2, §6.2) | **imported** from `shared/src/types/deal-hold-risk.ts:137` — never redefine |
| `TOLERANCE_DAYS` | **14** | `hit_rate_14d`, `silent_miss_n` (§2.3, §4.2) | proposed here; open question 1 |
| `WIDE_TOLERANCE_DAYS` | **30** | `hit_rate_30d` (§2.3) | proposed here; open question 1 |
| `STANDING_ANCHOR_DAYS` | **30** | the P₃₀ anchor and its fallback gate (§4.0.3, §4.0.4) | proposed here; open question 2 |
| `CHRONIC_MIN_MOVES` | **3** | `chronic_mover` (§4.6) | proposed here |
| `CHRONIC_MIN_PUSHED_DAYS` | **60** | `chronic_mover` (§4.6) | proposed here |

`MIN_RANKED_COVERAGE` is set equal to `MIN_RANKED_SCOREABLE` rather than given an independent value: there
is no evidence to justify two different thresholds, and one number is easier to defend and to re-tune. They
are named separately because they gate different populations, so a future decision can move one without the
other. Every value except the imported horizon is a **proposal**, and three of them are already open
questions for the approver — the point of the table is that they are visible and tunable in one place, not
that they are correct.

Name the constant `MIN_RANKED_SCOREABLE = 5` and apply it as an explicit predicate on the ranked set, not
as a rendering convention — §6.0 row 6.4 points at that predicate as the enforcing construct, and a floor
that lives only in the UI is a floor that a CSV export or a second consumer silently ignores.

**The floor gates on `scoreable_n`, not `landed_n`.** Once the hit rate's denominator became `D_score`
(§4.2), a `landed_n >= 5` floor stopped protecting anything: a rep could land 20 deals, have forecast only
one of them, hit that one, and rank first on a 100% hit rate computed over a single deal. The floor must
count the same set the rate is computed over — the same numerator/denominator discipline as §4.0.6, applied
to the ranking gate.

### 6.5 Clearing a date does not reset history — and does not leave the old date standing

A clear (`new_date IS NULL` on a deal that had one) is counted as a `clear_count` event and becomes a
coverage failure from that instant. It **does not** remove the deal's prior moves from `move_count`,
`days_pushed_out` or the chronic-mover flag. Deleting the evidence must not delete the record.

The mirror-image error is just as bad and is easy to write by accident: **a cleared date must not keep
counting as the standing prediction.** §4.0's `prediction_at` LATERAL takes the latest event before `T` and
returns *its* `new_date`, which is NULL when that event was a clear. Adding an innocent-looking
`AND new_date IS NOT NULL` to that subquery would reach back past the clear and resurrect a date the rep
deliberately removed — scoring them on a forecast they had withdrawn. The filter belongs on the *outcome*
of the LATERAL — as the `cleared` arm of the state enum (§4.0.3) — never inside it. This is called out
because an early draft's prose said "last non-null value", which is precisely the wrong implementation, and
because the same instinct applied to machine writes produced the round-4 P1 (§4.0.0).

### 6.6 No blank ever ranks — every NULL-capable column, in both directions

**Postgres sorts NULLs FIRST under `ORDER BY ... DESC`.** `NULLS LAST` is the default for `ASC` only. So
the natural way to write "best first" — `ORDER BY coverage_rate DESC` — puts every rep whose rate is
undefined at the top of the table, which is the exact "a blank score wins" failure §6.1 exists to prevent,
reintroduced in the column the scorecard sorts by first.

Two rules, both required:

1. **Every `ORDER BY` on a NULL-capable column specifies `NULLS LAST` explicitly**, in both directions.
   Never rely on the direction's default.
2. **A row whose denominator is zero is excluded from the ranked set**, not merely sorted last. It renders
   with an em dash and an "insufficient data" marker, below the ranked rows. Sorting a meaningless value
   last still implies it was measured and came last.

The sweep — every column a user can sort, and whether it can be NULL:

| Column | NULL when | Ranked? |
|---|---|---|
| `coverage_rate` | `\|D_cov\| = 0` (no open deals, or all machine-dated) | Yes — `NULLS LAST` + unranked |
| `hit_rate_14d`, `hit_rate_30d` | `\|D_score\| = 0` | Yes — `NULLS LAST` + §6.4 volume gate |
| `hit_rate_14d_final` | `\|D_score_final\| = 0` | Yes — `NULLS LAST` + unranked |
| `forecast_reliability` | never, once coalesced (§6.1) | Yes |
| `mean_signed_error_days` | `\|D_score\| = 0` | **See the sign caveat below** |
| `median_signed_error_days`, `p90_signed_error_days` | `\|D_score\| = 0` (`percentile_cont` over an empty set) | Same |
| `moves_per_deal` | `\|D_book\| = 0` | Yes — `NULLS LAST` |
| `chronic_mover_rate` | `\|D_book\| = 0` | Yes — `NULLS LAST` |
| `median_days_overdue` | no overdue-open deals | Yes — `NULLS LAST` |
| every `*_n` count | never — `count()` returns 0 | Yes |
| `total_days_slipped`, `days_pushed_out`, `days_pulled_in` | never — coalesced at §4.5 | Yes |

Ten NULL-capable columns, all previously exposed. The counts and the slip sums are safe, and they are safe
*because* of the §4.5 `COALESCE` and `count()`'s own semantics — not by luck, but worth stating so nobody
"tidies" the COALESCE away.

**The signed-error columns have a second, different ranking hazard: they have no good end.** Sorting
`median_signed_error_days DESC` puts the most optimistic rep first; `ASC` puts the most pessimistic first.
Neither is "best" — best is *nearest zero*. A naive sort therefore ranks a rep who is 40 days pessimistic
as the polar opposite of one who is 40 days optimistic, when they are equally inaccurate. **Rank on `abs(<the sorted signed-error column>) ASC NULLS LAST` while displaying the signed value** — for
`mean_signed_error_days`, `median_signed_error_days` **and** `p90_signed_error_days` alike, so the ordering
means "most accurate first" on whichever one the user sorts. An earlier draft named the median alone, which
left the other two ranking extreme pessimism ahead of near-zero accuracy. This is the one place the report
sorts on a transform of what it displays, and the header must say so.

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

**Prerequisite before any of this is built.** Run the `hubspot_refresh_log` census in §1.1.1. It is one
query and it decides whether the machine-contamination problem is theoretical or live. Do not build the
report without knowing the answer.

**Per-rep surface (v1) — every metric in §4.0.6, with its destination**

This table is an **equal set** with the §4.0.6 audit table, not a subset: every metric the report computes
appears here with a stated destination. A metric that is computed but has nowhere to go is either dead
work or an omission, and there is no way to tell which from a list that only names the survivors. The
`Where` column carries the distinction a "v1 columns" heading used to hide.

`Col` = a column on the rep row · `Drill` = shown in the evidence drawer, not the summary row ·
`Diag` = diagnostic column, present so a silent distortion becomes visible.

| Metric | Where | Population (§4.0.6) | § |
|---|---|---|---|
| `coverage_rate` | Col | `D_cov` | 4.1 |
| `covered_n` | Drill | `D_cov` | 4.1 |
| `parked_n` | Col | `D_cov` | 4.1 / 6.2 |
| `at_risk_n` | Col | `D_cov` | 4.1 |
| `machine_dated_n` | Col | `D_open` \ `D_cov` | 4.1 |
| `landed_n` | Col | `D_landed` | 2.4 |
| `scoreable_n` | Col | `D_score` | 4.2 |
| `no_prediction_n`, `cleared_n`, `machine_superseded_n`, `parked_prediction_n` | Col (grouped) | `D_landed` \ `D_score` | 4.2 |
| `hit_rate_14d` | Col | `D_score` | 4.2 |
| `hit_rate_30d` | **Col** | `D_score` | 4.2 / 2.3 |
| `hit_rate_14d_final` | Col | `D_score_final` | 4.2 |
| `scoreable_final_n` | Col | `D_score_final` | 4.2 |
| `cov_n` | Col | `D_cov` | 4.1 |
| `forecast_reliability` | Col | composite of `D_cov` + `D_score` | 6.1 |
| `mean_signed_error_days` | Col | `D_score` | 4.3 |
| `median_signed_error_days` | Col | `D_score` | 4.3 |
| `p90_signed_error_days` | **Col** | `D_score` | 4.3 |
| `overdue_open_n` | Col | `D_open` | 2.4 |
| `median_days_overdue` | Col | `D_open` | 2.4 |
| `move_count` | Drill | `E` | 4.4 |
| `set_count` | Drill | `E` | 4.4 |
| `clear_count` | Drill | `E` | 4.4 |
| `moves_per_deal` | Col | `E` over `D_book` | 4.4 |
| `total_days_slipped` | Col | `E` | 4.5 |
| `days_pushed_out`, `days_pulled_in` | Drill | `E` | 4.5 |
| `chronic_mover_n` | Col | `D_book` | 4.6 |
| `chronic_mover_rate` | Col | `D_book` | 4.6 |
| `silent_miss_n` | Col | `D_score` | 4.7 |
| `moves_by_other_actor` | Drill | `E` | 3 |
| `machine_written_events_n` → `hubspot_refresh_events_n`, `migration_seed_events_n` | Diag | `source='machine'` on `D_book` | 2.5(b) |
| `mirror_terminal_no_date_n` | Diag | `D_nodate` | 4.0.5 |
| `bid_board_owned_n` | Diag | `D_book` | 2.5(c) |
| `out_of_period_landed_n` | Diag | `D_outside` | 4.0.5 |
| `reopened_after_landing_n` | Diag | `D_reopened` | 4.0.5 |
| `reopened_open_n` | Diag | `D_reopened ∩ D_open` | 4.0.5 |
| `provenance_unknown_n` | Diag | `D_open`, raw date with `pnow_state='no_event'` | 4.0.6 |

`hit_rate_30d` and `p90_signed_error_days` are marked in bold because they were **missing from an earlier
version of this table** while §2.3 and §4.3 promised them. Both are kept rather than dropped, for reasons
the document already argues: §2.3's case for the ±30 band is that the right tolerance is *unknown* and
open question 1 asks leadership to choose from real data — which requires both bands on screen. And §4.3
justifies the mean by saying the long optimistic tail is where the problem lives, which is precisely what
`p90` measures and what mean and median together still hide. Both come from the same query at no marginal
cost.

**Three tables enumerate metrics, and they must agree.** §4.0.6 (numerator/denominator),
§6.0 (fairness claims and enforcing constructs), and this one (destinations). The intended relationships,
stated so a future reader can tell a deliberate omission from a missed one:

| Relationship | Kind | Why |
|---|---|---|
| §4.0.6 ↔ this table | **Equal sets** | Every computed metric has a destination; every shipped column has a defined population |
| §6.0 → §4.0.6 | **Strict subset**, by design | Only metrics involved in a fairness guarantee appear; most metrics are descriptive, not protective |

**Adding a metric means touching all three tables.** Both checks are mechanical because all three now name
real identifiers in backticks rather than prose labels — the earlier version of this table used
descriptions like "Coverage %", so a set-difference against §4.0.6 returned *every* metric as missing and
the check could not run at all. That is why the ±30 and p90 gap survived: the table looked complete to a
reader and was unverifiable to a script.

**Time basis differs across the row and the UI must say so:** coverage and churn columns are "as of
today"; landed and error columns are period-scoped (§4.0.5).

Default sort:

```sql
ORDER BY coverage_rate DESC NULLS LAST, hit_rate_14d DESC NULLS LAST, rep_name ASC, rep_id ASC
```

`rep_id` is the final tie-breaker, not decoration: two active users can share a `display_name`, and without
it the ordering is not total — which makes row order vary between runs and, under pagination, lets a rep
appear twice or not at all. Same rule as §4.0.6's total-order requirement, applied to the presentation
query rather than to a `LIMIT 1` lookup.

`NULLS LAST` is explicit and mandatory — `DESC` defaults to NULLS **first** in Postgres, which would put
every unmeasurable rep at the top (§6.6). A rep below the floor **for the column being sorted** — each rate
gates on its own denominator (§6.4) — or with a zero denominator is shown **below** the ranked rows with an
em dash and an "insufficient data" marker, not merely sorted last. The columns in bold were added after review: each is the only visible trace of a specific way the
report could otherwise mislead, and dropping them for width is not a cosmetic decision.

**Evidence drill.** Clicking any cell opens the deal list behind it. Per deal: the full close-date timeline
from `audit_log` — `changed_at`, `old_date → new_date`, actor (display name, or "Unattributed"), the
event's `source`, and when that is `machine`, its **`machine_source`** (`hubspot_refresh` or
`migration_seed`), plus the matching Move Close Date note body when one exists within a short window of the
event (§1.7). Every number on the summary row is reachable this way.

**The drill must distinguish the two machine writers, not merely mark an event machine-written.** §1.1.1
makes the `hubspot_refresh_log` census the prerequisite for building this report at all, and §2.5(b) splits
the rep-row counts for the same reason: a book carrying migration seeds and no refresh writes must not read
as HubSpot contamination. A drill that collapses both to "machine" defeats that at the row level, which is
exactly where someone checks a suspicious number. The classifier already emits `machine_source` (§4.0.2) —
surface it.

**Conventions v1 must follow**, restated so they are not lost in implementation:

1. Won date **only** through `aliasedWonHsClosedWonDateSql`; Lost date as `d.lost_at::date`. No new
   COALESCE (§1.8).
2. Rep filter = `buildAliasedOwnedRepSql` — **owner, never estimator** (§3).
3. All period slicing through `server/src/lib/period.ts` (§1.9).
4. Timeline from the **trigger** rows only, selected by `changes ? 'expected_close_date'` (§1.3). Every
   event carries a `source` from the §4.0.2 classifier. **Nothing is ever deleted from the timeline** —
   a machine write must be able to end a rep's forecast without becoming one (§4.0.0).
5. Coverage built on the same scope as `at-risk-service.ts` so the two reconcile (§4.1).
6. Stage membership from `WON_STAGE_SLUGS` / `LOST_STAGE_SLUGS`, never hand-written slug lists (§1.8), and
   the terminal test must consult `bid_board_stage_slug` as well as the CRM stage (§4.0).
7. The 90-day horizon comes from `CLOSE_TARGET_HOLD_HORIZON_DAYS` (`shared/src/types/deal-hold-risk.ts:137`),
   imported, never hardcoded (§4.1). Coverage anchors it to **business today**; scoring anchors it to the
   **event's own `changed_at`** (§6.2).
8. "Open" means `outcome_kind = 'open'` from §4.0, never `pipeline_stage_config.is_terminal = false`.
9. **Every rate casts before dividing** — `count(...)::numeric / NULLIF(count(...), 0)`. `bigint / bigint`
   truncates to 0 (§4.0.6).
10. **No metric reads `d.expected_close_date` directly, with exactly one bounded exception.** Every date —
    standing or historical — comes from `state_at` (§4.0.3); a raw column read is how the HubSpot
    exclusion leaked in round 3. The exception is the **coverage provenance-resolution block** in §4.1,
    which may read the raw column *solely* to derive `cov_state`, `cov_prediction` and
    `provenance_unknown_n`, and nothing else. Those three outputs are the block's entire permitted
    surface; every downstream metric consumes them, never the column. **Do not "fix" that block as a
    convention violation** — it is what keeps §4.0.6's promise that an audit-window gap cannot shrink a
    rep's coverage, and deleting it silently restores the defect (see the appendix, round 6).
11. **Every metric appears in the §4.0.6 population table**, with its numerator and denominator drawn from
    the same named set. Add a metric, add a row. Pin the three invariants as tests.
12. **Never negate a nullable** (§4.0.6). Prefer positive equality against the coalesced state enum.
13. **Every `ORDER BY` on a NULL-capable column carries an explicit `NULLS LAST`**, and zero-denominator
    rows are excluded from the ranked set rather than sorted into it (§6.6).
14. **Every protective claim in §6 names its enforcing construct** in the §6.0 table. A claim with no
    construct gets implemented or deleted — never left as prose.
15. **Every identifier a SQL block consumes is produced by an earlier block or is a real table column**,
    per the §4.0.7 producer/consumer chain. Adding a name means adding its producer in the same edit. When
    a reference does not resolve, **add the projection — never delete the reference**: twice now the
    dangling name was the load-bearing half of a defect fix, and dropping it would have reinstated the
    defect (non-deterministic ordering; the unimplementable machine-source split).
16. **Every fix must be propagated, not just applied.** Before calling a correction done, ask what else it
    obliges: a new metric needs rows in §4.0.6 *and* the v1 table; a new population needs a partition
    invariant; a new denominator needs its own volume floor; a new name needs a producer; a new permission
    needs the column in scope where the permission applies. Three consecutive review rounds were dominated
    not by errors in the original design but by **incomplete propagation of the previous round's fixes** —
    a metric given its own population but not its own floor, a ranked column in neither table, an exception
    granted to a block that could not reach the data. Re-run the §7 convention audit and the three
    table-agreement checks **after** a change, never before.
17. **Every audit row must state what would falsify it.** §6.0 carries a falsifying-input column and
    §4.0.7 a producer/consumer chain precisely so a reader can check a claim *against the text* instead of
    trusting the author's intent. An audit that certifies itself is worse than no audit: §6.0's row 6.4
    was marked ✅ against a construct that did not deliver it, which is a false negative in the check built
    to prevent false negatives. When adding an audit row, write the falsifying input first — if none can be
    named, the claim is too vague to enforce.
18. **A rule stated in more than one place must name the canonical statement.** Seventeen conventions are
    each restated across the document — the largest is repeated in thirty places — and a rule restated is
    a rule that can be half-amended. Convention 10 was given a bounded exception in round 9 and a second
    blanket copy survived four rounds, so an implementer reconciling the two could have deleted the
    `coverage_resolution` join as a violation and reopened the provenance hole. Every restatement must
    either carry the exception or point at the canonical section. Verified by the grep in the audit
    inventory below, not by reading.

**A convention that forbids something the spec requires is worse than no convention, because it will be
enforced.** Convention 10 was exactly that for one round: it banned every raw read of
`expected_close_date` while §4.1 necessarily performed one, so an implementer obeying it would have deleted
the coverage provenance resolution and silently restored the audit-window defect. Every convention above
must therefore be stated with its exceptions, and each was checked against the sites it governs:

| Convention | Sites it governs | Result |
|---|---|---|
| 1 canonical Won date | §4.0.5 outcome CASE | Obeyed |
| 2 owner-only rep filter | §3, all populations | Obeyed |
| 3 `period.ts` for slicing | §1.9, `D_landed` bounds | Obeyed |
| 4 timeline never deleted | §4.0.1–4.0.3 | Obeyed — `E`'s `source='rep'` filter is a *metric population*, not a timeline deletion; the distinction is stated in §4.0.6 |
| 5 coverage scope = At-Risk scope | §4.0.5 base CTE | Obeyed |
| 6 stage slugs + mirror | §4.0.5 | Obeyed |
| 7 import `CLOSE_TARGET_HOLD_HORIZON_DAYS` | §4.1, §4.2, §6.2 | **Was violated** — §4.1 hardcoded `+ 90` while §4.2 used the constant. Fixed |
| 8 "open" = `outcome_kind` | §2.4, §4.1 | Obeyed |
| 9 cast before dividing | 6 rate expressions | Obeyed |
| 10 no raw column read | §4.1 resolution block | **Was self-contradictory** — now a bounded exception |
| 11 every metric in the table | §4.0.6 / §7 / §6.0 | Obeyed (three-way check, §7) |
| 12 never negate a nullable | `NOT p30_parked_at_write`, `NOT pfinal_parked_at_write` | **Was violated** — `pfinal_parked_at_write` was used but never defined, so its COALESCE guarantee was assumed rather than stated. Fixed |
| 13 `NULLS LAST` + unranked | §6.6, default sort | Obeyed; default sort also needed `rep_id` for totality. Fixed |
| 14 §6 claims name constructs | §6.0 | Obeyed |
| 15 no dangling identifiers | §4.0.7 producer/consumer chain | Obeyed — re-run after round 8; `coverage_resolution` added as a producer |
| 16 fixes fully propagated | every round-8/9 change | **Still the dominant finding class** — 3 of 4 round-9 findings were round-8 fixes reaching some consumers and not others. Audits re-run after each round |
| 17 audit rows state their falsifier | §6.0, §4.0.7 | Added round 9; extended round 10 with §4.0.7's ordering rule after the chain table certified a cycle |

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
- Reconstructing `D_open` membership as of the period end rather than today (§4.0.5). v1 labels the
  coverage and churn columns "as of today" instead; a stage-history replay is the real fix.
- Raising the At-Risk watchlist's mirror-terminal blind spot as its own change (§4.1).

---

## 8. Open questions for the approver

1. **±14 days** — is that the tolerance the business would manage to, or is "landed in the right month"
   (±30) the real bar? Both are computed; only one should be the headline.
2. **P₃₀ as the headline** — is 30 days the forward visibility that matters, or is it 60 (a quarter's
   planning horizon)?
3. **Lost deals** — in or out of the accuracy number?
4. **Bid-Board-owned deals** — proposal is include-and-flag, with the outcome resolved from
   `bid_board_stage_slug` as well as the CRM stage (§2.5(c), §4.0). Confirm.
5. **Volume floor of 5 scoreable deals** for ranking (§6.4) — right number for a team this size?
6. **Has `scripts/refresh-from-hubspot.ts` ever run with `DRY_RUN=false` against production, and is it
   still expected to?** (§1.1.1) If it is part of an ongoing operational routine, the §4.0.2 classifier is
   permanent infrastructure rather than a one-off cleanup, and that should be stated on the report itself
   so future readers know some events are marked machine-sourced.
7. **Reason capture (§5.1)** — accept the migration to make `deal_history.changed_by` nullable, or scope
   the reason writer to user edits only and accept the blind spot?

---

## Appendix: review corrections

Three review rounds. Recording every correction because the pattern across them matters more than any
individual fix.

**Round 1 → 2 (one premise error, five design defects)**

| # | Was | Now |
|---|---|---|
| P1 | "`expected_close_date` has no machine writer; every value was typed by a person" (§1.1) | False. `scripts/refresh-from-hubspot.ts` overwrites it from HubSpot. Rewritten §1.1 with the corrected writer inventory, plus §1.1.1/§1.1.2 on distinguishability and the `hubspot_refresh_log` match now in the §4.0.2 classifier. |
| P2-1 | Outcome CASE tested only `pipeline_stage_config.slug` | Also tests `bid_board_stage_slug`; mirror-terminal deals no longer fall into "open" (§4.0, §2.5(c)). |
| P2-2 | Coverage counted any today-or-future date | Parked dates (>90d) excluded from the numerator, reported as `parked_n` (§4.1, §6.2). |
| P2-3 | Prose said "last **non-null** value before T" | The LATERAL returns the latest event's `new_date` *including* NULL, so a cleared date no longer stands (§4.0, §6.5). |
| P2-4 | Hit-rate denominator was all landed deals | Denominator is `D_score` (§4.2). "No prediction" is a coverage failure, counted once. |
| P2-5 | "`deal_history` reason capture requires no migration" | False: `changed_by` is `NOT NULL REFERENCES public.users(id)` (`0067:85`). Two explicit options, one a migration (§5.1). |

**Round 2 → 3 (one premise error, seven defects)**

| # | Was | Now |
|---|---|---|
| P1 | HubSpot events removed from the timeline, but coverage bucketed off raw `d.expected_close_date` | §4.0.1 defines the standing date *and its provenance* once; coverage reads that. Machine-dated open deals get their own bucket, excluded from the rate (§4.1). |
| P2-1 | `count(*) / NULLIF(count(*), 0)` in four rate expressions | `bigint / bigint` truncates to 0. All rates now cast `::numeric` first; called out as a standing rule (§4.0.2, convention 9). |
| P2-2 | `moves_per_deal` divided `E`-wide numerator by `landed_n + overdue_open_n` | Denominator is `\|D_book\|`, the population `E` is defined over (§4.4). Second fix to this metric — the first moved the mismatch rather than closing it. |
| P2-3 | P₃₀ fallback fired whenever no event preceded the anchor | Guarded on `min(changed_at) > outcome_date − 30d`, so a long-lived deal first forecast late is *not* scoreable (§4.0). |
| P2-4 | "Insert-only prediction" used as the migration-seed proxy | Too broad — discarded genuine rep forecasts set at deal creation. Narrowed to insert-seed **+ NULL actor + `hubspot_deal_id`** (§4.0.1, §5.3). |
| P2-5 | Base `outcomes` CTE omitted `aliasedReportableDealFilterSql` | Carried in the base CTE so the At-Risk reconciliation can hold (§4.0). |
| P2-6 | Parked-at-write anchored to `stage_entered_at` | Anchored to the event's own `changed_at`, matching the platform's today-anchored rule (`deal-reporting.ts:125-139`). Divergence on `bid_due_date` stated explicitly (§6.2). |
| P2-7 | Ranking floor gated on `landed_n >= 5` | Gates on `scoreable_n >= 5`, the set the rate is computed over (§6.4). |

**Round 3 → 4 (one premise error, nine defects)**

| # | Was | Now |
|---|---|---|
| P1 | Machine events **deleted** from the timeline | Deletion made `prediction_at` fall through to the rep's *superseded* forecast and score against it. Re-modelled: events are never removed, each carries a `source`, and a machine write ends a rep's forecast without becoming one (§4.0.0–§4.0.3). |
| A | `NOT p30.had_event` over a nullable boolean | NULL under three-valued logic, and a NULL predicate in `FILTER` counts nothing — landed deals with no prediction incremented no bucket and broke invariant 2 silently. Replaced by a coalesced non-null state enum tested by positive equality (§4.0.3). |
| B | `hit_rate_14d_final` reused `D_score` | `D_score` requires a usable P₃₀, dropping the exact strong-final / weak-P₃₀ case §6.3 says the metric exists to reveal. Own population `D_score_final` (§4.2, §4.0.6). |
| C | Migration seeds still reached P₃₀ / P_final | Step 2 removed HubSpot *updates* only. Seeds are now classified `machine` by arm (b) of the same classifier (§4.0.2). |
| D | P₃₀ fallback gated on `min(changed_at)` of events | Circular — a long-lived deal first forecast 10 days out still tripped it. Gated on `deals.created_at` (§4.0.4). |
| E | §7 deferred list still said "insert-only prediction is unscoreable" | Contradicted the narrowed §4.0.2 rule. Removed. |
| F | `D_open` defined as-of-`to`, computed from today | Definition and computation disagreed. v1 accepts a today snapshot and labels the columns; as-of reconstruction deferred (§4.0.5). |
| G | Machine-seed test caught the rep spreadsheet campaign | Same NULL-actor shape on an UPDATE. Now requires `event_kind = 'insert'` (§4.0.2). |
| H | `mirror_terminal_no_date_n` drawn from `D_book` | A mirror-won deal with a NULL won date is in neither `D_landed` nor `D_open`, so the diagnostic could not see its own case. New `D_nodate` population; `D` is now a stated three-way partition (§4.0.5). |
| I | Watchlist tie-out asserted as equality | `at-risk-service.ts:71` filters `psc.is_terminal = false` and never reads `bid_board_stage_slug` (verified: zero occurrences). Stated as an identity with two correction terms, and raised as a finding about the *existing* watchlist (§4.1). |

**Round 4 → 5 (boundary and ordering sweep)**

| # | Was | Now |
|---|---|---|
| P1a | P_final defined as "the prediction held at the outcome instant", implemented as `changed_at < outcome_date` | `outcome_date` is a `DATE`, so the comparison meant midnight at the *start* of the closing day and excluded every same-day edit. Both P_final and P₃₀ are now defined as the state at the **end of** their business date, via an exclusive next-day bound, with the precision limitation stated in §2.1 rather than implied by an operator. |
| P1b | `ORDER BY changed_at DESC ... LIMIT 1` | `NOW()` is transaction-stable, so same-transaction writes tie and `state_at` was not a function. `audit_log.id` (`BIGSERIAL`) is carried through the timeline. *(Superseded in round 10: the composite order was itself wrong — `changed_at` must not be a sort key at all.)* |
| S1 | P₃₀ had the identical boundary defect | Fixed with the same helper — it was one bug at two anchors, not a P_final special case. |
| S2 | `d.created_at > outcome_date - interval '30 days'` in the P₃₀ fallback | `timestamptz` against a bare date resolves in the *session* timezone. Rewritten with the explicit business-timezone bound. |
| S3 | `p30_changed_at::date` in the parked-at-write test | Same session-timezone defect; an evening Chicago edit shifted the horizon a day. Now `(… AT TIME ZONE 'America/Chicago')::date`. |
| S4 | §6.2 restated the parked test with the old bare cast | Internal contradiction with the corrected §4.2. Aligned. |
| S5 | "earliest event" in the P₃₀ fallback had no tie-breaker | Mirror of P1b in the ascending direction; a deal created and forecast twice in one transaction resolved its first prediction non-deterministically. |
| S6 | `D_landed` period bounds unspecified | Stated as `BETWEEN from AND to` (inclusive, matching `getWtdPeriod`), with an explicit warning not to import the `< to + 1 day` timestamp convention from `deal-date-scope.ts` onto a date column. |

**The sweep.** Twenty boundary comparisons and orderings were checked — every line inside a ```sql fence
containing a comparison operator, `BETWEEN`, `ORDER BY`, `::date`, `interval`, `now()` or `today`, read in
context, plus the period bounds stated only in prose. Six were wrong (two reported, four found), and the
four found were all the *same two* root causes reaching sites the report did not name: one boundary
convention and one timezone assumption. Fourteen were correct, and the four that reconcile against platform
predicates were verified against the source rather than assumed — `at_risk`'s `< today` is the exact
complement of `futureDatedCloseDatePredicateSql`'s `>= today` (`foundations.ts:46`), and `parked`'s strict
`>` matches `closeTargetFarOutSqlPredicate` (`deal-reporting.ts:137`), so a deal exactly 90 days out is
unparked in both. One ordering — `percentile_cont`'s `WITHIN GROUP` — deliberately needs no tie-breaker,
and §4.3 now says why.

**Round 16 (a diagnostic that inferred a workflow event from an absence, and table prose no check reads)**

| # | Was | Now |
|---|---|---|
| 4 | `D_reopened` required an in-window landing **and** that landing being absent from `D_landed` — never that the deal **reopened** | Absence has other causes: a NULL `outcome_date` (`D_nodate`) or a Won date later corrected outside the window both matched. A data-quality problem was reported as a workflow event, in a diagnostic people act on. Now requires positive evidence: a later `deal_stage_history` row whose `from_stage_id` is terminal and `to_stage_id` is not. Residual recorded — `from_stage_id` is nullable, so a reopen written without it is invisible, **unverified against production**. |
| 1, 2, 6 | Three audit-table cells asserted relations the SQL had already contradicted: `D_reopened ⊂ D_open` (it is an overlay), `machine_dated_n = D_open \ D_cov` (re-including reopened deals), and `overdue_open_n` over `D_open` rather than the resolved `D_cov` | All three were **table prose lagging correct SQL**. Fixed, and the class closed — see below. |
| 3 | A P₃₀ literal `30` surviving in prose | The constants check excludes prose by design and this is the second instance it has hidden. Fixed; prose exclusion kept, but now listed as a known cost rather than an assumption. |
| 5 | The evidence drill marked events machine-written without saying **which** machine | The classifier emits `machine_source`, and §1.1.1 makes the HubSpot census the build prerequisite — a drill collapsing refresh and migration seeds defeats that at the row level, which is where a suspicious number gets checked. |

**The table-prose class, closed.** Findings 1, 2 and 6 were assertions *inside* a table that no check
reads — the §4.0.6 contents check verifies the populations column against the SQL and is blind to prose in
neighbouring cells, so a subset claim sitting beside a machine-checked column read as equally verified and
was not. Rather than fix three cells, the load-bearing content was **moved into one canonical `RELATIONS`
block** (§4.0.5) and a check now asserts that no set assertion appears anywhere else without citing it.
Everything remaining in those cells is commentary. Coverage line: the check matches set symbols and the
stock phrases "subset of" / "carved out of", so a relation asserted in freeform English is still invisible.

**Round 15 (the table not widened with the SQL, and a check blind to markdown)**

| # | Was | Now |
|---|---|---|
| 1 | The `D_reopened` **predicate** was widened to catch re-closed reopens; the **populations table row** still said `D ∩ outcome_kind = 'open' ∩ …` | Table-vs-SQL divergence, in the table that exists to prevent it, and the direct consequence of changing the SQL and *reading* the row rather than re-deriving it. Row now states the widened predicate and that `D_reopened` is an **overlay**, not a partition member. |
| 2 | The §4.0.6 audit row for `silent_miss_n` still said `> 14` after the metric SQL moved to `TOLERANCE_DAYS` | **Fourth wave on constants.** The inverted check scanned only lines inside ` ```sql ` fences, so **every markdown table cell was structurally invisible to it** — and three of this document's metric tables are markdown. Extended to scan `code spans` inside table cells; it then found **five** live sites, not one. |

**Why the check missed it, precisely.** Not a subtle bug: the scanner built a set of line numbers inside
SQL fences and skipped everything else. Table cells were never in scope, and the check said "none" rather
than "none, in fences". Extending it required distinguishing executable fragments from column *names* —
`hit_rate_14d` legitimately embeds 14 — which the existing identifier guard already handles, and excluding
the appendix, whose round-history rows quote superseded literals on purpose. Both are now stated as
coverage lines.

**The population check.** §4.0.5 had no mechanical check at all, and finding 1 is exactly what the
memory-based list predicts. Set-notation definitions are not extractable expressions, so a contents diff is
not available — but names are: every `D_*` used anywhere must have a table row, and every declared row must
be referenced by a fence or a table. That is weaker than a contents diff and it immediately found `D_prior`,
a name deleted in round 8 still living in §4.0.5 prose. **Residual, stated in the inventory:** a row whose
definition drifts from its SQL predicate while the name stays put is still invisible — which is finding 1
itself, so this check would *not* have caught it. That half stays memory-based and is labelled as such.

**Round 14 (a check that reported a clean it had not earned)**

| # | Was | Now |
|---|---|---|
| 1 | `D_book` included all of `D_open`, so `E`'s `open → now()` window ran through the interval a reopened deal was **closed** | Edits made while the deal was closed counted as forecast churn — the post-outcome churn removed in round 5b, back through a population that did not exist then. `D_reopened` is now excluded from `D_book` and `E`. Splitting the window around the closed interval would be more faithful but needs the same landed-history reconstruction §4.0.5 declines; excluding is less informative and more honest, and `reopened_after_landing_n` keeps it from being silent. |
| 2 | `D_reopened` was gated on `outcome_kind = 'open'` | A deal that landed in-window, reopened, and **re-closed after `to`** stopped matching and fell into `D_outside` unflagged — the common case for any period more than a few weeks old, and exactly the dropped landing the diagnostic exists to surface. Now based on in-window terminal stage history **plus** the landing not being represented in `D_landed`, so it catches both slices. It is an overlay across `D_open` and `D_outside`, so the tie-out uses `reopened_open_n` (the `D_open` slice) while `reopened_after_landing_n` reports the whole thing. |
| 3 | P₃₀ bounds subtracted a literal `30` while §6.4 defined `STANDING_ANCHOR_DAYS` | Open question 2 invites moving the anchor to 60; a copied implementation would keep scoring at 30. **Third wave of constant defects**, and it got past a check built after the second. |

**The check that failed, and why.** My last report said "hardcoded thresholds: none". It grepped the
literals it already knew about (14, 3, 60) inside *comparisons*, so a named constant used as a literal in
**date arithmetic** was outside its scope — and it reported clean rather than reporting limited. Inverted
to run table→SQL: for each named constant, assert its value appears nowhere in a fence but its own row.
Found the three `30`s immediately. Every mechanical check now carries an explicit **does NOT cover** line,
because the check's silence was more damaging than the defect.

**Round 13 (a half-converted window, and the asymmetry check that finds them)**

| # | Was | Now |
|---|---|---|
| 1 | `D_reopened` compared `h.created_at >= :from` bare against `business_day_end_exclusive(:to)` | One end session-timezone-dependent, the other explicit, in the same window — contradicting §4.0.6's own timezone rule. Both ends now CT-anchored, matching `ctDateInWindowSql` (`monday-showcase-service.ts:322-327`), which already applies this rule to `deal_stage_history.created_at`. Blast radius stated: the boundary gates `is_reopened_after_landing`, hence `D_cov`, `machine_dated_n`, `reopened_after_landing_n` **and** the §4.0.6 tie-out. |

**The check added.** Round 5 swept boundary comparisons *individually* and found six; this was a seventh,
introduced afterwards. Checking each bound for correctness needs judgement, but checking that **both ends of
a window share a basis** is answerable from the text alone — a range with one explicit end and one bare end
is wrong by construction, whichever end is individually right. Now mechanical: pair comparisons on a shared
left operand, classify each bound as explicit or bare, flag mismatches. Three windows examined, one
half-converted, zero after the fix. Building it also required fixing the checker's own regex, which
truncated `<business today> + CONST` and reported a false positive — a checker that cries wolf gets ignored,
which is its own failure mode.

**Round 12 (defects in round 11's own fix, and the hole all three checks missed)**

| # | Was | Now |
|---|---|---|
| 1 | `in_d_cov` defined **twice** — two conjuncts in Block A, three in §4.1 — and the third name, `is_reopened_after_landing`, defined nowhere and absent from §4.0.7 entirely | An implementation either left reopened deals in ordinary coverage or failed to resolve the identifier. One definition now, in Block A; `is_reopened_after_landing` is produced by `outcomes` via an `EXISTS` over `deal_stage_history` and listed in the chain table; §4.1 references rather than restates. |
| 2 | `machine_dated_n` and `reopened_after_landing_n` overlapped | A deal reopened after landing *and* later given a machine close-date write satisfied both, so the tie-out counted it twice — the identity widened to fix a double-count had one of its own. Made disjoint by precedence (`machine_dated_n` carries `NOT is_reopened_after_landing`), with disjointness asserted beside the sum. |

**The hole this exposed.** The *Produces* extraction added in round 11 could not catch
`is_reopened_after_landing`, because that name was in **neither** column: the contents rule verifies names
the table *claims*, the ordering rule verifies names the table *lists*, and a name present in the SQL and
absent from the table falls between them. Added a **completeness rule** — every identifier a block's SQL
references must appear in its *Consumes* column — plus a **duplicate-definition check**, validated by
running it against the previous commit, where it correctly reports `in_d_cov` at two lines with different
bodies. Expanding the `outcomes.*`, `p30_*`, `pfinal_*` and `flags` globs was required to make any of it
work: that is the fourth time a grouped label has blinded a mechanical check in this document.

**Round 11 (fixes that reached one site and not the others)**

| # | Was | Now |
|---|---|---|
| 1 | Populations table said `D_cov` excludes `D_reopened`; the `in_d_cov` scalar didn't | A deal that landed in-period and was reopened was counted as ordinary coverage *and* reported as a diagnostic — double-counted, and the tie-out silently false. Scalar gains the conjunct; tie-out gains `reopened_after_landing_n` as a third term. |
| 2 | §4.0.7 claimed `coverage_resolution` produces `cov_n` and Block A produces both parked flags | Neither was true of the SQL: `coverage_resolution` is per-deal and projects no aggregate; the flags were defined in §4.2. `cov_n` is now produced in Metrics, the flags in Block A. **Third time §4.0.7 certified something untrue** — so the *contents* rule and its extractor were added, mirroring the ordering rule. |
| 3 | A second, blanket "no metric reads `d.expected_close_date`" survived at §4.0.0 | Convention 10's bounded exception existed only in §7, so an implementer reconciling the two could delete the `coverage_resolution` join and reopen the provenance hole. Both restatements now carry the carve-out; convention 18 requires every restatement to point at the canonical rule. |
| 4 | Formulas hardcoded `14`, `3`, `60` after the constants were named | An implementation copied from a snippet keeps scoring with a stale threshold after a re-tune, making the constants table decoration. All comparisons now reference `TOLERANCE_DAYS`, `WIDE_TOLERANCE_DAYS`, `CHRONIC_MIN_MOVES`, `CHRONIC_MIN_PUSHED_DAYS`. |

**Round 10 (a chain that cannot execute, and an ordering guarantee that was false)**

| # | Was | Now |
|---|---|---|
| 1 | The derived-scalar block produced `event_window_end` (consumed by `E`) *and* consumed `E` (for `deal_move_count`) | A **cycle**: each needed the other. Split into block A (row-level, before `E`) and block B (churn aggregates, after `E`). §4.0.7 certified an ordering that cannot execute — a producer/consumer table whose row order is not itself checked is a list, not a dependency check. Added an explicit **ordering rule** verifiable from the table alone. |
| 2 | `ORDER BY changed_at DESC, audit_log_id DESC` | `NOW()` is transaction-**start** time, so overlapping requests can commit in one order and carry `changed_at` in the opposite order — the sort then picks the stale event and the tie-breaker never engages, because the timestamps are not tied. Round 5's claim that it bought "insertion order in the case that matters" was backwards: this *is* that case. Now `ORDER BY audit_log_id` alone, which is faithful because row locks serialise same-deal writes. |
| 3 | The short-lived P₃₀ fallback had no outcome cap | A post-close cleanup edit could become P₃₀ and make a no-prediction deal scoreable. `E` was capped at the outcome in round 5b; the cap did not reach this lookup. |
| 4 | Open buckets keyed on pre-resolution `pnow_state` | An audit-gap deal with a past raw date resolves to `rep_prediction` → `at_risk_n`, while a `pnow_state`-keyed overdue bucket called the same deal undated and omitted it from `overdue_open_n`. All current-open buckets now key on `cov_state` / `cov_prediction`. |
| 5 | A deal won/lost in-period then reopened silently became "open" | The terminal date fields are cleared on reopen (`stage-change.ts:357-362`), so the landing vanished from the rep's record. Now detected via stage history, reported as `reopened_after_landing_n`, and carved out of `D_cov`. v1 does not reconstruct the outcome date — that would put those deals on a second, unreconciled Won basis. |
| 6 | `MIN_RANKED_COVERAGE` was named but never assigned | A constant with no value is a claim with no construct. Full constants table added: all eight tunables with values, users and sources. Four were previously unnamed literals (14, 30, 3, 60). |
| 7 | `abs()` sort prescribed for `median_signed_error_days` only | §6.6 identified all signed-error columns as hazards; mean and p90 would still rank extreme pessimism first. Now specified for every signed-error sort. |

**Round 9 (an audit that certified itself, plus three more propagation misses)**

| # | Was | Now |
|---|---|---|
| 1 | `coverage_resolution` tested `pnow.state = 'no_event'` un-coalesced | The `LEFT JOIN LATERAL` yields NULL when no event exists — exactly the audit-window case the CTE exists to rescue — so both CASE arms went NULL, `in_d_cov` went NULL, and the deal fell out of **every** coverage bucket. Round 6's defect, reintroduced by round 8's CTE. Coalesced inside the CTE. |
| 2 | `event_window_end` referenced `stage_entry_date` | A name that **does not exist** — the real columns are `deals.stage_entered_at` and `deals.bid_board_stage_entered_at`. `outcomes` now projects `terminal_entry_date`, derived the same way `outcome_kind` is (CRM stage entry when the CRM stage is terminal, mirror entry when the mirror is), with the producer/consumer row. |
| 3 | `silent_miss_n`'s audit row still said `move_count = 0` | Round 8's granularity fix reached §4.7 and not its audit row. Now `deal_move_count`. |
| 4 | **§6.0 row 6.4 was a false ✅** | It claimed tiny denominators do not rank while `coverage_rate` was rankable at `\|D_cov\| = 1` and `forecast_reliability` could rank one scoreable hit — its `hit_rate_14d` operand was *coalesced* but never *volume-gated*. Per-column floor table added, including `MIN_RANKED_COVERAGE` and the rule that a composite clears **every** operand's floor. |

**The §6.0 re-derivation.** All thirteen ✅ were re-derived from the current SQL by naming a falsifying
input. **Eleven survived unchanged.** 6.4 was false (above). 6.1c was *unfalsifiable as worded* — "hit rate
never carries the ranking on its own" describes the default sort, while any user-initiated sort makes some
column carry it, so the row could be read true or false at will; narrowed to "no rate ranks on fewer than
`MIN_RANKED_SCOREABLE` underlying deals, on any sort". §6.0 now carries a **falsifying-input column** so
every row is checkable against the text rather than against the author's intent.

**Round 8 (incomplete propagation — round 7's own fixes leaving new gaps)**

| # | Was | Now |
|---|---|---|
| 1 | Convention 10 granted §4.1 permission to read `d.expected_close_date`, but the base `outcomes` CTE deliberately does not project it | A *permission* granted to a block with no access to the thing it permits — the referential-integrity class one level up. The only escape was the ad-hoc raw read convention 10 forbids. Now a named `coverage_resolution` CTE that joins `deals` itself, with a producer/consumer row. |
| 2 | P₃₀ fallback gate compared `created_at` against `outcome_date - 31` | That is the *start* of the anchor day, not its end. A deal created during the P₃₀ business date with no close date, first forecast after that day, slipped through and had its late forecast promoted to P₃₀. Both arms now use the identical `business_day_end_exclusive(outcome_date - 30)`. |
| 3 | The `lost_at::date` deliberate-exception note | **Was never actually in the document.** A round-5 replacement silently failed to match and the script's aggregate success flag hid it. Added, now naming the concrete consequence (a loss after 19:00 CT can shift period and both anchors by a day). |
| 4 | Mirror-terminal watchlist correction named only no-date deals | The watchlist counts `no_date` **and** `stale_dated` with no terminal awareness, so a mirror-terminal deal with a past raw date was counted there and excluded here. Correction widened to undated-or-past-due. |
| 5 | `hit_rate_14d_final` ranked, but the volume floor keyed on `D_score` | Round 7 gave the metric its own population without its own floor, so one scoreable-final deal could rank first — §6.4's exact failure, reintroduced by the fix that made the metric correct. Each rate now gates on its own denominator; `scoreable_final_n` added to both metric tables. |
| 6 | `forecast_reliability` presented as a ranked column, absent from both metric tables | Broke the equal-set check established in round 6. Added to §4.0.6 and the v1 table. |
| 7 | `D_prior` / `prior_period_landed_n` | `D` reflects current row state, so a completed-period view includes deals closed *after* `to`. The name asserted "prior" while the count meant "outside". Renamed `D_outside` / `out_of_period_landed_n`. |

Findings 1, 5 and 6 are all round 7's corrections leaving a new gap — the dominant failure mode for three
rounds running. Convention 16 now requires asking what else a fix obliges (table rows, floors, producers,
invariants, cross-references) and re-running the audits **after** a change rather than before.

**Round 7 (dangling references — names used where nothing produces them)**

| # | Was | Now |
|---|---|---|
| 1 | §4.0.3 ordered by `t.audit_log_id`; §4.0.2 never projected it | The query does not run — and the likely "fix" is dropping the tie-breaker, reinstating round 5's non-determinism. Projected, with a do-not-drop comment. |
| 2 | §4.0.6 required split HubSpot/migration counts; the classifier emitted only `source='machine'` for both arms | The split was **unimplementable**: the discriminator had been collapsed upstream. Added `machine_source` (`hubspot_refresh` / `migration_seed` / NULL) with a pinned invariant that it is non-null exactly when `source='machine'`. |
| 3 | `p30_*` / `pfinal_*` / `pnow_*` used throughout §4; the aliasing convention never stated | ~9 identifiers formally unproduced. §4.0.7 states the three lateral instances and their prefixes. |
| 4 | `signed_error_p30` defined only as prose in §2.2; `signed_error_pfinal` **never defined at all** | Both defined in §4.0.7, signed, never `ABS`. |
| 5 | `landed` consumed by §4.2 and §4.7; never defined | Defined in §4.0.7 as the `D_landed` membership predicate. |
| 6 | `move_count` / `days_pushed_out` meant **rep-level** in §4.4–4.5 and **per-deal** in §4.6–4.7 | One identifier, two granularities: a rep with 40 moves across 20 deals would have tripped the `>= 3` chronic threshold on every deal. Renamed the per-deal forms `deal_move_count` / `deal_days_pushed_out`. |
| 7 | `event_window_end` described in a comment, not defined | Defined in §4.0.7. |
| 8 | §4.0.4 consumed `d.created_at`; `outcomes` produces `deal_created_at` | Aligned to the produced name. |

Nine dangling references across ~15 identifiers, two reported and seven found by the sweep. New §4.0.7
carries the derived-name definitions and a producer/consumer table for the whole CTE chain, and convention
15 requires that adding a name adds its producer in the same edit.

**Round 6 (three tables that must agree; a convention that forbade what the spec required)**

| # | Was | Now |
|---|---|---|
| 1 | v1 column list omitted `hit_rate_30d` and `p90_signed_error_days` while §2.3 and §4.3 promised them | Both kept and added. §2.3's argument for the ±30 band is that the right tolerance is unknown and open question 1 asks leadership to choose from data — which needs both bands visible; §4.3 justifies the mean by the long tail, which is what `p90` measures and mean/median hide. Zero marginal cost, same query. |
| 2 | The v1 table used prose labels ("Coverage %") | A set-difference against §4.0.6 returned *every* metric as missing, so the check could not run — which is why the gap survived. Rewritten with real identifiers plus a `Where` column (Col/Drill/Diag), making it an **equal set** with §4.0.6. |
| 3 | Three metric tables could disagree pairwise | Relationships now stated: §4.0.6 ↔ v1 are **equal sets**; §6.0 → §4.0.6 is a **strict subset by design**. Adding a metric means touching all three. |
| 4 | Convention 10 banned raw reads of `expected_close_date`; §4.1 requires one | A convention that forbids what the spec requires *will be enforced* — an implementer would have deleted the coverage provenance resolution and restored the round-6 defect. Now a **bounded exception**: the §4.1 block may read the column solely to derive `cov_state`, `cov_prediction`, `provenance_unknown_n`. |
| 5 | §4.0.6's `coverage_rate` row named `pnow_state` | The SQL uses `cov_state` / `cov_prediction`. Row corrected so table and SQL agree. |
| 6 | `pfinal_parked_at_write` used in `scoreable_final`, never defined | Its COALESCE and timezone guarantees were assumed to carry over from the P₃₀ twin. Defined explicitly. |
| 7 | §4.1 hardcoded `+ 90` | Convention 7 says import `CLOSE_TARGET_HOLD_HORIZON_DAYS`, and §4.2 did. Both now use the constant. |
| 8 | Default sort ended `rep_name ASC` | Not total — two users can share a display name, so row order varied between runs and pagination could duplicate or drop a rep. `rep_id` appended. |

**Round 5b (unenforced guarantees, and the populations that did not close)**

| # | Was | Now |
|---|---|---|
| 1 | Ranked columns had no `NULLS LAST` | `DESC` defaults to NULLS **first** in Postgres, so a rep with no `D_cov` denominator sorted to the top of the column the scorecard ranks by — the exact failure §6.1 exists to prevent. New §6.6 sweeps all ten NULL-capable columns, mandates explicit `NULLS LAST` in both directions, and excludes zero-denominator rows from the ranked set rather than sorting them last. |
| 2 | `E` ran to `now()` for every deal | `expected_close_date` stays editable after close (`stage-change.ts` clears the terminal fields but deliberately not the forecast), so cleanup edits were counted as churn against a forecast no longer standing. `E` is now capped per deal by `event_window_end`, sharing the P_final boundary helper. |
| 3 | `D_landed ⊎ D_open ⊎ D_nodate = D` | False for any period narrower than all-time: deals closed before `from` matched no population. New population (named `D_prior` at the time, renamed `D_outside` in round 8 — it also contains deals closed *after* `to`); the partition and its invariant are now four-way. |
| 4 | §4.0.6 promised provenance-unknown deals bucket as rep-authored; §4.1 sent every `no_event` to `at_risk_n` | Provenance is resolved into `cov_state` / `cov_prediction` **before** the partition. The scoring anchors deliberately do not apply the same resolution, and §4.1 now says why. |
| 5 | `hubspot_written_events_n` counted migration seeds too | Both classifier arms map to `source='machine'`, so a book with seeds and no refresh writes looked contaminated — corrupting the §1.1.1 census that gates the whole build. Split into `hubspot_refresh_events_n` and `migration_seed_events_n` via a `machine_source` label. |
| 6 | "Forecast reliability = coverage × hit rate; zero coverage yields zero" | False in SQL: `0 * NULL` is `NULL`, so the composite went blank for exactly the rep it should score zero — then sorted first. Both operands coalesced. |
| 7 | Signed-error columns sortable like a rate | They have no good end: `DESC` ranks the most optimistic first, `ASC` the most pessimistic, but best is *nearest zero*. Rank on `abs(...) ASC NULLS LAST` while displaying the signed value (§6.6). |

**The pattern.** Almost every round-2 and round-3 defect is one error: *a numerator and a denominator that
describe different sets of deals*. `moves_per_deal` (twice), the coverage hole, the ranking floor, the
hit-rate denominator, the reportable filter — all the same shape. Fixing them individually is what let the
same defect reappear in a new place each round. §4.0.6 is the structural answer: named populations, one
row per metric, numerator and denominator both stated, and two invariants pinned as tests. A metric added
without a row in that table is the defect re-entering.

**On how the round-2 P1 slipped through:** my round-1 sweep grepped for write-shaped SQL
(`INSERT`/`UPDATE`/`SET` near the column name). The HubSpot refresh builds its assignment dynamically, so
the column name appears only in an allowlist and no grep for write syntax could match it. The corrected
inventory was built by listing every file that mentions the field at all and reading each one — which is
also how `scripts/migration-promote.ts` surfaced as a second machine writer.

**On how the round-3 P1 slipped through:** I applied the exclusion where I had been thinking about it (the
event timeline) and never asked which *other* expressions read the same underlying data by a different
route. The general lesson, now encoded as convention 10: when a filter is introduced to exclude a class of
data, grep for every remaining raw read of the source column, not just the one the fix was written against.

**On round 4, which is the one worth learning from.** Three separate P1s — coverage reading the raw column,
migration seeds reaching the scorer, and superseded forecasts being resurrected — were all the same
modelling error: *provenance was expressed as removing rows rather than as rows having a source*. Each
round I fixed the symptom the reviewer named and the model stayed wrong, so the next round found the next
symptom. The re-model in §4.0.0–§4.0.3 is deliberately structural: one timeline, one classifier, one state
function, four exhaustive states, and every consumer reading the same thing. A new machine writer now costs
one `WHEN` arm and changes nothing else.

Round 4's second lesson is narrower but sharper: **the invariants added in round 3 to catch silent drops
were themselves silently broken**, because `NOT <nullable>` inside `FILTER` counts nothing rather than
failing loudly. A check that can fail open is not a check. That is why the state enum is coalesced and
non-null by construction, and why "never negate a nullable" is now a stated SQL rule (§4.0.6) rather than
something to remember at each site.

**Round 16's lesson: prose adjacent to a checked column inherits its credibility without earning it.** The
audit table has now been wrong about three distinct things — its ordering, its *Produces* contents, and now
free text in cells beside both. A reader cannot tell which parts of a table a check actually read, and the
checked columns lend authority to the unchecked ones sitting inches away. The fix that generalises is not
another checker but a **single canonical declaration** of the load-bearing facts, with everything else
demoted to commentary that cites it: one place to be right, and a cheap grep to catch anything asserting a
relation elsewhere. Where that consolidation is not possible, the honest move is to say which cells are
commentary — not to leave them looking verified.

**Round 15's lesson: the scope line has to be written from the code, not from intent.** Round 14 added a
"does NOT cover" line to every check. The constants check's line said it ignored "prose formulas and column
names" — accurate as far as it went, and it omitted the thing that actually mattered: it never looked
outside SQL fences at all. I wrote that line from what I *meant* the check to cover rather than from what
the scanner does, which is the same failure the checks exist to catch, one level up. A scope line is only
worth trusting if it was derived the same way the check's results are.

**Round 14's lesson: a green check is a claim, and claims need their scope stated.** Round 13 argued that
when a sweep finds N defects the useful follow-up is the structural invariant they share. The corollary
this round supplies: *a check written for that invariant can still be wrong about its own scope*, and then
its zero is indistinguishable from a real zero — worse than no check, because it stops the search. The
constants check reported clean for a full round while the third wave of constant defects sat in lines it
never read. Every check in the inventory now states what it does not cover, and that line is the part a
reader should read first: the both-ends check's zero is trustworthy *because* it says "paired comparisons
inside SQL fences only", and the constants check's zero was not.

**Round 13's lesson: check the property that is cheap to verify, not the one you actually care about.**
What matters is whether each boundary is *correct*, which needs judgement about intent and timezone
semantics. What is mechanically checkable is whether the two ends *agree* — a strictly weaker property, and
one that would have caught this defect the moment it was introduced. Constants, populations and boundaries
have each now had a second wave after their first sweep, and in every case the second wave was found by a
structural property (a name with no value, a term that can overlap, a window with mismatched ends) rather
than by re-reading for correctness. When a sweep finds N defects, the useful follow-up is not a more careful
sweep but a structural invariant those N defects all violate.

**Round 12's lesson: three checks can all pass and still share a blind spot.** The ordering, contents and
three-table checks were each mechanical and each ran clean while `is_reopened_after_landing` sat in the SQL
of one block, in the definition of another, and in no table at all. Every check verified *the table against
itself or against a subset of the SQL*; none asked whether the SQL contained anything the table had never
heard of. That is a different question from the ones already being asked, and it needed its own extractor.

The generalisable form: a set of checks is only as complete as the *directions* it runs in. Table→SQL was
covered; SQL→table was not. When adding a check, ask which direction it runs and whether the reverse is
also covered — and note that the duplicate-definition check, the cheapest one added this round, would have
caught a defect that survived a full review round.

**Round 11's lesson: an audit is only as good as where its inputs come from.** All four findings were a
correction applied where it was noticed and not where it also applied — and the two audits built to catch
exactly that (§4.0.7 and the convention list) both failed at it again, because each was verified by the
author against their memory of what they had just changed. An author who is wrong in the same way twice
passes their own review every time.

The fix is not more diligence. It is to derive each audit's inputs *from the text*: the contents rule now
extracts projected names from every SQL fence and diffs them against the *Produces* column, and the
convention check now greps a signature per rule and lists every line that restates it. Both found real
defects on their first run that reading had missed three times. The §7 audit inventory added this round
states plainly which checks are mechanical and which remain read-and-recalled, so a reader knows which
results to distrust — the honest answer is that §6.0's falsifying inputs and the population definitions
still are.

**Round 10's lesson: a check can be structurally sound and still not check anything.** §4.0.7 listed the
right blocks with the right contents and certified a chain that cannot run, because *row order* was never
part of what it verified. Every individual cell was correct. The fix was not more care but a rule that
makes the table's own ordering falsifiable — read top to bottom, and every consumed name must already have
appeared. Round 9 made the enforcement table checkable against the text; round 10 had to do the same for
the dependency table, which had exactly the same flaw one level down.

The other half of the round is a guarantee I asserted and did not have. I wrote that `audit_log_id` bought
"determinism always, and insertion order in the case that matters" — and the case that matters is
concurrent overlapping writes, which is precisely where a transaction-start timestamp inverts the order and
a secondary key never engages. Stating a guarantee more confidently than the mechanism supports is the same
failure as a false ✅, in prose rather than in a table.

**Round 9's lesson: an audit is not exempt from being audited.** §6.0 was built to make unenforced claims
visible and its own guarantee is *"a claim with no construct is not a claim"* — yet it shipped a row marked
✅ against a construct that did not deliver it. A false ✅ is a false negative **in the check built to
prevent false negatives**, and it is worse than a missing row because it stops the next reader looking.
The structural fix is not vigilance but the falsifying-input column: a claim you cannot name a
counter-input for is too vague to enforce, and one you can is checkable by anyone. Convention 17 now
requires writing the falsifying input *first*.

The same flaw applied to §4.0.7's producer/consumer table, which I wrote from my mental model of the CTE
chain rather than by extracting from the text — which is exactly why it did not catch `stage_entry_date`, a
name that never existed, added in the same round as the table. Both tables are now verified by extraction.

**Round 8's lesson is about tooling, not design.** Finding 3 was not a judgement error: the note had been
written and I reported it as landed, but the scripted replacement silently did not match — I had targeted
`WON_STAGE_SLUGS / LOST_STAGE_SLUGS` where the document said `WON_STAGE_SLUGS / LOST_STAGE_SLUGS /
TERMINAL_STAGE_SLUGS` — and the script printed one aggregate success for the batch. Every subsequent edit
in this document now goes through a helper that asserts each individual replacement matched exactly once
and refuses to write the file otherwise. An edit tool that can fail silently makes every other check in
this document unreliable, because they all run against whatever actually landed.

**Round 7's lesson: the dangerous fix is the one that adds a name.** Both reported findings were a defect
fix from the previous round referring to something no block produced — and in both cases the *natural*
repair (delete the unresolvable reference) would have silently restored the original defect. That is a
worse failure mode than the defect itself, because it looks like cleanup. Hence convention 15's explicit
instruction: **add the projection, never delete the reference.** The producer/consumer table makes the
whole class a one-pass mechanical check rather than something review has to notice.

Worth noting how thin the reported findings turned out to be relative to the class: two were reported,
seven more were sitting in the same document, including one (`move_count` at two granularities) that would
have silently mis-flagged every deal belonging to an active rep.

**Round 6's lesson is that a rule can be as wrong as a metric.** Four of its eight findings were the
document contradicting its *own* conventions — and convention 10 was self-contradictory within a single
round of being written, under exactly the time pressure that makes a new rule feel like progress. The
checks that catch this are the same mechanical extractions used everywhere else: enumerate the rule's
governed sites, confirm each obeys or is a named exception. That audit is now in §7 as a table, because a
convention list nobody can check is decoration — and, worse, a convention that is *wrong* gets enforced by
the next reader against the working code.

**Round 5b named the most dangerous class of all: a stated guarantee with no mechanism.** Findings 1, 4
and 6 above were all prose promising protection that the SQL did not deliver — §6.1 promised a blank never
wins while the default sort put blanks first; §4.0.6 promised conservative provenance bucketing while §4.1
bucketed the opposite way; §6.1 promised zero coverage yields zero while `0 * NULL` yields NULL. These are
worse than missing features, because a stated guarantee stops the reader looking for the mechanism. The
answer is §6.0: every protective claim listed against the exact construct enforcing it, so a claim without
one is visible on the page. Three of thirteen rows turned out to be prose-only, and one of those was
actively false.

**Round 5 is the same lesson a third time, in a third dimension.** The population table made
numerator/denominator disagreement visible; round 5's findings were the *boundary* equivalent — prose
saying "at the outcome instant" while SQL said "before midnight", and a `LIMIT 1` over an order that was
not total. Both are a definition and a comparison that do not mean the same thing. The three new standing
rules in §4.0.6 (timezone-explicit comparisons, total orders, state-the-precision) are the structural
answer, in the same spirit as the population table: turn a thing the author has to remember at every site
into a thing the reader can check mechanically at every site.
