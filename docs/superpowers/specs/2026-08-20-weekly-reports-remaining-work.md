# Weekly Reports — everything still outstanding

Status: spec + handoff
Date: 2026-08-20

Written at the end of a long session. State below was verified against GitHub, the production database
and the working tree at the time of writing — re-verify before acting, because several items move.

---

## Where things actually are

> **SUPERSEDED, 2026-08-23. Everything in the table below shipped.** #1089–#1092 are merged and
> deployed, migrations 0228–0230 are applied in all three office schemas and 0231 in `public`, and
> #15/#16/#17 are done or in review.
>
> The split matters if you go looking: `0231_weekly_report_views.sql` creates `public.weekly_report_views`
> deliberately — a share link is opened by a route holding nothing but a token, before any tenant is known,
> so the table carries `tenant_id` and `office_slug` as columns instead of living in an office schema.
> Verifying it per-office sends you after a state that cannot exist. The state table is kept only so the record of what was believed on 2026-08-20 stays legible;
> do not act on it.
>
> **AND ONE CLAIM IN IT WAS WRONG, not merely stale** — see "#15, and why its premise was wrong" below
> before implementing anything from this file.
>
> **This file is a point-in-time spec, not a live status board.** For current PR state — tip, checks,
> unresolved threads — read `docs/weekly-reports-status.md`, which carries the commands to query it
> rather than a remembered SHA. The tips and check counts once written here went stale within the hour.

