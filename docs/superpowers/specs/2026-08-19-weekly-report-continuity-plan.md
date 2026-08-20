# Implementation plan — weekly-report continuity, escalation, duration, photo speed

Spec: `2026-08-19-weekly-report-continuity.md`
Branch: `feat/weekly-report-continuity`, stacked on `feat/weekly-report-setup-roster` (#1089)

---

## Where the carry-over lives: the SERVER, at draft creation

`createWeeklyReportDraft` (`reports-service.ts:474`) already INSERTs
`projected_duration_weeks` copied off the project row. Percent, weather days and the carried
look-ahead go into that same INSERT, read from the previous report.

Doing it there rather than on the phone, for three reasons:

- **The phone does not have last week's report.** It holds a local draft store; the previous week's
  content lives on the server. Prefilling client-side means a second round trip and a second source of
  truth for "what was last week".
- **The CRM sees the same values.** A director opening a fresh week in the browser gets the same
  prefill as the superintendent, because there is one write.
- **It is already the idempotent path.** That INSERT has `ON CONFLICT DO NOTHING` and a
  submission-id retry arm, so a prefill written there inherits "applied exactly once" — which is the
  property §3 of the spec depends on to never overwrite typed text.

The phone changes are presentation only: show provenance, relabel the weather field.

---

## Step 1 — `previousWeeklyReportForCarryOver` (server)

New helper in `reports-service.ts`. Given a project id and the week being opened, return the most
recent report on an EARLIER week that reached `pending_review` or beyond.

```sql
SELECT completion_percent, weather_delay_days, next_week_look_ahead
  FROM weekly_reports
 WHERE weekly_report_project_id = $1::uuid
   AND is_active
   AND week_of < $2::date
   AND status <> 'draft'          -- a half-filled abandoned draft is not a statement about the job
   AND superseded_by_id IS NULL   -- a replaced version is not what the client was told
 ORDER BY week_of DESC, version DESC
 LIMIT 1
```

`superseded_by_id IS NULL` matters: carrying a percentage from a version that was corrected would
propagate the number the correction existed to fix.

## Step 2 — wire it into the draft INSERT

Three more columns on the existing INSERT. `completion_percent` and `weather_delay_days` copied
straight; `work_completed` set to the previous `next_week_look_ahead`.

Guard: only when the previous value is non-null. A null carries as null, not as `0` — "nobody has
said" and "zero percent complete" are different claims and the PDF prints them differently.

**Corrections are excluded.** `createWeeklyReportCorrection` is a separate path and must not prefill:
a correction restates a week that already went out, and seeding it from a different week's plan would
be wrong in the one case where the client is watching.

## Step 3 — carry-over is visible on the phone

`mobile/src/weekly-reports/draft.ts` — the draft hydrated from the server carries the prefilled values.

- Work Completed shows a "carried from last week's plan — edit as needed" note while the text is
  still exactly what was carried, and drops it once edited.
- Weather field relabelled to make the running total explicit, showing the carried-in number.

## Step 4 — weather-days wording, phone + PDF

`weather_delay_days` becomes a job-to-date total in what it SAYS, not in what it stores — the column,
the API and the arithmetic are unchanged. Only the labels move:

- phone field label
- `pdf.ts` schedule row label
- the CRM report view

## Step 5 — duration resolves live until the report is frozen

`report-view.ts:197`. Today: report's own → snapshot → project. Change the non-sent arm so a null on
the report falls back to the project's CURRENT value. Sent reports keep the snapshot untouched.

Plus the visibility half: the CRM send dialog and the setup form say when a project has no projected
duration, because the PDF renders that as an empty box.

## Step 6 — migration 0229: widen the reminder-kind CHECK

`weekly_report_reminders_sent_kind_check` lists exactly `t_minus_2 / t_minus_1 / due_digest`. Add
`rep_escalation`.

- DROP + ADD the constraint inside the per-office DO loop, guarded so a replay is a no-op.
- The `TENANT_SCHEMA_START/END` block as well — a new office provisioned after this deploy needs the
  widened constraint or its first escalation INSERT fails.
- Runtime suite proves the two halves apart, as 0228's does.

## Step 7 — the 17:00 escalation

`worker/src/jobs/weekly-report-reminders.ts`.

- New kind `rep_escalation` in the shared offset/kind table.
- Cron tick at 17:00 CT. **It computes only its own kind** — the 07/09/11 ticks have already claimed
  theirs, and an evening pass that re-evaluated `due_digest` would re-send the digest daily.
- Selects projects whose report for the due week has not reached `pending_review`.
- Recipient: the deal's `assigned_rep_id`, cc the project's PM (roster-resolved, per #1089). No rep →
  `weekly_report_settings.leadership_recipient_emails`, subject noting the job has no rep.
- Claimed once per project per week on `weekly_report_reminders_sent`, same build-then-claim ordering
  the other kinds use.
- **Probes for the new kind before writing**, because migrations do not run on the worker — same
  pattern as 0228's column probe, and the same INFO-and-skip on absence.

## Step 8 — photo speed on the public link

`public-routes.ts` + `public-viewer.ts`.

- The grid `<img>` points at a **variant** URL; the original stays reachable behind a click.
- The variant route resizes via `generateEvidenceJpeg` (already imported for HEIC) and sets a long
  `Cache-Control` — the token is the access control and the bytes are immutable.
- `loading="lazy"`, `decoding="async"`, explicit `width`/`height`.
- **Measured**: total bytes and request count for a real multi-photo report, before and after, recorded
  in the PR.

---

## Test plan

Runtime (PGlite, real migrations from disk):

| What | Why it is not obvious |
|---|---|
| Percent/weather carry from the last SUBMITTED report | A draft must not be the source |
| Nothing carries from a SUPERSEDED version | Or a correction's fix propagates forward |
| Nothing carries from a LATER week | A late filing must not inherit from the future |
| Null carries as null, never as 0 | "Unknown" and "zero" print differently |
| Work Completed seeded from the previous look-ahead | The feature |
| A CORRECTION prefills nothing | The one case the client is already watching |
| Prefill never overwrites existing content | Re-running the draft path is data loss otherwise |
| Duration resolves live on an unsent report | The reported bug |
| Duration on a SENT report stays frozen | The client's copy must not change under them |
| 0229 widens the CHECK in every office AND in the tenant block | Two halves, proved apart |
| Escalation fires once, to the rep, cc the PM | |
| No rep → leadership, subject says so | The failure the fallback exists for |
| Escalation does NOT fire once submitted | |
| The 17:00 tick does not re-send the day's digest | The specific regression the new tick could cause |
| Worker skips an office lacking the widened CHECK | Migrations do not run on the worker |

Every guard mutation-checked: break the source, confirm the intended test fails, revert.

## Order

6 → 7 (migration before the job that needs it), then 1–3, then 4–5, then 8. Photos last: it is the
only step with no data-correctness risk, so it is the one to drop if something above needs the time.

## Deploy notes

- 0229 runs on the API deploy; the worker probes and skips until it lands.
- The 17:00 cron is new — worker restart required, and it should first fire on a day when somebody is
  watching.
- No new env vars.
