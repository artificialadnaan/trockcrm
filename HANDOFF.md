# Handoff — TRock Cam "AI Report" (PR #1019)

You are taking over an **autonomous drive-to-green review loop** on an open PR. The feature is built,
the gate is green, and the job is to keep cycling Codex review → fix → push → re-trigger until Codex
returns a clean verdict. Adnaan merges; **never self-merge.**

---

## 1. Where everything is

| | |
|---|---|
| Worktree | `/Users/adnaaniqbal/Developer/trockcrm/.worktrees/ai-report` (**not** the main checkout — different branch) |
| Branch | `feat/trockcam-ai-report` |
| Tip | `0829a1971d55cf894fc549a732c4c2e5ed119f7f` — pushed, local == remote, **working tree clean** |
| PR | https://github.com/artificialadnaan/trockcrm/pull/1019 — `MERGEABLE`, +4527/−40 across 26 files |
| Base | `main`. Branch is **2 commits behind** (`964eaeb60`, `ac555bcef`) with **zero file overlap** — do not rebase mid-round (see §5) |

**Shell cwd resets between Bash calls.** `cd` into the worktree in every command, or use absolute paths.
Subagents run in the MAIN checkout, so always give them the absolute worktree path.

---

## 2. What the feature is

An **"AI Report"** button beside "Preview report" on the T Rock Cam Build-report screen. Selected photos go
to Claude acting as a Director of Construction; out comes the existing branded PDF (cover → executive
summary with "Key Concerns at a Glance" → per-photo findings). Reference format:
`~/Downloads/HVAC_Platform_Assessment_Report.pdf`.

**Three product rules that drive most of the design** (from Adnaan, mid-build):

1. **Photo captions are input.** `files.description` — what the crew typed on site — is sent with each image
   as a fenced `<field_note>`, so the model doesn't re-raise things the field already knows about.
2. **An optional focus prompt** scopes *both* the summary and the per-photo findings. Blank = a general
   director's read. It's a third step in the sheet (select → focus → generate), with dictation.
3. **Don't nitpick.** Every selected photo still prints (it's a *documentation* report), but the model only
   *writes about* the ones worth citing. A photo it passes over keeps whatever caption the crew gave it —
   no invented "no issues found" line. Enforced in `shapeFindings`, not just in the prompt.

**Model:** `claude-sonnet-5`, overridable via `AI_REPORT_MODEL`. Adnaan chose Sonnet over Opus explicitly.
Thinking is left at the model default — **do not disable it**; that's the documented trigger for the model
emitting a tool call as plain text, which under forced tool use looks like a clean success and silently
yields zero findings.

### Request flow

```
POST /field/reports/ai-generate   → run row + job_queue row in ONE transaction → 202 {runId}
worker (dedicated poller)         → thin shim dynamic-imports the SERVER orchestrator
GET  /field/reports/ai-status/:id ← phone polls every 3s until terminal
```

### The five phases — this ordering is load-bearing

```
A  tx    load project + photo rows
B  ---   Claude vision pass          ← NO transaction
C  tx    read what the renderer needs
D  ---   render PDF + upload to R2   ← NO transaction
E  tx    write the files row (re-validates the project first)
```

`runInOfficeTransaction` holds a pooled client under `SET LOCAL statement_timeout = '30s'`. Minutes of work
inside one is the documented "Couldn't load deals" pool-saturation failure. **`field-ai-report-job.test.ts`
asserts the exact phase ordering** — if either slow step moves back inside a transaction, that test fails.

### Key files

```
migrations/0208_field_ai_report_runs.sql          public table + CHECKs + partial unique index
shared/src/schema/public/field-ai-report-runs.ts  drizzle mirror
server/src/modules/field/ai-report-service.ts     vision call, prompt, batching  ← the core IP
server/src/modules/field/ai-report-runs.ts        run ledger (raw SQL on the shared pool)
server/src/modules/field/ai-report-job.ts         orchestrator (the 5 phases)
server/src/modules/field/pdf-layout.ts            + "findings" layout (1 photo/page, bullets)
server/src/modules/field/photo-reports-service.ts split into prepare / renderAndStore / record
server/src/modules/field/routes.ts                ai-generate + ai-status
worker/src/jobs/ai-report-generation.ts           thin shim (dist→src dynamic import)
worker/src/queue.ts + index.ts                    dedicated ai_report_generation poller
mobile/src/components/ReportBuilder.tsx           AI button, focus step, polling
```

---

## 3. IMMEDIATE NEXT ACTION — round 4's findings

