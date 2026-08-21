# Weekly Reports — handoff

Paste the block below into a fresh session. Everything after it is context for a human.

Verified against GitHub, Railway and the production database on **2026-08-21 ~03:30 UTC**.

---

```text
Continue the T-Rock CRM Weekly Reports work. Read docs/weekly-reports-handoff.md first — it has
the full state, what shipped, and why several things are the way they are.

VERIFY BEFORE YOU TRUST ANY OF IT. Check PR state, main's tip and production yourself. This
session opened with a handoff whose numbers were wrong, and the first useful thing done was
checking them.

WHAT THIS FEATURE IS FOR, in one line: a client says "you never sent us that report", and the CRM
has to be able to answer with evidence. Everything below serves that.

WHERE IT STANDS: #1089, #1090, #1091 and #1092 are all merged and DEPLOYED. Migrations 0228-0231
are applied in production and verified per office schema. Open-tracking went live tonight.

WORK IN THIS ORDER. Stop and report after each item rather than chaining them.

1. PLAYWRIGHT AGAINST THE DEPLOYED APP.
   Blocked on a login: the smoke accounts in docs/smoke-credentials.md are REJECTED on
   trockcrm.com (they are for the smoke office). Ask Adnaan for a rep-role Dallas account.
   Without one you can still drive the PUBLIC share-link routes unauthenticated, which
   exercises view logging end to end — do that half first and report what it shows.
   What needs eyes, because it was all diagnosed from code and HTTP logs rather than seen:
     - the History tab's View sheet renders at its real width, not 384px
     - it shows stage + who submitted / approved / sent
     - This Week rows open the record, and the project name works by keyboard
     - the audit dialog's open log shows sittings with address, device, referrer origin

2. THE THREE OLDER FOLLOW-UPS.
   #15 the duplicate-risk retry warning gates on AGE alone; it should gate on OUTCOME. When
       send_delivered_at is null the provider never accepted it, so there is nothing to
       duplicate — and the warning actively discourages retrying a send that definitely failed.
       Code is client/src/pages/projects/weekly-report-history-panel.tsx, RetryButton.
   #16 decide whether the dictation endpoint needs rate limiting.
   #17 a field PM cannot re-mint a share link they just sent.

3. ASK ADNAAN, DO NOT DECIDE:
   - GDPR/CCPA on the view log. This is LIVE and collecting IPs now. 24 months of client-staff
     IP + user agent + referrer origin, with NO client-facing disclosure (his explicit call).
     Needs a lawful-basis position and an answer for erasure/access requests against
     public.weekly_report_views. Raised, never answered.
   - CREDENTIAL ROTATION. JWT_SECRET, ENCRYPTION_KEY, RESEND_API_KEY and the Procore client
     secret were printed into a transcript. Printed is disclosed. Raised five times, never
     answered. Costs: JWT_SECRET kills every session (off-hours); ENCRYPTION_KEY decrypts the
     stored Procore and Microsoft Graph OAuth tokens, so rotating without re-encrypting breaks
     both integrations; RESEND_API_KEY is cheapest and carries client email; Procore rotates
     there first.
   - PDF layout. He wants to review on his phone and list his changes FIRST — he asked for that
     order. One defect confirmed: the Issues/Concerns box is 84pt in a 130pt row and overflows
     onto page 2.
   - 15 dialogs app-wide render at 384px, and the Sheet primitive has the same bug affecting 4
     more surfaces. One line in each primitive, but it resizes 19 surfaces at once. Own PR, own
     visual pass.
   - Five roster people have no CRM login (Corey McShane, Eric Burnett, Kevin Posey, Nick
     Cheatam, Triston Mitchell). Admin provisioning, not code.

4. HOUSEKEEPING: the stage-slash worktree is merged (#1046) but DIRTY — never remove a dirty
   tree. Merged remote branches were left alone deliberately.

HOW TO WORK ON THIS FEATURE. Forty-three review findings landed on it across fifteen rounds.
Assume you will produce the same kinds:

  * THE PAGE MUST NOT CLAIM MORE THAN THE LOG CARRIES. This is the single lesson. Recording is
    best-effort by design — recordWeeklyReportView swallows its own failures so a view that
    cannot be logged never breaks the page a client is reading — so an EMPTY LIST NEVER PROVES
    ABSENCE. Three separate reviewers converged on one sentence, "Nobody has opened the link
    yet", before it became "No fetches of this link have been recorded".
  * A COMMENT IS A CLAIM. Five findings were comments or UI text describing behaviour the code
    did not have. One was a commit message of mine claiming a fix that had silently failed to
    apply. If a comment says "cleared when X", grep for the clear.
  * BREAK THE SOURCE AND WATCH THE TEST FAIL. Every guard, every time. At least six tests here
    could not fail, several of them written specifically to prevent that. Two asserted the bug
    as correct.
  * A SCRIPTED EDIT THAT MATCHES NOTHING LOOKS EXACTLY LIKE ONE THAT WORKED. Verify the file
    afterwards, and assert through the PAYLOAD rather than by reading the SQL.
  * WAIT AFTER THE CHECKS GO GREEN. Codex posts 5-10 minutes late and landed P1s in that window
    four times. Every check SUCCESS + mergeState CLEAN + zero threads, then wait ten minutes and
    check threads AGAIN. Also: build-gate CANCELLED reads as green at a glance, a review can be
    posted against a STALE sha, and a Greptile check can sit at `neutral` mid-run.
  * RUN THE SUITES SERIALLY. Running client and server together starves this machine and fails a
    different pair every time. All pass alone.

GATES: server/worker/client each have their own vitest.ci.config.ts and `npm test` is NOT the
gate. Typecheck per package (root tsc lies). Rebuild shared after touching it or consumers
resolve the stale build. No prettier. NEVER git stash — the stack is shared across worktrees.
```

