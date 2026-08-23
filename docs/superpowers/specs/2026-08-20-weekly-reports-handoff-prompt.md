# Handoff prompt — Weekly Reports remaining work

> **⚠️ ONE ITEM IN HERE IS NOT DONE: CREDENTIAL ROTATION (task 5).** `JWT_SECRET`, `ENCRYPTION_KEY`,
> `RESEND_API_KEY` and the Procore client secret were printed into a transcript and still need rotating —
> and were exposed again on 2026-08-23 by listing the Railway production variables. That task is the one
> thing on this page that is not a preference, it is still outstanding, and the banner below must not be
> read as covering it.
>
> **SUPERSEDED for everything else, 2026-08-23. DO NOT PASTE THIS.** The rest of what it instructs a fresh
> session to do has shipped:
> #1089–#1095 are merged and deployed, migrations 0228–0230 are in all three office schemas and 0231 in
> `public`, and follow-ups #15/#16/#17 landed as #1093/#1095/#1094 (with #1099 correcting #1094).
>
> Pasting it would start a session on work that is already done, which is worse than starting with nothing.
> For current state use `docs/weekly-reports-status.md`; for why #15's premise was wrong see
> `2026-08-20-weekly-reports-remaining-work.md`.
>
> Kept because the prompt itself — what a handoff needs to carry — is the useful part, and because task 5
> is still live. An earlier version of this banner claimed everything here had shipped, which would have
> told somebody the credential rotation was done.

Paste the block below into a fresh session. It is written to be pasted verbatim.

---

```text
Continue the T-Rock CRM Weekly Reports work. Full state and rationale:
docs/superpowers/specs/2026-08-20-weekly-reports-remaining-work.md — read it first.

VERIFY BEFORE YOU TRUST ANY OF THIS. It was written at the end of a long session and
several items move. Check PR #1089's real state, the branch tips, and production before
acting on a single claim in it.

Work in this order. Stop and report after each numbered item rather than chaining them.

1. UNBLOCK PR #1089.
   One open Greptile thread: "Accepted correction hides failure" on
   weekly-report-project-audit-dialog.tsx. A week whose v1 bounced and whose correction was
   accepted-but-unverified currently reads as fully resolved.
   This is a judgement call with a real trade — flagging every accepted-but-unverified send
   would light up every report for its first minutes. Decide it, say why in the commit, and
   make the SUMMARY COUNT, the PER-REPORT CHIP and the CARD BORDER all agree. Those three
   have disagreed twice already and each time only one got fixed.
   Then re-run the bots on the exact tip and drive to zero open threads.

2. HAND #1089 BACK TO ADNAAN TO MERGE. Do not merge it yourself — he merges this one.
   Tell him to merge before 11:00 CT: the reminder cron is 07:00 with catch-up at 09:00 and
   11:00, so a later deploy costs that day's nudges.

3. AFTER HE MERGES AND IT DEPLOYS, verify against production, not by assumption:
   - 0228/0229/0230 applied in all three office schemas
   - the PM picker offers all 15 roster people (it offered 6 before this work)
   - worker logs show the 17:00 CT escalation cron registered
   Then run the Playwright pass (task #5) and clean up the merged worktrees (task #6).

4. SHIP OPEN-TRACKING. Branch feat/weekly-report-open-tracking exists, is tested, and is
   NOT PUSHED. It is based on a commit predating the #1090 merge — rebase onto main after
   #1089 lands. Finish the 24-month retention purge (worker, beside the dead-letter sweep,
   same table-exists probe the other jobs use), then push and open a PR.
   Decisions already made, do not relitigate: log raw and classify at read time; full IP +
   user agent, 24 months; NO client-facing disclosure — Adnaan decided that explicitly.

5. ASK ADNAAN, do not decide for him:
   - the PDF layout pass (he wants to review on his phone and list changes FIRST; one
     defect is already confirmed — the Issues/Concerns box overflows onto page 2)
   - the 15 dialogs still rendering at 384px app-wide (one line in the primitive, resizes
     15 surfaces, wants its own visual pass)
   - whether the 5 roster people with no CRM login should get logins (admin task, not code)
   - CREDENTIAL ROTATION, which is the one item on this list that is not a preference.
     JWT_SECRET, ENCRYPTION_KEY, RESEND_API_KEY and the Procore client secret were printed
     into a session transcript. Printed is disclosed: treat all four as compromised and
     rotate them. What Adnaan is choosing is the WHEN and the sequencing, not the whether.
     Each has a cost that has to be scheduled rather than discovered:
       JWT_SECRET     — every session dies on rotation. Do it off-hours.
       ENCRYPTION_KEY — decrypts the stored Procore and Microsoft Graph OAuth tokens.
                        Rotating it without re-encrypting them breaks both integrations
                        until each is re-authorised. Re-encrypt in the same window.
       RESEND_API_KEY — swap first, it is the cheapest and it carries client email.
       Procore secret — rotate in Procore, then update the CRM side.
     Then scrub the transcript. Do not close this by recording that the risk was accepted.

HOW TO WORK ON THIS FEATURE. Seven real defects got past a green suite in the last session,
in three repeating shapes. Assume you will produce them too:

  * A COMMENT IS A CLAIM. Three defects were comments describing behaviour that was never
    implemented. If a comment says "cleared when X", grep for the clear.
  * BREAK THE SOURCE AND WATCH THE TEST FAIL. Two of my tests could not fail at all — one
    asserted a subject string no code path emits, inside the guard for the exact regression
    the design exists to prevent. Mutate, confirm red, revert. Every guard, every time.
  * ONE FACT, THREE SURFACES. Count, chip, border. Fix all three or none.
  * A CANCELLED CHECK IS NOT A PASS. That nearly caused a merge on an ungated tip.

Mutation testing earns its keep here: it deleted a predicate I had documented as
load-bearing and which could not fire, and it exposed a migration suite that stayed green
with the migration's core statement removed. Use it on anything load-bearing.

Gates: server/worker/client each have their own vitest.ci.config.ts, and `npm test` is not
the gate. Typecheck per package (root tsc lies). No prettier. Never git stash.
```

---

## Why the prompt is shaped this way

**"Verify before you trust any of this"** leads, because the most expensive failure mode for a handoff is
a successor acting on a stale claim. This session opened with a handoff whose numbers were wrong and the
first useful thing done was checking them.

**"Stop and report after each numbered item"** exists because items 1–3 have a human in the middle.
Chaining them produces a session that merges, deploys and verifies before Adnaan has seen any of it.

**Item 2 says "do not merge it yourself"** because the standing rule is hand-over, and the one
authorisation given this session was for #1090 specifically. An authorisation for one PR is not a
standing one.

**Item 5 is framed as questions, not tasks**, because each has already been surfaced and deferred by
Adnaan at least once. Re-deciding them unilaterally would override a decision he has been making
deliberately.

**The working-practices block is concrete and self-critical** rather than general advice. "Write good
tests" would have prevented none of the seven defects. "Two of my tests could not fail, here is how"
might.