Codex reviewed `0829a1971d` and left **5 inline findings**. Read them in full first:

```bash
cd /Users/adnaaniqbal/Developer/trockcrm/.worktrees/ai-report
R=artificialadnaan/trockcrm; TS=2026-07-30T23:43:05Z
gh api "repos/$R/pulls/1019/comments?per_page=100" --paginate 2>/dev/null \
  | jq -r --arg ts "$TS" '.[]|select(.user.login|startswith("chatgpt-codex"))|select(.created_at > $ts)|"---\n\(.path):\(.line // .original_line)\n\(.body)"'
```

My triage (**verify each against current code before acting — do not trust this list blindly**):

| # | Sev | Finding | My read |
|---|---|---|---|
| 1 | P1 | `ai-report-runs.ts:160` — a live run can age past the 20-min stale window during Phase D, because `started_at` is never refreshed and the 12-min deadline covers only model calls. Next enqueue reaps a live run. | **Real.** Fix: heartbeat `started_at = now()` before Phase D (add `touchAiReportRunHeartbeat`). |
| 2 | P1 | `pdf-layout.ts:311` — transcode-failure path returns the **raw** original to PDFKit, so a native JPEG over sharp's 50MP limit is embedded full-size, defeating the memory bound. | **Real.** Fix: on transcode failure return raw only under a hard cap (~8MB), else `null` (placeholder). |
| 3 | P2 | `ai-report-job.ts:235` — Phase E's project re-validation throws *after* the PDF is uploaded, so the R2 object is orphaned (the insert-level cleanup never runs). | **Real.** Fix: try/catch around Phase E, `deleteObject(stored.r2Key)` on failure. |
| 4 | P2 | `ai-report-service.ts:562` — a field note is an unbounded `text` column; several long ones bloat the request. | **Real.** Fix: cap each caption (~500 chars) in `sanitizeUntrusted`/label building. |
| 5 | P2 | `ReportBuilder.tsx:544` — AI button not disabled for view-only off-office projects. | **ALREADY HANDLED — refute with evidence.** The "Build report" launcher (`mobile/app/(app)/projects/[id].tsx:188-193`) sits inside the `!offOffice` branch (`View style={styles.actions}`, lines 170–198); off-office renders a view-only `Banner` instead. The builder can't be opened at all, so the AI button is unreachable. Reply in-thread with those line refs rather than adding a redundant guard. |

**#1 and #2 are both consequences of round 3's own fixes.** That's been the pattern every round — each fix
surfaces its own follow-on. Expect it and don't be alarmed.

After fixing: add a test per substantive finding, run the gate (§4), commit, push, re-trigger (§5).

---

## 4. The gate — run ALL of this before every push

```bash
cd /Users/adnaaniqbal/Developer/trockcrm/.worktrees/ai-report
npm run check:premerge                        # build + typecheck:tests:all + test:ci + test:scripts
npm run test:runtime --workspace=server       # ← premerge does NOT run this; CI's build-gate DOES
cd mobile && EXPO_PUBLIC_API_BASE_URL=https://api.test.local npx jest   # mobile is UNGATED in CI
```

Last known-green numbers on `0829a1971`:

| | |
|---|---|
| server `test:ci` | 7053 |
| server `test:runtime` | 2185 (244 files) |
| worker | 505 |
| client | 2562 |
| client-field | 110 |
| scripts | 41 |
| mobile jest | 636+ |
| typecheck | clean, all 5 workspaces |

**Known-acceptable noise:** mobile `tsc` reports 5 pre-existing errors in
`mobile/app/(app)/scorecards/corrective-action/[id].tsx` (`CorrectiveActionItem.events` doesn't exist on
`origin/main` either). Filter them; do not fix them here.

---

## 5. The review loop — exact procedure

```bash
R=artificialadnaan/trockcrm
git push
git rev-parse HEAD && git rev-parse origin/feat/trockcam-ai-report   # MUST match before claiming anything
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ); echo "$TS"                        # record; you filter findings by this
gh pr comment 1019 --repo $R --body "@codex review"
```

Then poll `build-gate` **and** Codex on the exact tip. Rules that matter:

- **Filter Codex by `created_at`/`submitted_at` > your trigger timestamp, NOT by `commit_id`.** After a push
  GitHub re-points existing inline comments at the new tip, so round-N findings look fresh.
- **Confirm `Reviewed commit:` in the review body matches your exact tip.**
- **Clean verdict** = an issue comment `Codex Review: Didn't find any major issues.` — or a review whose body
  is just the boilerplate header with **zero** inline comments.
