# Weekly Reports — running status

Living document. Update it when something lands; do not date-stamp it.

Verified against GitHub and the working tree on **2026-08-23**.

**No commit SHAs for live PR state below, on purpose.** An earlier version of this file pinned #1089 to a
tip and a check count, and both were wrong within the hour — every push during a review loop invalidates
them, including the push that updates this file. For anything that moves, the commands are given instead.
Run them; do not trust a remembered number.

```
# Substitute the PR you actually care about — the open set is listed below.
PR=1099
gh pr view $PR --json state,headRefOid,mergeStateStatus
gh pr checks $PR
gh api graphql -f query="{repository(owner:\"artificialadnaan\",name:\"trockcrm\"){pullRequest(number:$PR){
  reviewThreads(last:40){nodes{isResolved path comments(first:1){nodes{author{login}body}}}}}}}" \
  --jq '[.data.repository.pullRequest.reviewThreads.nodes[]|select(.isResolved==false)]'
```

---

## State at a glance

| | Where it is |
|---|---|
| `origin/main` | **#1089 through #1095 are all merged and deployed.** The batch this file was written to track is done. |
| Migrations on main | `0222`–`0231`. `0228`–`0230` are per-office (applied in `dallas`, `atlanta`, `pwauditoffice`); **`0231` is `public.weekly_report_views` and is verified in `public`** — it is deliberately not an office table, because a share link is opened by a route holding only a token, before any tenant is known. Do not go looking for a per-office 0231. |
| `feat/weekly-report-open-tracking` | Shipped as **#1092**. The branch is pushed and merged; it is no longer a loose local branch. |
| Still open | **#1096** dialog widths · **#1097** this correction · **#1100** sort-header target size. |
| Merged today | **#1094**, **#1095**, **#1098** (icon-button accessible names, `1a0226a`), **#1099** (the delivery-route regression from #1094, `fa14f59`). |

---

## Open work

- [x] **The 24-month retention purge — SHIPPED with #1092.** `worker/src/jobs/weekly-report-view-purge.ts`
  holds the batched purge and `worker/src/index.ts` schedules it daily. This was listed as open work in an
  earlier revision of this file, which would have sent somebody to reimplement it.

- [ ] **1. Playwright E2E against the deployed app.** #1091/#1092/#1093 have been verified live; the rest of
  the batch has not been walked end to end.

- [ ] **2. Clean up the merged weekly-report worktrees and stale branches.** ~18 branches, most merged.
  Judge by PR state; never remove a dirty tree.

### Landed since this file was last accurate

- **#7 → #1093.** The duplicate-risk warning. **The follow-up's premise was wrong** — a send's outcome is
  not recoverable from `send_delivered_at` / `send_error` / `send_attempts`, so the gate stayed on age and
  the WORDING was corrected instead. See `docs/superpowers/specs/2026-08-20-weekly-reports-remaining-work.md`,
  which is superseded for status but is the record of why.
- **#8 → #1095.** Dictation rate limiting: burst plus a daily cap, keyed per USER, because a crew shares a
  jobsite NAT. Note that not every call is a paid one — blank transcripts, over-length transcripts, and
  deploys without `ANTHROPIC_API_KEY` are formatted locally. "Over-length" means over the **private
  4,000-character `MAX_MODEL_TRANSCRIPT_CHARS`** — the exported `MAX_DICTATION_TRANSCRIPT_CHARS` is 20,000
  and REJECTS with a 400 rather than falling back.
- **#9 → #1094**, and its follow-up **#1099**. The re-mint capability landed, but its entry point was placed
  inside the card's `done` branch, so the route closed itself as soon as the cadence rolled over — which is
  before anyone needs it. Fixed in #1099.

---

## Decisions waiting on Adnaan — not code tasks

- [ ] **10. PDF layout pass.** He wants to review on his phone and list his changes **first** — he asked for
  exactly that order. One defect already confirmed: the Issues/Concerns box is 84pt inside a 130pt row and
  the reference document's own text overflows onto page 2.

- [ ] **11. Fifteen dialogs app-wide still render at 384px** regardless of the width they request.
  `DialogContent` pins `sm:max-w-sm`, and tailwind-merge keeps an unprefixed `max-w-*` alongside it rather
  than replacing it. The four weekly-report dialogs are fixed with `sm:!max-w-*`. The real fix is one line
  in the primitive — but it resizes 15 surfaces at once, several presumably laid out against the 384px they
  actually got. Own PR, own visual pass.

- [ ] **12. Five roster people have no CRM login** — Corey McShane, Eric Burnett, Kevin Posey, Nick Cheatam,
  Triston Mitchell. They can hold PM/super slots, print on reports and receive reminders, but cannot
  approve or send; a director approves on their behalf and the form says so. Giving them logins is admin
  provisioning, not a code change.

- [ ] **13. Credential rotation — the one item here that is not a preference.** `JWT_SECRET`,
  `ENCRYPTION_KEY`, `RESEND_API_KEY` and the Procore client secret were printed into a session transcript.
  Printed is disclosed; all four are compromised and all four have to be rotated. **Raised four times, and
  what is unanswered is the scheduling, not the whether.** Costs, because they want scheduling rather than
  discovering: `JWT_SECRET` kills every session at once (off-hours) · `ENCRYPTION_KEY` decrypts the stored
  Procore and Microsoft Graph OAuth tokens, so rotating without re-encrypting those rows breaks both
  integrations until each is re-authorised · `RESEND_API_KEY` is cheapest and carries client email, so do
  it first · the Procore secret rotates in Procore, then the CRM side. Then scrub the transcript.

