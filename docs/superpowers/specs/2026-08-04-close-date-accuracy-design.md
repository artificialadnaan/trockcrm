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

Throughout, **"open" means `outcome_kind = 'open'` as defined in §4.0** — the test that consults
`bid_board_stage_slug` as well as the CRM stage. Using `pipeline_stage_config.is_terminal = false` instead
would classify a Bid-Board deal that is already won or lost in the mirror as an open deal with a rotting
forecast, and charge its rep for a coverage failure on a deal that has closed.

Every deal in scope lands in exactly one bucket:

1. **Landed** — Won or Lost with a usable outcome date. Contributes to hit rate and to mean/median signed
   error, *if* it also carried a prediction (`scoreable`, §4.2).
2. **Overdue-open** — `is_active = true`, open, `expected_close_date < business today`. The error is
   **right-censored**: we know it is *at least* `today − prediction` days and it will only grow. These get
   their own columns (`overdue_open_n`, `median_days_overdue`) and are **never** folded into the landed
   mean, because doing so would let a rep improve their average by leaving deals open. They are also never
   counted as hits.
3. **Undated-open** — `is_active = true`, open, `expected_close_date IS NULL`. Not an error; a **coverage**
   failure. Counted in the coverage denominator and reported as its own number.
4. **Parked-open** — open, dated more than 90 days out (§4.1). Not yet judgeable *and* not covered: a date
   beyond the platform's own hold horizon forecasts nothing. Its own column, `parked_n`.
5. **Live-open** — open with a date between today and +90 days. Counted in coverage favourably, excluded
   from error metrics until it lands.

Buckets 2 and 3 together are exactly the `stale_dated` and `no_date` reasons already produced by
`server/src/modules/reports/at-risk-service.ts:63`, and together they are §4.1's `at_risk_n`. Reusing that
scope means the coverage number on this report reconciles to the existing At-Risk watchlist rather than
becoming a second, differing count of the same thing. Bucket 4 is *not* part of the At-Risk watchlist — the
platform does not flag a far-future date as at-risk, it zeroes the deal's value instead (§6.2) — so
`parked_n` is additional to that reconciliation, not part of it.

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

**Decision: exclude HubSpot-written close-date events from the timeline, at the event level, by
anti-joining `public.hubspot_refresh_log`.** Not the deal — the *event*. A deal whose date was overwritten
by the refresh in March and then genuinely re-forecast by its rep in June keeps the June prediction and
loses only the March one. Excluding the whole deal would throw away real rep behaviour; excluding the whole
*rep* would be worse. The join is given in §4.0.

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

### 4.0 The shared timeline CTE

Everything else is built on this. Note the `changes ? 'expected_close_date'` predicate: snake_case selects
**only** the database-trigger rows, which is what makes the timeline universal and what prevents
double-counting against the application's camelCase twin (§1.3).

```sql
-- Step 1: every recorded change to a deal's forecast date, from the universal audit_deals trigger.
WITH raw_close_date_events AS (
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

-- Step 2: drop machine-written events. See §1.1.2 / §2.5(b) — the HubSpot refresh's trigger row is
-- shape-identical to a rep's edit, so it MUST be removed by anti-join, never by `changed_by IS NULL`.
close_date_events AS (
  SELECT e.*
  FROM raw_close_date_events e
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.hubspot_refresh_log l
    WHERE l.tenant_schema = :tenant_schema
      AND l.deal_id       = e.deal_id
      AND l.field_name    = 'expected_close_date'
      AND l.old_value IS NOT DISTINCT FROM to_char(e.old_date, 'YYYY-MM-DD')
      AND l.new_value IS NOT DISTINCT FROM to_char(e.new_date, 'YYYY-MM-DD')
      AND l.created_at BETWEEN e.changed_at - interval '1 minute'
                           AND e.changed_at + interval '1 minute'
  )
),
```

On the matching rule: both rows are written inside `applyDealChanges` (the `UPDATE` at
`refresh-from-hubspot.ts:686-699`, the log INSERT at `:711-715`), so when they share a transaction their
`NOW()`-derived timestamps are identical. The ±1 minute window is slack for the case where they do not, and
it is safe because the match is really carried by `(deal_id, old_value, new_value)` — a rep would have to
make the identical date transition on the identical deal within the same minute to be caught by mistake.
Verify the window against real data before shipping; if `hubspot_refresh_log` turns out to be empty
(§1.1.1) the whole clause is inert.

Index note: `hubspot_refresh_log`'s only usable index is
`hubspot_refresh_log_run_idx (run_id, tenant_schema, deal_id)` — leading on `run_id`, so a per-deal probe
cannot use it. The `field_name = 'expected_close_date'` subset is small; materialise it once per report run
rather than probing per event. If it turns out to be large, add an index — that is a migration, and say so.

