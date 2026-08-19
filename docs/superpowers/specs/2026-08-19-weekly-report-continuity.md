# Weekly Reports — continuity, escalation, duration and photo speed

Status: spec
Date: 2026-08-19
Stacked on: #1089 (`feat/weekly-report-setup-roster`) — touches `pdf-service.ts` and
`weekly-report-reminders.ts`, both of which that PR also changes.

---

## Why

Five things, from using the shipped feature for a week.

Three of them are the same underlying problem: **each week's report is written as if no report ever
came before it.** The superintendent re-types the completion percentage, re-adds up the weather days,
and goes and reads last week's report to remember what was promised. The system holds every one of
those facts and offers none of them.

One is a bug: a projected duration entered on the project does not reach the report that prints it.

One is performance: the client opens the share link and waits on full-resolution camera photos.

---

## 1. Percent complete carries forward

**Today.** `mobile/src/weekly-reports/draft.ts:180` starts every new draft with
`completionPercent: ""`. Week 8 begins blank exactly like week 1.

**Change.** A new draft prefills `completionPercent` from the most recent report on that project that
reached `pending_review` or beyond, on an EARLIER week.

**Why that predicate.** A draft somebody abandoned half-filled is not a statement about the job. Only a
report the superintendent actually submitted is. And `week_of <` rather than "latest row", so a
correction drafted over week 7 does not become the baseline for a week 6 report being filed late.

**The value only moves forward by hand.** It is a prefill, not a computation — nothing derives percent
from elapsed time. Prefilling last week's number means an unchanged week reads as unchanged, which is
the truthful default; the alternative (blank) reads as "nobody knows".

## 2. Weather delay days carry the RUNNING TOTAL

**Decided:** cumulative for the job, not per-week. The client sees the total time weather has cost.

**Today.** Blank every week, same line as above.

**Change.** Prefill from the same source report's `weather_delay_days`. The superintendent adds this
week's days to it.

**The label has to change with it.** A field that prefills 5 and means "5 so far" but is labelled
"Weather delay days" invites somebody to type 2 for this week's two days and silently reset the job
total to 2. The phone field and the PDF row both get wording that says *to date*, and the phone shows
what it carried in from so the number is checkable.

**Explicitly NOT auto-summed.** The system does not add this week's days to last week's total on the
user's behalf, because it cannot tell a corrected total from a new week's addition. Prefill and let a
human own the number.

## 3. Last week's Look Ahead prefills this week's Work Completed

**Decided:** prefilled directly into the field, freely editable.

**Today.** `nextWeekLookAhead` is written every week and read by nobody afterwards. To find out what was
promised, the superintendent opens last week's report.

**Change.** On a NEW draft, `workCompleted` is seeded with the previous report's `nextWeekLookAhead`.

**Three rules that matter more than the feature.**

- **Fresh drafts only.** Never on resume, never on a correction, never when `workCompleted` already
  holds anything. The draft store persists across app restarts; re-applying a prefill over typed text
  is data loss.
- **The provenance is shown.** The phone marks the section as carried over from last week, so a
  superintendent knows the words are a plan rather than a record. Without that, the risk is a report
  going to a client stating that work was completed because nobody edited the default.
- **It does not weaken the send gate.** `transitionWeeklyReport` already refuses to move a report
  forward with an empty `work_completed`, and prefilled text satisfies it. That gate was protecting
  against an EMPTY section, not an unread one, and this change means "non-empty" no longer implies
  "somebody wrote it". Called out here because it is a real reduction in what that check proves.

## 4. 5pm escalation to the assigned sales rep

**Decided:** to the sales rep, cc the assigned PM. With no rep on the deal, fall back to the leadership
digest recipients and say so in the subject.

**Today.** The reminder cron runs 07:00 with catch-up at 09:00 and 11:00 CT, in three kinds:
`t_minus_2`, `t_minus_1`, `due_digest`. All of them reach the superintendent, the PM, or leadership.
After 11:00 on the due day nothing else happens, ever.

**Change.** A fourth kind — the report is still unsubmitted at **17:00 CT on its due date**, and the
person who owns the client relationship is told.

