# Weekly Reports — everything still outstanding

Status: spec + handoff
Date: 2026-08-20

Written at the end of a long session. State below was verified against GitHub, the production database
and the working tree at the time of writing — re-verify before acting, because several items move.

---

## Where things actually are

| | State |
|---|---|
| **PR #1089** `feat/weekly-report-setup-roster` → `main` | OPEN. Tip `723cecf0a`. All four checks green. **1 open Greptile thread** (task 1). Contains #1090 merged into it. |
| **PR #1090** | MERGED into #1089's branch. Verified by content. |
| `feat/weekly-report-open-tracking` | 3 commits, **never pushed**, based on `8fb22cfb5` (pre-#1090-merge). |
| Migrations not yet on `main` | `0228`, `0229`, `0230` (+ `0231` on the unpushed branch) |
| Deployed to production | **Nothing from this batch.** Main is still at the 8 merged PRs from the previous session. |

**Merge order is #1089 first.** Everything else stacks on it.

---

## 1. Close the last Greptile finding on #1089  — BLOCKING THE MERGE

`client/src/pages/projects/weekly-report-project-audit-dialog.tsx`, "Accepted correction hides failure".

The `undelivered && !supersededById` rule — added earlier in the session to stop a *resolved* week showing
a permanent red failure — is too broad in one direction. When v1 **bounced** and its correction v2 was
accepted by the provider but has no delivery verdict yet, the week reads as fully resolved. There is
positive evidence of one failure and no positive evidence of success.

**Judgement required, and it is a real trade.** Flagging every accepted-but-unverified send would light up
every report for its first minutes, which is why the current rule treats "accepted, no webhook verdict"
as fine. The narrower fix is to keep the week flagged only when a **known failure** preceded the
unverified correction.

Whatever is chosen, **the three surfaces must agree**: the summary count, the per-report chip and the card
border. They have disagreed twice already this session and each time only one of the three was fixed.

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

- **#15** duplicate-risk warning gates on age alone; should gate on outcome
- **#16** decide whether the dictation endpoint needs rate limiting
- **#17** a field PM cannot re-mint a share link they just sent
- **#5** Playwright E2E against the deployed app — cannot start until #1089 deploys
- **#6** clean up the merged weekly-report worktrees (judge by PR state; never remove a dirty tree)

## 6. Unanswered, and it is not a code task

**Credential rotation.** Production secrets were printed into a session transcript earlier —
`JWT_SECRET`, `ENCRYPTION_KEY`, `RESEND_API_KEY` and the Procore secret. Raised three times, never
answered. It needs a decision, even if the decision is "accept the risk".

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
