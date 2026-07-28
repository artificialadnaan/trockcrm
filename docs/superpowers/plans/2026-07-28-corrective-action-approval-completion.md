# Corrective-Action Approval Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let James approve or reject a submitted corrective action from the CRM, and close the email loop so the super/PM learns what to fix and oversight learns it was approved.

**Architecture:** The state machine, storage, authz and rendering are already built and green. This plan wires the three remaining edges: a card-generation fix so an approval actually reaches the PDF; the notification chain (extend the existing oversight job with an `awaiting_approval` phase, and make the existing responder email rejection-aware rather than adding a second token path); and the approve/reject controls, gated by a server-provided boolean.

**Tech Stack:** TypeScript, Express, Drizzle ORM, Postgres (per-office schemas), PGlite for runtime tests, Vitest, React + Tailwind, a `job_queue` worker with Resend.

**Spec:** `docs/superpowers/specs/2026-07-28-corrective-action-approval-completion-design.md`

---

## Before you start

```bash
cd /Users/adnaaniqbal/Developer/trockcrm/.claude/worktrees/corrective-action-approval
git fetch origin
git rebase origin/main          # #973 merged as 60631ed2; expect conflicts in scorecard-pdf.ts
npm run build --workspace=@trock-crm/shared
TZ=UTC npm run check:premerge
```

Expected baseline after rebase: shared 28/242, server 714/6299, client 319/2438, client-field 19/110, scripts 5/41.

Two environment facts you need:
- `QC_APPROVER_EMAILS` — comma-separated. **Unset means nobody can approve**, by design. Set it locally to test.
- `FIELD_SCORECARD_EMAIL_RECIPIENTS` — the oversight watcher list. Different list, different purpose.

Two repo rules that will bite you:
- **Never `git stash`** in this repo — the stash stack is shared across worktrees. Commit WIP instead.
- **No prettier.** Source is hand-formatted; a format pass rewrites whole files and buries the diff.

---

## File structure

| File | Responsibility | Task |
| --- | --- | --- |
| `server/src/modules/field/corrective-action-approval.ts` | approve/reject state machine — gains an unconditional generation bump | 1 |
| `migrations/0203_corrective_action_approval_requested_stamp.sql` | the third phase stamp column | 2 |
| `shared/src/schema/tenant/field-scorecards.ts` | Drizzle column for that stamp | 2 |
| `worker/src/jobs/scorecard-corrective-action-oversight-email.ts` | `awaiting_approval` phase: approver recipients, own stamp, no responder subtraction; "approved" relabel | 3, 4, 7 |
| `server/src/modules/deals/routes.ts` | reject route calls the cycle restart | 5 |
| `worker/src/jobs/scorecard-corrective-action-email.ts` | derive "this is a return" from state; show rejection reasons | 6 |
| `server/src/modules/field/scorecards-service.ts` | expose `canApproveCorrectiveActions` on the detail read | 8 |
| `client/src/hooks/use-corrective-actions.ts` | approve/reject/approve-all mutations | 9 |
| `client/src/pages/deals/deal-scorecards-tab.tsx` | the controls | 9 |

---

## Task 1: A card's generation must advance whenever any item changes

Approving 1 of 3 items leaves the card in `corrective_action_submitted`, so `recomputeCardStatus` early-returns and never touches `updated_at`. That column IS the PDF's content generation and the currency check is an equality against it — so the artifact stays "current" and **the downloaded PDF omits the approval**. This is the originally reported bug, reintroduced.

**Files:**
- Modify: `server/src/modules/field/corrective-action-approval.ts`
- Test: `server/tests/modules/field/corrective-action-approval-state.runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the existing top-level `describe` in `server/tests/modules/field/corrective-action-approval-state.runtime.test.ts`:

```ts
  it("REGRESSION: advances the card generation even when the CARD status does not change", async () => {
    // updated_at is the PDF's content generation and the currency check is an equality against it. Approving
    // one item of three changes what the PDF renders (the thread gains an `approved` event) while leaving the
    // card in corrective_action_submitted — so an early return here leaves the stale artifact classified as
    // current and the download omits the approval. That is the exact bug this whole feature line exists to fix.
    const { scorecardId, itemIds } = await seedSubmittedCard(3);

    const before = await tdb.execute(sql`
      SELECT status, updated_at FROM field_scorecards WHERE id = ${scorecardId}::uuid
    `);
    const priorGeneration = new Date((before.rows[0] as { updated_at: string }).updated_at);

    await approveCorrectiveActionItems(tdb, {
      scorecardId,
      itemIds: [itemIds[0]],
      actor: { userId: USER, name: "James Helms", email: "james@trockgc.com" },
    });

    const after = await tdb.execute(sql`
      SELECT status, updated_at FROM field_scorecards WHERE id = ${scorecardId}::uuid
    `);
    const row = after.rows[0] as { status: string; updated_at: string };
    // The card has NOT moved — two items still await approval.
    expect(row.status).toBe("corrective_action_submitted");
    // ...but its generation has, so the next download re-renders.
    expect(new Date(row.updated_at).getTime()).toBeGreaterThan(priorGeneration.getTime());
  });
