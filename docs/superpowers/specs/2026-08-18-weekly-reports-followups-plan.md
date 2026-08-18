# Weekly Reports follow-ups — implementation plan

Execution plan for `2026-08-18-weekly-reports-followups.md`. Five follow-ups, five PRs, two independent
tracks.

---

## Track A — off `main`, mergeable immediately

These touch nothing PR5 owns, so they do not wait on it.

### PR A1 — enable the deep-link flag *(smallest; do it first)*
**Base:** `main`

1. Verify `trockcam://reports/...` resolves to the report route and never reaches
   `pairing-callback.ts`. Both preconditions already hold — `APP_OWN_ROUTES` contains `"reports"` and
   `mobile/app/(app)/reports/` exists — so this is a confirmation, not a build.
2. Set `WEEKLY_REPORT_APP_DEEP_LINKS=true`. Literally `true`; `"1"` parses as false.
3. Rewrite the stale comment block at `weekly-report-reminders.ts:187`. It still says the route and the
   `APP_OWN_ROUTES` entry are missing, which would talk the next reader out of a safe change.

**Tests:** a reminder-job test asserting `appUrl` is emitted when the flag is on; a `pairing-callback`
test that a reports URL is not retainable (extend the existing one rather than duplicating it).
**Risk:** `mobile/` is not in CI and has no OTA. Verify locally before pushing.

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

1. Add to `field-routes.ts`, gated by `canPublishWeeklyReport` (**not** `requireWeeklyReportSender`):
   `GET /reports/:id/send-draft`, `POST /reports/:id/send`, `POST /reports/:id/send/retry`,
   `POST /reports/:id/correction`.
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
2. Age against `send_last_attempt_at`, **never** `sent_at`.
3. Alert on the *transition* into stalled, with per-report suppression — an alert every pass gets muted.
4. Skip reports superseded by a correction; that is not a delivery failure.

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

## Corrections to this plan, found during implementation

- **`mobile/` runs jest, not vitest.** "`TZ=UTC npm run test:ci` per workspace" does not apply there —
  it is `npm test`. (`mobile/` *is* CI-gated now, contrary to older notes, but still has no OTA.)
- **A server-side fallback for dictation was missing from the spec** and is required: without it, a
  deploy with no `ANTHROPIC_API_KEY` pays a model round trip per dictation purely to get an error.
- **Claude calls in this repo use raw `fetch` with an injected `fetchFn`**, not `@anthropic-ai/sdk` —
  matching `field/ai-report-service.ts` and `worker/jobs/call-recording-transcribe.ts`. Keep that style;
  it also lets tests assert the exact wire body.

## Standing rules for every PR here

**Verification** — `shared` must be built first or typecheck reports thousands of phantom errors. Run
each workspace separately with `TZ=UTC npm run test:ci`; root `test:ci` exceeds the tool timeout and dies
*after* server prints green. Never pipe a test run through `tail` — you get tail's exit code, not npm's.
Include `client-field` or the count is short. Derive expected counts from the branch's **actual base**,
not from a number written down before a rebase.

**Review** — heavy adversarial subagent review *before* `gh pr create`. Merge only when a review of the
**current tip** returns nothing, aggregating every review on that tip; "not yet reviewed" ≠ clean.

**Test fidelity** — the traps this feature kept hitting: stubs for failure shapes the real dependency
cannot produce; mutating branches instead of inputs; a fixture that ages relative to its own constant;
a guard tested without a control; and cross-branch fixture drift, which a per-PR reviewer with one
worktree structurally cannot see.

**After merge** — verify by CONTENT, not the badge. This repo has landed MERGED + green PRs containing
nothing.
