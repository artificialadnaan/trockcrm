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
to accidentally drop. They are not dropped here.

Two conventions govern this whole section, both defined once in §4 and referenced everywhere else:

- **"Open" means `outcome_kind = 'open'`** (§4.0.5) — the test that consults `bid_board_stage_slug` as well
  as the CRM stage. Using `pipeline_stage_config.is_terminal = false` instead would classify a Bid-Board
  deal already won or lost in the mirror as an open deal with a rotting forecast, and charge its rep for a
  coverage failure on a deal that has closed.
- **"The date" means `state_at(deal, T)`** (§4.0.3), never the raw `expected_close_date` column. The state
  distinguishes a rep's date from a machine's, from a deliberate clear, from no record at all — and those
  four cases belong in four different buckets.

Every deal in scope lands in exactly one bucket:

1. **Landed** — Won or Lost with a usable outcome date (`D_landed`). Contributes to hit rate and error
   statistics *if* it also carried a usable rep prediction — `D_score`, defined in §4.2.
2. **Overdue-open** — open, `pnow_state = 'rep_prediction'`, prediction earlier than business today. The
   error is **right-censored**: at least `today − prediction` days, and it will only grow. Own columns
   (`overdue_open_n`, `median_days_overdue`), **never** folded into the landed mean — doing so would let a
   rep improve their average by leaving deals open — and never counted as hits.
3. **Undated-open** — open, `pnow_state ∈ {cleared, no_event}`. Not an error; a **coverage** failure.
4. **Parked-open** — open, `pnow_state = 'rep_prediction'`, prediction more than 90 days out (§4.1). Not
   yet judgeable *and* not covered: a date beyond the platform's own hold horizon forecasts nothing.
5. **Live-open** — open, `pnow_state = 'rep_prediction'`, prediction between today and +90 days. Counted in
   coverage favourably, excluded from error metrics until it lands.
6. **Machine-dated open** — open, `pnow_state = 'machine'`. Held out of the coverage rate entirely
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

Additionally, **report `hubspot_written_events_n` on the rep row.** If the refresh has touched a rep's book
heavily, the reader needs to know their sample is thinner than it looks — and if the count is zero across
the board (the likely outcome if the script has only ever run dry, §1.1.1), the column costs nothing and
proves the report is clean.

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

Precisely what the tie-breaker buys, stated honestly: **determinism always, and insertion order in the case
that matters.** Identical `changed_at` implies the same transaction, and within one transaction the
sequence is drawn in insertion order, so `id` is the true ordering. Across *different* transactions `id`
can interleave with commit order — but then `changed_at` differs and is the primary key of the sort, so it
decides. The residual case (two concurrent transactions with a `NOW()` collision) is resolved
arbitrarily-but-repeatably, which is all that is required: `state_at` must be a function.

#### 4.0.2 The classifier — the single place provenance is decided

```sql
close_date_timeline AS (
  SELECT e.deal_id, e.changed_at, e.actor_user_id, e.event_kind, e.old_date, e.new_date,
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

Arm (a) is the HubSpot refresh; arm (b) is the migration promotion. Both are `'machine'`, and both now flow
through the *same* downstream logic instead of each needing its own exclusion.

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
  ORDER BY t.changed_at DESC, t.audit_log_id DESC   -- total order; see §4.0.1
  LIMIT 1
) p ON TRUE
```

`<T_exclusive_upper_bound>` per anchor:

| Anchor | Bound | Why |
|---|---|---|
| `pfinal` | `business_day_end_exclusive(outcome_date)` | Includes edits made on the closing day (the fix above) |
| `p30` | `business_day_end_exclusive(outcome_date - 30)` | Same convention, so the two anchors are comparable |
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
| `p30` | `outcome_date - interval '30 days'` (with the §4.0.4 fallback) | headline hit rate, all error stats |
| `pfinal` | `outcome_date` | `hit_rate_14d_final` (§4.2) |
| `pnow` | `now()` | coverage (§4.1) |

