# Weekly Reports — running status

Living document. Update it when something lands; do not date-stamp it.

Every claim below was verified against GitHub and the working tree on **2026-08-20**. Re-verify before
acting — PR state and branch tips move.

---

## State at a glance

| | Where it is |
|---|---|
| `origin/main` | `20ab7cb5b` — the merge of **#1088**. Everything through the 19 Aug batch is on main. |
| **PR #1089** `feat/weekly-report-setup-roster` | **OPEN.** Tip `1c096b508`. All 6 checks pass. **3 unresolved review threads.** |
| **PR #1090** | MERGED — but into **#1089's branch**, not main. It ships when #1089 does. |
| `feat/weekly-report-open-tracking` | 3 commits, **never pushed**, no upstream, based on `8fb22cfb5` (pre-#1090-merge). |
| Migrations on main | `0222`–`0227`. |
| Migrations NOT on main | `0228`, `0229`, `0230` (in #1089) · `0231` (unpushed branch). |

**Nothing in #1089 or #1090 is in production.** Two full batches of work are sitting behind one PR.

---

## Open work

### Blocking the merge

- [ ] **1. Greptile P1 — "Accepted correction hides failure."**
  `client/src/pages/projects/weekly-report-project-audit-dialog.tsx`. When v1 bounced and its correction
  v2 was accepted by the provider but has no delivery verdict yet, the `!supersededById` filter suppresses
  the failure and the week reads as fully resolved. Positive evidence of one failure, no positive evidence
  of success.
  **A real trade, not a typo.** Flagging every accepted-but-unverified send lights up every report for its
  first few minutes — which is why the current rule exists. The narrow fix keeps the week flagged only
  when a *known failure* preceded the unverified correction.
  Whichever way it goes, **the summary count, the per-report chip and the card border must all agree.**
  Those three have disagreed twice already and each time only one got fixed.

- [ ] **2. CodeRabbit — unlabelled fenced block** in `2026-08-20-weekly-reports-handoff-prompt.md:7`.
  One word (` ```text `). Trivial.

- [ ] **3. CodeRabbit (Critical) — the credential language in both spec docs.**
  The docs say rotation "needs a decision, even if the decision is to accept the risk." CodeRabbit's
  position is that exposed production credentials should be treated as compromised, not risk-accepted.
  It is right about the wording. The underlying decision is item 15 and is Adnaan's.

### Then, in order

- [ ] **4. Merge #1089 → deploy → verify.** **Adnaan merges this one** — the merge authorisation given this
  session was for #1090 specifically.
  **Merge before 11:00 CT.** The reminder cron runs 07:00 with catch-up at 09:00 and 11:00; a later deploy
  costs that day's t−2/t−1 nudges and the digest.
  Deploy order does not matter — the worker probes for every column it needs and skips offices cleanly
  until the API migrates.
  After deploy, verify against production rather than assuming:
  - `0228`/`0229`/`0230` applied in **all three** office schemas (`dallas`, `atlanta`, `pwauditoffice`)
  - the PM picker offers all **15** roster people (it offered 6 before this work)
  - worker logs show the **17:00 CT** escalation cron registered
  - **be present for that cron's first firing.** It is new and it emails a sales rep.

- [ ] **5. Ship open-tracking.** Branch is built and tested but **not pushed** and its base predates the
  #1090 merge — **rebase onto main after #1089 lands**, do not merge the old base forward.
  Built: migration `0231` (`public.weekly_report_views`), the classifier in `shared/lib/weeklyReportViews`,
  logging on all three public routes, the audit-dialog panel.
  Decisions already taken, **do not relitigate**: log raw and classify at read time · full IP + user agent ·
  24-month retention · **no client-facing disclosure** (Adnaan decided this explicitly).

- [ ] **6. The 24-month retention purge.** The one piece of open-tracking that is not built. Worker job,
  beside the dead-letter sweep, with the same table-exists probe the other jobs use.

- [ ] **7. Playwright E2E against the deployed app.** Cannot start until #1089 deploys.

- [ ] **8. Clean up the merged weekly-report worktrees and stale branches.** ~18 branches, most merged.
  Judge by PR state; never remove a dirty tree.

### Older follow-ups, still open

- [ ] **9.** The duplicate-risk warning gates on **age alone**; it should gate on **outcome**.
- [ ] **10.** Decide whether the dictation endpoint needs **rate limiting**.
- [ ] **11.** A field PM **cannot re-mint a share link** they just sent.

---

## Decisions waiting on Adnaan — not code tasks

- [ ] **12. PDF layout pass.** He wants to review on his phone and list his changes **first** — he asked for
  exactly that order. One defect already confirmed: the Issues/Concerns box is 84pt inside a 130pt row and
  the reference document's own text overflows onto page 2.

- [ ] **13. Fifteen dialogs app-wide still render at 384px** regardless of the width they request.
  `DialogContent` pins `sm:max-w-sm`, and tailwind-merge keeps an unprefixed `max-w-*` alongside it rather
  than replacing it. The four weekly-report dialogs are fixed with `sm:!max-w-*`. The real fix is one line
  in the primitive — but it resizes 15 surfaces at once, several presumably laid out against the 384px they
  actually got. Own PR, own visual pass.

- [ ] **14. Five roster people have no CRM login** — Corey McShane, Eric Burnett, Kevin Posey, Nick Cheatam,
  Triston Mitchell. They can hold PM/super slots, print on reports and receive reminders, but cannot
  approve or send; a director approves on their behalf and the form says so. Giving them logins is admin
  provisioning, not a code change.

- [ ] **15. Credential rotation.** `JWT_SECRET`, `ENCRYPTION_KEY`, `RESEND_API_KEY` and the Procore secret
  were printed into a session transcript. **Raised four times now, never answered.** See item 3.

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

### Built and reviewed, sitting in #1089 — **not on main**

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

### Built, tested, **unpushed** — `feat/weekly-report-open-tracking`

- Migration `0231` — `public.weekly_report_views`
- Open logging on the page, PDF and photo routes
- The scanner-vs-person classifier: groups on IP **and** user agent within 30 min; engagement
  (PDF download, photo loads) outranks the agent string
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
