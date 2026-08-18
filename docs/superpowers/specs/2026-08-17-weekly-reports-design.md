# Weekly Reports — design

Date: 2026-08-17
Status: approved, not yet implemented
Surfaces: CRM (`/projects/weekly-reports`), T-Rock Cam (`mobile/`), API, worker, public viewer

## Problem

PMs and superintendents produce a weekly client-facing progress report today by hand, outside the
platform. The people doing the work are not technical, the format drifts, and nobody can answer "who
hasn't sent theirs this week?" without asking around.

The reference artifact is `Cedar Springs Weekly Update Report 08_13_26.pdf` — two pages:

- **Page 1** — red header band (logo / "Weekly Progress Summary" / Week of), black Property Name box,
  Work Completed–In-Progress, Next Week Look Ahead, Client + Client Team (DOC/PM/RM/CM), T-Rock Project
  Team (PM/SUPER), Issues/Concerns, Project Schedule (contract date, start, completion, completion %,
  weather delays), Project Duration bars (Projected black arrow, Remaining red arrow).
- **Page 2** — "Weekly Progress Photos" band and a three-across photo grid.

Goal: the superintendent produces that report on a phone in a few minutes, largely by talking; the PM
reviews it; the client receives an email with a durable link and a PDF; and leadership can see at a
glance who is late.

## Decisions

Settled during design, with the reasoning that drove each:

| Decision | Choice | Why |
|---|---|---|
| Project identity | Config row linked to a **Won deal** | T-Rock Cam photos are keyed to a deal (`/api/field/projects/:dealId/...`); without a deal link there is no photo pool. Keeps the ~15 report-only fields off `deals`. |
| Weekly numbers | Super enters completion % and weather delays; remaining weeks computed | Prefilled from last week so it is a nudge, not re-entry. Computed remaining can't drift. |
| Client link | Branded web page **and** PDF attached | Reuses the proven `/p/:token` pattern; readable on a phone without a download. |
| Notifications | Email only for v1, with deep links | `expo-notifications` is not installed, there is no device-token table, no APNs credentials, and `mobile/` is not covered by CI. Push is a clean follow-on. |
| Approval | PM gate is **mandatory** | Nothing reaches a client without an explicit PM send. A PM may author from scratch, landing directly in their own review state. |
| Dictation | Existing whisper endpoint + a server-side bullet-formatting pass | `whisper-1` returns one unformatted paragraph; the report format is dash bullets. No new vendor. |
| `week_of` | The cadence due date for that week | Matches the sample (8/13/26 is a Thursday). Auto-filled, PM-overridable. |
| Client team | Name + optional email on the config row | RM and CM are frequently blank in practice; requiring CRM contact records would block setup. |
| PM review surface | **Both** CRM and T-Rock Cam | Explicitly requested. Mitigated by composing validation and the email draft server-side (below). |
| After send | Locked; corrections create a **v2** | A client who saved a link must never see it silently change. |
| Missed weeks | Stay outstanding and keep aging | Losing the signal that a week was skipped defeats the tracking. |

### Open question deferred

Wispr Flow was mentioned as the dictation backend on the assumption it returns pre-formatted text. It is
primarily a desktop/iOS keyboard dictation product and it is not established that it publishes a
transcription API usable from React Native. v1 uses the whisper endpoint already in production. If a
Wispr Flow API is confirmed later, it is a drop-in swap behind `transcribeAudio`.

## Architecture

Existing machinery this rides on, rather than reinventing:

| Need | Reuse |
|---|---|
| Per-office schema migration | `0172_field_scorecards.sql` — tenant `DO` loop + `TENANT_SCHEMA_START/END` |
| Draft → submit → PDF → email | `field_scorecards` + `worker/src/jobs/field-scorecard-email.ts` |
| Photo select + per-photo caption | `mobile/src/components/ReportBuilder.tsx` |
| Dictation | `mobile/src/dictation/transcribe.ts` → `POST /api/field/photos/transcribe-description` |
| Durable public link | `public.public_photo_tokens` (SHA-256 hashed) + `publicViewerBaseUrl()` |
| PDF rendering | `server/src/modules/field/pdf-layout.ts`, `pdf-logo.ts`, bundled Geist fonts |
| Immutable artifact keying | `server/src/modules/field/scorecard-pdf-artifact.ts` |
| Long job + phone polling | `0209_field_ai_report_runs` — enqueue to `job_queue`, poll an opaque uuid status row |
| Resumable mobile drafts | `mobile/src/scorecards/draft-store.ts`, incl. the #938 photo-URI rebase |
| Cron | `node-cron` in `worker/src/index.ts` |

### Both-surfaces without doubling the logic

The PM can review and send from the CRM or the app. To keep that from meaning two implementations of
every rule, the server owns everything except pixels:

- Field-level edit permissions are returned with the report payload, not re-derived per client.
- The email draft (subject, body, default recipients) is **composed server-side** and returned as data.
  Both clients render the same text and post the same mutation.
- State transitions are a single server-side machine; clients call intent endpoints
  (`submit`, `approve`, `send`), never write `status` directly.

Duplication is therefore confined to presentation.

## Data model

Migration `0222_weekly_reports.sql`. Per-office (`office_*`) schema, tenant loop plus the
`TENANT_SCHEMA_START/END` block for new-office provisioning. Skip any office missing `deals` or `files`
rather than creating a partial schema, matching 0172.

### `weekly_report_projects`

The setup row. One per deal; every column editable from the CRM dashboard, because PMs and supers change
mid-project.

- `id`, `deal_id` (FK → `deals`, cascade), `property_display_name`
- `client_name`
- `client_doc_name` / `client_doc_email`, and the same pair for `pm`, `rm`, `cm`
- `trock_pm_user_id`, `trock_super_user_id` — T-Rock Cam login roster
- `contract_date`, `project_start_date`, `project_completion_date`
- `contract_date_note`, `project_start_date_note`, `project_completion_date_note`
- `projected_duration_weeks`
- `cadence_weekday` (0–6), `cadence_start_date`, `cadence_end_date`
- `status` (`active` | `paused` | `completed`), `is_active`, `created_by`, `created_at`, `updated_at`
- `UNIQUE (deal_id) WHERE is_active`

The `_note` columns exist because the sample prints **"TBD Permit"** where a date belongs. A nullable date
plus a note beats degrading the column to text and losing date arithmetic.

### `weekly_reports`

One row per project per week.

- `id`, `client_submission_id uuid UNIQUE` (mobile idempotency, as `field_scorecards` does)
- `weekly_report_project_id` (FK, cascade), `deal_id` (denormalised for photo/office queries)
- `week_of date`, `version int NOT NULL DEFAULT 1`, `superseded_by_id uuid NULL`
- `status` — `draft` | `pending_review` | `approved` | `sent`
- `work_completed`, `next_week_look_ahead`, `issues_concerns`
- `completion_percent numeric(5,2)`, `weather_delay_days int`, `remaining_weeks int`,
  `projected_duration_weeks int`
- `snapshot jsonb` — the entire header block frozen at send time
- `authored_by` / `authored_at`, `submitted_by` / `submitted_at`, `reviewed_by` / `reviewed_at`,
  `sent_by` / `sent_at`
- `pdf_r2_key`, `pdf_r2_bucket`, `pdf_generated_at`, `pdf_render_version int`
- `send_attempts int`, `send_error text`
- `is_active`, `created_at`, `updated_at`
- `UNIQUE (weekly_report_project_id, week_of, version) WHERE is_active`

`snapshot` is the reason swapping a PM in September does not silently rewrite August's reports. The live
config drives the *next* report; sent reports read from their snapshot.

### `weekly_report_photos`