Index support for the audit side: `audit_record_idx (table_name, record_id, created_at)`.

```sql
-- Step 3: outcomes. The terminal test consults the Bid Board mirror as well as the CRM stage, because a
-- BB-owned deal can be won/lost in bid_board_stage_slug while its CRM stage_id is still open
-- (server/src/modules/shared/deal-value-sql.ts:383-393). Omitting it drops those deals into 'open',
-- where they are counted as coverage failures instead of as the closed deals they are.
outcomes AS (
  SELECT d.id                       AS deal_id,
         d.assigned_rep_id          AS rep_id,
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
         d.expected_close_date      AS current_close_date,
         COALESCE(d.is_bid_board_owned, false) OR COALESCE(d.is_read_only_mirror, false) AS bid_board_owned,
         psc.is_terminal            AS crm_stage_terminal
  FROM deals d
  JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
  WHERE d.is_active = true
    AND COALESCE(d.is_test_data, false) = false
),
```

`:won_slugs` / `:lost_slugs` are parameterised from `WON_STAGE_SLUGS` / `LOST_STAGE_SLUGS`
(`server/src/modules/shared/pipeline-terminal-stages.ts`), which is also where
`aliasedTerminalDealBySlugSql` gets its list — reuse that helper rather than re-deriving the OR by hand if
the query shape allows it.

**Consequence to carry through the whole report:** "open / non-terminal" everywhere below means
`outcome_kind = 'open'`, **not** `crm_stage_terminal = false`. A mirror-terminal deal has a CRM stage that
is still open; treating it as open would put a closed deal into the overdue-coverage bucket. Note that a
mirror-won deal may still have a NULL `won_closed_date` (nothing stamps it while the CRM stage stays open),
in which case it has no usable outcome date and falls out of the error metrics under the rule below —
correctly, but it should be counted in a `mirror_terminal_no_date_n` diagnostic so the drop is visible
rather than silent.

The prediction in force at an instant:

```sql
-- prediction_at(deal, T): the state of the field immediately before T.
-- Takes the LATEST event before T and returns ITS new_date -- which is NULL when that event was a CLEAR.
-- Do NOT filter `new_date IS NOT NULL` here: that would resurrect a date the rep deliberately removed
-- and report it as the standing prediction, contradicting §6.5.
LEFT JOIN LATERAL (
  SELECT e.new_date AS prediction,
         true       AS had_event
  FROM close_date_events e
  WHERE e.deal_id = o.deal_id AND e.changed_at < <T>
  ORDER BY e.changed_at DESC
  LIMIT 1
) p_at ON TRUE
```

Three distinct states come out of this, and the metrics below treat them differently:

| `had_event` | `prediction` | Meaning |
|---|---|---|
| `NULL` (no row) | — | **No prediction ever recorded before T.** The deal is outside the audit window, or was never forecast. |
| `true` | `NULL` | **The date was explicitly cleared before T.** No prediction stood at T. |
| `true` | a date | A prediction stood at T. |

The first two both mean "no prediction in force at T" for scoring purposes, and both keep the deal out of
the hit-rate *denominator* (§4.2). They are reported separately because they are different failures: the
first is a data-coverage hole, the second is rep behaviour.

Applied twice per deal: `T = outcome_date` (P_final) and `T = outcome_date - interval '30 days'` (P₃₀),
with the documented fallback that when no event precedes `outcome_date − 30d`, P₃₀ takes the **earliest**
event's `new_date` instead (still honouring a clear: if that earliest event is a clear, P₃₀ is NULL).

### 4.1 Coverage rate

**Plain English:** of the rep's currently-open deals, what share carry a close date that is *usable* — in
the future, but not parked so far out that it forecasts nothing.

An earlier draft counted any today-or-future date as covered. That is the gaming hole §6.2 exists to
close: a rep who parks the entire book in 2028 would have scored **100% coverage** on the column the
scorecard sorts by first. A date beyond the platform's own 90-day hold horizon is not a forecast, and
coverage must not accept it as one.

```sql
-- Three mutually exclusive buckets over the rep's open deals; they sum to open_n.
covered_n  = count(*) FILTER (WHERE open AND current_close_date >= <business today>
                                       AND current_close_date <= <business today> + 90)
parked_n   = count(*) FILTER (WHERE open AND current_close_date >  <business today> + 90)
at_risk_n  = count(*) FILTER (WHERE open AND (current_close_date IS NULL
                                           OR current_close_date < <business today>))

coverage_rate = covered_n / NULLIF(covered_n + parked_n + at_risk_n, 0)
```