```

If `seedSubmittedCard(n)` does not already exist in that file, add this helper above the `describe`:

```ts
/** A card with `count` items, all `submitted`, so the card sits in corrective_action_submitted. */
async function seedSubmittedCard(count: number): Promise<{ scorecardId: string; itemIds: string[] }> {
  const scorecardId = randomUUID();
  await tdb.insert(fieldScorecards).values({
    id: scorecardId,
    clientSubmissionId: randomUUID(),
    dealId: DEAL,
    weekOf: "2026-07-27",
    totalScore: 23,
    formVersion: 2,
    rating: "corrective_action",
    status: "corrective_action_submitted",
    submittedBy: USER,
  });
  const itemIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID();
    itemIds.push(id);
    await tdb.insert(scorecardCorrectiveActions).values({
      id,
      scorecardId,
      itemType: "action_item",
      itemRef: String(index),
      itemLabel: `Item ${index}`,
      status: "submitted",
      responderName: "Pat Manager",
      responseComment: "Fixed.",
      respondedAt: new Date(),
    });
  }
  return { scorecardId, itemIds };
}
```

- [ ] **Step 2: Run it and verify it FAILS**

```bash
TZ=UTC npx vitest run server/tests/modules/field/corrective-action-approval-state.runtime.test.ts -t "advances the card generation"
```

Expected: FAIL — `expected <n> to be greater than <n>`, the two timestamps being equal.

A test that passes here is not testing the fix. Stop and check your fixture leaves the card status unchanged.

- [ ] **Step 3: Make the generation bump unconditional**

In `server/src/modules/field/corrective-action-approval.ts`, replace the early return in `recomputeCardStatus`:

```ts
  // The card's own status may not move — approving 1 of 3 items leaves it awaiting approval — but the CARD
  // generation must advance regardless, because it is the PDF's content generation and the item change is
  // content. Returning early here re-creates the reported bug: the stale artifact keeps comparing equal and
  // the download omits the approval. Always write; `changed` still reports whether the STATUS moved, which is
  // what the notification callers switch on.
  await tx
    .update(fieldScorecards)
    .set({ status: cardStatus, updatedAt: nextGeneration() })
    .where(eq(fieldScorecards.id, scorecardId));
  return { cardStatus, changed: cardStatus !== currentStatus };
```

Delete the `if (cardStatus === currentStatus) return { cardStatus, changed: false };` line above it.

`nextGeneration()` already exists in this file's imports from `corrective-actions-service.ts`; if not, import it.

- [ ] **Step 4: Run and verify it PASSES**

```bash
TZ=UTC npx vitest run server/tests/modules/field/corrective-action-approval-state.runtime.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Confirm no caller depended on `changed` meaning "wrote a row"**

```bash
grep -rn "recomputeCardStatus" server/src/
```

Expected: only internal calls in `corrective-action-approval.ts`, all reading `cardStatus`. If any reads `changed`, verify it means "status moved" and not "row written" — the semantics are unchanged, but check rather than assume.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/field/corrective-action-approval.ts server/tests/modules/field/corrective-action-approval-state.runtime.test.ts
git commit -m "fix(scorecards): advance the card generation on every item change, not only status moves"
```

---

## Task 2: The third phase stamp

`stampColumn(phase)` is a literal switch from phase to column, and the phase's own stamp is what encodes "this cycle has already been notified". `awaiting_approval` needs its own, or an approval request would suppress the opened or closed notice.

**Files:**
- Create: `migrations/0203_corrective_action_approval_requested_stamp.sql`
- Modify: `shared/src/schema/tenant/field-scorecards.ts`
- Test: `server/tests/modules/migration/corrective-action-approval-requested-stamp.runtime.test.ts`

- [ ] **Step 1: Write the migration**

Both halves are required — the `DO $tenant$` loop reaches existing offices, the `TENANT_SCHEMA` block seeds new ones. Omitting either is a recurring bug in this repo.

```sql
-- Migration 0203: field_scorecards.corrective_action_approval_requested_at
--
-- The third oversight phase stamp. Each phase dedups on its OWN column: the stamp is what encodes "this
-- cycle has been told", and a fresh cycle clears it server-side. Reusing corrective_action_oversight_opened_at
-- or _closed_at would make an approval request suppress the opened or the completion notice for the same
-- cycle, which is a silent missed notification rather than a visible error.
--
-- Nullable and unstamped for every existing row: a card already awaiting approval when this deploys has not
-- been notified, and should be. That is the OPPOSITE of migration 0201's grandfathering, deliberately — 0201
-- suppressed a phantom notice for a cycle whose opened phase had already passed unobserved, whereas here the
-- approver genuinely has work sitting in their queue that nobody has told them about.