- **A FAILED Codex run looks exactly like a pending one** (`Something went wrong… Unknown error`). Read the
  summary text; don't treat absence as approval.
- Codex normally responds in 2–4 min but has taken ~10. If nothing after ~10 min, re-trigger.
- **Don't rebase mid-round.** Codex reviews the merge-test commit; a force-push invalidates the in-flight
  review and costs a full cycle. Rebase only between rounds, and only if `main` actually conflicts
  (currently 2 commits behind, zero overlap — leave it).

**CodeRabbit is out of the loop.** It's rate-limited on the *org spending cap*, not the self-clearing
adaptive limit, and re-triggering doesn't help. Adnaan steered to "use codex review". Note: its check reads
`pass / Review rate limited` even when it has reviewed nothing — **the only trustworthy signal is a
"Review finished" issue comment newer than the tip.** Don't read its green check as a clean review.

---

## 6. Gotchas already paid for — don't rediscover these

- **`photo_ids` must use `sql.param()`.** A bare `${array}` in a drizzle template expands to
  `($1, $2)::uuid[]` — a syntax error that would have 500'd **every** enqueue. Mocked route tests stayed
  green; only the real-SQL runtime test catches it.
- **A mock must mirror every export the route imports.** A missing one is `undefined` at the call site and
  500s the request. This bit twice (`MAX_FOCUS_PROMPT_LENGTH`, then the quota exports).
- **`clearAllMocks` does NOT drain a queued `mockRejectedValueOnce`.** An unconsumed one fires in a later
  test as a baffling wrong-status failure. The route suite now `mockReset()`s explicitly.
- **Resolve migration paths from `import.meta.url`, never `process.cwd()`.** cwd is the repo root under the
  root vitest config but `server/` under `--workspace=server`. A cwd-relative path makes the file error at
  import and its tests get **silently skipped** — worse than failing.
- **Snapshot guards don't hold under concurrency.** The per-user quota started as count-then-insert and was
  correctly flagged; the predicate now lives inside the INSERT.
- **PDFKit accepts JPEG/PNG only.** HEIC/WebP need transcoding or they render "Image unavailable".
- **Two heavy PDF tests need explicit 30s timeouts** — the root vitest config defaults to 5s while
  `server/vitest.config.ts` allows 15s, so they flake depending on which config picks them up.
- `sharp`/`pdfkit` are **server-only** — that's why the worker job is a dynamic-import shim.
- Field routes use **`req.fieldUser`** (not `req.user`) and go through `runFieldDealWrite(req, {dealId}, (db, office) => …)`.

---

## 7. Not blocking, but Adnaan should know

- **Migration `0208` has not been applied anywhere.** Per the standing agreement, Adnaan runs every prod
  write himself. It's verified against a real Postgres engine (PGlite): applies, idempotent, both CHECKs
  bite, the in-flight index blocks a second tap and frees on completion *and* failure, and the reaper
  expires an abandoned run without touching a live one.
- **`AI_REPORT_MODEL`** is new and optional. `ANTHROPIC_API_KEY` / `R2_*` already exist. Without a key the
  endpoint returns 503 rather than queueing a job that can't run.
- **No real Claude call has ever been made.** Transport is covered by stubbed-fetch tests only. The first
  live run is unexercised — worth watching.
- **`mobile/` is ungated in CI.** `mobile-crm` in CI is the *other* app. This feature's UI is covered only by
  the local jest run.
- Optional env: `AI_REPORT_BATCH_SIZE` (default 20), `AI_REPORT_TOTAL_DEADLINE_MS` (default 12 min — must
  stay well under `STALE_RUN_MINUTES` = 20), `AI_REPORT_{INPUT,OUTPUT}_COST_PER_MILLION_USD`.

---

## 8. Round history

| Round | Tip | build-gate | Codex |
|---|---|---|---|
| pre-PR | — | — | own adversarial pass: 43 candidates → 5 confirmed |
| 1 | `1adfcbc05` | pass | 10 findings |
| 2 | `3b6515d23` | pass | 8 findings |
| 3 | `392d15166` | pass | 8 findings |
| 4 | `0829a1971` | pending | **5 findings ← you are here** |

Every finding across rounds 1–3 was legitimate; #5 in round 4 is the first refutable one. Findings are
shrinking and converging on follow-ons rather than new categories.

**Definition of done:** Codex returns "Didn't find any major issues" with `Reviewed commit` matching the
exact pushed tip, and `build-gate` is green on that same tip. Then report to Adnaan with evidence — do not
merge.