Coverage reads `pnow` — the same timeline as everything else. There is no separate "standing date" concept
and **no metric reads `d.expected_close_date` directly**; that raw read is how the exclusion leaked in
round 3, and the unified state function removes the need for it entirely.

#### 4.0.4 The P₃₀ fallback, gated on the deal's life

§2.1 allows falling back to the deal's first recorded prediction **only when the deal's whole life was
shorter than 30 days**. The gate is the deal's own age, not its first close-date event:

```sql
p30 = CASE
        WHEN <an event exists below business_day_end_exclusive(outcome_date - 30)>
          THEN state_at(deal, business_day_end_exclusive(o.outcome_date - 30))
        -- The DEAL is younger than the anchor: its whole life sits inside the window, so its earliest
        -- recorded state is all there is. Same tz-explicit boundary as everywhere else (§4.0.3).
        WHEN d.created_at >= business_day_end_exclusive(o.outcome_date - 31)
          THEN <earliest event state, see below>
        ELSE 'no_event'                        -- long-lived, forecast late: NOT scoreable
      END
```

The "earliest event" arm needs the same total order as `state_at`, in the other direction:

```sql
ORDER BY t.changed_at ASC, t.audit_log_id ASC
LIMIT 1
```

A deal created and forecast twice within one transaction would otherwise resolve its *first* prediction
non-deterministically — the mirror of the §4.0.1 problem, and just as easy to miss because it only bites on
same-transaction writes.

An earlier draft gated on `min(changed_at)` over the deal's *events*. That is circular: a deal created in
January and first forecast on 20 July, closing on 30 July, has `min(changed_at)` after the anchor, so the
guard passed and the ten-day-old date became P₃₀ — scoring a last-minute guess as a confident month-ahead
forecast. The deal's `created_at` is the honest measure of how long the rep had to form a view.

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
| `D_book` | `D_landed ∪ D_open` — the rep's book. Denominator for churn rates. | mixed, stated |
| `D_score` | `D_landed` ∩ `p30_state = 'rep_prediction'` ∩ P₃₀ not parked-at-write (§6.2) | period |
| `D_score_final` | `D_landed` ∩ `pfinal_state = 'rep_prediction'` ∩ P_final not parked-at-write | period |
| `D_cov` | `D_open` ∩ `pnow_state <> 'machine'` | today |
| `E` | Events in `close_date_timeline` on deals in `D_book`, `source = 'rep'`, `changed_at <= now()` | to date |

**On `D_landed`'s period bounds:** `outcome_date` is a `DATE`, and `getWtdPeriod` returns `from`/`to` as
inclusive `YYYY-MM-DD` strings (§1.9), so `BETWEEN from AND to` is correct and needs no adjustment. Do
**not** import the timestamp convention from `deal-date-scope.ts` (`>= from::date` and
`< to::date + interval '1 day'`, §1.8) — that exclusive upper bound exists to cover a *timestamp* column's
intraday values, and applying it to a date column is harmless only by luck. Two different boundary
conventions in one query is how an off-by-one day enters.