---

## What we were trying to accomplish

One thing: **make "you never sent us that report" an answerable claim.** Every piece below is in
service of that, and the parts that generated the most argument are the parts where the CRM was
tempted to say more than it could prove.

## What shipped, and what it does

All four PRs are merged and deployed. `main` is at `e61bd1e76`.

### #1089 — roster, pickers, audit trail

- **PM/Super pickers read the Field Team roster**, not the login list. This was the Adam Sherwood
  bug: coverage went from 6 people to 15. Migration `0228` adds `trock_pm_responder_id` /
  `trock_super_responder_id`, keeping the derived login alongside so every existing authz gate
  still works.
- **Client and contract date auto-fill** from the picked deal (`companies.name`,
  `contract_signed_date`). Neither overwrites something already typed.
- **Project picker restricted to Won deals.**
- **The per-project audit trail** — every version of every week, who drafted, submitted, approved
  and sent it, the reminder ledger, dismissals and pauses. All of it was already being written and
  none of it was reachable.
- **The weekly-report modals** were rendering at a third of their requested width.

### #1090 — week-to-week continuity

- Percent complete and weather-delay days **carry forward** (`0230`).
- Next week's Work Completed **prefills** from last week's Look Ahead — and the carry pointer is
  cleared the moment the text is edited, so rewritten text is never labelled "last week's plan".
- **17:00 CT escalation** to the assigned sales rep when a report is past due (`0229`), with a
  claim ledger for idempotency and a leadership fallback when the rep's address is missing *or
  malformed*.
- Projected duration reaches the report that prints it.
- Public-link photos cached instead of re-rendered per request.

### #1091 — the History record

- The View sheet was rendering at **384px**. `SheetContent` pins `data-[side=right]:sm:max-w-sm`
  and tailwind-merge keeps it alongside the requested width. Verified by running `twMerge` on the
  actual strings rather than reasoning about it.
- It could not say **who** — `REPORT_SELECT` joined `authored_by` and nothing else.
- A failed load **said nothing**: `openDetail` had no catch, so a rejection produced exactly the
  sheet's closed state.
- The drill-in was on the **wrong tab** — built on Projects, asked for on the dashboard.

### #1092 — open tracking