- `id`, `weekly_report_id` (FK, cascade), `file_id` (FK → `files`, cascade)
- `caption text` — **report-specific**
- `sort_order int`, `created_at`
- `UNIQUE (weekly_report_id, file_id)`

Editing a caption here never writes `files.description`. The requirement that changing a report caption
must not change the original capture description is enforced by the schema, not by discipline.

### `weekly_report_settings`

Per-office, single row. Holds `leadership_recipient_emails text[]` — seeded with Adam, Takashi and
Adnaan, editable in the CRM. No names in code.

### `weekly_report_dismissals`

`(weekly_report_project_id, week_of)` unique, plus `dismissed_by`, `dismissed_at`, `reason text NOT NULL`.

A missed week has **no** `weekly_reports` row — nobody started one — so the dismissal cannot live on the
report. Expected weeks are generated from the cadence and left-joined against both this table and
`weekly_reports`; a week with neither is "Not started" and keeps aging.

### `weekly_report_pauses`

`weekly_report_project_id`, `paused_from date NOT NULL`, `resumed_on date NULL`, `paused_by`,
`resumed_by`. One OPEN interval per project at most (`UNIQUE (weekly_report_project_id) WHERE resumed_on
IS NULL`). Migration 0223.

`status` answers only "is this project reporting today", and the expected weeks are regenerated from
`cadence_start_date` on every read — so without this ledger a project paused for six weeks came back
owing all six as missed and late, contradicting the form's own promise that pausing stops weeks being
generated. The interval is half-open `[paused_from, resumed_on)`: the week due on the day reporting
stopped is not owed, the week due on the day it resumed is, and the weeks missed **before** the pause
stay outstanding. Recording the interval rather than advancing `cadence_start_date` is what keeps those
earlier misses — and the answer to "when did we start reporting to this client".

### `weekly_report_reminders_sent`

`(weekly_report_project_id, week_of, kind)` unique, where `kind` ∈ `t_minus_2` | `t_minus_1` |
`due_digest`. Worker restarts are routine; without this the reminders double-send.

### `public.weekly_report_tokens`

Global, not per-office — the public route must resolve a token to its office before choosing a
`search_path`, the same reasoning documented in `0209`.

- `token text UNIQUE` — **SHA-256 hash**; the raw token appears only in the URL
- `weekly_report_id`, `tenant_id`, `office_slug`, `created_by_user_id`
- `expires_at` = now() + 180 days, `revoked_at`, `created_at`

## CRM — `/projects/weekly-reports`

Third entry in the Projects hover flyout beside All Projects and QC Reports
(`client/src/components/layout/sidebar.tsx`), mirroring `qc-reports-page.tsx` in structure.

**This Week** (default) — one row per project with a report due this cadence week: status chip
(Not started / With super / Pending PM review / Approved, not sent / Sent / Send failed), who it is
blocked on, due date, days late. Overdue sorts first, then due soonest. Missed weeks from prior weeks
remain listed with their age until filed or explicitly dismissed with a recorded reason.

The row set is **generated from the cadence, not read from `weekly_reports`** — expected weeks are
derived from `cadence_weekday` between `cadence_start_date` and today, then left-joined against
`weekly_reports` and `weekly_report_dismissals`. A week matching neither is "Not started". Reading the
reports table alone would make an untouched week invisible, which is precisely the case this page exists
to surface.

**Projects** — the setup list and "New weekly report project". Per row: reports sent, last sent, next
due. The setup form picks a Won deal and fills the standing fields.

**History** — per project, every `week_of`, opening the shared detail drawer: download PDF, copy client
link, re-send, issue a correction.

Sorting uses the shared `useTableSort` hook (numeric-not-lexical, nulls last).

### Traps to design around

- The deal picker **must** pass `scope=all`. `GET /deals` silently defaults to `scope=mine` and this has
  already shipped as a bug in two other pickers, caught by review bots rather than tests.