`D_landed ⊎ D_open ⊎ D_nodate = D` — a three-way partition. `D_nodate` exists because a mirror-won deal can
have a NULL `won_closed_date` (nothing stamps it while the CRM stage stays open): it is terminal, so not in
`D_open`, and has no outcome date, so not in `D_landed`. Without naming it, those deals fall out of every
population and the `mirror_terminal_no_date_n` diagnostic that is supposed to make the drop visible would
itself be drawn from a set that excludes them.

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
| `coverage_rate` | 4.1 | `D_cov` where `pnow_state = 'rep_prediction'` and date in `[today, today+90]` | `D_cov` | Yes |
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
| `total_days_slipped`, `days_pushed_out/pulled_in` | 4.5 | `E` | — | Event sums |
| `chronic_mover_n` | 4.6 | deals in `D_book` meeting the flag | — | Count |
| `chronic_mover_rate` | 4.6 | `chronic_mover_n` | `\|D_book\|` | Yes |
| `silent_miss_n` | 4.7 | `D_score` with `move_count = 0` and `abs(err) > 14` | — | Count |
| `moves_by_other_actor` | 3 | `E` where `actor_user_id` is a user other than the owner (NULL ≠ "other") | — | Event count |
| `hubspot_written_events_n` | 2.5(b) | `close_date_timeline` where `source='machine'`, deals in `D_book` | — | Diagnostic |
| `mirror_terminal_no_date_n` | 4.0.5 | **`D_nodate`** | — | Diagnostic |
| `bid_board_owned_n` | 2.5(c) | `D_book` | — | Diagnostic |
| `provenance_unknown_n` | 4.0.6 | `D_open` with a non-null `expected_close_date` but `pnow_state = 'no_event'` | — | Integrity diagnostic |

`provenance_unknown_n` is the **one** permitted reader of the raw `expected_close_date` column (convention
10, §7), because its entire job is to compare the column against the timeline. A deal carrying a date with
no event behind it means the audit window does not reach as far back as §1.4 assumes. It should be
near-zero; if it is not, the coverage numbers are resting on an assumption that does not hold, and this is
the column that says so. Bucket such deals as `rep` for coverage purposes — the conservative choice, since
excluding them would let an unverifiable gap quietly shrink a rep's denominator.

Invariants to pin as tests — they are the point of the table:

1. `covered_n + parked_n + at_risk_n = |D_cov|`, and `|D_cov| + machine_dated_n = |D_open|`.
2. `scoreable_n + no_prediction_n + cleared_n + machine_superseded_n + parked_prediction_n = landed_n`.
3. `|D_landed| + |D_open| + |D_nodate| = |D|`.

**Two SQL rules that apply to every expression in this document:**

- **Cast before dividing.** `count(*)` is `bigint` and `bigint / bigint` truncates — `3 / 4` is `0`, not
  `0.75`. Every rate uses `count(...)::numeric / NULLIF(count(...), 0)`.
- **Never negate a nullable.** No `NOT <col>` or `<col> <> x` where `<col>` can be NULL — in particular
  anything from a `LEFT JOIN LATERAL`, which is NULL when no row matches. Under three-valued logic those
  are NULL, and a NULL predicate inside `FILTER (WHERE ...)` counts nothing, so rows disappear instead of
  landing in a bucket. The state enum in §4.0.3 is coalesced precisely so every downstream test is a
  positive equality against a non-null value. Where a negative test is unavoidable, write it as
  `<col> IS DISTINCT FROM x` or `<col> IS NOT TRUE`.
- **Never compare a `timestamptz` against a bare date, and never `::date` one without a timezone.** Both
  resolve in the *session* timezone, which is not guaranteed to be `America/Chicago`. Use
  `business_day_end_exclusive(d)` (§4.0.3) for an upper bound and
  `(<ts> AT TIME ZONE 'America/Chicago')::date` for a cast. A day-boundary error is invisible in test data
  seeded at midday and appears in production only for evening edits.
- **Every "latest" or "earliest" selection needs a total order.** `changed_at` alone is not one: `NOW()` is
  transaction-stable, so same-transaction writes tie (§4.0.1). Always append `audit_log_id` in the matching
  direction. A `LIMIT 1` over a non-total order is a query whose answer can change between runs.
- **State the precision you actually have.** `outcome_date` is a `DATE`; the data does not record what time
  a deal was won. Where a bound is derived from it, say in prose which end of the day is meant rather than
  letting `<` versus `<=` carry a definition the reader has to reverse-engineer.

### 4.1 Coverage rate

**Plain English:** of the rep's open deals, what share carry a rep-authored close date that is usable —
in the future, but not parked so far out that it forecasts nothing.