---

## Recently completed

### On `main` (17–19 Aug) — the module itself

| PR | What |
|---|---|
| **#1070** | Migration 0222 + the weekly-reports server module |
| **#1071** | CRM dashboard at `/projects/weekly-reports` |
| **#1072** | Reminder cron + leadership digest |
| **#1073** | T-Rock Cam Reports tab + superintendent wizard |
| **#1075** | PDF renderer + public viewer + token minting |
| **#1076** | Forward transition conditioned on **content**, not just status |
| **#1081** | The send flow — server-composed email, delivery job, corrections |
| **#1082** | Reminders deep-link into T-Rock Cam, gated on the **shipped** app |
| **#1083** | Spec + plan for the five deferred follow-ups |
| **#1084** | Dictation moved server-side |
| **#1085** | The field send — the assigned PM can actually send |
| **#1086** | Dead-letter sweep — somebody is told when a send never left the building |
| **#1087** | Delivery made a **real fact**, not "the provider accepted the call" |
| **#1088** | The PM has somewhere to go when their send fails |

### Shipped with #1089 — **on main since 2026-08-20**

*Kept as the record of what this batch contained. The heading below used to read "sitting in #1089 — not
on main"; that was true when it was written and is not now.*

**#1090 — week-to-week continuity, escalation, duration, photo speed**

- Percent complete and total weather-delay days **carry forward** from the last submitted report
- Next week's Work Completed **prefills** from last week's Look Ahead — and the carry pointer is
  cleared the moment the text is edited, so rewritten text is never labelled "last week's plan"
- **17:00 CT escalation** to the assigned sales rep when a report is past due, with a claim ledger for
  idempotency and a leadership fallback when the rep's address is missing *or malformed*
- Projected duration reaches the report that prints it
- Public-link photos: derived-JPEG R2 cache, content-addressed, with lookup and write timeouts

**#1089 — roster, pickers, audit trail**

- PM/Super pickers sourced from the **Field Team roster** — the Adam Sherwood bug; coverage went 6 → 15
- Client and contract date auto-populate from the picked deal
- Project picker restricted to **Won** deals
- Per-project drill-in with the full audit trail — submitted, approved, sent, reminded, dismissed, paused
- Weekly-report modals resized and re-laid-out for hierarchy

### The #1089 review loop — three rounds, three real defects

Each landed on a tip whose predecessor had been called clean, which is why the bar in item 1 is the
*current* tip and not the last verdict.

1. **Greptile P1 — an accepted correction hid a failure.** `v1 bounced → v2 accepted-but-unverified` read
   as a settled week; the provider taking a correction is not the client receiving it.
2. **Greptile P1 — a delivered correction left a stale failure.** The fix for (1), asking "did anything
   fail" when the question is "is anything still *unanswered*". `v1 bounced → v2 delivered → v3 accepted`
   was flagged off a bounce the client's copy of v2 had already answered. Now compares the newest failure
   against the newest confirmed receipt.
3. **CodeRabbit — the credential language, and this file's own staleness.** Both fixed; the second is why
   there are no live SHAs at the top any more.

Two structural changes came out of it, and they matter more than the bugs: `outstanding` is now **decided
on the server** so the count, chip and border cannot disagree again, and **two guards that could not fail**
were found by mutation testing and given cases that reach them.

### Shipped as #1092 — `feat/weekly-report-open-tracking` (merged 2026-08-21)

*Merged and deployed, including the 24-month retention purge — `worker/src/jobs/weekly-report-view-purge.ts`,
scheduled daily from `worker/src/index.ts`. This section used to read "Built, tested, unpushed", and an
intermediate revision of this file still called the purge outstanding after correcting it elsewhere. Nothing
in this section is outstanding.*

- Migration `0231` — `public.weekly_report_views`
- Open logging on the page, PDF and photo routes
- Session grouping on IP **and** user agent within 30 min. The scanner-vs-person LABELS that originally
  went with it — "A person", "Email scanner" — were **removed before ship**: `summariseWeeklyReportViews`
  groups fetches without judging them, and the audit dialog says so in place of a verdict it could not
  stand behind. An earlier revision of this file still described the classifier as shipped.
- The opens panel in the audit dialog

---

## How this feature has been going wrong

Across #1089 and #1090 the review bots found **seven real defects that a green suite did not**, in three
shapes that repeated:

- **Three were comments asserting behaviour that did not exist** — a carry-label that was never cleared, a
  route claiming it exposed no contact details, a deploy note claiming a skipped tick "loses nothing".
- **Two were tests that could not fail.** One asserted a subject string no code path emits — inside the
  guard for the exact regression the design exists to prevent.
- **Two were one fact rendered inconsistently across three surfaces**, each time with only one of the three
  fixed.

Mutation testing caught what review did not: it **deleted** a predicate documented as load-bearing
(`superseded_by_id IS NULL`, which could not fire and was wrong in the one case it changed), and it exposed
a migration suite that stayed fully green with the migration's core statement removed.

So, concretely:

1. **Break the source and watch the test fail.** Every guard, every time.
2. **A comment is a claim.** If it says "cleared when X", grep for the clear.
3. **One fact, three surfaces.** Count, chip, border — fix all three or none.
4. **A `CANCELLED` check is not a pass.** That nearly caused a merge on an ungated tip.
