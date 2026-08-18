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