| | State |
|---|---|
| **PR #1089** `feat/weekly-report-setup-roster` → `main` | ~~OPEN, and everything stacks on it.~~ MERGED 2026-08-20. |
| **PR #1090** | MERGED into #1089's branch. Verified by content. |
| `feat/weekly-report-open-tracking` | 3 commits, **never pushed**, based on `8fb22cfb5` (pre-#1090-merge). |
| Migrations not yet on `main` | `0228`, `0229`, `0230` (+ `0231` on the unpushed branch) |
| Deployed to production | ~~**Nothing from this batch.**~~ ALL OF IT, 2026-08-20/21. Verified per office schema, and the send path re-verified end to end on 2026-08-23. |

**Merge order is #1089 first.** Everything else stacks on it.

---

## 1. ~~Close the last Greptile finding on #1089~~ — DONE, and it cost two more rounds

Kept here because the shape of it is the useful part.

The original finding: `undelivered && !supersededById` was too broad in one direction. When v1 **bounced**
and its correction v2 was accepted by the provider but had no delivery verdict, the week read as fully
resolved — positive evidence of one failure, none of success.

The first fix required a known prior failure before flagging an unverified send, which kept the ordinary
pre-verdict case quiet. **Greptile then found that fix wrong too**: asking "did any previous version fail"
is not "is anything still unanswered", so `v1 bounced → v2 delivered → v3 accepted` was flagged off a
bounce the client's copy of v2 had already answered. It now compares the newest failure against the newest
confirmed receipt.

Two things came out of it worth keeping:

- **The verdict moved to the server.** The summary count, the per-report chip and the card border had each
  owned their own predicate and disagreed twice, each time with only one of the three fixed. They read one
  `outstanding` boolean now, so a third disagreement is not something an edit can express.
- **Two guards could not fail.** `status = 'sent'` survived deletion because no fixture reached a live
  draft; the client's border survived being keyed on the old rule because the two predicates diverge only
  on inputs the server cannot emit. Both have cases that reach them now.

**What remains blocking is the loop itself**, not this finding: all checks green with `build-gate`
**SUCCESS, not CANCELLED**, and zero unresolved threads, on the tip that will actually be merged. Three
tips in a row have produced a real defect, so a clean previous round is not evidence about the current one.

## 2. Merge #1089, deploy, verify

**Merge before 11:00 CT.** The reminder cron runs 07:00 with catch-up at 09:00 and 11:00; a deploy landing
after that costs that day's t−2/t−1 nudges and the digest. Not damaging, entirely avoidable.

Deploy order does not matter — the worker probes for every column it needs and skips offices cleanly until
the API migrates.

**After deploy, verify against production rather than assuming:**

- `0228`/`0229`/`0230` applied in **all three** office schemas (`dallas`, `atlanta`, `pwauditoffice`)
- The PM picker offers all **15** roster people (it offered 6 before this work)
- Worker logs show the new **17:00 CT** escalation cron registered
- **The 17:00 cron is new and emails a sales rep.** Be present for its first firing.

## 3. Push and PR the open-tracking work

Branch exists, is tested, and is **not pushed**. It is based on `8fb22cfb5`, which predates the #1090
merge — **rebase onto `main` after #1089 lands**, do not merge the old base forward.

What is built: migration `0231` (`public.weekly_report_views`), the classifier in
`shared/lib/weeklyReportViews`, logging on all three public routes, and the audit-dialog panel.

**Still missing: the 24-month retention purge.** Adnaan chose 24 months. Put it in the worker beside the
dead-letter sweep, and give it the same table-exists probe the other jobs have.

**Design decisions already taken — do not relitigate:**
- Log everything raw, classify at **read** time (the strongest human signal, whether they loaded photos or
  the PDF, does not exist when the page fetch is logged)
- Full IP + user agent, 24 months
- **No client-facing disclosure.** Adnaan decided against the footer notice explicitly.

## 4. Deferred product work

**PDF layout pass.** Waiting on Adnaan's phone review. One defect already confirmed: the Issues/Concerns
box is 84pt inside a 130pt row, and the reference document's own text overflows onto page 2. Do not start
until he has reviewed and listed his other changes — he asked for exactly that order.

**15 dialogs app-wide render at 384px** regardless of the width they request. `DialogContent` pins
`sm:max-w-sm`, and tailwind-merge keeps an unprefixed `max-w-*` alongside it rather than replacing it. The
four weekly-report dialogs are fixed with `sm:!max-w-*`. The one-line fix is in the primitive, but it
resizes 15 surfaces at once — several presumably laid out against the 384px they actually got. Own PR,
own visual pass.

**Five roster people have no CRM login** — Corey McShane, Eric Burnett, Kevin Posey, Nick Cheatam, Triston
Mitchell. They can hold PM/super slots, print on reports and receive reminders, but cannot approve or send;
a director approves on their behalf and the form says so. If Adnaan wants them approving, that is admin
provisioning, not a code change.

## 5. Older open follow-ups

- **#15** ~~duplicate-risk warning gates on age alone; should gate on outcome~~ — **DONE (#1093), but not
  as written.** The premise was wrong three separate ways; see below.
- **#16** ~~decide whether the dictation endpoint needs rate limiting~~ — **DONE (#1095).** Yes: an eligible
  call reaches the configured model — `claude-opus-5` by default, overridable per deploy via
  `WEEKLY_REPORT_DICTATION_MODEL` — and every field account in the company can authenticate against it.
  Burst limit plus a daily cap, keyed per USER rather than per IP, because a crew shares a jobsite NAT.

  *Not* every call is a paid one: `formatWeeklyReportDictation` returns a locally formatted result for a
  blank transcript, for one over `MAX_DICTATION_TRANSCRIPT_CHARS`, and on any deploy without
  `ANTHROPIC_API_KEY`. That does not weaken the case for the limit — a runaway loop sends eligible
  requests — but "every call spends money" overstates it, and this file is the wrong place to overstate.
- **#17** ~~a field PM cannot re-mint a share link they just sent~~ — **in review (#1094).** The capability
  existed; it sat on the CRM router behind an admin/director/rep gate a `construction` account cannot
  reach. Reaching it took three attempts — the button has to hang off the LAST SENT report, not the
  current week, or it disappears the moment the cadence rolls over.

### #15, and why its premise was wrong

This file said, in full:

> #15 duplicate-risk warning gates on age alone; should gate on outcome

The premise that shorthand rests on — reconstructed here, **not** quoted, because the file never spelled
it out — is that a send's outcome is knowable from what the row records:

> When `send_delivered_at` is null the provider never accepted it, so there is nothing to duplicate.

**That premise is false, and implementing it would have created the duplicate it set out to prevent.** Three
rounds of review took it apart, and the corrections are the useful part:

1. `send_delivered_at` is stamped by a SEPARATE statement after the provider call returns, so a process
   that dies in between leaves a report the client HAS with no stamp. `weekly-report-send.ts` calls that
   an ordinary outcome; `dashboard-service.ts` calls it "the reason the whole idempotency-key design
   exists". **Null means no confirmation of acceptance, never "not accepted".**
2. A non-blank `send_error` is not proof of refusal either. `classifySendFailure` writes `unknown:` for a
   swallowed fetch, a 5xx, a 408 and an in-flight idempotency 409 — every one of which may have left the
   message enqueued.
3. A `rejected:` prefix proves only that ONE attempt created nothing, and not necessarily the latest one:
   the column holds a single outcome and a retry clears it while keeping `send_attempts`.

**What shipped instead.** The gate is age alone, exactly as it was. What changed is what the dialog SAYS:
on a provable rejection it tells the PM that a recorded attempt sent nothing, and stops there. The
question "did this send definitely reach nobody" is not one these columns can answer, and the fix was to
stop asking it rather than to keep refining the guess.
- **#5** Playwright E2E against the deployed app — cannot start until #1089 deploys
- **#6** clean up the merged weekly-report worktrees (judge by PR state; never remove a dirty tree)

## 6. Unanswered, and it is not a code task

**Credential rotation.** `JWT_SECRET`, `ENCRYPTION_KEY`, `RESEND_API_KEY` and the Procore client secret
were printed into a session transcript. Printed is disclosed, so all four are compromised and all four
have to be rotated. Raised four times and still unanswered — but what is unanswered is the *scheduling*,
not whether. Recording this as "risk accepted" is not a way to close it.

Each rotation has a cost worth scheduling rather than discovering:

| Secret | What rotating it costs |
|---|---|
| `JWT_SECRET` | Every session dies at once. Off-hours. |
| `ENCRYPTION_KEY` | It decrypts the stored **Procore** and **Microsoft Graph** OAuth tokens. Rotate without re-encrypting those rows and both integrations break until each is re-authorised. Same window. |
| `RESEND_API_KEY` | Cheapest, and it carries client email. Do it first. |
| Procore client secret | Rotate in Procore, then update the CRM side. |

Then scrub the transcript. **Status: not started.**

---

## What this feature has taught, and what it costs to ignore

Across #1089 and #1090 the review bots found **seven real defects** that a green suite did not. The
pattern is specific and it repeated:

- **Three were comments asserting behaviour that did not exist.** A carry-label that was never cleared, a
  route claiming it exposed no contact details, a deploy note claiming a skipped tick "loses nothing".
- **Two were tests of mine that could not fail.** One asserted a subject string no code path emits — in
  the guard for the regression the whole design exists to prevent.
- **Two were the same fact rendered inconsistently across three surfaces**, each time with only one of
  the three fixed.

Mutation testing caught what review did not: it **deleted** a predicate documented as load-bearing
(`superseded_by_id IS NULL`, which could not fire and was wrong in the one case it changed), and it
exposed a migration suite that stayed fully green with the migration's core statement removed.

**Concretely, for whoever picks this up:**

1. **Break the source and watch the test fail.** Every guard, every time. Two unfireable assertions
   shipped past a reading of the code.
2. **A comment is a claim.** If it says "cleared when X", grep for the clear.
3. **One fact, three surfaces.** Count, chip, border. Fix all three or none.
4. **Run the bots on the exact tip and read the findings.** A `CANCELLED` check is not a pass — that
   nearly caused a merge on an ungated tip in this session.
