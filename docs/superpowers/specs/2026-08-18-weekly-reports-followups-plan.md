# Weekly Reports follow-ups — implementation plan

Execution plan for `2026-08-18-weekly-reports-followups.md`. Five follow-ups, five PRs, two independent
tracks.

---

## Track A — off `main`, mergeable immediately

These touch nothing PR5 owns, so they do not wait on it.

### PR A1 — enable the deep-link flag *(smallest; do it first)*
**Base:** `main`

1. **Replace the emitted URL with `trockcam://reports` (the hub).** The worker emitted
   `trockcam://reports/weekly/<weeklyReportProjectId>?weekOf=…`, which file-system-routes to
   `reports/weekly/[draftId].tsx` — and that segment is a **local draft id**, not a server project id. A
   server id there matches nothing on the device and renders *"Draft not found. It may have been submitted
   or discarded."* Do this **before** step 3, not after: enabling the flag without it ships that link.
   Drop the now-dead `weeklyReportProjectId` / `weekOf` inputs rather than leaving them implying a routing
   that does not exist.
2. Verify `trockcam://reports` never reaches `pairing-callback.ts`. `APP_OWN_ROUTES` contains `"reports"`,
   so this is a confirmation, not a build.
3. Set `WEEKLY_REPORT_APP_DEEP_LINKS`. Parsed as `=== "true"` after trim+lowercase, so `"1"` and `"yes"`
   are false. ⚠️ **Ship it `false`.** The deny-list that decides what a tapped link does is the one
   compiled into the build ON THE PHONE, and `"reports"` entered `APP_OWN_ROUTES` in the same commit as
   the route (#1073) — which `mobile/` has no OTA to deliver. On any older build the link is retained as a
   Meta pairing callback and unpairs the glasses. Enabling is a human call once field adoption is
   confirmed; no test in this repo can assert it.
4. Rewrite the stale comment block at `weekly-report-reminders.ts:187`, which still says the route and the
   `APP_OWN_ROUTES` entry are missing — and state the real gate, which is the shipped build.

**Tests:** an end-to-end reminder-job test asserting `appUrl` IS emitted when the flag is on (every
job-level assertion was negative, so replacing the flag read with a literal `false` left all 97 green); a
`pairing-callback` test that the exact emitted string is not retainable.
**Risk:** `mobile/` has **no OTA**, so a break reaches devices only via a store release and lives on
un-updated phones indefinitely. It *is* CI-gated (typecheck + jest + `expo export`), but verify on a
device anyway — CI compiles the app, it does not tell you what anyone is running.

### PR A2 — server-side dictation
**Base:** `main`

1. Server endpoint that cleans a dictated transcript, using the latest capable Claude model.
2. Client calls it, keeping **append** semantics (`draft.ts:285`) — never replace a section, or hand-typed
   text is destroyed.
3. Enforce `MAX_SECTION_CHARS` server-side too (`draft.ts:363`).
4. Extend the `voiceBusy` guard (`editor-state.ts:21`) to cover the round-trip, which widens the
   leave-mid-dictation window.
5. **Fall back to the existing local split** on failure or offline. Jobsites lose signal; losing the
   transcript is not acceptable.

**Tests:** append-not-replace (with a control proving text is actually appended); cap enforced
server-side; offline falls back and retains the transcript; `voiceBusy` covers the round-trip.

---

## Track B — stacked on PR5, merged bottom-up after it

All three need `send-service.ts`, `send_request`, `send_delivery_key` or the 0226 index. **Merge order is
PR5 → B1 → B2 → B3.** A non-default base means the review bots do not fire on push — trigger `@codex`
and `@coderabbitai` by hand.

### PR B1 — the field-route send *(the one that makes the feature usable)*
**Base:** `feat/weekly-reports-send-v2`

1. Add to `field-routes.ts`: `GET /reports/:id/send-draft`, `POST /reports/:id/send`,
   `POST /reports/:id/send/retry`, `POST /reports/:id/correction`. **No `requireWeeklyReportSender`.**

   **`send-service.ts` IS THE AUTHORIZATION BOUNDARY, not the router.** Each of those operations calls
   `canPublishWeeklyReport` itself, having taken `FOR UPDATE` on the report and its setup row, and both
   things matter. A route-level check protects only callers that arrive through that route — it does
   nothing for a direct caller, a future second mount, or a script — and a check made outside the lock is
   a check against a row that can change before the transition commits, which is how two concurrent sends
   both pass. Put it where the decision and the write are in one transaction.

   The tests belong at the same boundary: call the service directly for both the assigned-PM success and
   the unauthorized refusal. A test that only drives the router proves the router, and the router is the
   layer that is easy to get right.
2. Remove the 409 at `field-routes.ts:253` — **in the same commit** as the endpoints above, never before.
3. Reuse `send-service.ts` wholesale. The token mint stays in the same commit as the transition.
4. Mobile send screen under `mobile/app/(app)/reports/`, over `mobile/src/weekly-reports/`.

**Tests:** the assigned `construction` PM CAN send (the control — without it a guard that refuses
everything passes); a non-assigned `construction` user cannot; a superintendent posting `{"to":"sent"}`
is refused **by the service**, not merely by the router; the raw share token is never persisted to the
draft store or logged.

### PR B2 — bounce / delivery webhook
**Base:** B1

1. Signed provider webhook; verify the signature, and do not leak whether a delivery key exists.
2. Correlate on `send_delivery_key`. Record `delivered` / `bounced` (hard vs soft) / `complained`.
3. Order by the provider's event timestamp — **not** arrival — so a late `delivered` cannot overwrite a
   later `bounced`.
4. Leave `send_delivered_at`'s meaning (*accepted*) intact or add a sibling column; the board, chip and
   sweep all read it.

**Tests:** out-of-order events resolve to the correct final state; a replayed event is idempotent; a
bounce on version N leaves N+1 untouched; an unsigned request is rejected.

### PR B3 — dead-letter sweep and alerting
**Base:** B2

1. Worker sweep over `weekly_reports_send_undelivered_idx`, per office via `search_path`.
2. Age against **`max(sent_at, send_last_attempt_at)`** — never `sent_at` alone, and never
   `send_last_attempt_at` alone either. This step used to say the latter, which is wrong in exactly the
   case the job exists for: a send that dead-letters before the worker writes `send_last_attempt_at` has a
   NULL there, so an attempt-only clock yields a null age and the sweep skips the report entirely — no
   alert, on the failure it was built to catch. Take the later of the two, which is what the board's
   `lastSendActivityAt` already computed; put it in `shared/` so board and sweep cannot diverge.
3. Alert on the *transition* into stalled, with per-report suppression — an alert every pass gets muted.
4. Skip reports superseded by a correction; that is not a delivery failure.
5. **The sweep must not assume its own schema exists.** Migrations run on the API before it starts and
   never on the worker, and the two are separate Railway services deployed independently — so "apply the
   migration first" is a sequence nobody enforces, and a worker that starts first queries
   `send_stall_alerted_at` and every send column PR5 added, and fails. Either gate the deploy on
   migrations having run, or — better, because it needs no coordination — **probe for the schema and skip
   the office until it appears**, logging at INFO. Probe COLUMNS, not tables: `weekly_reports` has existed
   since 0222, so a table check passes in exactly the window that breaks. Nothing is lost by waiting a
   tick, and this removes deploy ordering as a requirement in both directions.

**Tests:** absolute date fixtures, never `ageSend(STALL_MINUTES + 5)` — a fixture computed from the
constant it tests can never fail; a stalled send alerts once, not every pass; a superseded report does
not alert; the sweep cannot cross offices.

---

## ⚠️ Known cross-branch collision — A2 × B1

**`server/tests/weekly-report-field-route-surface.test.ts` asserts the field router's route list with an
exact `toEqual`.** A2 (dictation) added `/dictation` to it. **B1 (field send) adds four more —
`/reports/:id/send-draft`, `/reports/:id/send`, `/reports/:id/send/retry`, `/reports/:id/correction` —
and will break that assertion the moment both are on the same branch.**

Neither PR's reviewer can see this: A2 branches off `main`, B1 off PR5, and a per-PR reviewer gets one
worktree. This is the exact drift shape that hit this feature four times already. **Whoever merges
second updates the list** — and should read the test's comments rather than just appending, because two
of them encode real constraints:

- `/dictation` is registered **above** `router.use(requireFieldContractor, tenantMiddleware)` on purpose.
  It waits on a model round trip and touches no rows, so opening an office transaction would hold a
  pooled Postgres connection for the whole call — the shape of a pool-saturation outage this API has
  already had. It keeps its own `requireFieldContractor`, so it is not a hole in the mount. Moving it
  below the `use` passes every other test in the file and silently reintroduces the outage.
- B1's four endpoints **do** write, so they belong **below** the `use`, unlike `/dictation`.

## ⚠️ Second known collision — B3 × PR5 in `dashboard-service.ts`

B3 (sweep) branches off PR5 at `2bb4bcb90` and moves `WEEKLY_REPORT_SEND_STALL_MINUTES` plus the
max(`sent_at`, `send_last_attempt_at`) arithmetic **out of `dashboard-service.ts`** into
`shared/src/lib/weeklyReportSendStall.ts`, leaving the service importing and re-exporting it. PR5 has
since taken the dashboard corrections, which rewrote the `settled` predicate in the same file. **Expect a
conflict when B3 rebases onto the merged PR5** — both edits are wanted, neither supersedes the other.

Resolve toward: B3's shared-module extraction *and* PR5's
`!undeliveredByKey.has(key) && (dismissalByKey.has(key) || deliveredByKey.has(key))`. Verify afterwards
that the board and the sweep still read the same stall clock, which is the entire point of the
extraction — a sweep that announces a stall the board renders as "Sending…" is the drift it exists to
prevent.

## Third collision — B2 × B3 both claim migration 0227 (benign, do NOT renumber after deploy)

Both branches independently took `0227`:

- `0227_weekly_report_send_stall_alerted.sql` (B3, sweep) — adds `send_stall_alerted_at`
- `0227_weekly_report_delivery_events.sql` (B2, webhook) — adds `send_delivery_status`,
  `send_delivery_status_at`, `send_delivery_detail`, plus `public.weekly_report_send_deliveries`

**This is fine.** The columns are disjoint, both files are idempotent (`ADD COLUMN IF NOT EXISTS`), both
carry a `TENANT_SCHEMA_START/END` block, and the runner tracks applied migrations **by filename** and
sorts alphabetically — so both run, `delivery_events` before `send_stall_alerted`. `main` already carries
two `0224_*` files for the same reason.

⚠️ **Do not "tidy" this by renumbering after either has been applied.** The ledger is keyed on the
filename, so a renamed migration is an unseen migration and runs a second time. Before deploy, renumbering
is free; after, it is not.

## Corrections to this plan, found during implementation

- **`mobile/` runs jest, not vitest.** "`TZ=UTC npm run test:ci` per workspace" does not apply there —
  it is `npm test`. (`mobile/` *is* CI-gated now, contrary to older notes, but still has no OTA.)
- **A server-side fallback for dictation was missing from the spec** and is required: without it, a
  deploy with no `ANTHROPIC_API_KEY` pays a model round trip per dictation purely to get an error.
- **Claude calls in this repo use raw `fetch` with an injected `fetchFn`**, not `@anthropic-ai/sdk` —
  matching `field/ai-report-service.ts` and `worker/jobs/call-recording-transcribe.ts`. Keep that style;
  it also lets tests assert the exact wire body.

## Standing rules for every PR here

**Typecheck baseline is CONFIG-DEPENDENT.** In `server/`, `npm run typecheck` (the CI-relevant config)
reports **0 errors**, while `npx tsc --noEmit -p tsconfig.json` reports **2 pre-existing TS6059**. Both
numbers are real; quoting one as "the" baseline sends the next person hunting a regression that is a
config difference. Say which command produced the number.

**Verification** — `shared` must be built first or typecheck reports thousands of phantom errors. Run
each npm workspace separately with `TZ=UTC npm run test:ci` — `server`, `client`, `client-field`,
`worker`, `shared`; root `test:ci` exceeds the tool timeout and dies *after* server prints green.
Include `client-field` or the count is short.

**`mobile/` is NOT one of them.** It is a self-contained app outside the workspace graph and runs
**jest**: `EXPO_PUBLIC_API_BASE_URL=… npx jest` from `mobile/`, with its own `npm install` and its own
`npx tsc -p tsconfig.json --noEmit`. `npm run test:ci` does not exist there. (`mobile-crm` is a second
such app, same shape.)

Never pipe a test run through `tail` — you get tail's exit code, not npm's. Derive expected counts from
the branch's **actual base**, not from a number written down before a rebase.

**Review** — heavy adversarial subagent review *before* `gh pr create`. Merge only when a review of the
**current tip** returns nothing, aggregating every review on that tip; "not yet reviewed" ≠ clean.

**Test fidelity** — the traps this feature kept hitting: stubs for failure shapes the real dependency
cannot produce; mutating branches instead of inputs; a fixture that ages relative to its own constant;
a guard tested without a control; and cross-branch fixture drift, which a per-PR reviewer with one
worktree structurally cannot see.

**After merge** — verify by CONTENT, not the badge. This repo has landed MERGED + green PRs containing
nothing.