Coverage reads `pnow_state` from §4.0.3. It does **not** read `d.expected_close_date`.

```sql
-- machine_dated_n leaves the rate on BOTH sides: charging it as at-risk blames the rep for a machine
-- write, counting it as covered credits them for one.
machine_dated_n = count(*) FILTER (WHERE open AND pnow_state = 'machine')

-- The remaining three partition D_cov (= D_open minus machine-dated).
covered_n  = count(*) FILTER (WHERE in_d_cov AND pnow_state = 'rep_prediction'
                                             AND pnow_prediction >= <business today>
                                             AND pnow_prediction <= <business today> + 90)
parked_n   = count(*) FILTER (WHERE in_d_cov AND pnow_state = 'rep_prediction'
                                             AND pnow_prediction >  <business today> + 90)
at_risk_n  = count(*) FILTER (WHERE in_d_cov AND (pnow_state IN ('cleared','no_event')
                                              OR (pnow_state = 'rep_prediction'
                                                  AND pnow_prediction < <business today>)))

coverage_rate = count(*) FILTER (WHERE in_d_cov AND pnow_state = 'rep_prediction'
                                                AND pnow_prediction >= <business today>
                                                AND pnow_prediction <= <business today> + 90)::numeric
              / NULLIF(count(*) FILTER (WHERE in_d_cov), 0)
```

`open` is `outcome_kind = 'open'` (§4.0.5) — the mirror-aware test. `in_d_cov` is
`open AND pnow_state <> 'machine'`; note this comparison is safe because `pnow_state` is coalesced and
never NULL (§4.0.6).

Every branch tests `pnow_state` positively and the three buckets cover all four enum values, so no deal can
fall through unbucketed. That is invariant 1 in §4.0.6.

90 days is `CLOSE_TARGET_HOLD_HORIZON_DAYS` (`shared/src/types/deal-hold-risk.ts:137`), imported, never
hardcoded, so this report and the effective-value chains agree on what "parked" means.

`parked_n` is a **first-class column**, not a footnote — it is the only visible trace of the single most
effective way to game this metric (§6.2).

**Reconciliation with the At-Risk watchlist — an identity with two correction terms, not an equality.**

```
at_risk_n
  + (machine-dated open deals that are undated or past-due)     -- provenance: this report excludes, watchlist doesn't
  + (mirror-terminal deals with an open CRM stage and no usable date)  -- see below
  = At-Risk watchlist count (no_date + stale_dated) for the same rep
```

The second term is a genuine divergence and worth raising as a finding **about the existing watchlist**,
not as a caveat here. `at-risk-service.ts:71` filters `psc.is_terminal = false` and never inspects
`bid_board_stage_slug` (verified: zero occurrences in that file). So a Bid-Board-owned deal that is won or
lost in the mirror while its CRM stage is still open is **counted by the watchlist as an open deal with a
rotting forecast**, when the codebase's own terminal-aware value logic
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

hit_rate_14d = count(*) FILTER (WHERE scoreable AND abs(signed_error_p30) <= 14)::numeric
             / NULLIF(count(*) FILTER (WHERE scoreable), 0)
```

`p30_parked_at_write` is computed as:

```sql
COALESCE(
  p30_prediction > (p30_changed_at AT TIME ZONE 'America/Chicago')::date
                   + CLOSE_TARGET_HOLD_HORIZON_DAYS,
  false)
```

Three things are load-bearing in that one line. The `COALESCE` makes it a non-null boolean so the `NOT` in
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
scoreable_final = landed
              AND pfinal_state = 'rep_prediction'
              AND NOT pfinal_parked_at_write

hit_rate_14d_final = count(*) FILTER (WHERE scoreable_final AND abs(signed_error_pfinal) <= 14)::numeric
                   / NULLIF(count(*) FILTER (WHERE scoreable_final), 0)
```

