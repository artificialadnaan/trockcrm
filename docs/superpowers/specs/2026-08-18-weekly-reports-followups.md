# Weekly Reports — the five deferred follow-ups

Companion to `2026-08-17-weekly-reports-design.md`, which specified the feature, and to PR5 (the send
flow), which is the last piece of it still in flight. This spec covers the five things PR5 deliberately
did **not** do.

Each was deferred for a stated reason, not forgotten. This document records what each one actually
requires, what is already in place for it, and what would go wrong if it were built the obvious way.

---

## Sequencing — read this before branching

Three of the five depend on code that exists **only on PR5's branch** (`feat/weekly-reports-send-v2`),
which is not merged. Two do not.

| # | Follow-up | Base | Why |
|---|---|---|---|
| 1 | Field-route send | **PR5** | needs `send-service.ts`, `send_request`, migration 0226 |
| 2 | Bounce webhook | **PR5** | correlates on `send_delivery_key`, added by 0226 |
| 3 | Dead-letter sweep | **PR5** | sweeps 0226's partial index, ages on `send_last_attempt_at` |
| 4 | Server-side dictation | `main` | touches the #1073 wizard only |
| 5 | Deep-link flag | `main` | touches `weekly-report-reminders.ts` (#1072) and mobile only |

**Build 4 and 5 off `main` so they can merge independently.** Stack 1–3 on PR5 and merge them
**bottom-up**, after PR5 lands. This repo has lost work to stacked-PR merge ordering before, and a
non-default base means the review bots must be triggered by hand rather than firing on push.

---

## 1. The field-route send

### The problem
Today the person who *should* send the report is the one person who **cannot**. The CRM router gates on
`admin | director` (`requireWeeklyReportSender`, `routes.ts:465`), and `ASSIGNABLE_ROLES` — who may hold
the PM slot at all — is `field_contractor | construction | admin | director`. Intersect those and the
assigned-PM arm can only ever fire for somebody who is already leadership. A `construction` PM, which is
the normal case, gets 403 at the router before any permission logic runs.

This was not an oversight and **must not be fixed by widening the CRM router**. That router is the
office-wide leadership board, the client contact book and the dismissal ledger; admitting `construction`
there would hand every superintendent the whole surface, and it collides with the open construction-role
CRM boundary issue. The sanctioned path is the field mount.

### What is already in place
More than it looks:

- `canPublishWeeklyReport(project, actor)` **already has the assigned-PM arm**, and
  `publication-gates.test.ts:16` pins `{id: PM, role: "construction"} → true`. `routes.ts:573` says in so
  many words that this arm "exists for the field mount." The policy is written; nothing consumes it.
- `field-routes.ts` already mounts `requireFieldContractor + tenantMiddleware` and exposes the report
  lifecycle: create, read, patch, photo-candidates, photos, transition.
- `field-routes.ts:247` already has the transition endpoint, with an **explicit placeholder**:

  ```
  if (req.body?.to === "sent") {
    throw new AppError(409, "Sending a weekly report is not available in the app yet");
  }
  ```

  The comment beneath it states exactly why a naive removal is unsafe: the service *would* let a PM reach
  `sent`, and the effect would be a report stamped `sent_by`/`sent_at` with its header frozen and
  **nothing delivered** — permanently immutable, invisible on the dashboard as outstanding, and with no
  way back.

### What to build
1. Remove the 409, but **only together with** the endpoints that make `sent` mean something.
2. Add the field counterparts of the four leadership send endpoints, gated by `canPublishWeeklyReport`
   rather than `requireWeeklyReportSender`:
   `GET /reports/:id/send-draft`, `POST /reports/:id/send`, `POST /reports/:id/send/retry`,
   `POST /reports/:id/correction`.
3. **Reuse `send-service.ts`.** Do not reimplement the transition. The synchronous token mint must stay
   inside the same commit as the `approved → sent` transition, or a report can be `sent` with no link.
4. Mobile: a send screen in `mobile/app/(app)/reports/`, on top of `mobile/src/weekly-reports/`.

### Failure modes to design against
- **The gate must be the service's, not the router's.** A superintendent posting `{"to":"sent"}` from a
  patched build must be refused by `canTransitionAs`, exactly as the existing comment promises for
  `approved`. A router-only gate is bypassable.
- **The raw share token exists exactly once.** It is returned to the caller and stored nowhere; only its
  SHA-256 hash lives in `public.weekly_report_tokens`. The mobile client must not log it, persist it to a
  draft store, or include it in crash telemetry.
- A test that gates on the *router* proves nothing about the service. Pair every refusal test with a
  **control** proving the assigned PM's send still executes.

---

## 2. The bounce / delivery webhook

### The problem
`send_delivered_at` currently means "Resend accepted the API call" and nothing more. A typo'd client
address reads as **delivered forever**. The surfaces were carefully worded so nothing overclaims, but the
underlying fact is still missing: nobody learns that the client never received the report.

### What to build
A provider webhook that turns delivery into a real fact, distinguishing at minimum `delivered`,
`bounced` (hard vs soft) and `complained`.

**Correlate on `send_delivery_key`.** 0226 already mints it per send request as the provider's
idempotency key, so it is the one identifier that survives a retry and is stable across the worker
restarting mid-send. Do not correlate on a recomposed identity (recipient + subject + week), which
collapses the moment a correction goes to the same client for the same week.

### Failure modes to design against
- **Webhooks arrive out of order and more than once.** A late `delivered` must not overwrite a later
  `bounced`. Order by the provider's event timestamp, not arrival.
- **The endpoint is public.** It must verify the provider's signature, and it must not leak whether a
  given delivery key exists.
- A bounce for **version N** must not mark version N+1 undelivered, and vice versa — corrections share a
  client and a week but not a delivery key.
- `send_delivered_at` keeps its current meaning (*accepted*) or gains a sibling; **do not silently
  redefine it**, because the board, the chip and the sweep all read it.

---

## 3. The dead-letter sweep and proactive alerting

### The problem
PR5 shipped **surfacing, not alerting**. An undelivered send is visible on the board and the Projects
tab, but nothing tells anyone — somebody has to go and look. The failure this feature exists to surface
can still pass unnoticed.

### What is already in place
Migration 0226 built the exact row set a sweep would run, and kept it partial so it stays tiny:

```sql
CREATE INDEX weekly_reports_send_undelivered_idx
  ON <office>.weekly_reports (weekly_report_project_id, week_of)
  WHERE is_active AND status = 'sent' AND send_delivered_at IS NULL;
```

### What to build
A worker sweep over that index, plus a notification.

**Age stalled sends against `max(sent_at, send_last_attempt_at)`.**

⚠️ **Corrected 2026-08-18, during implementation.** This section originally said "against
`send_last_attempt_at`, **never** `sent_at`", and taken literally that is **wrong** —
`send_last_attempt_at` is NULL in precisely the case this feature exists for, a job that dead-lettered
having written nothing. PR5's board already had it right: `lastSendActivityAt` takes the later of the
two. B3 moved that arithmetic and the stall constant into `shared/src/lib/weeklyReportSendStall.ts` so
the board and the sweep cannot disagree — otherwise the sweep could announce a stall the board is still
rendering as "Sending…".

The *intent* behind the original wording stands and is what to preserve: **never age off `sent_at`
alone.** That is the specific bug 0226 was written to fix — `sent_at` is stamped once when the sender
commits and never moves, so every legitimate retry read as "Send stuck". And `send_attempts` alone
cannot distinguish "failed twice an hour ago and gave up" from "failed twice in the last minute and is
still retrying", which is the whole difference between a chip somebody must act on and one they should
leave alone.

### Failure modes to design against
- **Migrations do not auto-run on the worker in this repo.** The API runs the runner before start; the
  worker does not. Reason explicitly about the deploy window in which the worker is live and the column
  is not yet there.
- **A sweep that alerts on every pass is a sweep everybody mutes.** Alert on a state *transition* into
  stalled, and keep a per-report suppression.
- **Do not let the sweep resurrect a superseded version.** A report superseded by a correction is not a
  delivery failure.
- Multi-tenancy: the sweep must iterate offices via `search_path` and cannot leak across them.
- Test the constant with an **absolute fixture**. `ageSend(STALL_MINUTES + 5)` cannot detect
  `STALL_MINUTES` changing to 30,000 — this exact trap already shipped once here.

---

## 4. The server-side dictation pass

### The problem
The original design specified a server-side model pass turning dictated speech into clean report prose.
What shipped is a **client-side sentence→bullet split** in `mobile/src/weekly-reports/draft.ts`.

### What to build
Move the pass server-side. Per repo convention, use the latest and most capable Claude model.

### Constraints the current client code already encodes — keep them
- Dictation **appends** to whatever is already in the section rather than replacing it
  (`draft.ts:285`). A server pass that returns a rewritten whole section will silently destroy text the
  superintendent typed by hand.
- `MAX_SECTION_CHARS` is capped client-side because dictation appends programmatically, so a
  `TextInput`'s `maxLength` never applies (`draft.ts:363`). Without the cap a long dictated section
  overruns what the server accepts and the PATCH 400s at submit. **A server-side pass must enforce the
  same ceiling**, and the cap exists for a runaway dictation loop, not to limit anyone writing prose.
- Leaving mid-dictation unmounts the recorder before the transcript returns; `editor-state.ts:21` guards
  this with `voiceBusy`. A network round-trip makes that window **longer**, not shorter.

### Failure modes to design against
- Offline and flaky-signal capture is the normal case on a jobsite. The feature must degrade to the
  current local split rather than losing the transcript.
- The model must not invent site facts. This text goes to a paying client over T Rock's name.

---

## 5. Enabling `WEEKLY_REPORT_APP_DEEP_LINKS`

### The problem
The flag defaults off, so every reminder ships with the CRM web link alone.

### ⚠️ Correction (2026-08-18, found during implementation)
**This section was wrong.** It claimed both blockers were gone. Only the `APP_OWN_ROUTES` one was.

`mobile/app/(app)/reports/` exists, but the worker emitted
`trockcam://reports/weekly/<weeklyReportProjectId>?weekOf=…`, which file-system-routes to
`reports/weekly/[draftId].tsx` — and that segment is a **local draft id** (`newClientUploadId()`, read
back through `loadWeeklyReportDraft`), not a server project id. A server id there matches nothing on the
device and renders *"Draft not found. It may have been submitted or discarded."* — worse than no link at
all, because it tells the superintendent their work is gone. `?weekOf=` is never read. There is no
`+not-found`, no `+native-intent`, and no `getStateFromPath` override to catch it.

The route existing is not the same as the route accepting what the email sends. **Check the parameter
semantics, not just the path.** Resolved by pointing `appUrl` at the hub (`trockcam://reports`), which is
the deepest destination that actually lands; per-week deep linking needs a mobile route that accepts a
project id and a week, and that is its own PR on a surface CI never compiles.

### The stated blockers, as originally assessed
`weekly-report-reminders.ts:187` says turning the flag on "requires both the route and a `reports` entry
in `APP_OWN_ROUTES`." **Both now exist:**

- `mobile/src/wearables/pairing-callback.ts:79` — `APP_OWN_ROUTES = {"accept-invite", "scorecards", "reports"}`
- `mobile/app/(app)/reports/` — the route directory exists (landed with #1073)
- `pairing-callback.test.ts:178` already pins `isRetainablePairingUrl("trockcam://reports/weekly/abc") → false`

The danger the comment describes — `APP_OWN_ROUTES` being a **deny-list**, so an unknown route key is
treated as a possible Meta pairing callback, and a tapped `trockcam://reports/...` would be retained as
one, evicting a real held callback and leaving the glasses unpaired — is therefore already neutralised.

### What to build
1. Verify end to end that a `trockcam://reports/...` link resolves to the report and does **not** reach
   the pairing handler.
2. Set `WEEKLY_REPORT_APP_DEEP_LINKS=true`.
3. **Correct the stale comment** at `weekly-report-reminders.ts:187`, which still tells the next reader
   that the route and the `APP_OWN_ROUTES` entry are missing. Left as is, it will talk someone out of a
   change that is already safe.

### Failure modes to design against
- **`mobile/` has no OTA.** (It *is* CI-gated — `premerge-build-gate.yml` runs `npm ci`, typecheck, jest
  and `expo export` — an older note here said otherwise and was wrong.) CI compiling the app is not the
  risk; **delivery** is. A change reaches devices only through an EAS build, TestFlight and a user
  installing it, so a break cannot be pulled back without a store release and lives on un-updated phones
  indefinitely. That is also why this flag's precondition is the build in the field, not the repo.
- `mobile/` has **two source roots** (`mobile/app` and `mobile/src`). Sweep both, and parse the TS AST
  rather than grepping.
- The flag is read as `String(env.…).trim().toLowerCase() === "true"`, so `"1"` is **false**. Set it
  literally.

---

## What this spec does not cover

- Universal links and the `apple-app-site-association` hosting they need — still out of scope, as in
  #1072. `appUrl` and `webUrl` stay offered side by side.
- Widening the CRM router to `construction`. Explicitly rejected; see §1.
- Removing the global `SYSTEM_EMAIL_BCC` from client mail. A deliberate standing choice, pinned by a
  test; changing it is a separate decision and Adnaan's to make.
</content>
