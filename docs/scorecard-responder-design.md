# Scorecard-driven corrective-action recipient (picked field responder)

## What it does

The superintendent / PM a field user **picks** from the `field_responders` roster on the T-Rock Cam scorecard
becomes **that card's** corrective-action recipient, completed-scorecard recipient, and response-token holder —
instead of the deal's Team-tab super/PM.

**The rule, per role:** a pick that still resolves to an **ACTIVE** `field_responders` row **of the matching
role** wins. Otherwise the deal's Team-tab super/PM stands, exactly as before. The two roles are independent —
a card can have a picked superintendent and a deal-team PM.

The picked person is the one who was actually on site, so they are the one who should have to answer for the
card. The deal team is who the CRM *thinks* is responsible; the pick is who *was there*.

## Why it is built this way

The obvious implementation — write a `deal_team_members` row when the scorecard is submitted — was tried and
abandoned (PR #954, closed). Two things killed it:

1. **Locks.** Every `deal_team_members` write path fires `restartCorrectiveActionNotificationCycleForDeal`,
   which resets sent stamps, deletes every outstanding response token on the deal's open cards, and re-enqueues
   notifications — while holding `FOR UPDATE` locks on the roster row and the member row. Doing that from
   inside the field submit transaction put the scorecard path into the team-assignment lock graph. Review
   rounds produced directly contradictory demands ("add a `FOR UPDATE`" vs. "that lock deadlocks against the
   Team-tab path"; "restart the cycle" vs. "the restart deadlocks against a concurrent edit").
2. **Name-matching.** Storing the name only meant a field user who **typed** a name that happened to match a
   roster member got that member silently assigned and emailed. Name-only cannot distinguish typed from picked.

This design avoids both:

- **Store the id, not the name.** `field_scorecards.superintendent_responder_id` / `pm_responder_id`
  (migration 0199, FK to `field_responders` `ON DELETE SET NULL`). The free-text `superintendent_name` /
  `pm_name` remain the display label. On mobile, an id can only ever be set by pressing a roster row; any other
  edit to the name clears it.
- **Resolve at read time.** Nothing is written to `deal_team_members`, ever. Recipients are computed when the
  worker sends and when a token is verified, so there is no assignment to serialize and no cycle to restart
  from the submit transaction.

## Where the two halves live

The corrective-action email and the completed-scorecard email resolve recipients at **different times**, so the
rule is applied in two places:

| what | resolves | applied in |
|---|---|---|
| Corrective-action email + response token | at SEND time, in the worker | `recipientResolutionSql` — `worker/src/jobs/scorecard-corrective-action-email.ts` |
| Completed-scorecard email | frozen into the job payload at ENQUEUE | `createFieldScorecard` — `server/src/modules/field/scorecards-service.ts` |
| Token verify-time authorization | on every request | `resolveScorecardCorrectiveActionRecipients` — `server/src/modules/field/corrective-action-recipients.ts` |

The worker SQL and the server resolver must stay in agreement: the worker mints a token for whoever it
resolves, and the server decides whether that token still authorizes. A divergence produces a link that sends
fine and then 403s on its first click. Both are covered by real-SQL tests against the same fixtures
(`worker/tests/jobs/scorecard-corrective-action-recipients.runtime.test.ts`,
`server/tests/modules/field/scorecard-responder-recipients.runtime.test.ts`).

## Properties that fall out of resolve-at-read-time

- **Deactivation is the revoke.** Because authorization re-reads the roster row on every request, deactivating
  a picked responder kills their outstanding link immediately — no separate token-revocation hook needed. The
  other half is not free, though: revoking without re-notifying strands the card, so the roster PATCH restarts
  the notification cycle for every open card that picked the person whenever the edit changed `is_active`,
  `role`, or `email` (a name edit changes the label, not who is reached, so it stays quiet).
- **A pick is per card.** Being picked on this week's scorecard grants nothing on last week's.
- **An unusable link degrades, never rejects.** A card drafted in the truck can upload days later, by which
  time the picked person may be deactivated, re-roled, or deleted. Rather than stranding the submission, the
  link resolves to null and the deal team answers.
- **Roster people are email-only.** `field_responders` has no `user_id`, so a picked recipient always responds
  through the tokenized web page — the same route a roster person assigned from the Team tab already takes.

## Things worth knowing before changing this

- **The edit path is a full replacement.** An edit that omits the ids CLEARS them. That is the safe direction:
  a link must never outlive the name it was picked for. It also means an older app build editing a newer card
  drops the picks back to the deal-team fallback.
- **The ids are part of the edit's content-equality check.** A pick swap can leave the display name identical,
  so without this the no-op short-circuit would silently discard the change.
- **The two `role` columns are different types.** `field_responders.role` is bare text (0198);
  `deal_team_members.role` is the `deal_team_role` ENUM (0016). Postgres will not reconcile them in a UNION —
  it raises `42804 UNION types text and deal_team_role cannot be matched` before resolving any recipient, which
  breaks EVERY corrective-action email, not just picked cards. Both branches of the worker's candidate CTE cast
  to `::text`. The PGlite harness creates the real enum on purpose: declaring it as text let this pass review
  once, so the test is written to fail without the casts.
- **Lock order is roster-then-card.** The edit takes the roster row's FOR KEY SHARE — the same lock its FK
  write needs anyway — BEFORE locking the card, because the assign-from-roster team POST goes roster-then-card
  and two opposed orders on that pair deadlock.
- **A pick change on an open card restarts the notification cycle UNCONDITIONALLY.** Not "if already sent",
  not "if no job looks live" — every such test is a race, because the worker's re-resolve is not atomic with its
  stamp: a job that re-read the old pick will block on the card row and stamp after the edit commits unless the
  nonce moves. Restarting always is safe because the cycle nonce supersedes: the stale job returns early with no
  send and no stamp. **A pick change on an already-notified open card restarts the notification cycle.** Otherwise the swap
  strands both people: the previous holder's token stops authorizing and the new pick was never emailed, while
  the sent stamp suppresses any further send. This reuses the existing cycle machinery
  (`reconcileScorecardCorrectiveActions`, `responderPickChanged`) — no new locks.
- **The worker's `assignedRoles` completeness gate stays deal-team-derived.** It combines correctly at role
  granularity; see the comment at its definition for why deriving it from the picks instead would dead-letter
  jobs on a deactivated roster person.

## Known gaps (deliberate, not oversights)

- `resolveActiveScorecardTeamRows` (the completion-email / mobile-prefill fallback) still has **no email-only
  branch**, so an email-only super/PM assigned from the Team tab is invisible to the completed-scorecard email.
  That is a pre-existing bug, unchanged here, and worth its own PR — a pick makes the same person visible, which
  will make the inconsistency easier to notice.
- The completed-scorecard recipient is frozen at submit for ordinary edits, matching how the deal-team
  addresses have always behaved on that job. A pick CHANGE is the exception: it re-addresses the job — and
  REQUEUES it if it had dead-lettered — so correcting a mis-picked superintendent shortly after filing reaches
  the right person. **Not covered: a job already `processing`.** The worker has loaded its payload by then, and
  reaching the new pick would mean clearing `email_sent_at` and re-running, which re-sends the PDF to the whole
  env recipient list (this job addresses one deduped union, not a person). That window is one job run and is
  the pre-existing send-once behavior, not something the pick feature introduced; the corrective-action email,
  the one a responder must act on, resolves at send time and is unaffected. Closing it needs a per-recipient
  follow-up delivery this job type does not have — a deliberate piece of work, not a patch here.
- The pick-changed restart triggers on id inequality rather than on a change to the RESOLVED recipient set, so
  clearing a pick whose person is also the deal-team super re-notifies the same people once. Worst case is a
  duplicate email carrying a fresh link, never a stranded card.
- Worker tests are NOT in the CI gate — `worker/package.json` has no `test:ci`, so `npm run test:ci
  --workspaces --if-present` skips it. The worker half of this feature (the recipient SQL and its real-SQL
  test) is verified locally only, the same footing as mobile.
- Creation takes `FOR KEY SHARE` on the picked roster rows so a concurrent hard-delete cannot fail the FK
  insert (which would reject a field submission instead of degrading). It deliberately does NOT block a
  director's PATCH — a plain UPDATE takes `FOR NO KEY UPDATE`, which does not conflict — so a deactivation can
  land mid-submit. The stored link is harmless there (send-time resolution re-checks ACTIVE), but the
  completed-scorecard email SNAPSHOTS its addresses, so that snapshot is taken from a RE-READ immediately
  before the enqueue rather than from the earlier validating read. At READ COMMITTED that sees any PATCH which
  has committed, leaving only the sliver where a PATCH commits after that statement and before this
  transaction — closable only by a conflicting lock, i.e. the assignment-lock coupling that sank #954.
- `revokeCorrectiveActionTokensForRemovedMember` is email-keyed and deal-scoped, so removing a Team-tab member
  whose email matches a picked responder revokes that token too. Every call site pairs the revoke with a cycle
  restart, which re-mints under the new resolution, so it self-heals.

## Rollout

Server and worker deploy normally. T-Rock Cam has **no OTA** (`expo-updates` is not installed), so the mobile
half reaches devices only via an EAS build. The server changes are inert until the app starts sending the ids:
with no pick, resolution is byte-for-byte the pre-existing deal-team behavior.