It must **not** reuse `D_score`. That population requires a usable P₃₀, which excludes exactly the case
§6.3 says the final rate exists to reveal: a rep with no month-ahead forecast who set a correct date in the
final week would be dropped rather than shown as strong-final / weak-P₃₀. `D_score_final` is its own row in
§4.0.6 for that reason. `hit_rate_30d` uses `D_score` (it is the same P₃₀ measurement at a wider
tolerance), so only the `_final` variant needs the separate population.

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
`E`, which is defined over `D_book` (§4.0.6), so this is the only denominator that describes the same set.

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
  chronic_mover = COALESCE(move_count, 0) >= 3 AND COALESCE(days_pushed_out, 0) >= 60
  ```

  Both conditions, because three ±2-day adjustments is diligence and one 200-day push is a single
  decision; the pattern worth naming is repeated, substantial, one-directional pushing. The COALESCEs
  matter even though a deal with `move_count >= 3` necessarily has a non-null `days_pushed_out`: without
  them the expression is NULL-safe only *by accident of evaluation order*, and `NULL >= 60` inside a
  `FILTER` counts nothing rather than reading as false (§4.0.6). Per-deal aggregates reached through a
  `LEFT JOIN` are NULL, not 0, for a deal with no events.
- **Rep-level:**

  ```sql
  chronic_mover_rate = count(*) FILTER (WHERE chronic_mover)::numeric
                     / NULLIF(count(*), 0)          -- both over D_book
  ```

Same denominator as `moves_per_deal` (§4.4) — `|D_book|` — because the flag is evaluated over every
in-scope deal, open ones included. A deal does not need to have closed to have been moved five times. Both
rate metrics now describe the same book, so a reader can compare them.

`::numeric` on the numerator (§4.0.6).

3 and 60 are proposals. Make them constants in one place so they can be tuned after the first real
distribution is visible.

### 4.7 Silent misses

**Plain English:** deals whose date was set once and never touched, and which then missed badly.

```sql
silent_miss_n = count(*) FILTER (WHERE scoreable
                                   AND COALESCE(move_count, 0) = 0
                                   AND abs(signed_error_p30) > 14)
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

### 6.1 Not forecasting is the worst score, not a blank

Coverage rate (§4.1) is a **first-class column**, shown next to accuracy, always. A rep with zero
predictions shows `coverage 0%`, `hit rate —`, `at_risk_n`. The hit rate renders as an em dash and is
**excluded from sorting** — a null must never float to the top of a descending sort and read as a clean
sheet. The scorecard's default sort is on coverage, then hit rate, so "doesn't forecast" sinks.

Coverage is only safe as the primary sort key because §4.1 now **excludes parked dates from the numerator**.
Sorting first on a coverage number that counted any future date would have promoted the exact behaviour
§6.2 forbids. If the two ever drift apart again, the sort key is the thing that turns the bug into an
injustice.

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

This report applies the horizon in **two** places, and both are required:

1. **Coverage (§4.1).** An open deal whose standing date is more than 90 days out is `parked_n`, not
   `covered_n`. Anchor: **business today**, matching `closeTargetFarOutSqlPredicate`
   (`shared/src/types/deal-reporting.ts:125-139`), which emits
   `(horizon) > CT_TODAY_SQL + INTERVAL '90 days'`. Same anchor, same strict `>`, so a deal exactly 90 days
   out is *not* parked in either world.
2. **Scoring.** A prediction is **parked-at-write** when it was more than 90 days beyond **the date it was
   written** — `new_date > (changed_at AT TIME ZONE 'America/Chicago')::date + 90`, the explicit-timezone
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

**Per-rep columns (v1)**