`open` means `outcome_kind = 'open'` per §4.0 — the mirror-aware test, not `crm_stage_terminal = false`.

90 days is `CLOSE_TARGET_HOLD_HORIZON_DAYS` (`shared/src/types/deal-hold-risk.ts:137`), reused rather than
reinvented so this report and the effective-value chains agree about what "parked" means. Import the
constant; do not hardcode 90.

`parked_n` is a **first-class column on the rep row**, not a footnote — it is the tell for the specific
gaming strategy the metric is most vulnerable to, and it is invisible in every other number.

Reconciliation: `at_risk_n` is exactly the At-Risk watchlist count (`no_date` + `stale_dated`) from
`at-risk-service.ts:53-75`, so the two surfaces tie out. Build it on the same scope — including
`aliasedReportableDealFilterSql('d')` (`server/src/modules/shared/deal-value-sql.ts:464`, which resolves to
`COALESCE(d.on_hold, false) = false`) — or the numbers will differ and one of them will be wrong. Note that
`parked_n` deals still satisfy that predicate: the far-out rule zeroes a deal's *value*, it does not set
the stored `on_hold` flag (§6.2). They remain in the denominator, which is the point.

### 4.2 Hit rate within tolerance

**Plain English:** of the deals that landed in the period **and carried a real prediction beforehand**,
what share landed within ±14 days of that prediction.

The denominator qualifier is load-bearing. If a landed deal has no P₃₀ — because the deal predates the
audit window, or because the rep never set a date, or because they cleared it (§4.0) — then
`signed_error_p30` is NULL, so the deal can never enter the numerator but would still sit in the
denominator. That silently converts "no prediction" into "a miss", which is the wrong charge: not
forecasting is a **coverage** failure (§4.1), measured there, and double-counting it here would punish the
same behaviour twice and make the two columns disagree about the same deal.

```sql
-- `scoreable` = landed AND a prediction actually stood 30 days out.
scoreable   = landed AND p30.had_event AND p30.prediction IS NOT NULL

hit_rate_14d = count(*) FILTER (WHERE scoreable AND abs(signed_error_p30) <= 14)
             / NULLIF(count(*) FILTER (WHERE scoreable), 0)
```

Report `landed_n` and `scoreable_n` as separate columns. A rep whose `scoreable_n` is far below their
`landed_n` is closing deals they never forecast — a real finding, and one that a single blended percentage
would hide. Every other error metric in §4.3 uses the same `scoreable` filter.

Also exclude parked predictions from `scoreable` — see §6.2 — so "park it in 2028, then set a real date the
week it closes" cannot buy a perfect hit rate.

Also emit `hit_rate_30d` (same shape, `<= 30`) and `hit_rate_14d_final` (same shape against P_final).

### 4.3 Mean and median signed error

**Plain English:** on average, how many days late (positive) or early (negative) does this rep's forecast
turn out to be. Both statistics, because the mean is where the long optimistic tail shows up and the median
is the number you can defend to a rep.