- PM/Super pickers draw from the T-Rock Cam login roster (accepted `field_user_invites` joined to
  `users`), **not** `deal_team_members`, which is empty in production.
- `requireCrmUser` currently admits `construction`-role users to every CRM route. These routes need a
  tighter gate or superintendents will see the full leadership dashboard.

## T-Rock Cam

The tab renames **Scorecard → Reports** and points at a new `mobile/app/(app)/reports/` group whose index
is a hub with three entries: Project Scorecard, Leadership Scorecard, Weekly Report. The existing
`scorecards/*` routes stay in place as a hidden group (`<Tabs.Screen name="scorecards" options={{ href: null }} />`,
the pattern already used for `dev-wearables` and `walk`), so existing drafts and deep links keep working.

### Superintendent wizard

Resumable local draft throughout, reusing `scorecards/draft-store.ts` including the #938 photo-URI rebase
on resume (blank photos otherwise appear after an iOS container-UUID rotation).

1. **Pick project** — projects where the signed-in user is the assigned super and a report is open or
   due. `week_of` auto-fills to the cadence due date.
2. **Work Completed / In-Progress** — type or dictate.
3. **Next Week Look Ahead** — type or dictate.
4. **Issues / Concerns** — type or dictate.
5. **Progress numbers** — completion %, weather delay days, both prefilled from last week.
6. **Photos** — deal photos from the 14 days ending on `week_of`, newest first. Multi-select; anything
   already used in a prior report is flagged so it is not repeated. Per-photo caption defaults to the
   original capture description and is editable. Reorder. Import from device always available (imports
   go through the normal upload path so they become `files` rows).
7. **Review** → Submit for PM review.

Dictation posts to the existing transcription endpoint, then a server-side formatting pass returns dash
bullets into an editable box — the super can fix anything the model got wrong before it moves on.

### PM review

A pending queue on the hub. Opens the same wizard in review mode with every field, photo and caption
editable, ending in **Approve & Send**.

## Send and client delivery

The send modal is identical on both surfaces because the server composes it:

- **Recipients** prefilled from whichever client-team roles carry emails; PM can add, remove or type free
  addresses.
- **Subject** — `{Property Name} — Weekly Progress Report, Week of 8/13/26`.
- **Body** — `Hello {first name},` + an editable context paragraph + `Here's the link to your weekly
  report: {link}` + the T-Rock PM's name, email and phone.
- **PDF attached**, toggleable.

On send the API stamps `approved`, mints the 180-day token **synchronously** so the modal shows the real
URL, then enqueues a `weekly_report_send` job. The worker renders the PDF, uploads to R2 under a
content-addressed key, sends via Resend with the attachment, and stamps `sent_at`.

`send_attempts` and `send_error` surface as a **Send failed** chip with retry on the dashboard. The
existing scorecard email path is fire-and-forget; here a silent failure means a client never received
their report and nobody finds out.

### Corrections

A sent report is immutable. **Send correction** clones it to `version + 1` with a fresh token and PDF,
sets `superseded_by_id` on the original, and emails the client noting it is a revision. The original link
keeps resolving and shows a "a newer version was issued" banner.

### The public link

`https://<share-host>/wr/<rawToken>`, served by the **API service** so the viewer is same-origin with
`/api` — the constraint documented in `public-share-url.ts`. The field host `trockcam.com` serves the
field app and has no such route, and overloading `FRONTEND_URL` drags CORS in.

The page is a mobile-first render of the report — header band, three text sections, schedule block,
duration bars, photo grid with captions — plus Download PDF. `noindex`. An expired or revoked token shows
a friendly page naming the T-Rock PM and their email.

> **Deploy prerequisite (Adnaan):** `PUBLIC_SHARE_BASE_URL` must point at a branded host on the API
> service, e.g. `reports.trockcam.com`. Outbound links currently resolve to the raw Railway subdomain,
> and `crm.trockconstruction.com` has no DNS. Needed before the send flow ships.