`0231` adds `public.weekly_report_views` — public, not per-office, because a share link is resolved
before any tenant is known. Page, PDF and photo fetches are logged; the audit page groups them into
sittings and shows time, span, address, device, referrer origin and what was taken.

Retention is 24 months, swept by a worker cron at 03:20 CT, bounded by wall clock rather than a
batch count.

**Two things about this PR are worth carrying forward.**

**The classifier was removed.** It judged each sitting `person | scanner | unclear`. The motivation
was sound — corporate mail security fetches every link within seconds, so a raw open count is mostly
robots. But every rule separating the two had a counterexample and review found them one after
another: photos looked like scrolling until `loading="lazy"` turned out to preload with nobody
present; photos over time looked like reading until one cached refresh stretched a single image
across two minutes; a PDF download looked decisive until a scanner followed the link, which is what
those products are *for*; the agent string looked authoritative except proxies rewrite it. Ten
rounds, and nearly every finding landed in that one function, because HTTP requests do not carry
intent and a verdict asserts one. The page counts and shows now. **If it comes back, it should be
its own PR where the argument is about one function.**

**Two security fixes.** The `Referer` on every photo and PDF fetch *is* the share URL, so the log
was storing working links in plaintext for 24 months. Redacting the path was not enough — a mail
gateway hands the destination back percent-encoded inside its own URL — so only the **origin** is
stored now. And `HEAD /wr/:token/pdf` dispatched through the GET handler and recorded a PDF fetch,
so a link checker could make the audit assert a client had read a report nobody opened.

## Verified in production, not assumed

- `0228`/`0229`/`0230` in **all three** office schemas (`dallas`, `atlanta`, `pwauditoffice`)
- `0231` applied 03:29:33 UTC; `public.weekly_report_views` with 11 columns, the `event_type`
  CHECK, and **zero** per-office copies
- **All four indexes**, including both partial ones (`engagement_idx`, `page_idx`). These are worth
  checking by eye: a missing partial index fails nothing and errors nowhere — it silently makes the
  bounded read unbounded again on exactly the reports carrying a flood.
- Worker crons registered: reminders 07:00 (catch-up 09:00, 11:00), **rep escalation 17:00**, send
  sweep every 15 min, **view-log purge 03:20**
- Roster: 15 active — 4 PMs, 11 superintendents, 10 with logins. Adam Sherwood is active, a
  `project_manager`, and has a login.

One thing that looked wrong and was not: `0228`'s backfill linked **zero** projects. Both existing
projects are seeded with Adnaan as PM *and* super, and his roster row is `superintendent` with
`is_active = false` — so the PM slot fails the role check and the super slot fails the active check.
The authz boundary refusing to link an inactive row is the intended behaviour.

## What is left

| | |
|---|---|
| Playwright against the deployed app | **blocked on a login** |
| Follow-up #15 duplicate-risk on outcome | not started, scoped |
| Follow-up #16 dictation rate limiting | a decision |
| Follow-up #17 re-mint a share link | not started |
| GDPR/CCPA position | **live and collecting now** |
| Credential rotation | raised five times |
| PDF layout pass | waiting on his phone review |
| 19 surfaces clamped at 384px | own PR, own visual pass |
| Five roster logins | admin task |

## The honest retrospective

Forty-three findings across fifteen rounds on one feature. Three things I would do differently:

**I should have proposed the split around round four, not round ten.** The signal was there: one
function generating a new counterexample every round while everything around it stayed fixed. I kept
treating each finding as a bug to patch rather than as evidence the question was underdetermined.

**Four fixes carried the next bug inside them** — a rule right in the ordinary case and wrong in the
case it was written for. Suppress superseded rows → break the unverified correction. Cap at
earliest-N → discard the buried reader. Bound the process → don't bound the query. Fall back to the
retention floor → fabricate a horizon.

**The most valuable habit was the grace period.** Four times, every check went green and CLEAN, and
findings arrived minutes later. Merging on the green would have shipped two P1s that had the CRM
stating things it could not support — on the one screen built to be quoted to a client.