DO $tenant$
DECLARE schema_name text;
BEGIN
  FOR schema_name IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^office_' ORDER BY nspname LOOP
    IF to_regclass(format('%I.field_scorecards', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format(
      'ALTER TABLE %I.field_scorecards
         ADD COLUMN IF NOT EXISTS corrective_action_approval_requested_at timestamptz',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.field_scorecards
  ADD COLUMN IF NOT EXISTS corrective_action_approval_requested_at timestamptz;
-- TENANT_SCHEMA_END
```

- [ ] **Step 2: Write the migration test**

Create `server/tests/modules/migration/corrective-action-approval-requested-stamp.runtime.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0203_corrective_action_approval_requested_stamp.sql", import.meta.url),
  "utf8",
);

let pg: PGlite | null = null;

afterEach(async () => {
  await pg?.close();
  pg = null;
});

async function columns(db: PGlite, schema: string): Promise<string[]> {
  const rows = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'field_scorecards'`,
    [schema],
  );
  return rows.rows.map((r) => r.column_name);
}

describe("migration 0203 — approval-requested stamp (runtime, PGlite)", () => {
  it("adds the column to EVERY office schema, not just the template", async () => {
    // The DO-loop is the half that reaches production offices; the TENANT_SCHEMA block only seeds new ones.
    const db = new PGlite();
    pg = db;
    await db.exec(`
      CREATE SCHEMA office_dallas;
      CREATE SCHEMA office_atlanta;
      CREATE TABLE office_dallas.field_scorecards (id uuid PRIMARY KEY, status varchar(30));
      CREATE TABLE office_atlanta.field_scorecards (id uuid PRIMARY KEY, status varchar(30));
    `);
    await db.exec(MIGRATION_SQL);

    expect(await columns(db, "office_dallas")).toContain("corrective_action_approval_requested_at");
    expect(await columns(db, "office_atlanta")).toContain("corrective_action_approval_requested_at");
  });

  it("leaves the stamp NULL, so a card already awaiting approval still gets notified", async () => {
    // The opposite of 0201's grandfathering, on purpose: the approver has real work in their queue that
    // nobody has told them about, so suppressing the first notice would strand it silently.
    const db = new PGlite();
    pg = db;
    await db.exec(`
      CREATE SCHEMA office_dallas;
      CREATE TABLE office_dallas.field_scorecards (id uuid PRIMARY KEY, status varchar(30));
      INSERT INTO office_dallas.field_scorecards (id, status)
        VALUES ('00000000-0000-0000-0000-000000000001', 'corrective_action_submitted');
    `);
    await db.exec(MIGRATION_SQL);

    const rows = await db.query<{ corrective_action_approval_requested_at: Date | null }>(
      `SELECT corrective_action_approval_requested_at FROM office_dallas.field_scorecards`,
    );
    expect(rows.rows[0]?.corrective_action_approval_requested_at).toBeNull();
  });

  it("is idempotent", async () => {
    const db = new PGlite();
    pg = db;
    await db.exec(`
      CREATE SCHEMA office_dallas;
      CREATE TABLE office_dallas.field_scorecards (id uuid PRIMARY KEY, status varchar(30));
    `);
    await db.exec(MIGRATION_SQL);
    await expect(db.exec(MIGRATION_SQL)).resolves.toBeDefined();
  });

  it("skips a schema with no field_scorecards table instead of erroring", async () => {
    const db = new PGlite();
    pg = db;
    await db.exec(`
      CREATE SCHEMA office_dallas;
      CREATE SCHEMA office_empty;
      CREATE TABLE office_dallas.field_scorecards (id uuid PRIMARY KEY, status varchar(30));
    `);
    await expect(db.exec(MIGRATION_SQL)).resolves.toBeDefined();
  });
});
```

- [ ] **Step 3: Run it and verify it FAILS**

```bash
TZ=UTC npx vitest run server/tests/modules/migration/corrective-action-approval-requested-stamp.runtime.test.ts
```

Expected: FAIL — the migration file does not exist yet if you did Step 2 first, or PASS if you did Step 1 first. Order Step 1 then Step 2 and confirm PASS; the point of the test is the DO-loop coverage, which is easy to get wrong.

- [ ] **Step 4: Add the Drizzle column**

In `shared/src/schema/tenant/field-scorecards.ts`, immediately after `correctiveActionOversightClosedAt`:

```ts
    /**
     * "The approver has been told this cycle needs review." The THIRD phase stamp — each phase dedups on its
     * own column, so reusing either oversight stamp would make an approval request suppress the opened or the
     * completion notice for the same cycle. Cleared, like the others, when a genuine reopen mints a new cycle.
     */
    correctiveActionApprovalRequestedAt: timestamp("corrective_action_approval_requested_at", {
      withTimezone: true,
    }),
```

- [ ] **Step 5: Verify schema parity**

```bash
npm run build --workspace=@trock-crm/shared
TZ=UTC npx vitest run server/tests/modules/migration/corrective-action-approval-requested-stamp.runtime.test.ts
npx tsc --noEmit -p server/tsconfig.json
```

Expected: 4 tests PASS, tsc silent.

- [ ] **Step 6: Commit**

```bash
git add migrations/0203_corrective_action_approval_requested_stamp.sql shared/src/schema/tenant/field-scorecards.ts server/tests/modules/migration/corrective-action-approval-requested-stamp.runtime.test.ts
git commit -m "feat(scorecards): migration 0203 — the approval-requested phase stamp"
```

---

## Task 3: Teach the oversight job the `awaiting_approval` phase

`enqueueCorrectiveActionApprovalRequested` already inserts a job with `phase: "awaiting_approval"`. The worker's payload guard accepts only `opened | closed`, so **the job completes having sent nothing.** This task is the highest-value change in the plan: everything downstream already works.

**Files:**
- Modify: `worker/src/jobs/scorecard-corrective-action-oversight-email.ts`
- Test: `worker/tests/jobs/scorecard-corrective-action-oversight-email.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe` in `worker/tests/jobs/scorecard-corrective-action-oversight-email.test.ts`:

```ts
  it("REGRESSION: an awaiting_approval job actually sends — it used to be dropped by the payload guard", async () => {
    // enqueueCorrectiveActionApprovalRequested has always enqueued this phase; the worker's union rejected it,
    // so the job completed successfully having notified nobody. A silently-dropped notification is worse than
    // a dead-letter, because nothing surfaces it.
    const { query } = makeQuery({ status: "corrective_action_submitted" });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "awaiting_approval" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env: { ...env, QC_APPROVER_EMAILS: "james@trockgc.com" } as never,
      logger: makeLogger(),
    });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [to, subject] = sendEmail.mock.calls[0] as unknown as [string[], string];
    expect(to).toEqual(["james@trockgc.com"]);
    expect(subject).toMatch(/awaiting your approval/i);
  });

  it("addresses the APPROVER list, not the oversight watcher list", async () => {
    // Different question, different config: FIELD_SCORECARD_EMAIL_RECIPIENTS is who watches,
    // QC_APPROVER_EMAILS is who can act. Notifying watchers to approve would ask people who will 403.
    const { query } = makeQuery({ status: "corrective_action_submitted" });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "awaiting_approval" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env: { ...env, QC_APPROVER_EMAILS: "james@trockgc.com" } as never,
      logger: makeLogger(),
    });

    const [to] = sendEmail.mock.calls[0] as unknown as [string[]];
    expect(to).not.toContain("ops@trockgc.com");
  });

  it("does NOT subtract responders from the approver list", async () => {
    // The subtraction exists so a super does not get "someone must fix this" on top of "please fix this".
    // An approver who happens to also be a super on some card still has to be asked to approve THIS one.
    const { query } = makeQuery({ status: "corrective_action_submitted" }, [
      { email: "james@trockgc.com", name: "James Helms", role: "superintendent" } as never,
    ]);
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "awaiting_approval" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env: { ...env, QC_APPROVER_EMAILS: "james@trockgc.com" } as never,
      logger: makeLogger(),
    });

    const [to] = sendEmail.mock.calls[0] as unknown as [string[]];
    expect(to).toEqual(["james@trockgc.com"]);
  });

  it("stamps its OWN column, so it cannot suppress the opened or completed notice", async () => {
    const { query, stampUpdates } = makeQuery({ status: "corrective_action_submitted" });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "awaiting_approval" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env: { ...env, QC_APPROVER_EMAILS: "james@trockgc.com" } as never,
      logger: makeLogger(),
    });

    expect(stampUpdates).toHaveLength(1);
    expect(stampUpdates[0].sql).toContain("corrective_action_approval_requested_at");
    expect(stampUpdates[0].sql).not.toContain("oversight_opened_at");
    expect(stampUpdates[0].sql).not.toContain("oversight_closed_at");
  });

  it("logs and returns when QC_APPROVER_EMAILS is unset — nobody can approve, so nobody is asked to", async () => {
    // Matches the API, which 403s everyone when the list is empty. Not an error: a dead-letter here would be
    // pure noise on a misconfiguration the API already reports.
    const { query, stampUpdates } = makeQuery({ status: "corrective_action_submitted" });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "awaiting_approval" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env: { ...env, QC_APPROVER_EMAILS: "" } as never,
      logger: makeLogger(),
    });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(stampUpdates).toHaveLength(0);
  });
```

The shared mock needs the new column and the new expected status. In `makeQuery`'s scorecard-snapshot branch add `corrective_action_approval_requested_at: over.approvalRequestedAt ?? null,` and add `approvalRequestedAt?: Date | null;` to `ScorecardOverrides`.

- [ ] **Step 2: Run and verify they FAIL**

```bash
TZ=UTC npx vitest run worker/tests/jobs/scorecard-corrective-action-oversight-email.test.ts -t "awaiting_approval"
```

Expected: FAIL — `sendEmail` never called, because the payload guard returns early.

- [ ] **Step 3: Extend the phase union and the guard**

In `worker/src/jobs/scorecard-corrective-action-oversight-email.ts`:

```ts
export type CorrectiveActionOversightPhase = "opened" | "closed" | "awaiting_approval";
```

```ts
const VALID_PHASES: readonly CorrectiveActionOversightPhase[] = ["opened", "closed", "awaiting_approval"];
```

Replace the payload guard:

```ts
  if (!isSafeTenantSchema(tenantSchema) || !scorecardId || !phase || !VALID_PHASES.includes(phase)) {
```

- [ ] **Step 4: Route the stamp column and the expected status**

```ts
/** The phase's own stamp column. A literal switch — the phase never reaches SQL as interpolated text. */
function stampColumn(phase: CorrectiveActionOversightPhase): string {
  if (phase === "opened") return "corrective_action_oversight_opened_at";
  if (phase === "awaiting_approval") return "corrective_action_approval_requested_at";
  return "corrective_action_oversight_closed_at";
}
```

Replace the `expectedStatus` derivation (both the snapshot guard and the delivery revalidation use it):

```ts
  const expectedStatus =
    phase === "opened"
      ? "corrective_action_open"
      : phase === "awaiting_approval"
        ? "corrective_action_submitted"
        : "corrective_action_closed";
```

Add the new column to the snapshot `SELECT` alongside the other two stamps, and to `ScorecardRow`:

```ts
  corrective_action_approval_requested_at: Date | null;
```

Extend the already-sent check:

```ts
  const alreadySent =
    phase === "opened"
      ? scorecard.corrective_action_oversight_opened_at
      : phase === "awaiting_approval"
        ? scorecard.corrective_action_approval_requested_at
        : scorecard.corrective_action_oversight_closed_at;
```

- [ ] **Step 5: Route recipients to the approver list**

Add the import:

```ts
import { resolveCorrectiveActionApprovers } from "@trock-crm/shared/lib/correctiveActionApprovers";
```

Register the alias in **all four** vitest configs or the import will not resolve in tests — `worker/vitest.config.ts`, `server/vitest.config.ts`, `vitest.config.ts`, and the package export in `shared/package.json` (check whether the approval branch already added them; it added `correctiveActionApprovers` for the server, so the worker alias may still be missing).

Replace the recipient block:

```ts
  // WHO to tell depends on the question being asked. opened/closed inform the watchers
  // (FIELD_SCORECARD_EMAIL_RECIPIENTS); awaiting_approval asks the people who can actually act
  // (QC_APPROVER_EMAILS) — the same config the API authorizes the verb against, so the set notified and the
  // set able to act are one definition and cannot drift.
  const configured =
    phase === "awaiting_approval"
      ? resolveCorrectiveActionApprovers(env)
      : resolveFieldScorecardRecipients(env);
```

and scope the responder subtraction to `opened` only — it is already `phase === "opened" ? ... : configured`, so verify rather than change it.

- [ ] **Step 6: Add the email body**

In `buildOversightEmail`, `phase` already discriminates. Add the third branch to `subject`, `intro` and `textIntro`:

```ts
  const subject =
    phase === "opened"
      ? `Corrective Action Opened — ${input.dealName}`
      : phase === "awaiting_approval"
        ? `Corrective action awaiting your approval — ${input.dealName}`
        : `Corrective Action Approved — ${input.dealName}`;
```

```ts
  const awaitingIntro = `The corrective action for <strong>${escapeHtml(input.dealName)}</strong>${input.projectNumber ? ` (${escapeHtml(input.projectNumber)})` : ""}${input.weekOf ? `, week of ${escapeHtml(input.weekOf)}` : ""} has been documented and is waiting for your review. Approve each item, or send it back with a comment saying what still has to be fixed.`;
```

Wire `awaitingIntro` into the `intro` ternary and write the matching plain-text line into `textIntro`. The item list, CTA and attachment blocks need no change — they already render every phase.

- [ ] **Step 7: Run and verify PASS**

```bash
TZ=UTC npx vitest run worker/tests/jobs/scorecard-corrective-action-oversight-email.test.ts
```

Expected: all PASS (52 existing + 5 new).

- [ ] **Step 8: Mutation-check the phase routing**

Do not skip this. Three tests in this repo have passed against unfixed code this week.

```bash
cp worker/src/jobs/scorecard-corrective-action-oversight-email.ts /tmp/ph.bak
# force the approver branch to fall back to the watcher list
sed -i '' 's/? resolveCorrectiveActionApprovers(env)/? resolveFieldScorecardRecipients(env)/' worker/src/jobs/scorecard-corrective-action-oversight-email.ts
TZ=UTC npx vitest run worker/tests/jobs/scorecard-corrective-action-oversight-email.test.ts 2>&1 | grep -E "×|Tests "
cp /tmp/ph.bak worker/src/jobs/scorecard-corrective-action-oversight-email.ts
```

Expected: at least the "addresses the APPROVER list" test FAILS. If nothing fails, your test is not pinning the routing — fix the test before continuing.

- [ ] **Step 9: Commit**

```bash
git add worker/src/jobs/scorecard-corrective-action-oversight-email.ts worker/tests/jobs/scorecard-corrective-action-oversight-email.test.ts worker/vitest.config.ts
git commit -m "feat(scorecards): send the awaiting-approval notice to the approver list"
```

---

## Task 4: Relabel the completion notice as approved

`corrective_action_closed` now means approved. The email still says "is complete. Every flagged item has been documented" — documented is not accepted, so under the gate that sentence is false.

**Files:**
- Modify: `worker/src/jobs/scorecard-corrective-action-oversight-email.ts`
- Test: `worker/tests/jobs/scorecard-corrective-action-oversight-email.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it("says APPROVED, not merely documented, on the completion notice", async () => {
    // Under the approval gate, "documented" and "accepted" are different claims and the card only reaches
    // this state on the second one. Saying "complete. Every flagged item has been documented" describes the
    // pre-gate behaviour and would tell oversight the wrong thing about what happened.
    const { query } = makeQuery({ status: "corrective_action_closed" });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "closed" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      getPdf: (async () => Buffer.from("%PDF-1.4")) as never,
      env,
      logger: makeLogger(),
    });

    const [, subject, html] = sendEmail.mock.calls[0] as unknown as [string[], string, string];
    expect(subject).toMatch(/approved/i);
    expect(html).toMatch(/approved/i);
    expect(html).not.toMatch(/has been documented\./i);
  });
```

- [ ] **Step 2: Run and verify it FAILS**

```bash
TZ=UTC npx vitest run worker/tests/jobs/scorecard-corrective-action-oversight-email.test.ts -t "says APPROVED"
```

Expected: FAIL on the subject assertion (`Corrective Action Completed`).

- [ ] **Step 3: Change the copy**

The subject was already handled in Task 3 Step 6. Change the closed `intro` and `textIntro`:

```ts
    : `The corrective action for <strong>${escapeHtml(input.dealName)}</strong>${input.projectNumber ? ` (${escapeHtml(input.projectNumber)})` : ""}${input.weekOf ? `, week of ${escapeHtml(input.weekOf)}` : ""} has been <strong>approved</strong>. Every flagged item was documented and accepted. The updated scorecard is attached where available.`;
```

- [ ] **Step 4: Run and verify PASS**

```bash
TZ=UTC npx vitest run worker/tests/jobs/scorecard-corrective-action-oversight-email.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add worker/src/jobs/scorecard-corrective-action-oversight-email.ts worker/tests/jobs/scorecard-corrective-action-oversight-email.test.ts
git commit -m "fix(scorecards): the completion notice says approved, not documented"
```

---

## Task 5: A rejection restarts the responder cycle

`rejectCorrectiveActionItem` already returns `reopened: true` when the card goes back to `corrective_action_open`, with a comment saying the caller must restart the cycle. Nothing does. Without the restart the responder's tokens stay revoked and any link they receive 403s.

**Files:**
- Modify: `server/src/modules/deals/routes.ts:2601`
- Test: `server/tests/modules/field/corrective-action-rejection-cycle.runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/tests/modules/field/corrective-action-rejection-cycle.runtime.test.ts`. Model it on the existing `field-responder-restart-cycle.runtime.test.ts` for the PGlite + tenant-schema setup, then:

```ts
  it("REGRESSION: a rejection mints a fresh cycle and live tokens, so the emailed link works", async () => {
    // The responders' tokens were revoked when they submitted. A rejection notice carrying a stale link sends
    // someone an email they cannot act on — the fix arrives, they click, they get a 403, and the card sits.
    const { scorecardId } = await seedSubmittedCard();
    const before = await cardState(scorecardId);
    await tdb.insert(scorecardCorrectiveActionTokens).values({
      scorecardId,
      recipientEmail: "pat@trockgc.com",
      tokenHash: "stale-hash",
      role: "project_manager",
    });

    await rejectAndRestart(tdb, {
      office: OFFICE,
      scorecardId,
      itemId: (await itemIds(scorecardId))[0],
      comment: "Torque values were not documented.",
      actor: { userId: USER, name: "James Helms", email: "james@trockgc.com" },
    });

    const after = await cardState(scorecardId);
    // A NEW cycle: a stale in-flight job cannot stamp this one.
    expect(after.nonce).not.toBe(before.nonce);
    // The send stamp is cleared, or the worker would skip the re-notify.
    expect(after.sentAt).toBeNull();
    // Stale tokens are gone, so nobody holds a link bound to the previous cycle.
    const tokens = await tdb.execute(sql`
      SELECT token_hash FROM scorecard_corrective_action_tokens WHERE scorecard_id = ${scorecardId}::uuid
    `);
    expect(tokens.rows).toHaveLength(0);
    // And a responder job is queued to mint fresh ones.
    const jobs = await tdb.execute(sql`
      SELECT payload FROM public.job_queue WHERE job_type = 'scorecard_corrective_action_email'
    `);
    expect(jobs.rows).toHaveLength(1);
  });
```

- [ ] **Step 2: Run and verify it FAILS**

```bash
TZ=UTC npx vitest run server/tests/modules/field/corrective-action-rejection-cycle.runtime.test.ts
```

Expected: FAIL — `rejectAndRestart` is not defined.

- [ ] **Step 3: Add the composed operation**

In `server/src/modules/field/corrective-action-approval.ts`:

```ts
/**
 * Reject an item AND restart the responders' notification cycle, in one transaction.
 *
 * These belong together and must not be two calls a route can get half-right. Rejecting revokes nothing by
 * itself, but the responders' tokens were already deleted when they submitted — so a rejection without a
 * restart leaves them holding no valid link and the card stalls silently with work nobody can do.
 *
 * The restart machinery is reused rather than reimplemented: it mints a fresh cycle nonce, clears the send
 * stamp, deletes stale tokens and enqueues the responder job, and it carries the supersession and delivery
 * guarantees thirteen review rounds put into it. A second token path would have to re-earn all of that.
 */
export async function rejectAndRestart(
  tx: TenantDb,
  input: {
    office: { id: string; slug: string };
    scorecardId: string;
    itemId: string;
    comment: string;
    actor: ApprovalActor;
  },
): Promise<ApprovalOutcome> {
  const outcome = await rejectCorrectiveActionItem(tx, {
    scorecardId: input.scorecardId,
    itemId: input.itemId,
    comment: input.comment,
    actor: input.actor,
  });
  // Only on a real transition. A no-op rejection (already rejected, or resubmitted since the approver loaded
  // the page) must not churn the cycle — that would revoke a link the responder is actively using.
  if (outcome.reopened) {
    await restartCorrectiveActionCyclesForCards(
      tx,
      [{ id: input.scorecardId, dealId: await readDealId(tx, input.scorecardId) }],
      input.office,
    );
  }
  return outcome;
}
```

`restartCorrectiveActionCyclesForCards` is currently module-private in `corrective-actions-service.ts` — export it, and add a `readDealId` helper there or inline the one-row select.

- [ ] **Step 4: Call it from the route**

In `server/src/modules/deals/routes.ts`, the reject handler at `:2601` — replace the `rejectCorrectiveActionItem` call with `rejectAndRestart`, passing `office: { id: req.user!.activeOfficeId, slug: req.officeSlug! }`.

- [ ] **Step 5: Run and verify PASS**

```bash
TZ=UTC npx vitest run server/tests/modules/field/corrective-action-rejection-cycle.runtime.test.ts
```

- [ ] **Step 6: Verify the no-op case does NOT churn the cycle**

Add and run:

```ts
  it("does NOT restart the cycle for a no-op rejection", async () => {
    // Rejecting an already-rejected item is idempotent by design. Restarting anyway would revoke a link the
    // responder may be in the middle of using, and re-send them an email about a state that did not change.
    const { scorecardId } = await seedSubmittedCard();
    const [itemId] = await itemIds(scorecardId);
    const args = { office: OFFICE, scorecardId, itemId, comment: "Not enough detail.", actor: APPROVER };
    await rejectAndRestart(tdb, args);
    const afterFirst = await cardState(scorecardId);

    await rejectAndRestart(tdb, args);

    expect((await cardState(scorecardId)).nonce).toBe(afterFirst.nonce);
  });
```

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/field/corrective-action-approval.ts server/src/modules/field/corrective-actions-service.ts server/src/modules/deals/routes.ts server/tests/modules/field/corrective-action-rejection-cycle.runtime.test.ts
git commit -m "feat(scorecards): a rejection restarts the responder cycle so their link works"
```

---

## Task 6: The responder email tells them what to fix

The restart re-sends the existing "corrective action required" email. It must now say the work came back, and why.

**Files:**
- Modify: `worker/src/jobs/scorecard-corrective-action-email.ts`
- Test: `worker/tests/jobs/scorecard-corrective-action-email.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
  it("REGRESSION: says the work was RETURNED, and why, when an item is rejected", async () => {
    // Derived from STATE, not from the payload. This job runs ~120s after enqueue and the payload cannot be
    // re-checked, while state can — the same reasoning that put the browsable gate at delivery time.
    const { query } = makeQuery({
      items: [
        { ...ITEM, status: "rejected", item_label: "Re-torque the anchors" },
      ],
      latestRejection: "Torque values were not documented.",
    });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionEmail(payload(), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env,
      logger: makeLogger(),
    });

    const [, subject, html] = sendEmail.mock.calls[0] as unknown as [string[], string, string];
    expect(subject).toMatch(/returned|changes requested/i);
    expect(html).toContain("Torque values were not documented.");
  });

  it("still reads as a FIRST request when nothing was rejected", async () => {
    const { query } = makeQuery({ items: [{ ...ITEM, status: "open" }] });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionEmail(payload(), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env,
      logger: makeLogger(),
    });

    const [, subject] = sendEmail.mock.calls[0] as unknown as [string[], string];
    expect(subject).not.toMatch(/returned|changes requested/i);
  });
```

- [ ] **Step 2: Run and verify they FAIL**

```bash
TZ=UTC npx vitest run worker/tests/jobs/scorecard-corrective-action-email.test.ts -t "RETURNED"
```

- [ ] **Step 3: Select the latest rejection reason per item**

In the job's item query, add a lateral join for the most recent `rejected` event:

```sql
            (SELECT e.comment
               FROM ${tenantSchema}.scorecard_corrective_action_events e
              WHERE e.corrective_action_id = ca.id
                AND e.event_type = 'rejected'
              ORDER BY e.seq DESC
              LIMIT 1) AS latest_rejection
```

Ordered by `seq`, not `created_at`: events written in one transaction share a timestamp and the uuid PK is random, so a timestamp sort picks an arbitrary one.

- [ ] **Step 4: Derive the return and render the reason**

```ts
  // DERIVED, never carried in the payload. If any item is rejected at SEND time, this is a return — which
  // stays true even if the card changed between enqueue and delivery.
  const isReturn = items.some((item) => item.status === "rejected");
  const subject = isReturn
    ? `Changes requested — corrective action returned for ${dealName}`
    : `Corrective action required — ${dealName}`;
```

For each rejected item, render its `latest_rejection` above the response prompt, bounded by the same
`emailCommentExcerpt`-style guard the oversight email uses (labels and comments here are equally unbounded).

- [ ] **Step 5: Run and verify PASS**

```bash
TZ=UTC npx vitest run worker/tests/jobs/scorecard-corrective-action-email.test.ts
```

- [ ] **Step 6: Mutation-check the derivation**

```bash
cp worker/src/jobs/scorecard-corrective-action-email.ts /tmp/re.bak
sed -i '' 's/const isReturn = items.some((item) => item.status === "rejected");/const isReturn = false;/' worker/src/jobs/scorecard-corrective-action-email.ts
TZ=UTC npx vitest run worker/tests/jobs/scorecard-corrective-action-email.test.ts 2>&1 | grep -E "×|Tests "
cp /tmp/re.bak worker/src/jobs/scorecard-corrective-action-email.ts
```

Expected: the "says the work was RETURNED" test FAILS.

- [ ] **Step 7: Commit**

```bash
git add worker/src/jobs/scorecard-corrective-action-email.ts worker/tests/jobs/scorecard-corrective-action-email.test.ts
git commit -m "feat(scorecards): the responder email says what came back and why"
```

---

## Task 7: Enqueue the approval request on the winning transition

Confirm `enqueueCorrectiveActionApprovalRequested` is called exactly where the card reaches `corrective_action_submitted`, and only on the winning write.

**Files:**
- Modify: `server/src/modules/field/corrective-actions-service.ts`
- Test: `server/tests/modules/field/scorecard-corrective-actions.runtime.test.ts`

- [ ] **Step 1: Find the call site**

```bash
grep -rn "enqueueCorrectiveActionApprovalRequested" server/src/
```

If it has no caller, wire it into `resolveCorrectiveActionItemTx` where the card transitions to
`CORRECTIVE_ACTION_CARD_AWAITING_APPROVAL`, inside the same transaction, guarded on the transition having
actually happened (the same shape as the existing `enqueueCorrectiveActionOversightClosed` call).

- [ ] **Step 2: Write the test**

```ts
  it("enqueues the approval request exactly once, on the transition into awaiting approval", async () => {
    // Inside the same transaction as the state change, so the job cannot exist for a transition that rolled
    // back; and only on the WINNING write, so two concurrent responders do not both notify the approver.
    const { scorecardId, itemIds } = await seedOpenCard(2);
    await resolveCorrectiveActionItem(tdb, { scorecardId, itemId: itemIds[0], responseComment: "Fixed.", respondedBy: RESPONDER });
    expect(await approvalJobs(scorecardId)).toHaveLength(0); // one item still open

    await resolveCorrectiveActionItem(tdb, { scorecardId, itemId: itemIds[1], responseComment: "Fixed.", respondedBy: RESPONDER });
    expect(await approvalJobs(scorecardId)).toHaveLength(1);
  });
```

with

```ts
async function approvalJobs(scorecardId: string) {
  const res = await tdb.execute(sql`
    SELECT payload FROM public.job_queue
     WHERE job_type = 'scorecard_corrective_action_oversight_email'
  `);
  return (res.rows as Array<{ payload: { scorecardId: string; phase: string } }>).filter(
    (r) => r.payload.scorecardId === scorecardId && r.payload.phase === "awaiting_approval",
  );
}
```

- [ ] **Step 3: Run, implement if needed, run again**

```bash
TZ=UTC npx vitest run server/tests/modules/field/scorecard-corrective-actions.runtime.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/field/corrective-actions-service.ts server/tests/modules/field/scorecard-corrective-actions.runtime.test.ts
git commit -m "feat(scorecards): enqueue the approval request on the winning transition"
```

---

## Task 8: Tell the client whether to show the controls

**Files:**
- Modify: `server/src/modules/field/scorecards-service.ts`, `shared/src/types/field-scorecard.ts`
- Test: `server/tests/modules/deals/deal-scorecards.runtime.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it("reports approval capability WITHOUT leaking the allowlist", async () => {
    // The allowlist is authorization config. Shipping it would tell every CRM user who can sign off, and the
    // client must never re-derive the gate anyway — it is UX, the 403 is the guarantee.
    const detail = await getDealScorecardDetail(tdb, DEAL, SCORECARD, {
      user: { id: USER, email: "james@trockgc.com" },
      env: { QC_APPROVER_EMAILS: "james@trockgc.com" } as never,
    });
    expect(detail.canApproveCorrectiveActions).toBe(true);
    expect(JSON.stringify(detail)).not.toContain("QC_APPROVER_EMAILS");

    const other = await getDealScorecardDetail(tdb, DEAL, SCORECARD, {
      user: { id: USER, email: "someone@trockgc.com" },
      env: { QC_APPROVER_EMAILS: "james@trockgc.com" } as never,
    });
    expect(other.canApproveCorrectiveActions).toBe(false);
  });
```

- [ ] **Step 2: Run, verify FAIL, implement**

Add `canApproveCorrectiveActions: boolean` to `FieldScorecardDetail` in `shared/src/types/field-scorecard.ts` and set it in the detail read using the existing `canApproveCorrectiveActions(req, env)` helper.

- [ ] **Step 3: Commit**

```bash
git add shared/src/types/field-scorecard.ts server/src/modules/field/scorecards-service.ts server/tests/modules/deals/deal-scorecards.runtime.test.ts
git commit -m "feat(scorecards): expose approval capability on the scorecard detail"
```

---

## Task 9: The approve / reject controls

**Files:**
- Modify: `client/src/hooks/use-corrective-actions.ts`, `client/src/pages/deals/deal-scorecards-tab.tsx`
- Test: `client/src/pages/deals/deal-scorecards-tab.test.tsx`

- [ ] **Step 1: Add the mutations**

```ts
export async function approveCorrectiveActions(dealId: string, scorecardId: string, itemIds?: string[]) {
  return api(`/deals/${dealId}/scorecards/${scorecardId}/corrective-actions/approve`, {
    method: "POST",
    body: itemIds ? { itemIds } : {},
  });
}

export async function rejectCorrectiveAction(
  dealId: string,
  scorecardId: string,
  itemId: string,
  comment: string,
) {
  return api(`/deals/${dealId}/scorecards/${scorecardId}/corrective-actions/${itemId}/reject`, {
    method: "POST",
    body: { comment },
  });
}
```

Omitting `itemIds` is approve-all — the server treats an absent list as "everything awaiting approval".

- [ ] **Step 2: Write the failing tests**

```ts
  it("shows Approve/Reject only for an approver, and only on items awaiting approval", () => {
    // The control is UX; the 403 is the guarantee. But showing a button that always 403s trains people to
    // ignore errors, and showing it on an already-approved item invites a no-op that reads as a bug.
    const awaiting = { ...ITEM, status: "submitted" };
    expect(shouldShowApprovalControls({ item: awaiting, canApprove: true })).toBe(true);
    expect(shouldShowApprovalControls({ item: awaiting, canApprove: false })).toBe(false);
    expect(shouldShowApprovalControls({ item: { ...ITEM, status: "approved" }, canApprove: true })).toBe(false);
    expect(shouldShowApprovalControls({ item: { ...ITEM, status: "open" }, canApprove: true })).toBe(false);
  });

  it("refuses an empty rejection comment before it reaches the server", () => {
    // Telling the responder what to fix IS the rejection; a blank one wastes a round trip on both sides.
    expect(isRejectionCommentValid("   ")).toBe(false);
    expect(isRejectionCommentValid("Re-torque and log the values.")).toBe(true);
  });
```

- [ ] **Step 3: Implement and run**

Export the two pure helpers from `deal-scorecards-tab.tsx` and render the controls in `CorrectiveActionResponse` (per item, when shown) plus an "Approve all" above the list when more than one item is `submitted`. Reject opens an inline textarea with a required comment.

```bash
TZ=UTC npx vitest run client/src/pages/deals/deal-scorecards-tab.test.tsx
```

- [ ] **Step 4: Commit**

```bash
git add client/src/hooks/use-corrective-actions.ts client/src/pages/deals/deal-scorecards-tab.tsx client/src/pages/deals/deal-scorecards-tab.test.tsx
git commit -m "feat(scorecards): approve / reject controls on the deal Scorecards tab"
```

---

## Task 10: Full verification

- [ ] **Step 1: Gate**

```bash
npm run build --workspace=@trock-crm/shared
TZ=UTC npm run check:premerge
```

Expected: green across shared / server / client / client-field / scripts.

- [ ] **Step 2: The worker, which the gate does NOT cover**

```bash
TZ=UTC npx vitest run worker/
```

The `worker` package has no `test:ci`, so neither CI nor `check:premerge` runs any of it — and this plan changes three worker jobs. Expected: one pre-existing failure, `rep-performance-rollup-period-scope`, already red on `main`. Anything else is yours.

- [ ] **Step 3: Walk the loop by hand**

With `QC_APPROVER_EMAILS` and `FIELD_SCORECARD_EMAIL_RECIPIENTS` set locally:

1. Submit a below-band scorecard → responder email arrives, oversight "Opened" arrives.
2. Answer every item via the token link → card reads **Awaiting Approval**; approver email arrives.
3. Reject one item with a comment → card returns to **Corrective Action Open**; the responder email arrives titled as a return and quotes the comment; the link in it **works**.
4. Re-answer → approver email again.
5. Approve all → card reads **Corrective Action Approved**; oversight "Approved" arrives with the PDF attached.
6. Download the PDF → the full thread is there, in order, including the rejection and its reason.

Step 6 is the acceptance test for the original bug report. If the PDF is missing the last event, Task 1 regressed.

- [ ] **Step 4: Open the PR**

```bash
gh pr create --title "feat(scorecards): corrective-action approval — James approves or rejects, with the email loop" --body "..."
```

Then trigger `@codex review` and `@coderabbitai review`, and drive to green the same way #973 was driven.

---

## Self-review notes

**Spec coverage.** §2 messages 1–5 → Tasks 3, 4, 5, 6. §3.1 → Task 3. §3.2 → Tasks 5, 6. §3.3 → Task 4. §4 generation bug → Task 1. §5 UI → Tasks 8, 9. §7 testing → distributed, plus Task 10.

**Known gap, deliberately not planned:** the spec's "no escalation or SLA" stays out of scope, so a card can sit in `corrective_action_submitted` indefinitely if James is away. That consequence is still unacknowledged in writing by the owner and should be confirmed before this ships, not after.

**Order matters.** Task 1 first — it is a correctness fix to code the later tasks build on. Task 2 before Task 3 (the stamp column must exist). Task 5 before Task 6 (the restart must happen before the email that depends on it means anything). Tasks 8 and 9 can be done in either order but 8 first avoids a client reading a field the server does not send.