## PDF

Rendered with `field/pdf-layout.ts`, `pdf-logo.ts` and the bundled Geist fonts, reproducing the sample.

Page 1: red header band (logo | title | Week of), black Property Name box, right column of Client /
Client Team / T-Rock Project Team, the two text boxes, and the bottom row of Issues/Concerns, Project
Schedule and the black-and-red Project Duration arrows.

Page 2+: "Weekly Progress Photos" band, three-across grid, caption beneath each photo, overflowing at six
per page.

Content-addressed immutable key with a `pdf_render_version`, following
`scorecard-pdf-artifact.ts`, so regeneration is cheap and cache-safe.

## Reminders

One cron at **07:00 America/Chicago** daily → `worker/src/jobs/weekly-report-reminders.ts`. For each
office and active project, derive this week's due date from `cadence_weekday`:

- **due − 2 days** — email super and PM: report due {day}.
- **due − 1 day** — email super and PM **only if not yet submitted**. Silent when done, so it keeps
  meaning something.
- **due date** — one digest to `leadership_recipient_emails`: completed vs outstanding across all
  projects, with names.

Idempotent via `weekly_report_reminders_sent`.

Every email link lands on a small page offering **Open in T-Rock Cam** (custom scheme via `expo-linking`,
already installed) with a web fallback. Proper universal links need apple-app-site-association hosting —
out of scope here.

## Testing

Project-specific traps that will otherwise produce a false green:

- Server: `npm run test:ci`. Plain `cd server && npx vitest run` skips ~35 files including every
  `*.runtime.test.ts`.
- Worker: coverage must live in `worker/tests/jobs/`. Tests under `worker/src` never run in the gate.
- Any new `shared/` subpath import needs a vitest alias or roughly 19 suites break; only `test:ci` shows it.
- Typecheck per package with `shared` built. Root `npx tsc --noEmit` prints help and proves nothing.
- **`mobile/` is not in CI.** The wizard, the hidden-tab restructure and draft resume get manual device
  verification or they ship unchecked.
- Run date-sensitive tests under `TZ=UTC`; cadence and `week_of` arithmetic is business-timezone
  (America/Chicago), so bounds must be asserted deliberately rather than by whatever the runner's clock says.
- No prettier in this repo — source is hand-formatted and a format pass buries the diff.
- The migration needs **both** the tenant `DO` loop and the `TENANT_SCHEMA_START/END` block.

Coverage worth writing: the state machine's illegal transitions; `week_of` derivation across cadence
weekdays and DST boundaries; `remaining_weeks` arithmetic; the 14-day photo window anchored on `week_of`
rather than now; caption isolation from `files.description`; reminder idempotency across a simulated
worker restart; token expiry and revocation; correction versioning leaving the original link resolvable.

## Rollout

Six independently mergeable PRs, stacked. PRs 1–3 deliver the tracking dashboard before any delivery
machinery exists, which is the half that solves "who hasn't sent theirs".

| PR | Scope |
|---|---|
| 1 | Migration 0222 + server module: config CRUD, report CRUD, state machine |
| 2 | CRM dashboard — setup, This Week, History |
| 3 | Mobile Reports tab + superintendent wizard + drafts |
| 4 | PDF renderer + public viewer page + token minting |
| 5 | Send flow — modal on both surfaces, worker send job, corrections |
| 6 | Reminder cron + leadership digest + settings |

Merge bottom-up. Stacked PRs on a non-default base do not trigger the review bots automatically and need
manual triggering.

## Out of scope

- Push notifications (`expo-notifications`, APNs credentials, device-token table). `mobile/eas.json` also
  still has no TestFlight group, so distribution to supers is a separate blocker.
- Universal links / apple-app-site-association.
- Backfilling reports sent before this shipped. Existing in-flight projects get a `cadence_start_date`
  and begin fresh.
- Wispr Flow integration, pending confirmation that a usable API exists.