- Recipient: `deals.assigned_rep_id` → `public.users`, cc the project's PM (roster-resolved login).
- No rep: the office's `weekly_report_settings.leadership_recipient_emails`, subject noting the job has
  no rep assigned — a missed client report must not go unescalated because a field was blank.
- Fires once per project per week, on the same claim ledger the other kinds use.
- Only when the report has NOT reached `pending_review`. A report sitting with the PM is not the
  superintendent's problem and is not this email's business.

**Needs a migration.** `weekly_report_reminders_sent.kind` carries a CHECK constraint listing exactly
the three existing kinds. A fourth kind INSERTs into a constraint that rejects it, so the constraint
widens first — per-office DO loop plus the `TENANT_SCHEMA` block, and the worker probes for the new
kind before writing, because migrations do not run on the worker.

**Timing note that shaped the design.** The existing ticks are 07/09/11. Adding a 17:00 tick means the
job runs when the earlier kinds are all long claimed, so the new tick must not re-evaluate them — it
computes only its own kind or it will re-send the day's digest every evening.

## 5. Projected duration must reach the report that prints it

**The bug.** `projected_duration_weeks` is copied from the project onto the report in exactly one
place: the `draft → pending_review` transition (`reports-service.ts:939-946`). `report-view.ts:197`
then reads the report's OWN column first. So a duration set on the project after the report was
submitted never reaches it, and a sent report is frozen without one forever.

**What production shows.** Two projects, and they disagree:

| Project | project duration | report duration | outcome |
|---|---|---|---|
| Monaco on the Trail | 2 | 2 | prints correctly |
| Haven Lake Highlands | NULL | NULL | prints blank |

Haven Lake's `created_at` equals its `updated_at` — it was created once and never edited, so its
duration was never saved at all. The reported symptom is therefore only partly the stamping bug: for
that project there was nothing to stamp.

**Change, in two parts because there are two failures.**

1. **Resolve live until the report is frozen.** For a report that has not been sent, fall back to the
   project's current duration when the report's own is null. A sent report keeps its snapshot — that is
   the whole point of the snapshot, and a client's copy must not silently change.
2. **Make the gap visible before it prints.** The CRM says, on the send dialog and on the setup form,
   when a project has no projected duration — because the PDF renders that as a blank box and nobody
   notices until the client has it.

**Not doing:** back-filling durations onto reports already sent. Their snapshot is the record of what
the client received.

## 6. Photos on the public link are slow

**Today.** `public-viewer.ts:220` emits one `<img>` per photo at
`/wr/:token/photos/:fileId`, and that route streams the **full original object** from R2
(`public-routes.ts:398`). Camera originals are multi-megabyte; the grid displays them at a third of
viewport width. There is no lazy loading and no intrinsic sizing, so every image is fetched at once and
the page reflows as each lands.

**Change.**

- Serve a **resized variant** for the grid. `lib/image-thumbnail.ts` already has `generateEvidenceJpeg`,
  used today only on the HEIC path.
- `loading="lazy"` and `decoding="async"` so photos below the fold do not compete with the ones on it.
- Explicit `width`/`height` so the page stops reflowing.
- Cache headers on the variant. The token is already the access control; the bytes behind it are
  immutable.
- Full resolution stays reachable — clicking a photo opens the original.

**Measured, not assumed.** The current payload is recorded before the change and after, and the numbers
go in the PR. "Feels faster" is not a result.

---

## Out of scope

- Auto-computing percent complete from the schedule.
- Any change to what the client's PDF looks like beyond the two label changes in §2 and the duration in
  §5. The layout review is a separate pass the user is doing from the phone.
- The Issues/Concerns box overflow (known, separate).

## Risks

| Risk | Mitigation |
|---|---|
| Prefilled look-ahead sent unedited, claiming work that did not happen | Provenance shown on the phone; §3 states plainly that the non-empty gate proves less than it did |
| Weather total reset by somebody typing this week's days | Label says "to date"; phone shows the carried-in value |
| 17:00 tick re-sends the day's earlier reminders | New tick computes only its own kind; existing claims untouched |
| Worker runs before the CHECK widens | Probe for the kind, skip the office, same pattern as 0228 |
| Thumbnail generation adds latency to the first view | Variant cached; permit model already exists in image-thumbnail.ts |