| Column | Population (§4.0.6) | § |
|---|---|---|
| Coverage % (usable, non-parked, rep-authored date) | `D_cov` | 4.1 |
| **Parked n** (open deals dated >90 days out) | `D_cov` | 4.1 / 6.2 |
| At-risk n (open deals undated or past-due) | `D_cov` | 4.1 |
| **Machine-dated n** (last write was HubSpot/migration) | `D_open` \ `D_cov` | 4.1 |
| Landed n | `D_landed` | 2.4 |
| **Scoreable n** (landed *and* carried a usable P₃₀) | `D_score` | 4.2 |
| **No-prediction / cleared / machine-superseded / parked-prediction n** | `D_landed` \ `D_score` | 4.2 |
| Hit rate ±14d (against P₃₀) | `D_score` | 4.2 |
| **Hit rate ±14d (final call)** | **`D_score_final`** | 4.2 |
| Median signed error (days) | `D_score` | 4.3 |
| Mean signed error (days) | `D_score` | 4.3 |
| Overdue-open n / median days overdue | `D_open` | 2.4 |
| Moves per deal | `E` over `D_book` | 4.4 |
| Chronic movers n / rate | `D_book` | 4.6 |
| Silent misses n | `D_score` | 4.7 |
| Moves by other actor | `E` | 3 |
| **HubSpot-written events n** (diagnostic) | `source='machine'` events on `D_book` | 2.5(b) |
| **Mirror-terminal-no-date n** (diagnostic) | **`D_nodate`** | 4.0.5 |
| Bid-Board-owned n (diagnostic) | `D_book` | 2.5(c) |
| Provenance-unknown n (integrity diagnostic) | `D_open` with a raw date but `pnow_state='no_event'` | 4.0.6 |

Two columns carry a period label that differs from the rest of the row: **coverage and churn are "as of
today"**, landed/error columns are period-scoped (§4.0.5). The UI must say so on the headers rather than
letting a reader assume one time basis across the row.

Every column names the population it is drawn from. That is not documentation garnish — three separate
review rounds found defects that were exactly a column drawn from one set and divided by another, and the
column-to-population mapping is what makes the next one visible before it ships.

Sorted by coverage, then hit rate. Reps below the volume floor (`scoreable_n >= 5`, §6.4) shown but
unranked. The columns in bold were added after review: each is the only visible trace of a specific way the
report could otherwise mislead, and dropping them for width is not a cosmetic decision.

**Evidence drill.** Clicking any cell opens the deal list behind it. Per deal: the full close-date timeline
from `audit_log` — `changed_at`, `old_date → new_date`, actor (display name, or "Unattributed"), whether
the event was excluded as HubSpot-written, and the matching Move Close Date note body when one exists
within a short window of the event (§1.7). Every number on the summary row is reachable this way.

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
10. **No metric reads `d.expected_close_date` directly.** Every date — standing or historical — comes from
    `state_at` (§4.0.3). A raw column read is how the exclusion leaked in round 3. The single permitted
    exception is the `provenance_unknown_n` integrity diagnostic (§4.0.6), which exists precisely to
    compare the column against the timeline and must be labelled as such.
11. **Every metric appears in the §4.0.6 population table**, with its numerator and denominator drawn from
    the same named set. Add a metric, add a row. Pin the three invariants as tests.
12. **Never negate a nullable** (§4.0.6). Prefer positive equality against the coalesced state enum.

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
| P1b | `ORDER BY changed_at DESC ... LIMIT 1` | `NOW()` is transaction-stable, so same-transaction writes tie and `state_at` was not a function. `audit_log.id` (`BIGSERIAL`) is carried through the timeline and every lookup orders by `changed_at, audit_log_id`. |
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

**Round 5 is the same lesson a third time, in a third dimension.** The population table made
numerator/denominator disagreement visible; round 5's findings were the *boundary* equivalent — prose
saying "at the outcome instant" while SQL said "before midnight", and a `LIMIT 1` over an order that was
not total. Both are a definition and a comparison that do not mean the same thing. The three new standing
rules in §4.0.6 (timezone-explicit comparisons, total orders, state-the-precision) are the structural
answer, in the same spirit as the population table: turn a thing the author has to remember at every site
into a thing the reader can check mechanically at every site.