```sql
mean_signed_error_days   = avg(signed_error_p30)                                         FILTER (WHERE scoreable)
median_signed_error_days = percentile_cont(0.5) WITHIN GROUP (ORDER BY signed_error_p30) FILTER (WHERE scoreable)
p90_signed_error_days    = percentile_cont(0.9) WITHIN GROUP (ORDER BY signed_error_p30) FILTER (WHERE scoreable)
```

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
moves_per_deal = move_count / NULLIF(landed_n + overdue_open_n, 0)
```

The denominator is `landed_n + overdue_open_n`, **not** `landed_n` — the same denominator §4.6 uses for
`chronic_mover_rate`, and for the same reason. `move_count` is summed over every event on every one of the
rep's in-scope deals, including deals still open. Dividing that numerator by landed deals alone would count
moves on open deals in the numerator while excluding those deals from the denominator, inflating the rate
for exactly the reps carrying the most unresolved forecasts. The two rate metrics must share a denominator
or they will disagree about the same book.

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
silent_miss_n = count(*) FILTER (WHERE scoreable AND move_count = 0 AND abs(signed_error_p30) > 14)
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
durable per-field ledger of exactly these writes, so §4.0 anti-joins them out of the timeline. What remains:

- **Unverified: whether the refresh has ever run with `DRY_RUN=false` in production, and on how many
  deals.** The query is in §1.1.1. Run it before v1 ships. If it returns rows, also spot-check that the
  anti-join's ±1-minute window actually matches them.
- **Unverified: whether the reported 2026-07-30 "service deleted, damage reversed from `audit_log`" event
  touched close dates.** I found no such deletion and no reversal script in this repository. If a reversal
  ran, it was a write, and unless it also logged to `hubspot_refresh_log` the anti-join will not catch it.
- **Not closeable:** `scripts/migration-promote.ts` seeds `expected_close_date` at INSERT time with no
  distinguishing ledger. Those land as the deal's `insert` seed event in §4.0's UNION branch. They are
  probably confined to migration/promotion runs rather than the live tenant, but I could not confirm that
  from the code. Treat a deal whose *only* prediction is its insert-time seed as unscoreable until this is
  settled.

**Guidance for the evidence column:** surface NULL actors as "Unattributed" rather than dropping the
event — a NULL actor is a fact about the write, not a reason to hide it. But never infer "machine" from a
NULL actor, and never infer "rep" from a non-NULL one.

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

1. **Coverage (§4.1).** An open deal whose current date is more than 90 days out is `parked_n`, not
   `covered_n`. Without this, parking the book scores 100% coverage on the column the scorecard sorts by.
2. **Scoring.** A prediction more than 90 days beyond the deal's `stage_entered_at` at the moment it was
   made is a **parked prediction**: excluded from `scoreable` (§4.2) and therefore from hit rate and every
   error statistic, while still counted in `move_count`, `days_pushed_out` and the chronic-mover flag.
   Without this the winning strategy is "push everything to 2028, then set an accurate date the week it
   closes" — a perfect hit rate on a forecast nobody could plan with.

`parked_n` and `parked_prediction_n` are both columns on the rep row. Neither is a footnote: they are the
only visible trace of the single most effective way to game this metric.

### 6.3 Late re-dating is caught by the P₃₀ headline

§2.1. The headline error is measured against the standing prediction 30 days out, not the final call. A rep
who only gets it right in the last week shows a good `hit_rate_14d_final` and a bad `hit_rate_14d`, and both
are on the row.

### 6.4 Small denominators do not rank

A rep with two landed deals and two hits is not the best forecaster in the company. Require a minimum
denominator — proposed **5 landed deals in the period** — to appear in the ranking. Below it, show the row
with the real numbers and an "insufficient volume" marker, excluded from sort order. This is the same
discipline `at-risk-service.ts` applies by making every row its own evidence.

### 6.5 Clearing a date does not reset history — and does not leave the old date standing

A clear (`new_date IS NULL` on a deal that had one) is counted as a `clear_count` event and becomes a
coverage failure from that instant. It **does not** remove the deal's prior moves from `move_count`,
`days_pushed_out` or the chronic-mover flag. Deleting the evidence must not delete the record.

The mirror-image error is just as bad and is easy to write by accident: **a cleared date must not keep
counting as the standing prediction.** §4.0's `prediction_at` LATERAL takes the latest event before `T` and
returns *its* `new_date`, which is NULL when that event was a clear. Adding an innocent-looking
`AND new_date IS NOT NULL` to that subquery would reach back past the clear and resurrect a date the rep
deliberately removed — scoring them on a forecast they had withdrawn. The filter belongs on the *outcome*
of the LATERAL (`p30.prediction IS NOT NULL`, §4.2), never inside it. This is called out because the first
draft's prose said "last non-null value", which is precisely the wrong implementation.

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

| Column | §  |
|---|---|
| Coverage % (open deals with a usable, non-parked date) | 4.1 |
| **Parked n** (open deals dated >90 days out) | 4.1 / 6.2 |
| At-risk n (open deals undated or past-due) | 4.1 |
| Landed n | 2.4 |
| **Scoreable n** (landed *and* carried a prediction) | 4.2 |
| Hit rate ±14d (against P₃₀) | 4.2 |
| Median signed error (days) | 4.3 |
| Mean signed error (days) | 4.3 |
| Overdue-open n / median days overdue | 2.4 |
| Moves per landed deal | 4.4 |
| Chronic movers n | 4.6 |
| Silent misses n | 4.7 |
| **HubSpot-written events n** (diagnostic) | 2.5(b) |
| Bid-Board-owned n (diagnostic) | 2.5(c) |

Sorted by coverage, then hit rate. Reps below the volume floor shown but unranked (§6.4). The four columns
in bold were added after review: each one is the only visible trace of a specific way the report could
otherwise mislead, and dropping them for width is not a cosmetic decision.

**Evidence drill.** Clicking any cell opens the deal list behind it. Per deal: the full close-date timeline
from `audit_log` — `changed_at`, `old_date → new_date`, actor (display name, or "Unattributed"), whether
the event was excluded as HubSpot-written, and the matching Move Close Date note body when one exists
within a short window of the event (§1.7). Every number on the summary row is reachable this way.

**Conventions v1 must follow**, restated so they are not lost in implementation:

1. Won date **only** through `aliasedWonHsClosedWonDateSql`; Lost date as `d.lost_at::date`. No new
   COALESCE (§1.8).
2. Rep filter = `buildAliasedOwnedRepSql` — **owner, never estimator** (§3).
3. All period slicing through `server/src/lib/period.ts` (§1.9).
4. Timeline from the **trigger** rows only, selected by `changes ? 'expected_close_date'` (§1.3), **with
   the `hubspot_refresh_log` anti-join** (§4.0). The anti-join is not optional and not a follow-up.
5. Coverage built on the same scope as `at-risk-service.ts` so the two reconcile (§4.1).
6. Stage membership from `WON_STAGE_SLUGS` / `LOST_STAGE_SLUGS`, never hand-written slug lists (§1.8), and
   the terminal test must consult `bid_board_stage_slug` as well as the CRM stage (§4.0).
7. The 90-day horizon comes from `CLOSE_TARGET_HOLD_HORIZON_DAYS` (`shared/src/types/deal-hold-risk.ts:137`),
   imported, never hardcoded (§4.1).
8. "Open" means `outcome_kind = 'open'` from §4.0, never `pipeline_stage_config.is_terminal = false`.

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
- Handling `scripts/migration-promote.ts` insert-time seeds (§5.3). v1 treats an insert-only prediction as
  unscoreable; if the census shows those deals matter, revisit.

---

## 8. Open questions for the approver

1. **±14 days** — is that the tolerance the business would manage to, or is "landed in the right month"
   (±30) the real bar? Both are computed; only one should be the headline.
2. **P₃₀ as the headline** — is 30 days the forward visibility that matters, or is it 60 (a quarter's
   planning horizon)?
3. **Lost deals** — in or out of the accuracy number?
4. **Bid-Board-owned deals** — proposal is include-and-flag, with the outcome resolved from
   `bid_board_stage_slug` as well as the CRM stage (§2.5(c), §4.0). Confirm.
5. **Volume floor of 5 landed deals** for ranking — right number for a team this size?
6. **Has `scripts/refresh-from-hubspot.ts` ever run with `DRY_RUN=false` against production, and is it
   still expected to?** (§1.1.1) If it is part of an ongoing operational routine, the anti-join is
   permanent infrastructure rather than a one-off cleanup, and that should be stated on the report itself
   so future readers know the timeline is filtered.
7. **Reason capture (§5.1)** — accept the migration to make `deal_history.changed_by` nullable, or scope
   the reason writer to user edits only and accept the blind spot?

---

## Appendix: review corrections

This document was revised on 2026-08-04 after review found one premise-level error and five design
defects. Recording them because each was a case where the spec read as confident and was wrong, and the
pattern is worth remembering.

| # | Was | Now |
|---|---|---|
| P1 | "`expected_close_date` has no machine writer; every value was typed by a person" (§1.1) | False. `scripts/refresh-from-hubspot.ts` overwrites it from HubSpot. Rewritten §1.1 with the corrected writer inventory, plus §1.1.1/§1.1.2 on distinguishability and §4.0's `hubspot_refresh_log` anti-join. |
| P2-1 | Outcome CASE tested only `pipeline_stage_config.slug` | Also tests `bid_board_stage_slug`; mirror-terminal deals no longer fall into "open" (§4.0, §2.5(c)). |
| P2-2 | Coverage counted any today-or-future date | Parked dates (>90d) are excluded from the numerator and reported as `parked_n` (§4.1, §6.2). |
| P2-3 | Prose said "last **non-null** value before T" | The LATERAL returns the latest event's `new_date` *including* NULL, so a cleared date no longer stands (§4.0, §6.5). |
| P2-4 | Hit-rate denominator was all landed deals | Denominator is `scoreable` — landed *and* a prediction stood (§4.2). "No prediction" is a coverage failure, counted once, in §4.1. |
| P2-5 | "`deal_history` reason capture requires no migration" | False: `changed_by` is `NOT NULL REFERENCES public.users(id)` (`0067:85`). Two explicit options, one of which is a migration (§5.1). |

The P1 was found by review, not by me, and the reason is worth stating: my original sweep grepped for
write-shaped SQL (`INSERT`/`UPDATE`/`SET` near the column name). The HubSpot refresh builds its assignment
dynamically, so the column name appears only in an allowlist and the grep could not match it. The corrected
inventory was built by listing every file that mentions the field at all and reading each one — which is
also how `scripts/migration-promote.ts` turned up as a second, previously unnoticed machine writer.
