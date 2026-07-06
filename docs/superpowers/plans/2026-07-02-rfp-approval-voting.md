# RFP Approval Voting (non-service) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-approver RFP flow for **non-service** deals with a CRM-owned three-person (Sidney / Tim / James) 2-of-3 vote — recording every vote on the deal, showing it live on the deal card, creating the Bid Board project on a 2/3 approve, and escalating to Takashi/Adam on a 2/3 reject. Service / type-4 (Colby + James, first-approve) is untouched.

**Architecture:** The CRM owns votes + tally. `trigger-rfp` branches: service/type-4 → existing SyncHub email path (unchanged); non-service (behind the `ENABLE_RFP_VOTING` flag) → `openRfpVoteRound` (reserve + three invitation emails). Votes land in a new per-office `rfp_votes` table; `castRfpVote` runs an atomic (`FOR UPDATE` + before/after transition) tally so exactly one outcome fires. A single pure helper `computeRfpVoteState` is the ONLY tally/threshold source — consumed by the decision, the deal-card panel, and the escalation summary (reconciliation invariant). 2/3 approve → a worker HMAC-POSTs SyncHub's new `POST /api/bid-board/create-from-rfp` (reusing `createBidBoardProjectFromDeal` + the existing `bid-board-created` callback, resolved by `sourceDealId`). 2/3 reject → `applyRfpDeclineToDeal` sets `declined` and the app-driven `rfp_vote_outcome` job emails rep + Takashi/Adam the `/rfp-review` link.

**Tech Stack:** TypeScript, Express, Drizzle ORM (schema-per-office Postgres), PGlite for runtime tests, Vitest, React + React Router (client), a shared `job_queue` worker, HMAC-signed CRM↔SyncHub HTTP, Resend (branded emails).

---

## Cross-cutting notes (read before starting)

- **Task numbering.** Section A = foundation tasks **A1–A6** (schema, migration, config helpers, `computeRfpVoteState`, `isRfpVoter`, `requireRfpVoter`). Sections B and C continue as **Tasks 7–20**. Execute A1–A6 first (Sections B/C import their symbols).
- **Worktree.** All `trockcrm` commands run in the worktree `/Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting` (branch `feat/rfp-approval-voting`). SyncHub changes (Task 12) run in `/Users/adnaaniqbal/Developer/trocksynchubv3`.
- **Test naming = CI gating.** Server/worker/client gating suites are named `*.runtime.test.ts(x)` so `test:runtime` / `test:ci` execute them. Pure shared-lib unit suites are `*.test.ts` under `shared/src/**` (run with `--config vitest.ci.config.ts`). Exact commands are in each task.
- **Migration number.** The votes migration is `0173_rfp_votes.sql` (latest `origin/main` has `0172_field_scorecards.sql`). Numbers are not enforced-unique — re-confirm `0173` is free at authoring time.
- **Reconciliation invariant.** `computeRfpVoteState` (Task A4) is the single source of tally/threshold/outcome. No task re-implements approve/reject counting; card == decision == escalation by construction.
- **Deliberate deviations from the spec (discovered during planning, documented here):**
  1. **No-go escalation is app-driven, not the DB trigger (deviates from spec §5.5).** Migration 0148's `enqueue_rfp_rejected_email` trigger early-returns when `rfp_approval_request_id IS NULL`, and voting deals have none. Rather than relax that shared trigger (it also serves SyncHub declines + keys receipt dedup on the request id), `castRfpVote` enqueues an `rfp_vote_outcome` job in both decided branches; Task 19's handler sends the rep GO email (approve) or the rep + Takashi/Adam `/rfp-review` escalation (reject). The trigger stays inert for voting deals, so there is no double-send.
  2. **The voting GO callback uses direct delivery, not the durable outbox (v1).** SyncHub's `bidboard_callback_outbox.rfp_approval_request_id` is `NOT NULL`/FK, and voting creates no request row, so `create-from-rfp` posts the `bid-board-created` callback directly (small retry loop) keyed by `sourceDealId`. The CRM callback handler is relaxed (Task 13) to resolve voting-path deals by `sourceDealId` when no request id is present.

---
## Section A: Foundation — schema, migration, config, pure helpers, auth flag, middleware

This section builds the load-bearing primitives every later section imports: the `rfp_votes` tenant
table + its migration, the `RFP_VOTER_EMAILS` config helper, the single `computeRfpVoteState`
reconciliation helper, the `isRfpVoter` auth flag, and the `requireRfpVoter` middleware. Nothing here
touches the trigger/vote/route flow yet — it is inert until Sections B/C wire it up.

**Cross-workspace resolution facts that drive several steps (verified, not assumed):**
- `server/vitest.config.ts` aliases each shared lib **explicitly** (one `path.resolve` line per file,
  lines 10–12). A new `@trock-crm/shared/lib/*` import is unresolvable in server tests until its alias
  line is added. (Confirmed: only `bidBoardStatusMap`, `rfpReviewerEmails`, `userProvisioningGuards`
  are aliased today.)
- `shared/package.json` `exports` has **no wildcard** — every `./lib/*` is listed explicitly
  (`rfpReviewerEmails`, `fieldScorecardEmails`, `userProvisioningGuards`, …). A new lib is unresolvable
  from server/worker **production** code until its `exports` entry is added, and unusable by server
  `tsc` until `shared` is rebuilt to `dist` (the `exports` `"types"` condition points at `./dist/…`).
- Server test commands: `test:ci` = `vitest run --config vitest.ci.config.ts` (include globs
  `tests/**/*.test.ts` + `src/**/*.test.ts`); `test:runtime` = `vitest run runtime.test`. A file named
  `*.runtime.test.ts` therefore runs in **both** gates. Gating tests (migration/route/middleware) MUST
  be named `*.runtime.test.ts`.
- Shared test command: `shared` has only `vitest.ci.config.ts` (include `src/**/*.test.ts`) run via
  `test:ci`. Pure shared-lib unit suites are colocated `shared/src/**/*.test.ts` and run with
  `(cd shared && npx vitest run --config vitest.ci.config.ts <path>)`.
- `getUserOnboardingGateStatus` (`server/src/modules/auth/service.ts:68-85`) **short-circuits with no DB
  query when `role === "admin" || "director"`** — the Task A5 `/me` runtime test exploits this to assert
  the flag without a live Postgres.

All `git` commands run in the worktree `/Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting`.

---

### Task A1 — `rfp_votes` drizzle schema + register in the schema barrel

Declare the bare `pgTable("rfp_votes", …)` sibling table (mirroring
`shared/src/schema/tenant/deal-approvals.ts`) and re-export it from `shared/src/schema/index.ts` next to
`dealApprovals`. Cross-schema FKs (`deal_id → office_x.deals`, `voter_user_id → public.users`) live in
the SQL migration (Task A2), **not** in the Drizzle object — per the convention noted in the dossier
(`deal_change_orders`/`deals.ts` header comment) that Drizzle tenant tables omit cross-schema FK refs.

**Files:**
- Create: `shared/src/schema/tenant/rfp-votes.ts`
- Modify: `shared/src/schema/index.ts` (add re-export beside `dealApprovals` at dossier anchor
  `index.ts:75`)
- Test: `shared/src/schema/rfp-votes.test.ts` (colocated shared unit suite)

Steps:

- [ ] **Step 1: Write the failing schema-shape test.** Create `shared/src/schema/rfp-votes.test.ts`.
  It imports `rfpVotes` from the barrel (`./index.js`) to prove registration, and introspects the table
  via `getTableConfig` to prove columns + the unique index name.

  ```ts
  import { describe, it, expect } from "vitest";
  import { getTableConfig } from "drizzle-orm/pg-core";
  import { rfpVotes } from "./index.js";

  describe("rfp_votes schema", () => {
    it("is registered in the schema barrel", () => {
      expect(rfpVotes).toBeDefined();
    });

    it("declares the rfp_votes table with the contract columns", () => {
      const cfg = getTableConfig(rfpVotes);
      expect(cfg.name).toBe("rfp_votes");
      const cols = cfg.columns.map((c) => c.name).sort();
      expect(cols).toEqual(
        [
          "created_at",
          "deal_id",
          "decision",
          "id",
          "reason",
          "round_event_id",
          "voter_email",
          "voter_user_id",
        ].sort(),
      );
    });

    it("declares the composite unique index (deal_id, round_event_id, voter_user_id)", () => {
      const cfg = getTableConfig(rfpVotes);
      const idxNames = cfg.indexes.map((i) => i.config.name);
      expect(idxNames).toContain("rfp_votes_deal_round_voter_uq");
    });
  });
  ```

- [ ] **Step 2: Run the test — expect FAIL** (module `./index.js` has no export `rfpVotes` → the import
  resolves to `undefined`, and `getTableConfig(undefined)` throws).

  ```
  (cd shared && npx vitest run --config vitest.ci.config.ts src/schema/rfp-votes.test.ts)
  ```
  Expected: fails — `rfpVotes` is undefined / `getTableConfig` throws `Cannot read properties of undefined`.

- [ ] **Step 3: Create the schema file.** Write `shared/src/schema/tenant/rfp-votes.ts`. Imports mirror
  `deal-approvals.ts` (all primitives from `drizzle-orm/pg-core`; `uniqueIndex` for the composite
  constraint, matching the `deals.ts` partial-index style). `decision` is plain `text` per the no-enum
  RFP-state convention documented in migration 0151.

  ```ts
  import {
    pgTable,
    uuid,
    text,
    timestamp,
    uniqueIndex,
  } from "drizzle-orm/pg-core";

  /**
   * Per-office RFP approval votes (non-service deals). One row per voter per vote round. A "round" is
   * scoped by round_event_id (= deals.rfp_approval_request_event_id at trigger time) so a cancel/
   * re-trigger starts a fresh tally and old rows never leak into a new round. 2-of-3 majority decides
   * (see shared/src/lib/rfpVoteState.ts — the single reconciliation helper).
   *
   * Cross-schema FKs (deal_id -> office_x.deals(id) ON DELETE CASCADE, voter_user_id ->
   * public.users(id) ON DELETE SET NULL) are declared in migration 0173, NOT here, per the tenant-table
   * convention (Drizzle tenant objects omit cross-schema references). decision is plain text
   * ('approve' | 'reject') matching the no-enum RFP-state convention (migration 0151).
   */
  export const rfpVotes = pgTable(
    "rfp_votes",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      dealId: uuid("deal_id").notNull(),
      roundEventId: uuid("round_event_id").notNull(),
      voterUserId: uuid("voter_user_id"),
      voterEmail: text("voter_email").notNull(),
      decision: text("decision").notNull(),
      reason: text("reason"),
      createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
      // One vote per voter per round; enforces "locked on cast". Mirrors migration 0173's
      // CONSTRAINT rfp_votes_deal_round_voter_uq UNIQUE (deal_id, round_event_id, voter_user_id).
      uniqueIndex("rfp_votes_deal_round_voter_uq").on(
        table.dealId,
        table.roundEventId,
        table.voterUserId,
      ),
    ],
  );
  ```

- [ ] **Step 4: Register in the schema barrel.** In `shared/src/schema/index.ts`, add the re-export
  immediately after the `dealApprovals` line (dossier anchor `index.ts:75`, inside the deal-* sibling
  block at `index.ts:70-75`):

  ```ts
  export { dealApprovals, approvalStatusEnum } from "./tenant/deal-approvals.js";
  export { rfpVotes } from "./tenant/rfp-votes.js";
  ```

- [ ] **Step 5: Run the test — expect PASS.**

  ```
  (cd shared && npx vitest run --config vitest.ci.config.ts src/schema/rfp-votes.test.ts)
  ```
  Expected: 3 passing (`rfpVotes` defined; 8 columns match; `rfp_votes_deal_round_voter_uq` present).

- [ ] **Step 6: Commit.**

  ```
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting add shared/src/schema/tenant/rfp-votes.ts shared/src/schema/index.ts shared/src/schema/rfp-votes.test.ts
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting commit -m "feat(rfp-voting): add rfp_votes tenant schema + register in barrel

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task A2 — migration `0173_rfp_votes.sql` + PGlite runtime test

Create the per-office migration mirroring `migrations/0153_deal_change_orders.sql` **exactly** (the
`office_%` `DO`-loop over existing tenants + the `-- TENANT_SCHEMA_START/END` block the office
provisioner clones). `0173` is the confirmed next free number (last existing is `0172_field_scorecards.sql`;
no `0173` file exists). Prove it on PGlite by mirroring
`server/tests/modules/migration/deal-change-orders.runtime.test.ts` — the runtime test for 0153, i.e.
the exact sibling of the migration we clone.

**Files:**
- Create: `migrations/0173_rfp_votes.sql`
- Test: `server/tests/modules/migration/rfp-votes.runtime.test.ts`
  (mirrors `server/tests/modules/migration/deal-change-orders.runtime.test.ts:1-124`)

Steps:

- [ ] **Step 1: Write the failing runtime test.** Create
  `server/tests/modules/migration/rfp-votes.runtime.test.ts`. The PGlite bootstrap is copied verbatim
  from `deal-change-orders.runtime.test.ts` (`new PGlite()`; seed `public.users` + `office_dallas.deals`;
  `await db.exec(MIGRATION_SQL)`). Covers: table exists in `office_dallas`, UNIQUE rejects a duplicate,
  `deal_id` cascade, plus DO-loop provisioning of a second office and idempotency (mirroring the
  template's extra assertions).

  ```ts
  import { readFileSync } from "node:fs";
  import { afterEach, describe, expect, it } from "vitest";
  import { PGlite } from "@electric-sql/pglite";

  // Runs the REAL migration SQL against PGlite and asserts table behavior (existence, UNIQUE, FK
  // cascade, provisioning, idempotency). The static block targets office_dallas; the DO-loop targets
  // every office_* schema — both create the table here, exercising both paths idempotently. Mirrors
  // server/tests/modules/migration/deal-change-orders.runtime.test.ts (the 0153 runtime test).
  const MIGRATION_SQL = readFileSync(
    new URL("../../../../migrations/0173_rfp_votes.sql", import.meta.url),
    "utf8",
  );

  const SCHEMA = "office_dallas";
  const USER = "00000000-0000-0000-0000-000000000099";
  const DEAL = "00000000-0000-0000-0000-000000000001";
  const ROUND = "00000000-0000-0000-0000-0000000000aa";

  let pg: PGlite | null = null;

  afterEach(async () => {
    await pg?.close();
    pg = null;
  });

  async function setup(): Promise<PGlite> {
    const db = new PGlite();
    await db.exec(`
      CREATE TABLE public.users (id uuid PRIMARY KEY);
      CREATE SCHEMA ${SCHEMA};
      CREATE TABLE ${SCHEMA}.deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      INSERT INTO public.users (id) VALUES ('${USER}');
      INSERT INTO ${SCHEMA}.deals (id) VALUES ('${DEAL}');
    `);
    await db.exec(MIGRATION_SQL);
    return db;
  }

  describe("migration 0173 — rfp_votes (runtime, PGlite)", () => {
    it("creates rfp_votes in office_dallas and accepts an approve vote", async () => {
      pg = await setup();
      await pg.query(
        `INSERT INTO ${SCHEMA}.rfp_votes (deal_id, round_event_id, voter_user_id, voter_email, decision)
         VALUES ($1, $2, $3, 'sidney@trockgc.com', 'approve')`,
        [DEAL, ROUND, USER],
      );
      const rows = await pg.query<{ decision: string }>(
        `SELECT decision FROM ${SCHEMA}.rfp_votes WHERE deal_id = $1`,
        [DEAL],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.decision).toBe("approve");
    });

    it("rejects a duplicate vote by the same voter in the same round (UNIQUE)", async () => {
      pg = await setup();
      await pg.query(
        `INSERT INTO ${SCHEMA}.rfp_votes (deal_id, round_event_id, voter_user_id, voter_email, decision)
         VALUES ($1, $2, $3, 'sidney@trockgc.com', 'approve')`,
        [DEAL, ROUND, USER],
      );
      await expect(
        pg.query(
          `INSERT INTO ${SCHEMA}.rfp_votes (deal_id, round_event_id, voter_user_id, voter_email, decision)
           VALUES ($1, $2, $3, 'sidney@trockgc.com', 'reject')`,
          [DEAL, ROUND, USER],
        ),
      ).rejects.toThrow();
      const rows = await pg.query(`SELECT 1 FROM ${SCHEMA}.rfp_votes WHERE deal_id = $1`, [DEAL]);
      expect(rows.rows).toHaveLength(1);
    });

    it("cascade-deletes votes when the parent deal is deleted", async () => {
      pg = await setup();
      await pg.query(
        `INSERT INTO ${SCHEMA}.rfp_votes (deal_id, round_event_id, voter_user_id, voter_email, decision)
         VALUES ($1, $2, $3, 'sidney@trockgc.com', 'approve')`,
        [DEAL, ROUND, USER],
      );
      await pg.query(`DELETE FROM ${SCHEMA}.deals WHERE id = $1`, [DEAL]);
      const rows = await pg.query(`SELECT 1 FROM ${SCHEMA}.rfp_votes WHERE deal_id = $1`, [DEAL]);
      expect(rows.rows).toHaveLength(0);
    });

    it("nulls voter_user_id when the user row is deleted (ON DELETE SET NULL)", async () => {
      pg = await setup();
      await pg.query(
        `INSERT INTO ${SCHEMA}.rfp_votes (deal_id, round_event_id, voter_user_id, voter_email, decision)
         VALUES ($1, $2, $3, 'sidney@trockgc.com', 'approve')`,
        [DEAL, ROUND, USER],
      );
      await pg.query(`DELETE FROM public.users WHERE id = $1`, [USER]);
      const rows = await pg.query<{ voter_user_id: string | null }>(
        `SELECT voter_user_id FROM ${SCHEMA}.rfp_votes WHERE deal_id = $1`,
        [DEAL],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.voter_user_id).toBeNull();
    });

    it("provisions rfp_votes in a second office via the DO-loop", async () => {
      pg = await setup();
      await pg.exec(`
        CREATE SCHEMA office_atlanta;
        CREATE TABLE office_atlanta.deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      `);
      const deal2 = "00000000-0000-0000-0000-000000000002";
      await pg.query(`INSERT INTO office_atlanta.deals (id) VALUES ($1)`, [deal2]);
      await pg.exec(MIGRATION_SQL); // DO-loop now sees office_atlanta too
      await pg.query(
        `INSERT INTO office_atlanta.rfp_votes (deal_id, round_event_id, voter_email, decision)
         VALUES ($1, $2, 'james@trockgc.com', 'reject')`,
        [deal2, ROUND],
      );
      const rows = await pg.query(`SELECT 1 FROM office_atlanta.rfp_votes WHERE deal_id = $1`, [deal2]);
      expect(rows.rows).toHaveLength(1);
    });

    it("is idempotent — re-running the migration does not error", async () => {
      pg = await setup();
      await pg.exec(MIGRATION_SQL);
      const rows = await pg.query(`SELECT 1 FROM ${SCHEMA}.rfp_votes`);
      expect(rows.rows).toHaveLength(0);
    });
  });
  ```

- [ ] **Step 2: Run the test — expect FAIL** (migration file does not exist yet; `readFileSync` throws
  `ENOENT` at import time and the whole suite errors).

  ```
  (cd server && npx vitest run tests/modules/migration/rfp-votes.runtime.test.ts)
  ```
  Expected: fails — `ENOENT: no such file or directory ... migrations/0173_rfp_votes.sql`.

- [ ] **Step 3: Create the migration.** Write `migrations/0173_rfp_votes.sql`, cloning the 0153 shape:
  the `office_%` `DO`-loop with `format('%1$I', schema_name)` for existing tenants + the
  `-- TENANT_SCHEMA_START/END` `office_dallas`-qualified block for the provisioner. FKs per the
  contract: `deal_id → %I.deals(id) ON DELETE CASCADE`, `voter_user_id → public.users(id) ON DELETE SET
  NULL`; composite `UNIQUE (deal_id, round_event_id, voter_user_id)`.

  ```sql
  -- Migration 0173: rfp_votes (CRM-owned RFP approval voting for non-service deals)
  --
  -- One row per voter per RFP vote round. A "round" is scoped by round_event_id (=
  -- deals.rfp_approval_request_event_id at trigger time) so a cancel/re-trigger starts a fresh tally
  -- and old rows never leak into a new round. 2-of-3 majority decides (see shared/src/lib/rfpVoteState.ts).
  -- decision is plain text ('approve' | 'reject') per the no-enum RFP-state convention (migration 0151).
  -- Per-office tenant table, mirroring migration 0153 (deal_change_orders): an office_% DO-loop for
  -- existing tenants + a -- TENANT_SCHEMA_START/END block the office provisioner clones (office_dallas
  -- -> new schema).

  -- Existing tenants: create the table + index in every office_* schema.
  DO $tenant$
  DECLARE
    schema_name text;
  BEGIN
    FOR schema_name IN
      SELECT nspname
      FROM pg_namespace
      WHERE nspname LIKE 'office\_%' ESCAPE '\'
      ORDER BY nspname
    LOOP
      EXECUTE format(
        $sql$
          CREATE TABLE IF NOT EXISTS %1$I.rfp_votes (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            deal_id UUID NOT NULL REFERENCES %1$I.deals(id) ON DELETE CASCADE,
            round_event_id UUID NOT NULL,
            voter_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
            voter_email TEXT NOT NULL,
            decision TEXT NOT NULL,
            reason TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT rfp_votes_deal_round_voter_uq UNIQUE (deal_id, round_event_id, voter_user_id)
          );

          CREATE INDEX IF NOT EXISTS rfp_votes_deal_round_idx
            ON %1$I.rfp_votes (deal_id, round_event_id);
        $sql$,
        schema_name
      );
    END LOOP;
  END $tenant$;

  -- New tenants: the office provisioner clones this marked block (office_dallas -> new schema).
  -- TENANT_SCHEMA_START
  CREATE TABLE IF NOT EXISTS office_dallas.rfp_votes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id UUID NOT NULL REFERENCES office_dallas.deals(id) ON DELETE CASCADE,
    round_event_id UUID NOT NULL,
    voter_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    voter_email TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT rfp_votes_deal_round_voter_uq UNIQUE (deal_id, round_event_id, voter_user_id)
  );

  CREATE INDEX IF NOT EXISTS rfp_votes_deal_round_idx
    ON office_dallas.rfp_votes (deal_id, round_event_id);
  -- TENANT_SCHEMA_END
  ```

  Note: constraint/index names are schema-scoped (each office is its own schema), so reusing
  `rfp_votes_deal_round_voter_uq` / `rfp_votes_deal_round_idx` across every office is correct — matching
  how 0153 reuses `deal_change_orders_deal_id_idx` per schema.

- [ ] **Step 4: Run the test — expect PASS** (6 tests: accepts a vote, UNIQUE dup reject, deal cascade,
  user SET NULL, second-office provisioning, idempotency).

  ```
  (cd server && npx vitest run tests/modules/migration/rfp-votes.runtime.test.ts)
  ```
  Expected: 6 passing.

- [ ] **Step 5: Commit.**

  ```
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting add migrations/0173_rfp_votes.sql server/tests/modules/migration/rfp-votes.runtime.test.ts
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting commit -m "feat(rfp-voting): add migration 0173_rfp_votes with PGlite runtime proof

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task A3 — `rfpVoterEmails.ts` config helper (+ exports entry + server test alias)

Mirror `shared/src/lib/rfpReviewerEmails.ts` **exactly**, swapping the env var to `RFP_VOTER_EMAILS`
and the exports to `parseVoterEmails` / `resolveRfpVoterEmails` / `isRfpVoterEmail` /
`DEFAULT_NON_PROD_RFP_VOTER`. Same dev/test fallback, same fail-closed-in-prod semantics. Because the
helper is consumed by server **production** code in Tasks A5/A6 (`@trock-crm/shared/lib/rfpVoterEmails`),
this task also adds the `shared/package.json` `exports` entry and the `server/vitest.config.ts` alias so
both prod resolution and server tests can find it. The unit test location mirrors the reviewer helper's
test (`server/tests/modules/shared/rfp-reviewer-emails.test.ts`).

**Files:**
- Create: `shared/src/lib/rfpVoterEmails.ts` (mirrors `shared/src/lib/rfpReviewerEmails.ts:1-83`)
- Modify: `shared/package.json` (add `./lib/rfpVoterEmails` exports entry after the
  `./lib/rfpReviewerEmails` entry)
- Modify: `server/vitest.config.ts` (add the `@trock-crm/shared/lib/rfpVoterEmails` alias after
  line 11, the `rfpReviewerEmails` alias)
- Test: `server/tests/modules/shared/rfp-voter-emails.test.ts`
  (mirrors `server/tests/modules/shared/rfp-reviewer-emails.test.ts:1-72`)

Steps:

- [ ] **Step 1: Add the server-test alias.** In `server/vitest.config.ts`, insert after the
  `rfpReviewerEmails` alias (line 11) so the server test in Step 3 can import the new lib by its package
  specifier:

  ```ts
      "@trock-crm/shared/lib/rfpReviewerEmails": path.resolve(__dirname, "../shared/src/lib/rfpReviewerEmails.ts"),
      "@trock-crm/shared/lib/rfpVoterEmails": path.resolve(__dirname, "../shared/src/lib/rfpVoterEmails.ts"),
  ```

- [ ] **Step 2: Write the failing unit test.** Create
  `server/tests/modules/shared/rfp-voter-emails.test.ts`, mirroring the reviewer-helper test's four
  `describe` blocks (parse trims/dedupes/lowercases-key; resolve uses env / dev fallback / fail-closed;
  `isRfpVoterEmail` case-insensitive + empty + misconfigured-prod).

  ```ts
  import { describe, it, expect } from "vitest";
  import {
    parseVoterEmails,
    resolveRfpVoterEmails,
    isRfpVoterEmail,
    DEFAULT_NON_PROD_RFP_VOTER,
  } from "@trock-crm/shared/lib/rfpVoterEmails";

  describe("parseVoterEmails", () => {
    it("splits, trims, and de-dupes case-insensitively (keeping first spelling)", () => {
      expect(
        parseVoterEmails("Sidney@trock.com, tim@trock.com , SIDNEY@trock.com"),
      ).toEqual(["Sidney@trock.com", "tim@trock.com"]);
    });

    it("returns [] for empty, whitespace, or undefined input", () => {
      expect(parseVoterEmails(undefined)).toEqual([]);
      expect(parseVoterEmails(null)).toEqual([]);
      expect(parseVoterEmails("   ")).toEqual([]);
      expect(parseVoterEmails(",, ,")).toEqual([]);
    });
  });

  describe("resolveRfpVoterEmails", () => {
    it("uses RFP_VOTER_EMAILS when set", () => {
      expect(
        resolveRfpVoterEmails({
          NODE_ENV: "production",
          RFP_VOTER_EMAILS: "sidney@trock.com, tim@trock.com, james@trock.com",
        }),
      ).toEqual(["sidney@trock.com", "tim@trock.com", "james@trock.com"]);
    });

    it("falls back to the dev address in dev/test when unset", () => {
      expect(resolveRfpVoterEmails({ NODE_ENV: "test" })).toEqual([DEFAULT_NON_PROD_RFP_VOTER]);
      expect(resolveRfpVoterEmails({ NODE_ENV: "development" })).toEqual([DEFAULT_NON_PROD_RFP_VOTER]);
    });

    it("returns [] in production when unset (fail closed)", () => {
      expect(resolveRfpVoterEmails({ NODE_ENV: "production" })).toEqual([]);
    });
  });

  describe("isRfpVoterEmail", () => {
    const env = {
      NODE_ENV: "production",
      RFP_VOTER_EMAILS: "sidney@trock.com, tim@trock.com, james@trock.com",
    };

    it("is true for a listed voter (case-insensitive, trimmed)", () => {
      expect(isRfpVoterEmail("SIDNEY@trock.com", env)).toBe(true);
      expect(isRfpVoterEmail("  james@trock.com ", env)).toBe(true);
    });

    it("is false for a non-listed user (e.g. an admin who isn't a voter)", () => {
      expect(isRfpVoterEmail("someadmin@trock.com", env)).toBe(false);
    });

    it("is false for empty/missing email", () => {
      expect(isRfpVoterEmail("", env)).toBe(false);
      expect(isRfpVoterEmail(null, env)).toBe(false);
      expect(isRfpVoterEmail(undefined, env)).toBe(false);
    });

    it("denies everyone in a misconfigured production (env unset)", () => {
      expect(isRfpVoterEmail("sidney@trock.com", { NODE_ENV: "production" })).toBe(false);
    });
  });
  ```

- [ ] **Step 3: Run the test — expect FAIL** (module `@trock-crm/shared/lib/rfpVoterEmails` does not
  exist; the alias now points at a non-existent source file).

  ```
  (cd server && npx vitest run tests/modules/shared/rfp-voter-emails.test.ts)
  ```
  Expected: fails to resolve import `../shared/src/lib/rfpVoterEmails.ts`.

- [ ] **Step 4: Create the helper.** Write `shared/src/lib/rfpVoterEmails.ts`, an exact structural
  mirror of `rfpReviewerEmails.ts` (zero imports; only exports).

  ```ts
  /**
   * Single source of truth for the RFP voting trio (non-service deals: Sidney, Tim, James).
   *
   * Non-service RFPs are decided by a 3-person 2-of-3 vote in the CRM. Both the server (which authorizes
   * casting a vote and gates the vote UI) and the worker (which emails the invitations) resolve that set
   * through these helpers, so the invited set and the eligible-voter set are defined in one config and can
   * never drift apart. Mirrors rfpReviewerEmails.ts (RFP override reviewers) with its own env var.
   */

  export const DEFAULT_NON_PROD_RFP_VOTER = "adnaan.iqbal@gmail.com";

  const DEV_FALLBACK_NODE_ENVS = new Set(["development", "test"]);

  function isDevFallbackContext(env: NodeJS.ProcessEnv): boolean {
    return typeof env.NODE_ENV === "string" && DEV_FALLBACK_NODE_ENVS.has(env.NODE_ENV);
  }

  /**
   * Parse a comma-separated email list: trim each entry, drop blanks, and de-duplicate
   * case-insensitively while preserving the first spelling encountered.
   */
  export function parseVoterEmails(raw: string | null | undefined): string[] {
    if (typeof raw !== "string") return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of raw.split(",")) {
      const trimmed = part.trim();
      if (trimmed.length === 0) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
    return out;
  }

  /**
   * Resolve the RFP voter emails from `RFP_VOTER_EMAILS`. In dev/test only, falls back to a single dev
   * address so local runs work. In any other env (including a misconfigured prod) it returns [] so the
   * gate fails closed and the worker fails loudly.
   */
  export function resolveRfpVoterEmails(env: NodeJS.ProcessEnv): string[] {
    const parsed = parseVoterEmails(env.RFP_VOTER_EMAILS);
    if (parsed.length > 0) return parsed;
    return isDevFallbackContext(env) ? [DEFAULT_NON_PROD_RFP_VOTER] : [];
  }

  /**
   * True iff `email` is one of the configured RFP voters (case-insensitive, trimmed).
   * Used as the authorization boundary for the RFP vote endpoint + the vote UI flag.
   */
  export function isRfpVoterEmail(email: string | null | undefined, env: NodeJS.ProcessEnv): boolean {
    if (typeof email !== "string") return false;
    const target = email.trim().toLowerCase();
    if (target.length === 0) return false;
    return resolveRfpVoterEmails(env).some((voter) => voter.toLowerCase() === target);
  }
  ```

- [ ] **Step 5: Add the `exports` entry.** In `shared/package.json`, add the `./lib/rfpVoterEmails`
  entry immediately after the `./lib/rfpReviewerEmails` entry so server/worker production imports resolve:

  ```json
      "./lib/rfpReviewerEmails": {
        "types": "./dist/lib/rfpReviewerEmails.d.ts",
        "default": "./dist/lib/rfpReviewerEmails.js"
      },
      "./lib/rfpVoterEmails": {
        "types": "./dist/lib/rfpVoterEmails.d.ts",
        "default": "./dist/lib/rfpVoterEmails.js"
      },
  ```

- [ ] **Step 6: Run the test — expect PASS.**

  ```
  (cd server && npx vitest run tests/modules/shared/rfp-voter-emails.test.ts)
  ```
  Expected: 9 passing.

- [ ] **Step 7: Rebuild `shared` dist** so downstream server/worker `tsc` (which resolves the new
  `exports` `"types"` at `./dist/…`) and production runtime can import the helper. (Server *tests* use
  the vitest alias and don't need this, but the build gate does.)

  ```
  (cd shared && npm run build)
  ```
  Expected: emits `shared/dist/lib/rfpVoterEmails.js` + `.d.ts` (verify: `ls shared/dist/lib/rfpVoterEmails.*`).

- [ ] **Step 8: Commit.**

  ```
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting add shared/src/lib/rfpVoterEmails.ts shared/package.json server/vitest.config.ts server/tests/modules/shared/rfp-voter-emails.test.ts
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting commit -m "feat(rfp-voting): add rfpVoterEmails config helper (RFP_VOTER_EMAILS, fail-closed)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task A4 — `computeRfpVoteState` — the single reconciliation helper

Create the ONE pure/deterministic helper that is the single source of truth for tally + threshold +
outcome + decidedAt (§5.8 reconciliation invariant — later consumed identically by the card display,
the fire-on-2 decision transaction, and the escalation summary). No imports; no side effects. Colocated
shared unit test, exhaustive per the contract.

**Files:**
- Create: `shared/src/lib/rfpVoteState.ts`
- Modify: `shared/package.json` (add `./lib/rfpVoteState` exports entry — needed by the server
  `rfp-vote-service` in a later section)
- Modify: `server/vitest.config.ts` (add the `@trock-crm/shared/lib/rfpVoteState` alias for downstream
  server tests)
- Test: `shared/src/lib/rfpVoteState.test.ts` (colocated shared unit suite; relative import, no alias
  needed for this test)

Steps:

- [ ] **Step 1: Write the failing exhaustive unit test.** Create `shared/src/lib/rfpVoteState.test.ts`.
  Uses fixed `Date`s so `decidedAt` equality is exact. Covers every required case: empty→pending;
  1 approve→pending; 2 approve→approved with `decidedAt` = 2nd approve's `createdAt`; 2 reject→rejected;
  approve+reject+approve ordering→approved at the 2nd approve; threshold override; ignores extra votes
  past the decision.

  ```ts
  import { describe, it, expect } from "vitest";
  import {
    computeRfpVoteState,
    type RfpVoteRecord,
  } from "./rfpVoteState.js";

  const t = (iso: string) => new Date(iso);

  function vote(
    decision: "approve" | "reject",
    createdAt: Date,
    voterEmail = "voter@trock.com",
  ): RfpVoteRecord {
    return { voterUserId: voterEmail, voterEmail, decision, reason: null, createdAt };
  }

  describe("computeRfpVoteState", () => {
    it("empty -> pending, no decidedAt", () => {
      expect(computeRfpVoteState([])).toEqual({
        approvals: 0,
        rejections: 0,
        outcome: "pending",
        decidedAt: null,
      });
    });

    it("1 approve -> pending", () => {
      const r = computeRfpVoteState([vote("approve", t("2026-07-02T10:00:00Z"), "a@t.com")]);
      expect(r.approvals).toBe(1);
      expect(r.rejections).toBe(0);
      expect(r.outcome).toBe("pending");
      expect(r.decidedAt).toBeNull();
    });

    it("2 approve -> approved; decidedAt = the 2nd approve's createdAt (sorted asc)", () => {
      const first = t("2026-07-02T10:00:00Z");
      const second = t("2026-07-02T11:30:00Z");
      const r = computeRfpVoteState([
        vote("approve", first, "a@t.com"),
        vote("approve", second, "b@t.com"),
      ]);
      expect(r.approvals).toBe(2);
      expect(r.outcome).toBe("approved");
      expect(r.decidedAt).toEqual(second);
    });

    it("decidedAt uses createdAt ORDER, not array order", () => {
      const early = t("2026-07-02T10:00:00Z");
      const late = t("2026-07-02T12:00:00Z");
      // Passed late-first; the threshold-th vote by createdAt is still `late`.
      const r = computeRfpVoteState([
        vote("approve", late, "b@t.com"),
        vote("approve", early, "a@t.com"),
      ]);
      expect(r.outcome).toBe("approved");
      expect(r.decidedAt).toEqual(late);
    });

    it("2 reject -> rejected; decidedAt = the 2nd reject's createdAt", () => {
      const first = t("2026-07-02T09:00:00Z");
      const second = t("2026-07-02T09:15:00Z");
      const r = computeRfpVoteState([
        vote("reject", first, "a@t.com"),
        vote("reject", second, "b@t.com"),
      ]);
      expect(r.rejections).toBe(2);
      expect(r.outcome).toBe("rejected");
      expect(r.decidedAt).toEqual(second);
    });

    it("approve, reject, approve -> approved at the 2nd approve (mixed ordering)", () => {
      const a1 = t("2026-07-02T10:00:00Z");
      const rj = t("2026-07-02T10:30:00Z");
      const a2 = t("2026-07-02T11:00:00Z");
      const r = computeRfpVoteState([
        vote("approve", a1, "a@t.com"),
        vote("reject", rj, "b@t.com"),
        vote("approve", a2, "c@t.com"),
      ]);
      expect(r.approvals).toBe(2);
      expect(r.rejections).toBe(1);
      expect(r.outcome).toBe("approved");
      expect(r.decidedAt).toEqual(a2);
    });

    it("honors a threshold override (threshold: 1 decides on the first matching vote)", () => {
      const only = t("2026-07-02T10:00:00Z");
      const r = computeRfpVoteState([vote("reject", only, "a@t.com")], { threshold: 1 });
      expect(r.outcome).toBe("rejected");
      expect(r.decidedAt).toEqual(only);
    });

    it("ignores extra votes past the decision (decidedAt stays the threshold-crossing vote)", () => {
      const a1 = t("2026-07-02T10:00:00Z");
      const a2 = t("2026-07-02T10:05:00Z");
      const a3 = t("2026-07-02T10:59:00Z");
      const r = computeRfpVoteState([
        vote("approve", a1, "a@t.com"),
        vote("approve", a2, "b@t.com"),
        vote("approve", a3, "c@t.com"),
      ]);
      expect(r.approvals).toBe(3);
      expect(r.outcome).toBe("approved");
      expect(r.decidedAt).toEqual(a2); // the 2nd approve decided it; the 3rd doesn't move decidedAt
    });

    it("accepts ISO-string createdAt as well as Date", () => {
      const r = computeRfpVoteState([
        { voterUserId: null, voterEmail: "a@t.com", decision: "approve", reason: null, createdAt: "2026-07-02T10:00:00Z" },
        { voterUserId: null, voterEmail: "b@t.com", decision: "approve", reason: null, createdAt: "2026-07-02T11:00:00Z" },
      ]);
      expect(r.outcome).toBe("approved");
      expect(r.decidedAt).toEqual(new Date("2026-07-02T11:00:00Z"));
    });
  });
  ```

- [ ] **Step 2: Run the test — expect FAIL** (module `./rfpVoteState.js` does not exist).

  ```
  (cd shared && npx vitest run --config vitest.ci.config.ts src/lib/rfpVoteState.test.ts)
  ```
  Expected: fails to resolve `./rfpVoteState.js`.

- [ ] **Step 3: Create the helper.** Write `shared/src/lib/rfpVoteState.ts` with the exact
  contract types + signature. `approvals`/`rejections` are total counts; `decidedAt` is the `createdAt`
  of the threshold-th vote of the winning side, sorted ascending (so later votes never move it).

  ```ts
  /**
   * The ONE place RFP vote tally/threshold/outcome logic lives (design §5.8 reconciliation invariant).
   * Pure and deterministic: consumed identically by the deal-card display, the fire-on-2 decision inside
   * the vote transaction, and the escalation-page summary — so card == decision == escalation can never
   * drift for the same vote set.
   */

  export type RfpVoteRecord = {
    voterUserId: string | null;
    voterEmail: string;
    decision: "approve" | "reject";
    reason: string | null;
    createdAt: Date | string;
  };

  export type RfpVoteOutcome = "pending" | "approved" | "rejected";

  export interface RfpVoteState {
    approvals: number;
    rejections: number;
    outcome: RfpVoteOutcome;
    decidedAt: Date | null;
  }

  const DEFAULT_VOTE_THRESHOLD = 2;

  function toDate(value: Date | string): Date {
    return value instanceof Date ? value : new Date(value);
  }

  export function computeRfpVoteState(
    votes: RfpVoteRecord[],
    opts?: { threshold?: number },
  ): RfpVoteState {
    const threshold = opts?.threshold ?? DEFAULT_VOTE_THRESHOLD;
    const approveVotes = votes.filter((v) => v.decision === "approve");
    const rejectVotes = votes.filter((v) => v.decision === "reject");
    const approvals = approveVotes.length;
    const rejections = rejectVotes.length;

    // createdAt of the threshold-th matching vote (sorted ascending) — the vote that CROSSED the line.
    // Later votes on the same side never move this, so decidedAt is stable once decided.
    const decidedAtFor = (matching: RfpVoteRecord[]): Date => {
      const sorted = [...matching].sort(
        (a, b) => toDate(a.createdAt).getTime() - toDate(b.createdAt).getTime(),
      );
      return toDate(sorted[threshold - 1]!.createdAt);
    };

    if (approvals >= threshold) {
      return { approvals, rejections, outcome: "approved", decidedAt: decidedAtFor(approveVotes) };
    }
    if (rejections >= threshold) {
      return { approvals, rejections, outcome: "rejected", decidedAt: decidedAtFor(rejectVotes) };
    }
    return { approvals, rejections, outcome: "pending", decidedAt: null };
  }
  ```

- [ ] **Step 4: Add the `exports` entry + server alias** (for downstream server consumers —
  `rfp-vote-service` + its runtime tests in later sections). In `shared/package.json`, after the
  `./lib/rfpVoterEmails` entry from Task A3:

  ```json
      "./lib/rfpVoteState": {
        "types": "./dist/lib/rfpVoteState.d.ts",
        "default": "./dist/lib/rfpVoteState.js"
      },
  ```
  In `server/vitest.config.ts`, after the `rfpVoterEmails` alias from Task A3:

  ```ts
      "@trock-crm/shared/lib/rfpVoteState": path.resolve(__dirname, "../shared/src/lib/rfpVoteState.ts"),
  ```

- [ ] **Step 5: Run the test — expect PASS.**

  ```
  (cd shared && npx vitest run --config vitest.ci.config.ts src/lib/rfpVoteState.test.ts)
  ```
  Expected: 9 passing.

- [ ] **Step 6: Rebuild `shared` dist** (so the new `exports` `"types"` resolves for downstream `tsc`).

  ```
  (cd shared && npm run build)
  ```
  Expected: emits `shared/dist/lib/rfpVoteState.js` + `.d.ts`.

- [ ] **Step 7: Commit.**

  ```
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting add shared/src/lib/rfpVoteState.ts shared/src/lib/rfpVoteState.test.ts shared/package.json server/vitest.config.ts
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting commit -m "feat(rfp-voting): add computeRfpVoteState single reconciliation helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task A5 — `isRfpVoter` auth flag (server injection + type on both User shapes)

Inject `isRfpVoter: isRfpVoterEmail(user.email, process.env)` at the single assembly point
`withOnboardingGate` (`server/src/modules/auth/routes.ts:185`, beside `isRfpReviewer`) so all 4 auth
response paths (`/me`, dev-login, local-login, switch-office) carry it. Add the optional boolean to
BOTH the shared `AuthenticatedUser` type (`shared/src/types/auth.ts:44`) and the client-local `User`
type (`client/src/lib/auth.tsx:27`) — the client type is a hand-maintained duplicate, not imported from
shared. Depends on Task A3 (helper + alias + exports).

**Files:**
- Modify: `server/src/modules/auth/routes.ts` (import at line 18 area; injection at line 185, inside
  `withOnboardingGate` return object at `routes.ts:171-200`)
- Modify: `shared/src/types/auth.ts` (add field after `isRfpReviewer?` at line 44)
- Modify: `client/src/lib/auth.tsx` (add field after `isRfpReviewer?` at line 27)
- Test: `server/tests/modules/auth/rfp-voter-flag.runtime.test.ts`
  (mirrors `server/tests/modules/auth/local-auth-routes.test.ts:1-98`)

Steps:

- [ ] **Step 1: Write the failing `/me` runtime test.** Create
  `server/tests/modules/auth/rfp-voter-flag.runtime.test.ts`. It mirrors `local-auth-routes.test.ts`:
  mock `rate-limit` (`authLimiter` pass-through) and `auth` (`authMiddleware` sets `req.user`), mount
  `authRoutes`, hit `GET /api/auth/me`. Uses `role: "director"` so `getUserOnboardingGateStatus`
  short-circuits without a DB (see service.ts:77-85). A hoisted mutable `authState.user` lets each test
  choose the caller's email.

  ```ts
  import cookieParser from "cookie-parser";
  import express from "express";
  import request from "supertest";
  import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

  const SIDNEY = "sidney@trockgc.com";

  const authState = vi.hoisted(() => ({ user: null as any }));

  vi.mock("../../../src/middleware/rate-limit.js", () => ({
    authLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  }));

  vi.mock("../../../src/middleware/auth.js", () => ({
    authMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = authState.user;
      next();
    },
  }));

  const { authRoutes } = await import("../../../src/modules/auth/routes.js");
  const { errorHandler } = await import("../../../src/middleware/error-handler.js");

  function createTestApp() {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api/auth", authRoutes);
    app.use(errorHandler);
    return app;
  }

  describe("GET /api/auth/me — isRfpVoter flag (runtime)", () => {
    const original = process.env.RFP_VOTER_EMAILS;

    beforeEach(() => {
      vi.clearAllMocks();
      process.env.JWT_SECRET = "test-jwt-secret";
      process.env.RFP_VOTER_EMAILS = `${SIDNEY}, tim@trockgc.com, james@trockgc.com`;
    });
    afterEach(() => {
      process.env.RFP_VOTER_EMAILS = original;
    });

    it("carries isRfpVoter=true for a configured voter (case-insensitive)", async () => {
      authState.user = {
        id: "u1",
        email: SIDNEY.toUpperCase(),
        displayName: "Sidney Gibson",
        role: "director", // bypasses the onboarding-gate DB query
        officeId: "office-dallas",
        activeOfficeId: "office-dallas",
      };
      const res = await request(createTestApp()).get("/api/auth/me");
      expect(res.status).toBe(200);
      expect(res.body.user.isRfpVoter).toBe(true);
    });

    it("carries isRfpVoter=false for a non-voter (incl. a plain admin)", async () => {
      authState.user = {
        id: "u2",
        email: "someadmin@trockgc.com",
        displayName: "Some Admin",
        role: "director",
        officeId: "office-dallas",
        activeOfficeId: "office-dallas",
      };
      const res = await request(createTestApp()).get("/api/auth/me");
      expect(res.status).toBe(200);
      expect(res.body.user.isRfpVoter).toBe(false);
    });
  });
  ```

- [ ] **Step 2: Run the test — expect FAIL** (the `/me` payload has no `isRfpVoter` key →
  `res.body.user.isRfpVoter` is `undefined`, so `.toBe(true)` fails).

  ```
  (cd server && npx vitest run tests/modules/auth/rfp-voter-flag.runtime.test.ts)
  ```
  Expected: fails — `expected undefined to be true`.

- [ ] **Step 3: Import the voter helper in the auth router.** In `server/src/modules/auth/routes.ts`,
  add the import beside the existing `isRfpReviewerEmail` import (dossier anchor `routes.ts:18`):

  ```ts
  import { isRfpReviewerEmail } from "@trock-crm/shared/lib/rfpReviewerEmails";
  import { isRfpVoterEmail } from "@trock-crm/shared/lib/rfpVoterEmails";
  ```

- [ ] **Step 4: Inject the flag** in `withOnboardingGate`'s return object (dossier anchor
  `routes.ts:185`, right after `isRfpReviewer`):

  ```ts
      // Whether this user is one of the designated RFP override reviewers (Takashi/Adam). Lets the frontend gate
      // the /rfp-review page; the server endpoints enforce the same allowlist as the hard boundary.
      isRfpReviewer: isRfpReviewerEmail(user.email, process.env),
      // Whether this user is one of the 3 RFP voters (Sidney/Tim/James). Gates the vote UI + /rfp-vote page;
      // the vote endpoint enforces the same allowlist (requireRfpVoter) as the hard boundary.
      isRfpVoter: isRfpVoterEmail(user.email, process.env),
  ```

- [ ] **Step 5: Add the field to the shared type.** In `shared/src/types/auth.ts`, after
  `isRfpReviewer?: boolean;` (line 44) inside `AuthenticatedUser`:

  ```ts
    /** True iff this user is a designated RFP override reviewer (RFP_REJECTION_EMAIL_RECIPIENTS allowlist). */
    isRfpReviewer?: boolean;
    /** True iff this user is one of the 3 RFP voters (RFP_VOTER_EMAILS allowlist); gates the vote UI + /rfp-vote page. */
    isRfpVoter?: boolean;
  ```

- [ ] **Step 6: Add the field to the client type.** In `client/src/lib/auth.tsx`, after
  `isRfpReviewer?: boolean;` (line 27) inside the local `User` interface:

  ```tsx
    /** True iff this user may review declined RFPs (Takashi/Adam allowlist); gates the /rfp-review page. */
    isRfpReviewer?: boolean;
    /** True iff this user is one of the 3 RFP voters (Sidney/Tim/James); gates the vote UI + /rfp-vote page. */
    isRfpVoter?: boolean;
  ```

- [ ] **Step 7: Run the test — expect PASS.**

  ```
  (cd server && npx vitest run tests/modules/auth/rfp-voter-flag.runtime.test.ts)
  ```
  Expected: 2 passing (true for Sidney; false for the admin).

- [ ] **Step 8: Commit.**

  ```
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting add server/src/modules/auth/routes.ts shared/src/types/auth.ts client/src/lib/auth.tsx server/tests/modules/auth/rfp-voter-flag.runtime.test.ts
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting commit -m "feat(rfp-voting): inject isRfpVoter auth flag + add to both User types

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task A6 — `requireRfpVoter` middleware (403 `RFP_VOTER_ONLY`)

Add the middleware mirroring `requireRfpReviewer` (`server/src/middleware/rbac.ts:49-63`): 401 when
unauthenticated, 403 `RFP_VOTER_ONLY` when the caller's email is not in `RFP_VOTER_EMAILS` (role does
NOT grant it — a plain admin gets 403). This is the hard authorization boundary the `POST
/:id/rfp-vote` route (a later section) mounts. Depends on Task A3 (helper + alias + exports).

**Files:**
- Modify: `server/src/middleware/rbac.ts` (import at line 4 area; add `requireRfpVoter` after
  `requireRfpReviewer` at `rbac.ts:63`)
- Test: `server/tests/middleware/require-rfp-voter.runtime.test.ts`
  (mirrors `server/tests/middleware/require-rfp-reviewer.test.ts:1-38`)

Steps:

- [ ] **Step 1: Write the failing middleware runtime test.** Create
  `server/tests/middleware/require-rfp-voter.runtime.test.ts`, mirroring the reviewer middleware test but
  asserting the `RFP_VOTER_ONLY` code and driving off `RFP_VOTER_EMAILS`.

  ```ts
  import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
  import { requireRfpVoter } from "../../src/middleware/rbac.js";

  const SIDNEY = "sidney@trockgc.com";
  const JAMES = "james@trockgc.com";

  function run(user: any) {
    const next = vi.fn();
    requireRfpVoter({ user } as any, {} as any, next);
    return next;
  }

  describe("requireRfpVoter (email allowlist = RFP_VOTER_EMAILS)", () => {
    const original = process.env.RFP_VOTER_EMAILS;

    beforeEach(() => {
      process.env.RFP_VOTER_EMAILS = `${SIDNEY}, ${JAMES}`;
    });
    afterEach(() => {
      process.env.RFP_VOTER_EMAILS = original;
    });

    it("allows a configured voter (case-insensitive)", () => {
      const next = run({ id: "u1", email: SIDNEY.toUpperCase(), role: "rep" });
      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
    });

    it("403 RFP_VOTER_ONLY for an authenticated admin who is NOT a voter", () => {
      const next = run({ id: "u2", email: "someadmin@trockgc.com", role: "admin" });
      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 403, code: "RFP_VOTER_ONLY" }),
      );
    });

    it("401 when there is no authenticated user", () => {
      const next = run(undefined);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    });
  });
  ```

- [ ] **Step 2: Run the test — expect FAIL** (`requireRfpVoter` is not exported from `rbac.js`).

  ```
  (cd server && npx vitest run tests/middleware/require-rfp-voter.runtime.test.ts)
  ```
  Expected: fails — `requireRfpVoter is not a function` / import has no such export.

- [ ] **Step 3: Import the voter helper in rbac.** In `server/src/middleware/rbac.ts`, add the import
  beside the existing `isRfpReviewerEmail` import (dossier anchor `rbac.ts:4`):

  ```ts
  import { isRfpReviewerEmail } from "@trock-crm/shared/lib/rfpReviewerEmails";
  import { isRfpVoterEmail } from "@trock-crm/shared/lib/rfpVoterEmails";
  ```

- [ ] **Step 4: Add the middleware** after `requireRfpReviewer` (dossier anchor `rbac.ts:63`, end of
  file):

  ```ts
  /**
   * Restrict a route to the 3 designated RFP voters (Sidney/Tim/James), resolved from RFP_VOTER_EMAILS.
   * This is the SAME source of truth as who is invited to vote, so the eligible set and the invited set
   * never drift. A regular admin/director who is not on that list gets 403 — role does NOT grant vote
   * rights. Mirrors requireRfpReviewer.
   */
  export function requireRfpVoter(req: Request, _res: Response, next: NextFunction) {
    if (!req.user) {
      return next(new AppError(401, "Authentication required"));
    }
    if (!isRfpVoterEmail(req.user.email, process.env)) {
      return next(
        new AppError(
          403,
          "Only the designated RFP voters can vote on RFPs.",
          "RFP_VOTER_ONLY",
        ),
      );
    }
    next();
  }
  ```

- [ ] **Step 5: Run the test — expect PASS.**

  ```
  (cd server && npx vitest run tests/middleware/require-rfp-voter.runtime.test.ts)
  ```
  Expected: 3 passing (voter allowed; admin 403 `RFP_VOTER_ONLY`; unauth 401).

- [ ] **Step 6: Commit.**

  ```
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting add server/src/middleware/rbac.ts server/tests/middleware/require-rfp-voter.runtime.test.ts
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting commit -m "feat(rfp-voting): add requireRfpVoter middleware (403 RFP_VOTER_ONLY)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Section A exit check

Run the whole foundation to confirm every piece is green together (shared units + server units +
migration/auth/middleware runtime suites):

```
(cd shared && npx vitest run --config vitest.ci.config.ts src/schema/rfp-votes.test.ts src/lib/rfpVoteState.test.ts)
(cd server && npx vitest run tests/modules/shared/rfp-voter-emails.test.ts tests/modules/migration/rfp-votes.runtime.test.ts tests/modules/auth/rfp-voter-flag.runtime.test.ts tests/middleware/require-rfp-voter.runtime.test.ts)
(cd shared && npm run build)   # dist has rfpVoterEmails + rfpVoteState so server/worker tsc + prod resolve them
```

Expected: all suites pass; `shared/dist/lib/rfpVoterEmails.*` and `shared/dist/lib/rfpVoteState.*` exist.
At this point the schema, migration, config, reconciliation helper, auth flag, and vote-authz boundary
all exist and are proven — but nothing is wired into the trigger/vote flow yet (Sections B/C). The
service/type-4 path is entirely untouched.
## Section B: Vote engine + trigger branch + route + jobs + SyncHub

This section builds the server vote engine (`rfp-vote-service.ts`), the `trigger-rfp` branch, the
`POST /:id/rfp-vote` route, the two worker jobs (`rfp_vote_invitation`, `rfp_bidboard_create`), the
SyncHub `POST /api/bid-board/create-from-rfp` endpoint, and the minimal CRM `bid-board-created`
callback change so voting-path deals advance.

**Depends on Section A** (assumed landed before this section executes):
- `shared/src/schema/tenant/rfp-votes.ts` exporting `rfpVotes` (registered in `shared/src/schema/index.ts`).
- `migrations/0173_rfp_votes.sql` (the runtime tests below build `rfp_votes` inline on PGlite, so they do
  not depend on the migration file, but production does).
- `shared/src/lib/rfpVoteState.ts` exporting `computeRfpVoteState`, `RfpVoteRecord`, `RfpVoteOutcome`.
- `shared/src/lib/rfpVoterEmails.ts` exporting `resolveRfpVoterEmails` / `isRfpVoterEmail`.
- `server/src/middleware/rbac.ts` exporting `requireRfpVoter` (403 `RFP_VOTER_ONLY`).
- `isRfpVoter` on the auth payload.

**Package-boundary fact (load-bearing):** `server/src` never imports `worker/src` at runtime (only server
*tests* do, via `../../../../worker/src/...`). So the two `enqueue*` helpers that server engine code calls
(`enqueueRfpVoteInvitation`, `enqueueRfpBidBoardCreate`) live **server-side** in
`server/src/modules/deals/rfp-enqueue.ts` (next to `insertOpportunityRfpRequestJob`), inserting `job_queue`
rows via Drizzle. The worker files contain only the **handlers** for those job types. The canonical names
(`enqueueRfpVoteInvitation`, `enqueueRfpBidBoardCreate`, jobTypes `rfp_vote_invitation` /
`rfp_bidboard_create`) are preserved exactly.

**Test commands (exact):**
- Server runtime (runs in the CI gate `test:runtime` = `vitest run runtime.test`):
  `(cd server && npx vitest run tests/modules/deals/<name>.runtime.test.ts)`
- Worker runtime (CI gate `test:runtime` = `vitest run runtime.test`):
  `(cd worker && npx vitest run tests/jobs/<name>.runtime.test.ts)`
- SyncHub (vitest, `tests/*.test.ts`): `(cd /Users/adnaaniqbal/Developer/trocksynchubv3 && npx vitest run tests/<name>.test.ts)`

All git commands run in the worktree `/Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting` (SyncHub commits
run in `/Users/adnaaniqbal/Developer/trocksynchubv3`).

---

### Task 7: `rfp-vote-service.ts` — engine (isServiceRfp, openRfpVoteRound, buildRfpVoteDeclineReason, castRfpVote) + enqueue helpers + nullable decline

**Files:**
- Create: `server/src/modules/deals/rfp-vote-service.ts`
- Modify: `server/src/modules/deals/rfp-payload.ts` (add `resolveSyncHubCreateFromRfpUrl`, after `resolveSyncHubRfpRequestUrl` ~line 837)
- Modify: `server/src/modules/deals/rfp-enqueue.ts` (add `enqueueRfpVoteInvitation` + `enqueueRfpBidBoardCreate`; extend the `./rfp-payload.js` import ~line 452)
- Modify: `server/src/modules/deals/rfp-decline-service.ts` (make `rfpApprovalRequestId` nullable; `IS NOT DISTINCT FROM` guard ~lines 1179-1201 of the dossier / the `applyRfpDeclineToDeal` UPDATE)
- Test: `server/tests/modules/deals/rfp-vote-service.runtime.test.ts`

**Design notes (read before coding):**
- **Exactly-once fire:** the tally does `SELECT id FROM deals WHERE id=$1 FOR UPDATE` (serializes concurrent
  votes on the deal), recounts votes **before** and **after** the insert, and fires the outcome only when
  `priorState.outcome === 'pending' && newState.outcome !== 'pending'` (i.e. *this* vote crossed the
  threshold). Approve keeps `rfp_approval_status='pending'` (the callback later flips it), so the
  before/after transition — not a status change — is the idempotency signal for approve; the FOR UPDATE lock
  makes it race-free across connections.
- **Reject reuses `applyRfpDeclineToDeal`**, which requires a `PoolClient` + `schemaName`. `castRfpVote` gets
  the raw client from the Drizzle tenant db via `(tenantDb as { $client }).$client` (in a route this is the
  same pooled client `req.tenantClient`, in one transaction) and resolves `schemaName` from `officeId`.
- **Nullable request id + app-driven no-go escalation (resolved; deviation from spec §5.5):** voting-path deals
  never mint `rfp_approval_request_id`, so `applyRfpDeclineToDeal`'s `AND rfp_approval_request_id = $4` must
  become `IS NOT DISTINCT FROM $4` and the param type `number | null`. Migration `0148`'s
  `enqueue_rfp_rejected_email` trigger `RETURN NEW`s early when `rfp_approval_request_id IS NULL`, so it does
  **not** fire the Takashi/Adam escalation for a voting decline. Rather than relax that shared trigger (it also
  serves SyncHub declines, and its receipt dedup keys on the request id), the no-go escalation is **app-driven**:
  `castRfpVote` enqueues an `rfp_vote_outcome` job in BOTH decided branches (approve → rep GO email; reject →
  rep + Takashi/Adam escalation with the `/rfp-review` link). Task 19 (Section C) implements that handler; this
  task adds the `enqueueRfpVoteOutcome` seam + the enqueue calls. Because the trigger stays inert for
  null-request-id deals, there is no double-send. Deliberate deviation from spec §5.5 ("reuse the DB trigger"),
  forced by the trigger's null guard.

- [ ] **Step 1: Write the failing engine test.** Create `server/tests/modules/deals/rfp-vote-service.runtime.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  castRfpVote,
  isServiceRfp,
  buildRfpVoteDeclineReason,
  openRfpVoteRound,
} from "../../../src/modules/deals/rfp-vote-service.js";

/**
 * REAL-SQL (PGlite) proof of the vote engine. rfp_votes + deals live in the DEFAULT (public) schema so the
 * bare pgTable Drizzle mappings resolve unqualified (mirrors floor-gate.runtime.test.ts). The reject path
 * injects an `applyDecline` stub that (a) records the aggregated reason and (b) flips public.deals to
 * 'declined', so we assert the call + the transition without needing office_x.deals for applyRfpDeclineToDeal.
 */
const DEAL = "00000000-0000-0000-0000-0000000000d1";
const V1 = "00000000-0000-0000-0000-000000000001";
const V2 = "00000000-0000-0000-0000-000000000002";
const V3 = "00000000-0000-0000-0000-000000000003";
const ROUND = "00000000-0000-0000-0000-0000000000e1";

let pg: PGlite | null = null;
afterEach(async () => {
  await pg?.close();
  pg = null;
});

async function setup() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.job_queue (
      id bigserial PRIMARY KEY, job_type text NOT NULL, payload jsonb NOT NULL, office_id uuid,
      status text NOT NULL, max_attempts integer NOT NULL DEFAULT 3,
      run_after timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.offices (id uuid PRIMARY KEY, slug text NOT NULL, is_active boolean NOT NULL DEFAULT true);
    INSERT INTO public.offices (id, slug) VALUES ('00000000-0000-0000-0000-0000000000ff', 'test');
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text NOT NULL, deal_number text NOT NULL, project_number text,
      stage_id uuid, project_type text, workflow_route text NOT NULL DEFAULT 'normal',
      is_bid_board_owned boolean NOT NULL DEFAULT false, bid_board_stage_slug text,
      is_read_only_mirror boolean NOT NULL DEFAULT false, read_only_synced_at timestamptz,
      bid_board_stage_entered_at timestamptz, bid_board_mirror_source_entered_at timestamptz,
      rfp_approval_status text, rfp_approval_requested_at timestamptz,
      rfp_approval_request_event_id uuid, rfp_approval_requested_by uuid,
      rfp_approval_request_id integer, rfp_declined_reason text, rfp_declined_at timestamptz,
      updated_at timestamptz
    );
    CREATE TABLE rfp_votes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid NOT NULL, round_event_id uuid NOT NULL,
      voter_user_id uuid, voter_email text NOT NULL, decision text NOT NULL, reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT rfp_votes_deal_round_voter_uq UNIQUE (deal_id, round_event_id, voter_user_id)
    );
  `);
  await db.query(
    `INSERT INTO deals (id, name, deal_number, stage_id, workflow_route, rfp_approval_status, rfp_approval_request_event_id)
     VALUES ($1, 'jasonn ranches', 'TR-1001', '00000000-0000-0000-0000-0000000000aa', 'normal', 'pending', $2)`,
    [DEAL, ROUND],
  );
  return db;
}

function dealRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DEAL,
    name: "jasonn ranches",
    dealNumber: "TR-1001",
    projectNumber: null,
    workflowRoute: "normal",
    projectType: null,
    rfpApprovalStatus: "pending",
    rfpApprovalRequestEventId: ROUND,
    rfpApprovalRequestId: null,
    ...overrides,
  } as any;
}

describe("isServiceRfp", () => {
  it("is true only for the service route (code 4)", () => {
    expect(isServiceRfp({ workflowRoute: "service" })).toBe(true);
    expect(isServiceRfp({ workflowRoute: "normal" })).toBe(false);
    expect(isServiceRfp({ projectType: "roofing", workflowRoute: "normal" })).toBe(false);
  });
});

describe("buildRfpVoteDeclineReason", () => {
  it("aggregates the reject reasons as '(N of 3)'", () => {
    const reason = buildRfpVoteDeclineReason([
      { voterUserId: V2, voterEmail: "james@x.com", decision: "reject", reason: "Margins too thin", createdAt: new Date() },
      { voterUserId: V1, voterEmail: "sidney@x.com", decision: "reject", reason: "  Scope unclear ", createdAt: new Date() },
    ]);
    expect(reason).toBe("Rejected by vote (2 of 3). james@x.com: Margins too thin; sidney@x.com: Scope unclear");
  });
});

describe("castRfpVote", () => {
  it("approve-majority enqueues rfp_bidboard_create exactly once (2nd fires, 3rd does not)", async () => {
    pg = await setup();
    const tdb: any = drizzle(pg as any);
    const enqueueBidBoardCreate = vi.fn(async () => ({ jobId: 1 }));

    const r1 = await castRfpVote(
      { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V1, email: "sidney@x.com" }, decision: "approve", reason: null },
      { enqueueBidBoardCreate },
    );
    expect(r1.outcome).toBe("pending");
    const r2 = await castRfpVote(
      { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V2, email: "james@x.com" }, decision: "approve", reason: null },
      { enqueueBidBoardCreate },
    );
    expect(r2.outcome).toBe("approved");
    const r3 = await castRfpVote(
      { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V3, email: "tim@x.com" }, decision: "approve", reason: null },
      { enqueueBidBoardCreate },
    );
    expect(r3.outcome).toBe("approved");
    expect(enqueueBidBoardCreate).toHaveBeenCalledTimes(1);
  });

  it("reject-majority calls applyDecline with the aggregated reason and flips status to declined", async () => {
    pg = await setup();
    const tdb: any = drizzle(pg as any);
    const applyDecline = vi.fn(async (input: any) => {
      await pg!.query(`UPDATE deals SET rfp_approval_status='declined', rfp_declined_reason=$1 WHERE id=$2`, [input.denialReason, input.sourceDealId]);
      return { applied: true, declinedDeal: null };
    });

    await castRfpVote(
      { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V1, email: "sidney@x.com" }, decision: "reject", reason: "Margins too thin" },
      { applyDecline },
    );
    const res = await castRfpVote(
      { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V2, email: "james@x.com" }, decision: "reject", reason: "Scope unclear" },
      { applyDecline },
    );
    expect(res.outcome).toBe("rejected");
    expect(applyDecline).toHaveBeenCalledTimes(1);
    expect(applyDecline.mock.calls[0][0].denialReason).toBe(
      "Rejected by vote (2 of 3). sidney@x.com: Margins too thin; james@x.com: Scope unclear",
    );
    const rows = (await pg!.query(`SELECT rfp_approval_status, rfp_declined_reason FROM deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(rows[0].rfp_approval_status).toBe("declined");
  });

  it("second vote by the same voter -> 409 RFP_ALREADY_VOTED", async () => {
    pg = await setup();
    const tdb: any = drizzle(pg as any);
    await castRfpVote(
      { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V1, email: "sidney@x.com" }, decision: "approve", reason: null },
      { enqueueBidBoardCreate: vi.fn(async () => ({ jobId: 1 })) },
    );
    await expect(
      castRfpVote(
        { tenantDb: tdb, officeId: "00000000-0000-0000-0000-0000000000ff", deal: dealRow(), voter: { userId: V1, email: "sidney@x.com" }, decision: "reject", reason: "changed my mind" },
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "RFP_ALREADY_VOTED" });
  });
});

describe("openRfpVoteRound", () => {
  it("reserves the deal (status pending, event id) and enqueues rfp_vote_invitation", async () => {
    pg = await setup();
    // Reset the deal to a pre-round state.
    await pg.query(`UPDATE deals SET rfp_approval_status=NULL, rfp_approval_request_event_id=NULL WHERE id=$1`, [DEAL]);
    const tdb: any = drizzle(pg as any);
    await openRfpVoteRound({
      tenantDb: tdb,
      officeId: "00000000-0000-0000-0000-0000000000ff",
      deal: dealRow({ rfpApprovalStatus: null, rfpApprovalRequestEventId: null }),
      requestedByUserId: V1,
    });
    const deal = (await pg.query(`SELECT rfp_approval_status, rfp_approval_request_event_id, rfp_approval_requested_by FROM deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(deal[0].rfp_approval_status).toBe("pending");
    expect(deal[0].rfp_approval_request_event_id).not.toBeNull();
    const jobs = (await pg.query(`SELECT job_type, payload FROM public.job_queue`)).rows as any[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0].job_type).toBe("rfp_vote_invitation");
    expect(jobs[0].payload.dealId).toBe(DEAL);
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL (module not found).** `(cd server && npx vitest run tests/modules/deals/rfp-vote-service.runtime.test.ts)` → FAIL: `Cannot find module '../../../src/modules/deals/rfp-vote-service.js'`.

- [ ] **Step 3: Add `resolveSyncHubCreateFromRfpUrl` to `rfp-payload.ts`.** Insert directly after `resolveSyncHubRfpRequestUrl` (~line 837):

```ts
export function resolveSyncHubCreateFromRfpUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${resolveSyncHubBaseUrl(env)}/api/bid-board/create-from-rfp`;
}
```

- [ ] **Step 4: Add the two enqueue helpers to `rfp-enqueue.ts`.** Extend the `./rfp-payload.js` import (~line 452) to add `buildNormalizedRfpRequestBody, resolveSyncHubCreateFromRfpUrl`:

```ts
import { buildNormalizedRfpRequestBody, buildRfpAttachmentsFromFiles, buildRfpRequestDeliveryPayload, resolveSyncHubCreateFromRfpUrl, resolveSyncHubRfpRequestUrl } from "./rfp-payload.js";
```

Then append at the end of the file (both reuse the module-private `loadRfpPayloadDeal` + `loadRfpAttachmentsForDeal`):

```ts
/**
 * Enqueue the three-voter invitation email job for an opened vote round. Mirrors insertOpportunityRfpRequestJob's
 * Drizzle insert; the WORKER handler (worker/src/jobs/rfp-vote-invitation.ts) sends the emails. Server-side so the
 * server package (which never imports worker/src at runtime) owns the enqueue.
 */
export async function enqueueRfpVoteInvitation(input: {
  tenantDb: TenantDb;
  deal: typeof deals.$inferSelect;
  officeId: string | null;
}): Promise<{ jobId: number }> {
  const jobRows = await input.tenantDb
    .insert(jobQueue)
    .values({
      jobType: "rfp_vote_invitation",
      payload: {
        dealId: input.deal.id,
        dealNumber: input.deal.dealNumber ?? null,
        dealName: input.deal.name ?? null,
        officeId: input.officeId,
      },
      officeId: input.officeId,
      status: "pending",
      runAfter: new Date(),
      maxAttempts: 5,
    })
    .returning({ id: jobQueue.id });
  return { jobId: Number(jobRows[0]?.id) };
}

/**
 * Enqueue the GO outbound job (2/3-approve OR override-approve): the WORKER HMAC-POSTs the normalized deal body
 * (+ decision:'approved') to SyncHub's /api/bid-board/create-from-rfp. Mirrors insertOpportunityRfpRequestJob but
 * targets the create-from-rfp URL and carries a decision flag so SyncHub creates immediately (no email).
 */
export async function enqueueRfpBidBoardCreate(input: {
  tenantDb: TenantDb;
  deal: typeof deals.$inferSelect;
  officeId: string | null;
}): Promise<{ jobId: number }> {
  const rfpPayloadDeal = await loadRfpPayloadDeal(input.tenantDb, input.deal);
  const attachments = await loadRfpAttachmentsForDeal(input.tenantDb, input.deal.id);
  const body = buildNormalizedRfpRequestBody({
    deal: rfpPayloadDeal,
    sourceEventId: `crm:rfp-vote:approved:${input.deal.rfpApprovalRequestEventId ?? input.deal.id}`,
    attachments,
  });
  const jobRows = await input.tenantDb
    .insert(jobQueue)
    .values({
      jobType: "rfp_bidboard_create",
      payload: {
        dealId: input.deal.id,
        syncHubUrl: resolveSyncHubCreateFromRfpUrl(),
        body: { ...body, decision: "approved" },
      },
      officeId: input.officeId,
      status: "pending",
      runAfter: new Date(),
      maxAttempts: 8,
    })
    .returning({ id: jobQueue.id });
  return { jobId: Number(jobRows[0]?.id) };
}

/**
 * Enqueue the vote-outcome notification job (fires on a DECIDED round). approve -> rep GO email; reject -> rep +
 * Takashi/Adam escalation (the /rfp-review link) — the app-driven no-go escalation, since migration 0148's trigger
 * stays inert for a null-request-id voting decline. Mirrors enqueueRfpVoteInvitation. tenantSchema is resolved by
 * the caller (castRfpVote already resolves it for the decline path) so the worker handler can look up the office.
 */
export async function enqueueRfpVoteOutcome(input: {
  tenantDb: TenantDb;
  officeId: string | null;
  tenantSchema: string;
  deal: typeof deals.$inferSelect;
  outcome: "approved" | "rejected";
  approvals: number;
  rejections: number;
}): Promise<{ jobId: number }> {
  const jobRows = await input.tenantDb
    .insert(jobQueue)
    .values({
      jobType: "rfp_vote_outcome",
      payload: {
        tenantSchema: input.tenantSchema,
        dealId: input.deal.id,
        dealName: input.deal.name ?? null,
        dealNumber: input.deal.dealNumber ?? null,
        requestedByUserId: input.deal.rfpApprovalRequestedBy ?? null,
        outcome: input.outcome,
        approvals: input.approvals,
        rejections: input.rejections,
      },
      officeId: input.officeId,
      status: "pending",
      runAfter: new Date(),
      maxAttempts: 5,
    })
    .returning({ id: jobQueue.id });
  return { jobId: Number(jobRows[0]?.id) };
}
```

- [ ] **Step 5: Make `applyRfpDeclineToDeal` accept a null request id.** In `rfp-decline-service.ts`, change the `rfpApprovalRequestId` field type on the input to `number | null`, and change the UPDATE's `AND rfp_approval_request_id = $4` to `AND rfp_approval_request_id IS NOT DISTINCT FROM $4`:

```ts
export async function applyRfpDeclineToDeal(input: {
  client: PoolClient;
  schemaName: string;
  deal: RfpDeclineDealSnapshot;
  sourceDealId: string;
  rfpApprovalRequestId: number | null;
  denialReason: string | null;
  declinedAt: string;
  changedByUserId: string;
}): Promise<{ applied: boolean; declinedDeal: RfpDeclineDealSnapshot | null }> {
  const declineUpdate = await input.client.query(
    `UPDATE ${quoteIdent(input.schemaName)}.deals
        SET rfp_approval_status = 'declined',
            rfp_declined_reason = $1,
            rfp_declined_at = $2::timestamptz,
            updated_at = NOW()
      WHERE id = $3
        AND rfp_approval_request_id IS NOT DISTINCT FROM $4
        AND rfp_approval_status IN ('pending_outbox', 'pending')
      RETURNING id, name, deal_number, project_number,
                rfp_approval_status, rfp_declined_reason, rfp_declined_at`,
    [input.denialReason, input.declinedAt, input.sourceDealId, input.rfpApprovalRequestId]
  );
```

(The rest of `applyRfpDeclineToDeal` — the `deal_history` insert and `logActivityWithPgClient` — is unchanged;
its `metadata: { rfpApprovalRequestId }` tolerates null.)

- [ ] **Step 6: Create `server/src/modules/deals/rfp-vote-service.ts`** (the whole file):

```ts
import { randomUUID } from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { deals, rfpVotes } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import {
  computeRfpVoteState,
  type RfpVoteOutcome,
  type RfpVoteRecord,
} from "@trock-crm/shared/lib/rfpVoteState";
import { AppError } from "../../middleware/error-handler.js";
import { resolveProjectTypeCode } from "../../services/projectNumber.js";
import { applyRfpDeclineToDeal } from "./rfp-decline-service.js";
import { enqueueRfpBidBoardCreate, enqueueRfpVoteInvitation, enqueueRfpVoteOutcome } from "./rfp-enqueue.js";

type TenantDb = NodePgDatabase<typeof schema>;
type DealRow = typeof deals.$inferSelect;

// v1 is a fixed global trio (Sidney, Tim, James); the decline summary reads "(N of 3)".
const RFP_VOTER_COUNT = 3;

export interface CastRfpVoteDeps {
  applyDecline?: typeof applyRfpDeclineToDeal;
  enqueueBidBoardCreate?: typeof enqueueRfpBidBoardCreate;
  enqueueOutcome?: typeof enqueueRfpVoteOutcome;
  now?: () => Date;
}

/** Service / type-4 == project-type code '4'. Voting applies ONLY to non-service deals. */
export function isServiceRfp(deal: { projectType?: string | null; workflowRoute?: "normal" | "service" | null }): boolean {
  return (
    resolveProjectTypeCode({
      projectType: deal.projectType,
      workflowRoute: deal.workflowRoute ?? "normal",
    }) === "4"
  );
}

/**
 * Open a non-service RFP vote round. Guarded conditional UPDATE (same reserve style as trigger-rfp) stamps
 * rfp_approval_requested_at + a fresh rfp_approval_request_event_id (the round key) + requested_by +
 * rfp_approval_status='pending', then enqueues the three-voter invitation email. Does NOT call SyncHub.
 */
export async function openRfpVoteRound(args: {
  tenantDb: TenantDb;
  officeId: string | null;
  deal: DealRow;
  requestedByUserId: string;
}): Promise<void> {
  const eventId = randomUUID();
  const requestedAt = new Date();
  const [reserved] = await args.tenantDb
    .update(deals)
    .set({
      rfpApprovalRequestedAt: requestedAt,
      rfpApprovalRequestEventId: eventId,
      rfpApprovalRequestedBy: args.requestedByUserId,
      rfpApprovalStatus: "pending",
    })
    .where(
      and(
        eq(deals.id, args.deal.id),
        eq(deals.stageId, args.deal.stageId),
        isNull(deals.rfpApprovalStatus),
        isNull(deals.rfpApprovalRequestedAt),
        eq(deals.isBidBoardOwned, false),
        or(isNull(deals.bidBoardStageSlug), eq(deals.bidBoardStageSlug, ""))!,
        eq(deals.isReadOnlyMirror, false),
        isNull(deals.readOnlySyncedAt),
        isNull(deals.bidBoardStageEnteredAt),
        isNull(deals.bidBoardMirrorSourceEnteredAt),
      ),
    )
    .returning();

  if (!reserved) {
    throw new AppError(409, "RFP review has already been triggered for this deal.", "RFP_ALREADY_TRIGGERED");
  }

  await enqueueRfpVoteInvitation({ tenantDb: args.tenantDb, deal: reserved, officeId: args.officeId });
}

/** "Rejected by vote (2 of 3). <email>: <reason>; ..." — aggregated from the reject votes. */
export function buildRfpVoteDeclineReason(votes: RfpVoteRecord[]): string {
  const rejects = votes.filter((v) => v.decision === "reject");
  const detail = rejects
    .map((v) => `${v.voterEmail}: ${(v.reason ?? "").trim() || "No reason provided"}`)
    .join("; ");
  return `Rejected by vote (${rejects.length} of ${RFP_VOTER_COUNT}). ${detail}`;
}

/**
 * Cast one vote inside the atomic tally. FOR UPDATE serializes concurrent votes on the deal; the vote is
 * inserted (unique-violation -> 409); the round is recounted before + after; and the outcome fires exactly
 * once — only when THIS vote crossed pending -> decided (approve keeps status 'pending', so the transition,
 * not a status change, is the idempotency signal). approve -> enqueue rfp_bidboard_create; reject ->
 * applyRfpDeclineToDeal with the aggregated reason.
 */
export async function castRfpVote(
  args: {
    tenantDb: TenantDb;
    officeId: string | null;
    deal: DealRow;
    voter: { userId: string; email: string };
    decision: "approve" | "reject";
    reason: string | null;
  },
  deps: CastRfpVoteDeps = {},
): Promise<{ outcome: RfpVoteOutcome; votes: RfpVoteRecord[] }> {
  const applyDecline = deps.applyDecline ?? applyRfpDeclineToDeal;
  const enqueueCreate = deps.enqueueBidBoardCreate ?? enqueueRfpBidBoardCreate;
  const enqueueOutcome = deps.enqueueOutcome ?? enqueueRfpVoteOutcome;
  const now = deps.now ?? (() => new Date());

  const roundEventId = args.deal.rfpApprovalRequestEventId;
  if (!roundEventId) {
    throw new AppError(409, "This deal is not in an open RFP vote round.", "RFP_NO_VOTE_ROUND");
  }

  // Serialize concurrent votes on this deal so the pending->decided transition below is race-free.
  await args.tenantDb.execute(sql`SELECT id FROM deals WHERE id = ${args.deal.id} FOR UPDATE`);

  const priorState = computeRfpVoteState(await loadRoundVotes(args.tenantDb, args.deal.id, roundEventId));

  try {
    await args.tenantDb.insert(rfpVotes).values({
      dealId: args.deal.id,
      roundEventId,
      voterUserId: args.voter.userId,
      voterEmail: args.voter.email,
      decision: args.decision,
      reason: args.decision === "reject" ? args.reason : null,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(409, "You have already voted on this RFP.", "RFP_ALREADY_VOTED");
    }
    throw err;
  }

  const votes = await loadRoundVotes(args.tenantDb, args.deal.id, roundEventId);
  const state = computeRfpVoteState(votes);

  if (priorState.outcome === "pending" && state.outcome !== "pending") {
    // Resolve the office schema once — needed for both the decline write and the outcome-email enqueue.
    const schemaName = await resolveOfficeSchemaName(args.tenantDb, args.officeId);
    if (state.outcome === "approved") {
      await enqueueCreate({ tenantDb: args.tenantDb, deal: args.deal, officeId: args.officeId });
    } else {
      const client = (args.tenantDb as unknown as { $client: PoolClient }).$client;
      await applyDecline({
        client,
        schemaName,
        deal: {
          id: args.deal.id,
          name: args.deal.name,
          deal_number: args.deal.dealNumber,
          project_number: args.deal.projectNumber,
          rfp_approval_status: args.deal.rfpApprovalStatus,
        },
        sourceDealId: args.deal.id,
        rfpApprovalRequestId: args.deal.rfpApprovalRequestId ?? null,
        denialReason: buildRfpVoteDeclineReason(votes),
        declinedAt: now().toISOString(),
        changedByUserId: args.voter.userId,
      });
    }
    // App-driven outcome notification (GO: rep; NO-GO: rep + Takashi/Adam via /rfp-review) — Task 19 handler.
    // The 0148 trigger stays inert for null-request-id voting declines, so this is the only escalation path.
    await enqueueOutcome({
      tenantDb: args.tenantDb,
      officeId: args.officeId,
      tenantSchema: schemaName,
      deal: args.deal,
      outcome: state.outcome,
      approvals: state.approvals,
      rejections: state.rejections,
    });
  }

  return { outcome: state.outcome, votes };
}

async function loadRoundVotes(tenantDb: TenantDb, dealId: string, roundEventId: string): Promise<RfpVoteRecord[]> {
  const rows = await tenantDb
    .select({
      voterUserId: rfpVotes.voterUserId,
      voterEmail: rfpVotes.voterEmail,
      decision: rfpVotes.decision,
      reason: rfpVotes.reason,
      createdAt: rfpVotes.createdAt,
    })
    .from(rfpVotes)
    .where(and(eq(rfpVotes.dealId, dealId), eq(rfpVotes.roundEventId, roundEventId)))
    .orderBy(rfpVotes.createdAt);
  return rows.map((r) => ({
    voterUserId: r.voterUserId,
    voterEmail: r.voterEmail,
    decision: r.decision as "approve" | "reject",
    reason: r.reason,
    createdAt: r.createdAt,
  }));
}

async function resolveOfficeSchemaName(tenantDb: TenantDb, officeId: string | null): Promise<string> {
  if (!officeId) {
    throw new AppError(500, "Cannot resolve the office schema for the RFP decline (missing officeId).");
  }
  const res: any = await tenantDb.execute(sql`SELECT slug FROM public.offices WHERE id = ${officeId} LIMIT 1`);
  const rows = Array.isArray(res) ? res : res.rows ?? [];
  const slug = rows[0]?.slug;
  if (typeof slug !== "string" || !/^[a-z][a-z0-9_]*$/.test(slug)) {
    throw new AppError(500, `Unable to resolve office schema for officeId=${officeId}`);
  }
  return `office_${slug}`;
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code === "23505") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /duplicate key value|unique constraint|rfp_votes_deal_round_voter_uq/i.test(msg);
}
```

- [ ] **Step 7: Run the test — expect PASS.** `(cd server && npx vitest run tests/modules/deals/rfp-vote-service.runtime.test.ts)` → all `isServiceRfp` / `buildRfpVoteDeclineReason` / `castRfpVote` / `openRfpVoteRound` cases green.

- [ ] **Step 8: Commit.**

```
git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting add server/src/modules/deals/rfp-vote-service.ts server/src/modules/deals/rfp-enqueue.ts server/src/modules/deals/rfp-payload.ts server/src/modules/deals/rfp-decline-service.ts server/tests/modules/deals/rfp-vote-service.runtime.test.ts
git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting commit -m "feat(rfp-voting): vote engine (castRfpVote atomic tally, openRfpVoteRound, decline aggregation) + enqueue helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `trigger-rfp` branch behind `isRfpVotingEnabled` — service/type-4 unchanged, non-service opens a round

**Files:**
- Modify: `server/src/config/feature-flags.ts` (add `isRfpVotingEnabled`)
- Modify: `server/src/modules/deals/routes.ts` (import `isServiceRfp` + `openRfpVoteRound` + `isRfpVotingEnabled`; branch inside `POST /:id/trigger-rfp`, dossier lines 1258-1319: the reserve UPDATE + `insertOpportunityRfpRequestJob` + domain event)
- Test: `server/tests/modules/deals/trigger-rfp-vote-branch.runtime.test.ts`

**Design note:** the branch decision happens **after** all existing guards (auth, stage, ownership,
readiness) pass. `isServiceRfp(deal)` → the existing SyncHub path (reserve `pending_outbox` +
`insertOpportunityRfpRequestJob` + `DEAL_OPPORTUNITY_ENTERED` domain event) is 100% unchanged. Otherwise, if
`isRfpVotingEnabled()`, call `openRfpVoteRound` (its own reserve + invitation enqueue) and return; the
`DEAL_OPPORTUNITY_ENTERED` domain event and the SyncHub delivery job are intentionally NOT emitted for the
voting branch (spec §5.1 lists only: keep reserve stamps, no SyncHub, send invitations). When the flag is
OFF, non-service deals fall through to the existing SyncHub path (feature ships inert).

- [ ] **Step 1: Write the failing branch test.** Create `server/tests/modules/deals/trigger-rfp-vote-branch.runtime.test.ts`. Since the full `trigger-rfp` route pulls in the whole deals router, this test targets the **branch decision** directly by asserting the two service helpers route correctly against a PGlite deal (mirrors the reserve). Import the engine + a small branch predicate:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { isServiceRfp, openRfpVoteRound } from "../../../src/modules/deals/rfp-vote-service.js";
import { isRfpVotingEnabled } from "../../../src/config/feature-flags.js";

const DEAL = "00000000-0000-0000-0000-0000000000d1";

let pg: PGlite | null = null;
afterEach(async () => { await pg?.close(); pg = null; });

async function setup() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.job_queue (id bigserial PRIMARY KEY, job_type text NOT NULL, payload jsonb NOT NULL, office_id uuid, status text NOT NULL, max_attempts integer NOT NULL DEFAULT 3, run_after timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text NOT NULL, deal_number text NOT NULL, project_number text, stage_id uuid,
      project_type text, workflow_route text NOT NULL DEFAULT 'normal', is_bid_board_owned boolean NOT NULL DEFAULT false,
      bid_board_stage_slug text, is_read_only_mirror boolean NOT NULL DEFAULT false, read_only_synced_at timestamptz,
      bid_board_stage_entered_at timestamptz, bid_board_mirror_source_entered_at timestamptz, rfp_approval_status text,
      rfp_approval_requested_at timestamptz, rfp_approval_request_event_id uuid, rfp_approval_requested_by uuid,
      rfp_approval_request_id integer, updated_at timestamptz
    );
  `);
  await db.query(`INSERT INTO deals (id, name, deal_number, stage_id, workflow_route) VALUES ($1, 'd', 'TR-1', '00000000-0000-0000-0000-0000000000aa', 'normal')`, [DEAL]);
  return db;
}

function dealRow(overrides: Record<string, unknown> = {}) {
  return { id: DEAL, name: "d", dealNumber: "TR-1", projectNumber: null, stageId: "00000000-0000-0000-0000-0000000000aa", workflowRoute: "normal", projectType: null, rfpApprovalStatus: null, rfpApprovalRequestEventId: null, ...overrides } as any;
}

describe("trigger-rfp voting branch", () => {
  it("isRfpVotingEnabled reads ENABLE_RFP_VOTING", () => {
    expect(isRfpVotingEnabled({ ENABLE_RFP_VOTING: "true" } as any)).toBe(true);
    expect(isRfpVotingEnabled({} as any)).toBe(false);
  });

  it("service deal is NOT routed to voting", () => {
    expect(isServiceRfp(dealRow({ workflowRoute: "service" }))).toBe(true);
  });

  it("non-service deal opens a round (status pending + invitation job, no SyncHub delivery job)", async () => {
    pg = await setup();
    const tdb: any = drizzle(pg as any);
    await openRfpVoteRound({ tenantDb: tdb, officeId: null, deal: dealRow(), requestedByUserId: "00000000-0000-0000-0000-000000000001" });
    const deal = (await pg.query(`SELECT rfp_approval_status FROM deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(deal[0].rfp_approval_status).toBe("pending");
    const jobs = (await pg.query(`SELECT job_type FROM public.job_queue`)).rows as any[];
    expect(jobs.map((j) => j.job_type)).toEqual(["rfp_vote_invitation"]);
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL.** `(cd server && npx vitest run tests/modules/deals/trigger-rfp-vote-branch.runtime.test.ts)` → FAIL: `isRfpVotingEnabled` is not exported from feature-flags.

- [ ] **Step 3: Add `isRfpVotingEnabled` to `feature-flags.ts`** (mirror `isOpportunityRfpEventEnabled`):

```ts
/**
 * Gates the non-service RFP three-voter branch of POST /:id/trigger-rfp. OFF (default) = non-service deals
 * keep the existing single-approver SyncHub email path, so the voting feature ships inert until flipped.
 * Service / type-4 deals ignore this flag (always SyncHub email path).
 */
export function isRfpVotingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ENABLE_RFP_VOTING === "true";
}
```

- [ ] **Step 4: Run the flag test — expect PASS (branch tests already pass via the engine).** `(cd server && npx vitest run tests/modules/deals/trigger-rfp-vote-branch.runtime.test.ts)` → green.

- [ ] **Step 5: Wire the branch into `POST /:id/trigger-rfp`.** In `routes.ts`, extend the rbac import (dossier line 5) and the vote-service imports:

```ts
import { isOpportunityRfpEventEnabled, isRfpVotingEnabled } from "../../config/feature-flags.js";
import { isServiceRfp, openRfpVoteRound } from "./rfp-vote-service.js";
```

Then, inside the handler, **replace the reserve block** (dossier lines 1258-1319: from `const officeId = ...` through the `res.json(...)` that returns after the domain event) with a service/non-service branch. The existing SyncHub path stays byte-for-byte; only the non-service voting branch is added ahead of it:

```ts
    const officeId = req.user!.activeOfficeId ?? req.user!.officeId ?? null;

    // Non-service deals with voting ENABLED open a three-voter round instead of the SyncHub email path.
    // Service / type-4 (and voting-disabled) deals fall through to the unchanged SyncHub delivery below.
    if (!isServiceRfp(deal) && isRfpVotingEnabled()) {
      await openRfpVoteRound({
        tenantDb: req.tenantDb!,
        officeId,
        deal,
        requestedByUserId: userId,
      });
      const [voted] = await req.tenantDb!
        .select({ status: deals.rfpApprovalStatus, eventId: deals.rfpApprovalRequestEventId })
        .from(deals)
        .where(eq(deals.id, deal.id))
        .limit(1);
      await req.commitTransaction!();
      res.json(toJsonSafe({
        success: true,
        mode: "vote",
        status: voted?.status ?? "pending",
        eventId: voted?.eventId ?? null,
      }));
      return;
    }

    const requestedAt = new Date();
    const eventId = randomUUID();
    const updateConditions = [
```

(Everything from `const updateConditions = [` onward — the existing reserve UPDATE, `insertOpportunityRfpRequestJob`, `queueDomainEvent`, `emitLocalDealEvents`, and the final `res.json({ success, status, eventId, jobId })` — is unchanged.)

- [ ] **Step 6: Run the branch test — expect PASS.** `(cd server && npx vitest run tests/modules/deals/trigger-rfp-vote-branch.runtime.test.ts)` → green.

- [ ] **Step 7: Commit.**

```
git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting add server/src/config/feature-flags.ts server/src/modules/deals/routes.ts server/tests/modules/deals/trigger-rfp-vote-branch.runtime.test.ts
git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting commit -m "feat(rfp-voting): trigger-rfp opens a vote round for non-service deals behind isRfpVotingEnabled

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: `POST /api/deals/:id/rfp-vote` route behind `requireRfpVoter`

**Files:**
- Modify: `server/src/modules/deals/routes.ts` (import `requireRfpVoter` from rbac; import `castRfpVote`; register the route next to the `/:id/rfp-review` block, dossier lines 1550-1595)
- Test: `server/tests/modules/deals/rfp-vote-route.runtime.test.ts`

**Design note:** authz (403 for non-voters) is fully handled by `requireRfpVoter` (Section A). The route
validates the body (`reject` requires a non-empty `reason` → 400 `RFP_VOTE_REASON_REQUIRED`; `approve`
ignores `reason`), loads the deal, rejects service deals + deals not in an open round, then delegates to
`castRfpVote`. The route mounts the vote write on `req.tenantDb` (same transaction as `castRfpVote`'s
`$client`), committed by `req.commitTransaction`. The route test drives the handler via a minimal Express app
wired to a PGlite-backed tenant db, so the middleware stack (`requireRfpVoter`) and validation are real.

- [ ] **Step 1: Write the failing route test.** Create `server/tests/modules/deals/rfp-vote-route.runtime.test.ts`. It builds an Express app that mounts just the route with a fake `req.user` + a PGlite `req.tenantDb`/`req.commitTransaction`, and the real `requireRfpVoter`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq, sql } from "drizzle-orm";
import { deals, rfpVotes } from "@trock-crm/shared/schema";
import { requireRfpVoter } from "../../../src/middleware/rbac.js";
import { castRfpVote, isServiceRfp } from "../../../src/modules/deals/rfp-vote-service.js";
import { AppError } from "../../../src/middleware/error-handler.js";

const DEAL = "00000000-0000-0000-0000-0000000000d1";
const VOTER = { id: "00000000-0000-0000-0000-000000000001", email: "sidney@x.com" };
const NON_VOTER = { id: "00000000-0000-0000-0000-000000000009", email: "nobody@x.com" };
const ROUND = "00000000-0000-0000-0000-0000000000e1";

// Two designated voters so a second distinct voter can be simulated in one round.
const ENV = { RFP_VOTER_EMAILS: "sidney@x.com,james@x.com,tim@x.com", NODE_ENV: "test" } as any;

let pg: PGlite | null = null;
afterEach(async () => { await pg?.close(); pg = null; process.env.RFP_VOTER_EMAILS = undefined as any; });

async function setup() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.job_queue (id bigserial PRIMARY KEY, job_type text NOT NULL, payload jsonb NOT NULL, office_id uuid, status text NOT NULL, max_attempts integer NOT NULL DEFAULT 3, run_after timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.offices (id uuid PRIMARY KEY, slug text NOT NULL, is_active boolean NOT NULL DEFAULT true);
    INSERT INTO public.offices (id, slug) VALUES ('00000000-0000-0000-0000-0000000000ff', 'test');
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text NOT NULL, deal_number text NOT NULL, project_number text, stage_id uuid,
      project_type text, workflow_route text NOT NULL DEFAULT 'normal', is_bid_board_owned boolean NOT NULL DEFAULT false,
      bid_board_stage_slug text, is_read_only_mirror boolean NOT NULL DEFAULT false, read_only_synced_at timestamptz,
      bid_board_stage_entered_at timestamptz, bid_board_mirror_source_entered_at timestamptz, rfp_approval_status text,
      rfp_approval_requested_at timestamptz, rfp_approval_request_event_id uuid, rfp_approval_requested_by uuid,
      rfp_approval_request_id integer, rfp_declined_reason text, rfp_declined_at timestamptz, updated_at timestamptz
    );
    CREATE TABLE rfp_votes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid NOT NULL, round_event_id uuid NOT NULL, voter_user_id uuid, voter_email text NOT NULL, decision text NOT NULL, reason text, created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT rfp_votes_deal_round_voter_uq UNIQUE (deal_id, round_event_id, voter_user_id));
  `);
  await db.query(`INSERT INTO deals (id, name, deal_number, stage_id, workflow_route, rfp_approval_status, rfp_approval_request_event_id) VALUES ($1, 'd', 'TR-1', '00000000-0000-0000-0000-0000000000aa', 'normal', 'pending', $2)`, [DEAL, ROUND]);
  return db;
}

// Mirror of the production route body (same handler code) so the test exercises validation + middleware.
function buildApp(pgDb: PGlite, user: { id: string; email: string }) {
  const app = express();
  app.use(express.json());
  Object.assign(process.env, ENV);
  app.use((req: any, _res, next) => {
    req.user = { ...user, role: "rep", activeOfficeId: "00000000-0000-0000-0000-0000000000ff", officeId: "00000000-0000-0000-0000-0000000000ff" };
    req.tenantDb = drizzle(pgDb as any);
    req.commitTransaction = async () => {};
    next();
  });
  app.post("/deals/:id/rfp-vote", requireRfpVoter, async (req: any, res, next) => {
    try {
      const decision = req.body?.decision;
      if (decision !== "approve" && decision !== "reject") throw new AppError(400, "decision must be 'approve' or 'reject'.", "RFP_VOTE_DECISION_INVALID");
      const rawReason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      if (decision === "reject" && rawReason.length === 0) throw new AppError(400, "A reason is required to reject an RFP.", "RFP_VOTE_REASON_REQUIRED");
      const [deal] = await req.tenantDb.select().from(deals).where(eq(deals.id, req.params.id)).limit(1);
      if (!deal) throw new AppError(404, "Deal not found");
      if (isServiceRfp(deal)) throw new AppError(409, "Service RFPs are not decided by vote.", "RFP_VOTE_NOT_APPLICABLE");
      if (!deal.rfpApprovalRequestEventId || deal.rfpApprovalStatus !== "pending") throw new AppError(409, "This deal is not in an open RFP vote round.", "RFP_NO_VOTE_ROUND");
      const officeId = req.user.activeOfficeId ?? req.user.officeId ?? null;
      const result = await castRfpVote({ tenantDb: req.tenantDb, officeId, deal, voter: { userId: req.user.id, email: req.user.email }, decision, reason: decision === "reject" ? rawReason : null });
      await req.commitTransaction();
      res.json({ success: true, outcome: result.outcome, votes: result.votes });
    } catch (err) { next(err); }
  });
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ error: err.message, code: err.code }));
  return app;
}

describe("POST /deals/:id/rfp-vote", () => {
  it("403 for a non-voter", async () => {
    pg = await setup();
    const res = await request(buildApp(pg, NON_VOTER)).post(`/deals/${DEAL}/rfp-vote`).send({ decision: "approve" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("RFP_VOTER_ONLY");
  });

  it("400 when rejecting without a reason", async () => {
    pg = await setup();
    const res = await request(buildApp(pg, VOTER)).post(`/deals/${DEAL}/rfp-vote`).send({ decision: "reject" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("RFP_VOTE_REASON_REQUIRED");
  });

  it("happy-path approve records a pending vote", async () => {
    pg = await setup();
    const res = await request(buildApp(pg, VOTER)).post(`/deals/${DEAL}/rfp-vote`).send({ decision: "approve" });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("pending");
    const votes = (await pg.query(`SELECT decision FROM rfp_votes WHERE deal_id=$1`, [DEAL])).rows as any[];
    expect(votes).toHaveLength(1);
    expect(votes[0].decision).toBe("approve");
  });

  it("409 when the same voter votes twice (locked on cast)", async () => {
    pg = await setup();
    const app = buildApp(pg, VOTER);
    await request(app).post(`/deals/${DEAL}/rfp-vote`).send({ decision: "approve" });
    const res = await request(app).post(`/deals/${DEAL}/rfp-vote`).send({ decision: "reject", reason: "changed my mind" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("RFP_ALREADY_VOTED");
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL.** `(cd server && npx vitest run tests/modules/deals/rfp-vote-route.runtime.test.ts)` → FAIL: `requireRfpVoter` is not exported (Section A) OR the assertions fail until the production route exists. (If `requireRfpVoter` already landed in Section A, the four cases pass against the test's mirrored handler; Step 3 then wires the identical handler into the real router.)

- [ ] **Step 3: Register the production route in `routes.ts`.** Extend the rbac import (dossier line 5) to `import { requireRole, requireRfpReviewer, requireRfpVoter } from "../../middleware/rbac.js";` and add `castRfpVote` to the `./rfp-vote-service.js` import from Task 8. Register the route immediately after the `/:id/rfp-review` GET (dossier ~line 1560):

```ts
// POST /api/deals/:id/rfp-vote — cast a three-voter RFP vote (Sidney / Tim / James). requireRfpVoter gates
// to the RFP_VOTER_EMAILS allowlist; 2-of-3 decides. Reject requires a reason; approve ignores it.
router.post("/:id/rfp-vote", requireRfpVoter, async (req, res, next) => {
  try {
    const decision = req.body?.decision;
    if (decision !== "approve" && decision !== "reject") {
      throw new AppError(400, "decision must be 'approve' or 'reject'.", "RFP_VOTE_DECISION_INVALID");
    }
    const rawReason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (decision === "reject" && rawReason.length === 0) {
      throw new AppError(400, "A reason is required to reject an RFP.", "RFP_VOTE_REASON_REQUIRED");
    }
    const deal = await loadTriggerRfpDeal(req.tenantDb!, req.params.id);
    if (!deal) throw new AppError(404, "Deal not found");
    if (isServiceRfp(deal)) {
      throw new AppError(409, "Service RFPs are not decided by vote.", "RFP_VOTE_NOT_APPLICABLE");
    }
    if (!deal.rfpApprovalRequestEventId || deal.rfpApprovalStatus !== "pending") {
      throw new AppError(409, "This deal is not in an open RFP vote round.", "RFP_NO_VOTE_ROUND");
    }
    const officeId = req.user!.activeOfficeId ?? req.user!.officeId ?? null;
    const result = await castRfpVote({
      tenantDb: req.tenantDb!,
      officeId,
      deal,
      voter: { userId: req.user!.id, email: req.user!.email },
      decision,
      reason: decision === "reject" ? rawReason : null,
    });
    await req.commitTransaction!();
    res.json(toJsonSafe({ success: true, outcome: result.outcome, votes: result.votes }));
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 4: Run the test — expect PASS.** `(cd server && npx vitest run tests/modules/deals/rfp-vote-route.runtime.test.ts)` → 403 / 400 / approve / 409 all green.

- [ ] **Step 5: Commit.**

```
git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting add server/src/modules/deals/routes.ts server/tests/modules/deals/rfp-vote-route.runtime.test.ts
git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting commit -m "feat(rfp-voting): POST /deals/:id/rfp-vote route (requireRfpVoter, reject-needs-reason, locked-on-cast)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: `rfp_vote_invitation` worker job (email the three voters) + register

**Files:**
- Create: `worker/src/jobs/rfp-vote-invitation.ts`
- Modify: `worker/src/jobs/index.ts` (import + `registerJobHandler`, alongside the RFP block dossier lines 1190-1210)
- Test: `worker/tests/jobs/rfp-vote-invitation.runtime.test.ts`

**Design note:** the server-side `enqueueRfpVoteInvitation` (Task 7) inserts the `rfp_vote_invitation`
`job_queue` row with `payload: { dealId, dealNumber, dealName, officeId }` and `officeId` on the row. This
worker handler mirrors `rfp-rejection-email.ts` (branded template, `resolveFrontendUrl`,
`sendSystemEmailWithMetadata`) but emails the `resolveRfpVoterEmails()` trio a `/rfp-vote/:dealId` link. It
fails loudly (throw → retry → dead-letter) when `RFP_VOTER_EMAILS` is unset, matching the rejection job's
fail-closed contract.

- [ ] **Step 1: Write the failing worker test.** Create `worker/tests/jobs/rfp-vote-invitation.runtime.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { handleRfpVoteInvitation, buildRfpVoteInvitationEmail } from "../../src/jobs/rfp-vote-invitation.js";

const ENV = {
  RFP_VOTER_EMAILS: "sidney@x.com,tim@x.com,james@x.com",
  NODE_ENV: "test",
  APP_BASE_URL: "https://trockcrm.com",
} as any;

describe("handleRfpVoteInvitation", () => {
  it("emails the three configured voters with a /rfp-vote/:dealId link", async () => {
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m1" }));
    await handleRfpVoteInvitation(
      { dealId: "deal-1", dealNumber: "TR-1001", dealName: "jasonn ranches", officeId: "office-9" },
      "office-9",
      { sendEmail, env: ENV, logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } },
    );
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [recipients, subject, html] = sendEmail.mock.calls[0];
    expect(recipients).toEqual(["sidney@x.com", "tim@x.com", "james@x.com"]);
    expect(subject).toContain("TR-1001");
    expect(html).toContain("/rfp-vote/deal-1");
    expect(html).toContain("officeId=office-9");
  });

  it("throws (fails loudly) when RFP_VOTER_EMAILS is unset in prod", async () => {
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m1" }));
    await expect(
      handleRfpVoteInvitation(
        { dealId: "deal-1" },
        "office-9",
        { sendEmail, env: { NODE_ENV: "production" } as any, logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } },
      ),
    ).rejects.toThrow(/RFP_VOTER_EMAILS/);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("buildRfpVoteInvitationEmail links with the office param and the caption '2 of 3'", () => {
    const email = buildRfpVoteInvitationEmail({ dealId: "deal-1", dealName: "d", dealNumber: null, officeId: "office-9", frontendUrl: "https://trockcrm.com/" });
    expect(email.html).toContain("https://trockcrm.com/rfp-vote/deal-1?officeId=office-9");
    expect(email.text).toContain("Two of three");
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL.** `(cd worker && npx vitest run tests/jobs/rfp-vote-invitation.runtime.test.ts)` → FAIL: module not found.

- [ ] **Step 3: Create `worker/src/jobs/rfp-vote-invitation.ts`** (whole file):

```ts
import { sendSystemEmailWithMetadata, type SendSystemEmailResult } from "../lib/system-email.js";
import { resolveFrontendUrl, TROCK_LOGO_EMAIL_URL } from "./project-number-email.js";
import { resolveRfpVoterEmails } from "@trock-crm/shared/lib/rfpVoterEmails";
import { escapeHtml, normalizeText } from "../lib/email-format.js";

export const RFP_VOTE_INVITATION_JOB = "rfp_vote_invitation";

interface RfpVoteInvitationPayload {
  dealId?: string;
  dealNumber?: string | null;
  dealName?: string | null;
  officeId?: string | null;
}

interface HandlerDeps {
  sendEmail?: (
    to: string | string[],
    subject: string,
    html: string,
    options: { text: string; idempotencyKey: string }
  ) => Promise<SendSystemEmailResult>;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

/**
 * Email the three designated RFP voters (RFP_VOTER_EMAILS = Sidney/Tim/James) a focused /rfp-vote/:dealId
 * link when a non-service RFP vote round opens. Enqueued by openRfpVoteRound -> enqueueRfpVoteInvitation.
 * Fails loudly (throw -> retry -> dead-letter) if RFP_VOTER_EMAILS is unset, mirroring rfp-rejection-email.
 */
export async function handleRfpVoteInvitation(
  payload: RfpVoteInvitationPayload,
  _officeId: string | null,
  deps: HandlerDeps = {},
): Promise<void> {
  const logger = deps.logger ?? console;
  const env = deps.env ?? process.env;
  const dealId = normalizeText(payload.dealId);
  if (!dealId) {
    logger.warn("[RfpVoteInvitation] Invalid job payload (missing dealId) - skipping");
    return;
  }

  const recipients = resolveRfpVoterEmails(env);
  if (recipients.length === 0) {
    const error = new Error("RFP_VOTER_EMAILS is not configured");
    logger.error(
      "[RfpVoteInvitation] RFP_VOTER_EMAILS is not set - cannot send vote invitations. Set it (comma-separated) on the worker service; the job retries then dead-letters.",
      { dealId },
    );
    throw error;
  }

  const officeId = normalizeText(payload.officeId);
  const email = buildRfpVoteInvitationEmail({
    dealId,
    dealName: normalizeText(payload.dealName) ?? "Deal",
    dealNumber: normalizeText(payload.dealNumber),
    officeId,
    frontendUrl: resolveFrontendUrl(env),
  });

  const sendEmail = deps.sendEmail ?? sendSystemEmailWithMetadata;
  const result = await sendEmail(recipients, email.subject, email.html, {
    text: email.text,
    idempotencyKey: `rfp-vote-invite-${dealId}`,
  });
  if (!result.success) {
    throw new Error("Email provider returned unsuccessful result");
  }
  logger.log("[RfpVoteInvitation] Sent vote invitations", {
    dealId,
    recipientCount: recipients.length,
    messageId: result.messageId,
  });
}

export function buildRfpVoteInvitationEmail(input: {
  dealId: string;
  dealName: string;
  dealNumber: string | null;
  officeId?: string | null;
  frontendUrl: string;
}) {
  const officeParam = input.officeId ? `?officeId=${encodeURIComponent(input.officeId)}` : "";
  const baseUrl = input.frontendUrl.replace(/\/+$/, "");
  const voteUrl = `${baseUrl}/rfp-vote/${encodeURIComponent(input.dealId)}${officeParam}`;
  const safeVoteUrl = escapeHtml(voteUrl);

  const subject = input.dealNumber
    ? `RFP vote needed: ${input.dealNumber} (${input.dealName})`
    : `RFP vote needed: ${input.dealName}`;
  const text = `An RFP needs your vote (approve or reject). Two of three votes decide; a reject needs a written reason. Open ${voteUrl} to cast your vote.`;

  const rows = [
    ["Deal name", input.dealName],
    ["Project number", input.dealNumber ?? "Pending"],
  ] as const;
  const htmlRows = rows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#64748b;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;vertical-align:top;width:150px;">${escapeHtml(label)}</td>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#111111;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;vertical-align:top;">${escapeHtml(value)}</td>
        </tr>`,
    )
    .join("");

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>RFP Vote Needed</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid #e2e8f0;">
          <tr><td style="background-color:#CC0000;height:4px;line-height:4px;font-size:4px;mso-line-height-rule:exactly;">&nbsp;</td></tr>
          <tr><td align="center" style="padding:28px 24px 8px 24px;"><img src="${TROCK_LOGO_EMAIL_URL}" alt="T Rock Construction" width="220" height="246" style="display:block;width:220px;height:246px;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" /></td></tr>
          <tr><td align="center" style="padding:4px 24px 0 24px;"><h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:26px;color:#111111;font-weight:bold;">RFP Vote Needed</h1></td></tr>
          <tr><td align="center" style="padding:6px 24px 16px 24px;"><p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#64748b;">You are one of three RFP voters. Approve or reject this RFP — two of three votes decide. A reject requires a written reason.</p></td></tr>
          <tr><td style="padding:0 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-top:1px solid #e2e8f0;">${htmlRows}</table></td></tr>
          <tr><td align="center" style="padding:24px 24px 8px 24px;">
            <!--[if mso]>
            <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safeVoteUrl}" style="height:44px;v-text-anchor:middle;width:240px;" arcsize="9%" stroke="f" fillcolor="#CC0000"><w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">Cast your vote</center></v:roundrect>
            <![endif]-->
            <!--[if !mso]><!-- -->
            <a href="${safeVoteUrl}" style="display:inline-block;background-color:#CC0000;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;line-height:44px;text-align:center;text-decoration:none;width:240px;border-radius:4px;">Cast your vote</a>
            <!--<![endif]-->
          </td></tr>
          <tr><td align="center" style="padding:0 24px 24px 24px;"><p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#94a3b8;">Votes are final once cast. Live progress is shown on the deal.</p></td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html, text, dealNumber: input.dealNumber };
}
```

- [ ] **Step 4: Register the handler in `worker/src/jobs/index.ts`.** Add the import next to the RFP job imports (dossier line 1190) and the registration next to `RFP_REJECTED_JOB` (dossier line 1207):

```ts
import { handleRfpVoteInvitation, RFP_VOTE_INVITATION_JOB } from "./rfp-vote-invitation.js";
```
```ts
  registerJobHandler(RFP_VOTE_INVITATION_JOB, handleRfpVoteInvitation);
```

- [ ] **Step 5: Run the test — expect PASS.** `(cd worker && npx vitest run tests/jobs/rfp-vote-invitation.runtime.test.ts)` → recipients / link / fail-loud all green.

- [ ] **Step 6: Commit.**

```
git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting add worker/src/jobs/rfp-vote-invitation.ts worker/src/jobs/index.ts worker/tests/jobs/rfp-vote-invitation.runtime.test.ts
git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting commit -m "feat(rfp-voting): rfp_vote_invitation worker job emails the three voters a /rfp-vote link

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: `rfp_bidboard_create` worker job (HMAC-POST to SyncHub) + register

**Files:**
- Create: `worker/src/jobs/rfp-bidboard-create.ts`
- Modify: `worker/src/jobs/index.ts` (import + `registerJobHandler`)
- Test: `worker/tests/jobs/rfp-bidboard-create.runtime.test.ts`

**Design note:** the server-side `enqueueRfpBidBoardCreate` (Task 7) built the job payload
`{ dealId, syncHubUrl: <create-from-rfp URL>, body: { ...normalizedBody, decision: "approved" } }`. This
worker handler mirrors `rfp-request-delivery.ts`'s HMAC signing: it signs `JSON.stringify(payload.body)` with
`SYNCHUB_SHARED_SECRET` (the CRM-side name for the shared secret SyncHub verifies as
`RFP_REQUEST_SYNC_SECRET`) and POSTs to `payload.syncHubUrl` with header `x-rfp-request-signature`. SyncHub
returns 202 (create queued); the deal advances later via the `bid-board-created` callback (Task 12/13), so
this handler writes no deal state — it just confirms delivery (2xx) or throws to retry.

- [ ] **Step 1: Write the failing worker test.** Create `worker/tests/jobs/rfp-bidboard-create.runtime.test.ts`:

```ts
import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleRfpBidBoardCreate } from "../../src/jobs/rfp-bidboard-create.js";

const SECRET = "shared-secret";

function makePayload() {
  return {
    dealId: "deal-1",
    syncHubUrl: "https://synchub.example.com/api/bid-board/create-from-rfp",
    body: {
      sourceSystem: "trock_crm",
      sourceDealId: "deal-1",
      sourceEventId: "crm:rfp-vote:approved:round-1",
      deal: { name: "jasonn ranches", projectNumber: "TR-1001", projectType: "9", amount: 100000, workflowRoute: "normal", estimator: null, ownerName: null, ownerEmail: null, companyName: null, contactName: null, clientEmail: null, clientPhone: null, address: null, description: null, dueDate: null },
      attachments: [],
      decision: "approved",
    },
  };
}

describe("handleRfpBidBoardCreate", () => {
  it("HMAC-POSTs the body (with decision:'approved') to the create-from-rfp URL", async () => {
    const captured: any = {};
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      captured.url = url;
      captured.init = init;
      return { status: 202, ok: true, text: async () => "" } as any;
    });
    await handleRfpBidBoardCreate(makePayload(), "office-9", { fetchImpl: fetchImpl as any, secret: SECRET });

    expect(captured.url).toBe("https://synchub.example.com/api/bid-board/create-from-rfp");
    expect(captured.init.method).toBe("POST");
    const sentBody = JSON.parse(captured.init.body);
    expect(sentBody.decision).toBe("approved");
    expect(sentBody.sourceDealId).toBe("deal-1");
    expect(sentBody.deal.projectNumber).toBe("TR-1001");

    const expectedSig = `sha256=${crypto.createHmac("sha256", SECRET).update(captured.init.body).digest("hex")}`;
    expect(captured.init.headers["x-rfp-request-signature"]).toBe(expectedSig);
  });

  it("throws on a non-2xx SyncHub response so the job retries", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 500, ok: false, text: async () => "boom" } as any));
    await expect(
      handleRfpBidBoardCreate(makePayload(), "office-9", { fetchImpl: fetchImpl as any, secret: SECRET }),
    ).rejects.toThrow(/rfp_bidboard_create failed with 500/);
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL.** `(cd worker && npx vitest run tests/jobs/rfp-bidboard-create.runtime.test.ts)` → FAIL: module not found.

- [ ] **Step 3: Create `worker/src/jobs/rfp-bidboard-create.ts`** (whole file):

```ts
import crypto from "node:crypto";
import type { RfpRequestDeliveryPayload } from "@trock-crm/shared/types";

export const RFP_BIDBOARD_CREATE_JOB = "rfp_bidboard_create";

function signBody(rawBody: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function assertPayload(payload: any): asserts payload is RfpRequestDeliveryPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid rfp_bidboard_create payload");
  }
  if (typeof payload.dealId !== "string" || typeof payload.syncHubUrl !== "string") {
    throw new Error("rfp_bidboard_create payload is missing dealId or syncHubUrl");
  }
  if (!payload.body || typeof payload.body !== "object") {
    throw new Error("rfp_bidboard_create payload is missing body");
  }
}

/**
 * GO delivery: HMAC-POST the normalized deal body (+ decision:'approved') to SyncHub's create-from-rfp
 * endpoint. Mirrors rfp-request-delivery.ts's signing (SYNCHUB_SHARED_SECRET == SyncHub's
 * RFP_REQUEST_SYNC_SECRET). Writes no deal state — SyncHub returns 202 and the deal advances later via the
 * bid-board-created callback. A non-2xx throws so the generic queue runner retries (maxAttempts=8).
 */
export async function handleRfpBidBoardCreate(
  payload: unknown,
  _officeId: string | null,
  deps: { fetchImpl?: typeof fetch; secret?: string } = {},
): Promise<void> {
  assertPayload(payload);
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const secret = deps.secret ?? process.env.SYNCHUB_SHARED_SECRET;
  if (!secret) {
    throw new Error("SYNCHUB_SHARED_SECRET is not configured for rfp_bidboard_create delivery");
  }

  const rawBody = JSON.stringify(payload.body);
  let response: Response;
  try {
    response = await fetchImpl(payload.syncHubUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rfp-request-signature": signBody(rawBody, secret),
      },
      body: rawBody,
    });
  } catch (err) {
    throw new Error(`rfp_bidboard_create network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (response.status === 200 || response.status === 201 || response.status === 202) {
    return;
  }
  const text = await response.text().catch(() => "");
  throw new Error(`rfp_bidboard_create failed with ${response.status}: ${text || response.statusText}`);
}
```

- [ ] **Step 4: Register the handler in `worker/src/jobs/index.ts`.** Add the import and registration next to the Task 10 entry:

```ts
import { handleRfpBidBoardCreate, RFP_BIDBOARD_CREATE_JOB } from "./rfp-bidboard-create.js";
```
```ts
  registerJobHandler(RFP_BIDBOARD_CREATE_JOB, handleRfpBidBoardCreate);
```

- [ ] **Step 5: Run the test — expect PASS.** `(cd worker && npx vitest run tests/jobs/rfp-bidboard-create.runtime.test.ts)` → target URL / body / signature / retry all green.

- [ ] **Step 6: Commit.**

```
git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting add worker/src/jobs/rfp-bidboard-create.ts worker/src/jobs/index.ts worker/tests/jobs/rfp-bidboard-create.runtime.test.ts
git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting commit -m "feat(rfp-voting): rfp_bidboard_create worker job HMAC-POSTs the GO create to SyncHub

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 12 (SyncHub): `POST /api/bid-board/create-from-rfp` in `server/routes/rfp-requests.ts`

Repo: `/Users/adnaaniqbal/Developer/trocksynchubv3`.

**Files:**
- Modify: `server/routes/rfp-requests.ts` (add the endpoint + `createBidBoardFromRfpVote` helper inside/next to `registerRfpRequestRoutes`, reusing `jsonWithRawBody` + `verifyRfpRequestSignature` + `rfpRequestBodySchema` + `signRfpRequestPayload`)
- Test: `tests/bid-board-create-from-rfp.test.ts`

**Design notes (load-bearing):**
- Reuse the **same** HMAC path as `/api/rfp-requests`: mount with `jsonWithRawBody` and call
  `verifyRfpRequestSignature(req)` (both module-private in this file — reuse directly by adding the route
  *inside* `registerRfpRequestRoutes`). Verified with `RFP_REQUEST_SYNC_SECRET`.
- Body schema = `rfpRequestBodySchema.extend({ decision: z.literal("approved") })` (the CRM's normalized body
  already carries `sourceDealId` + `sourceEventId` + `deal` + `attachments`).
- Reuse the **`syncMappings` adopt-guard automatically** by calling `createBidBoardProjectFromDeal(...)` (its
  internal guard at `bidboard.ts:2006-2031` adopts an existing project instead of double-creating). No
  eligibility check (open item #2: the CRM already decided by vote). **No vote storage in SyncHub.**
- **Callback delivery is direct, NOT via the outbox.** `bidboard_callback_outbox.rfp_approval_request_id` is
  `NOT NULL` + FK to `rfp_approval_requests.id`, and voting creates NO request row, so the callback cannot go
  through `enqueueBidboardCallback`. Instead POST the `bid-board-created` callback directly to
  `buildBidBoardCreatedCallbackTargetUrl()` with `signRfpRequestPayload` (a small retry loop), carrying
  **no** `rfpApprovalRequestId` (Task 13 relaxes the CRM side to resolve by `sourceDealId`). Durable outbox
  retry for the voting callback is a deliberate v1 simplification.
- Respond **202** immediately; run the Playwright create + callback in `setImmediate` (same shape as the
  existing `override-approve` handler).

- [ ] **Step 1: Write the failing SyncHub test.** Create `tests/bid-board-create-from-rfp.test.ts` (mirrors `tests/rfp-requests-endpoint.test.ts` mocking conventions):

```ts
import crypto from "crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createBidBoardMock = vi.hoisted(() => vi.fn(async () => ({ success: true, projectId: "999" })));
const callbackFetchMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, status: 200, text: async () => "" })));

vi.mock("../server/playwright/bidboard.ts", () => ({
  createBidBoardProjectFromDeal: createBidBoardMock,
}));
vi.mock("../server/sync/bidboard-callback-worker.ts", () => ({
  buildBidBoardCreatedCallbackTargetUrl: () => "https://crm.example.com/api/internal/bid-board-created",
}));
vi.mock("../server/lib/fetch-with-timeout.ts", () => ({
  fetchWithTimeout: callbackFetchMock,
}));
vi.mock("../server/storage.ts", () => ({
  storage: { getAutomationConfig: vi.fn(async () => ({ value: { companyId: "42" } })) },
}));

const SECRET = "rfp-secret";

function requestBody(overrides: Partial<any> = {}) {
  return {
    sourceSystem: "trock_crm",
    sourceDealId: "crm-deal-1",
    sourceEventId: "crm:rfp-vote:approved:round-1",
    decision: "approved",
    deal: {
      name: "jasonn ranches",
      projectNumber: "TR-1001",
      projectType: "9",
      amount: 100000,
      estimator: null,
      companyName: "Acme",
      contactName: "Jane",
      clientEmail: "jane@acme.com",
      clientPhone: null,
      address: { street: "1 Main", city: "Dallas", state: "TX", zip: "75001", country: "US" },
      description: null,
      dueDate: null,
      workflowRoute: "normal",
    },
    attachments: [],
    ...overrides,
  };
}

function sign(body: string) {
  return `sha256=${crypto.createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

async function buildApp() {
  const { registerRfpRequestRoutes } = await import("../server/routes/rfp-requests");
  const app = express();
  registerRfpRequestRoutes(app);
  return app;
}

describe("POST /api/bid-board/create-from-rfp", () => {
  beforeEach(() => {
    process.env.RFP_REQUEST_SYNC_SECRET = SECRET;
    process.env.TROCK_CRM_BASE_URL = "https://crm.example.com";
    createBidBoardMock.mockClear();
    callbackFetchMock.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("401 on a bad signature", async () => {
    const app = await buildApp();
    const raw = JSON.stringify(requestBody());
    const res = await request(app).post("/api/bid-board/create-from-rfp").set("content-type", "application/json").set("x-rfp-request-signature", "sha256=deadbeef").send(raw);
    expect(res.status).toBe(401);
  });

  it("202, creates the project, and POSTs a 'created' callback keyed by sourceDealId (no rfpApprovalRequestId)", async () => {
    const app = await buildApp();
    const raw = JSON.stringify(requestBody());
    const res = await request(app).post("/api/bid-board/create-from-rfp").set("content-type", "application/json").set("x-rfp-request-signature", sign(raw)).send(raw);
    expect(res.status).toBe(202);

    await vi.waitFor(() => expect(callbackFetchMock).toHaveBeenCalledTimes(1));

    expect(createBidBoardMock).toHaveBeenCalledTimes(1);
    const createArgs = createBidBoardMock.mock.calls[0][0];
    expect(createArgs.sourceSystem).toBe("trock_crm");
    expect(createArgs.sourceDealId).toBe("crm-deal-1");
    expect(createArgs.normalizedDealData.project_number).toBe("TR-1001");
    expect(createArgs.normalizedDealData.company_name).toBe("Acme");

    const [cbUrl, cbInit] = callbackFetchMock.mock.calls[0];
    expect(cbUrl).toBe("https://crm.example.com/api/internal/bid-board-created");
    const cbBody = JSON.parse(cbInit.body);
    expect(cbBody.status).toBe("created");
    expect(cbBody.sourceDealId).toBe("crm-deal-1");
    expect(cbBody.bidboardProjectId).toBe("999");
    expect(cbBody.procoreCompanyId).toBe("42");
    expect(cbBody.rfpApprovalRequestId).toBeUndefined();
    expect(cbInit.headers["x-rfp-request-signature"]).toBe(sign(cbInit.body));
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL.** `(cd /Users/adnaaniqbal/Developer/trocksynchubv3 && npx vitest run tests/bid-board-create-from-rfp.test.ts)` → FAIL: route returns 404 (endpoint not registered).

- [ ] **Step 3: Add the endpoint + helper to `server/routes/rfp-requests.ts`.** First extend the top import (dossier line 17-19) so `storage` is available (it already is) and add the schema constant next to `overrideApproveBodySchema` (line 24):

```ts
const createFromRfpBodySchema = rfpRequestBodySchema.extend({
  decision: z.literal("approved"),
});
```

Then, **inside `registerRfpRequestRoutes`**, after the `override-approve` route (dossier line 311), add:

```ts
  // Create-on-command from a CRM RFP VOTE (2/3-approve or override-approve). The CRM already decided, so
  // this creates the BidBoard project immediately (no email, no rfp_approval_requests row, no vote storage
  // here) and posts the existing bid-board-created callback keyed by sourceDealId. HMAC-secured; 202 + async.
  app.post("/api/bid-board/create-from-rfp", jsonWithRawBody, asyncHandler(async (req, res) => {
    const signature = verifyRfpRequestSignature(req);
    if (!signature.ok) {
      const body = signature.status === 401
        ? { success: false, error: "Unauthorized", message: signature.message }
        : { success: false, error: "Internal Server Error", message: signature.message };
      return res.status(signature.status).json(body);
    }

    const parsed = createFromRfpBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: "Unprocessable Entity",
        message: "create-from-rfp validation failed",
        issues: parsed.error.issues,
      });
    }
    const input = parsed.data;

    res.status(202).json({
      success: true,
      queued: true,
      sourceDealId: input.sourceDealId,
      projectNumber: input.deal.projectNumber,
    });

    setImmediate(async () => {
      try {
        await createBidBoardFromRfpVote(input);
      } catch (err: any) {
        console.error(`[rfp-requests] create-from-rfp failed for deal ${input.sourceDealId}:`, err?.message || err);
      }
    });
  }));
```

Add the helper functions at module scope (below `registerRfpRequestRoutes`):

```ts
async function createBidBoardFromRfpVote(input: z.infer<typeof createFromRfpBodySchema>): Promise<void> {
  const { createBidBoardProjectFromDeal } = await import("../playwright/bidboard");
  const { buildBidBoardCreatedCallbackTargetUrl } = await import("../sync/bidboard-callback-worker");

  const d = input.deal;
  const normalizedDealData: Record<string, any> = {
    dealname: d.name,
    project_number: d.projectNumber,
    project_types: d.projectType,
    amount: d.amount,
    estimator: d.estimator,
    company_name: d.companyName,
    contact_name: d.contactName,
    client_email: d.clientEmail,
    client_phone: d.clientPhone,
    address: d.address?.street,
    city: d.address?.city,
    state: d.address?.state,
    zip: d.address?.zip,
    country: d.address?.country,
    description: d.description,
    bid_due_date: d.dueDate,
    attachments: input.attachments,
  };

  // Reuses the syncMappings adopt-guard inside createBidBoardProjectFromDeal (one deal -> one project).
  const result = await createBidBoardProjectFromDeal({
    sourceSystem: "trock_crm",
    sourceDealId: input.sourceDealId,
    bidboardStage: "Estimate in Progress",
    normalizedDealData,
    options: { syncDocuments: true },
  });

  const targetUrl = buildBidBoardCreatedCallbackTargetUrl();
  if (!targetUrl) {
    console.error(`[rfp-requests] TROCK_CRM_BASE_URL not configured; cannot deliver create-from-rfp callback for deal ${input.sourceDealId}`);
    return;
  }
  const secret = process.env.RFP_REQUEST_SYNC_SECRET;
  if (!secret) {
    console.error("[rfp-requests] RFP_REQUEST_SYNC_SECRET not configured; cannot deliver create-from-rfp callback");
    return;
  }

  const procoreCompanyId = await resolveProcoreCompanyIdForCallback();

  // Voting-path callback: NO rfpApprovalRequestId (no request row). The CRM resolves by sourceDealId.
  const payload = result.success && result.projectId
    ? {
        status: "created" as const,
        sourceDealId: input.sourceDealId,
        bidboardProjectId: result.projectId,
        projectNumber: input.deal.projectNumber,
        procoreCompanyId,
        createdAt: new Date().toISOString(),
      }
    : {
        status: "failed" as const,
        sourceDealId: input.sourceDealId,
        projectNumber: input.deal.projectNumber,
        procoreCompanyId,
        error: result.error || "BidBoard project creation failed",
        createdAt: new Date().toISOString(),
      };

  await deliverCreateFromRfpCallback(targetUrl, payload, secret);
}

async function resolveProcoreCompanyIdForCallback(): Promise<string | undefined> {
  const getAutomationConfig = (storage as any).getAutomationConfig;
  const config = typeof getAutomationConfig === "function"
    ? await getAutomationConfig.call(storage, "procore_config")
    : null;
  return String((config?.value as any)?.companyId || process.env.PROCORE_COMPANY_ID || "").trim() || undefined;
}

async function deliverCreateFromRfpCallback(targetUrl: string, payload: Record<string, any>, secret: string): Promise<void> {
  const { fetchWithTimeout } = await import("../lib/fetch-with-timeout");
  const rawBody = JSON.stringify(payload);
  const sig = signRfpRequestPayload(rawBody, secret);
  const MAX = 3;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      const resp = await fetchWithTimeout(targetUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rfp-request-signature": sig },
        body: rawBody,
      });
      if (resp.ok) return;
      if (attempt === MAX) console.error(`[rfp-requests] create-from-rfp callback failed with ${resp.status}`);
    } catch (err: any) {
      if (attempt === MAX) console.error(`[rfp-requests] create-from-rfp callback error: ${err?.message || err}`);
    }
    if (attempt < MAX) await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}
```

- [ ] **Step 4: Run the test — expect PASS.** `(cd /Users/adnaaniqbal/Developer/trocksynchubv3 && npx vitest run tests/bid-board-create-from-rfp.test.ts)` → 401 + 202/create/callback all green.

- [ ] **Step 5: Commit (SyncHub repo).**

```
git -C /Users/adnaaniqbal/Developer/trocksynchubv3 add server/routes/rfp-requests.ts tests/bid-board-create-from-rfp.test.ts
git -C /Users/adnaaniqbal/Developer/trocksynchubv3 commit -m "feat(rfp): POST /api/bid-board/create-from-rfp — HMAC create-on-command for CRM RFP votes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: `bid-board-created` callback resolves voting-path deals by `sourceDealId`

**Files:**
- Modify: `server/src/modules/internal-rfp/routes.ts` (two minimal edits in the `/bid-board-created` handler: the top request-id validation, dossier lines 1467-1470; and the stale-callback guard, dossier lines 1480-1487)
- Test: `server/tests/modules/internal-rfp/bid-board-created-voting.runtime.test.ts`

**Design note:** the handler already resolves the deal by `sourceDealId` via `findDeal` (it never keyed on
`rfp_approval_request_id` for lookup). The only two blockers for a voting-path deal (which has
`rfp_approval_request_id IS NULL` and whose SyncHub callback carries no `rfpApprovalRequestId`) are (1) the
top `typeof payload.rfpApprovalRequestId !== "number"` → 422, and (2) the stale guard computing
`Number(null) = 0` and treating a missing id as stale → no-op. Relaxing both — require `rfpApprovalRequestId`
to match **only when the deal has a non-null `rfp_approval_request_id`** (legacy / service / override path) —
lets the voting `created` callback advance. The linkage + stage UPDATEs already do not filter on request id
and pass the `rfp_override_reviewed_at IS NULL` freshness escape (voting deals have null reviewed_at). The
voting `failed`-callback path stays a no-op on the deal (status is `pending`, not `declined`) — a deliberate
v1 gap covered by the deal staying visibly "creating".

- [ ] **Step 1: Write the failing PGlite callback test.** Create `server/tests/modules/internal-rfp/bid-board-created-voting.runtime.test.ts`:

```ts
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const holder = vi.hoisted(() => ({ pg: null as any }));

async function pgQuery(text: string, params?: any[]) {
  const r = await holder.pg.query(text, params ?? []);
  return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
}

vi.mock("../../../src/db.js", () => ({
  pool: {
    query: (text: string, params?: any[]) => pgQuery(text, params),
    connect: async () => ({ query: (t: string, p?: any[]) => pgQuery(t, p), release: () => {} }),
  },
  releasePooledClient: () => {},
  isBrokenConnectionError: () => false,
}));
vi.mock("../../../src/modules/audit/pg-activity-logger.js", () => ({ logActivityWithPgClient: vi.fn(async () => {}) }));
vi.mock("../../../src/modules/audit/audit-logger.js", () => ({ buildAuditActorFromSystem: () => ({}) }));
vi.mock("../../../src/modules/audit/system-processes.js", () => ({ INTERNAL_RFP_RECEIVER: "internal_rfp_receiver" }));

const SECRET = "shared-secret";
const DEAL = "00000000-0000-0000-0000-0000000000d1";
const REP = "00000000-0000-0000-0000-000000000001";
const OPP = "00000000-0000-0000-0000-0000000000a1";
const EST = "00000000-0000-0000-0000-0000000000a2";

function sign(body: string) {
  return `sha256=${crypto.createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

async function seed() {
  const db = new PGlite();
  holder.pg = db;
  await db.exec(`
    CREATE SCHEMA office_test;
    CREATE TABLE public.pipeline_stage_config (id uuid PRIMARY KEY, slug text NOT NULL, display_order integer, is_terminal boolean NOT NULL DEFAULT false);
    INSERT INTO public.pipeline_stage_config (id, slug, display_order, is_terminal) VALUES ('${OPP}', 'opportunity', 3, false), ('${EST}', 'estimating', 5, false);
    CREATE TABLE office_test.deals (
      id uuid PRIMARY KEY, name text, deal_number text, project_number text, project_type text, bid_estimate numeric,
      estimator text, description text, bid_due_date timestamptz, property_address text, property_city text, property_state text,
      property_zip text, property_country text, stage_id uuid, company_id uuid, primary_contact_id uuid, procore_bid_id bigint,
      procore_company_id text, is_bid_board_owned boolean NOT NULL DEFAULT false, rfp_approval_status text, rfp_declined_reason text,
      rfp_declined_at timestamptz, rfp_override_state text, rfp_override_error text, rfp_override_decision text,
      rfp_override_reviewed_at timestamptz, bid_board_linked_at timestamptz, assigned_rep_id uuid, rfp_approval_requested_by uuid,
      rfp_approval_request_id integer, workflow_route text NOT NULL DEFAULT 'normal', stage_entered_at timestamptz,
      on_hold boolean NOT NULL DEFAULT false, on_hold_started_at timestamptz, on_hold_accumulated_seconds bigint DEFAULT 0,
      on_hold_accumulated_seconds_at_stage_entry bigint DEFAULT 0, is_active boolean NOT NULL DEFAULT true, updated_at timestamptz
    );
    CREATE TABLE office_test.deal_stage_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid, from_stage_id uuid, to_stage_id uuid, changed_by uuid,
      is_backward_move boolean, is_director_override boolean, override_reason text, duration_in_previous_stage interval,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  // Voting-path deal: pending round, NO rfp_approval_request_id.
  await db.query(
    `INSERT INTO office_test.deals (id, name, deal_number, stage_id, workflow_route, rfp_approval_status, rfp_approval_request_id, assigned_rep_id, rfp_approval_requested_by, stage_entered_at)
     VALUES ($1, 'jasonn ranches', 'TR-1001', $2, 'normal', 'pending', NULL, $3, $3, now())`,
    [DEAL, OPP, REP],
  );
  return db;
}

async function buildApp() {
  const { internalRfpRoutes } = await import("../../../src/modules/internal-rfp/routes.js");
  const app = express();
  app.use(internalRfpRoutes);
  return app;
}

describe("POST /bid-board-created (voting path)", () => {
  beforeEach(() => { process.env.SYNCHUB_SHARED_SECRET = SECRET; });
  afterEach(async () => { await holder.pg?.close(); holder.pg = null; vi.restoreAllMocks(); });

  it("advances a voting deal (no rfp_approval_request_id) on a 'created' callback with no rfpApprovalRequestId", async () => {
    await seed();
    const app = await buildApp();
    const raw = JSON.stringify({
      status: "created",
      sourceDealId: DEAL,
      bidboardProjectId: "88123",
      procoreCompanyId: "42",
      createdAt: new Date().toISOString(),
    });
    const res = await request(app).post("/bid-board-created").set("content-type", "application/json").set("x-rfp-request-signature", sign(raw)).send(raw);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const rows = (await holder.pg.query(`SELECT rfp_approval_status, is_bid_board_owned, procore_bid_id, stage_id FROM office_test.deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(rows[0].rfp_approval_status).toBe("approved");
    expect(rows[0].is_bid_board_owned).toBe(true);
    expect(String(rows[0].procore_bid_id)).toBe("88123");
    expect(rows[0].stage_id).toBe(EST);
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL.** `(cd server && npx vitest run tests/modules/internal-rfp/bid-board-created-voting.runtime.test.ts)` → FAIL: the callback returns 422 (missing numeric `rfpApprovalRequestId`), the deal is never advanced.

- [ ] **Step 3: Edit 1 — relax the top request-id validation.** In `internal-rfp/routes.ts` `/bid-board-created`, replace:

```ts
      if (!sourceDealId || typeof payload.rfpApprovalRequestId !== "number") {
        res.status(422).json({ success: false, error: "invalid_payload" });
        return;
      }
```

with:

```ts
      if (!sourceDealId) {
        res.status(422).json({ success: false, error: "invalid_payload" });
        return;
      }
```

- [ ] **Step 4: Edit 2 — request-id match only for deals that have one.** Replace the stale-callback guard:

```ts
      const currentRequestId = Number(found.deal.rfp_approval_request_id);
      if (!Number.isFinite(currentRequestId) || payload.rfpApprovalRequestId !== currentRequestId) {
        console.warn(
          `[RFP callback] stale callback ignored for sourceDealId=${sourceDealId}; incoming rfpApprovalRequestId=${payload.rfpApprovalRequestId}; current rfpApprovalRequestId=${found.deal.rfp_approval_request_id ?? "null"}`
        );
        res.json({ success: true, idempotent: true, reason: "stale_callback_ignored" });
        return;
      }
```

with:

```ts
      // Legacy / service / override deals carry a SyncHub rfp_approval_request_id and must reconcile the
      // callback against it. VOTING-path deals never mint one (the CRM decided by vote, not SyncHub), so the
      // callback carries no rfpApprovalRequestId and is resolved purely by sourceDealId (found via findDeal).
      const dealRequestId = found.deal.rfp_approval_request_id;
      const currentRequestId = dealRequestId == null ? null : Number(dealRequestId);
      if (dealRequestId != null) {
        if (!Number.isFinite(currentRequestId as number) || payload.rfpApprovalRequestId !== currentRequestId) {
          console.warn(
            `[RFP callback] stale callback ignored for sourceDealId=${sourceDealId}; incoming rfpApprovalRequestId=${payload.rfpApprovalRequestId}; current rfpApprovalRequestId=${found.deal.rfp_approval_request_id ?? "null"}`
          );
          res.json({ success: true, idempotent: true, reason: "stale_callback_ignored" });
          return;
        }
      }
```

(All downstream uses of `currentRequestId` remain valid: the `failed` branch's UPDATE guards on
`rfp_approval_status = 'declined'`, which a voting-approved deal never matches, so passing `null` there is a
harmless no-op; the `created` linkage/stage UPDATEs never reference `currentRequestId` in their WHERE.)

- [ ] **Step 5: Run the test — expect PASS.** `(cd server && npx vitest run tests/modules/internal-rfp/bid-board-created-voting.runtime.test.ts)` → the voting deal advances to `estimating`, `rfp_approval_status='approved'`, `is_bid_board_owned=true`, `procore_bid_id=88123`.

- [ ] **Step 6: Regression-check the legacy callback path.** Confirm the existing internal-rfp callback suite still passes (the request-id match is preserved for deals that have one): `(cd server && npx vitest run tests/modules/internal-rfp)`.

- [ ] **Step 7: Commit.**

```
git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting add server/src/modules/internal-rfp/routes.ts server/tests/modules/internal-rfp/bid-board-created-voting.runtime.test.ts
git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting commit -m "fix(rfp-voting): bid-board-created advances voting-path deals resolved by sourceDealId (no request id)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Section B — final verification

- [ ] **Run the full server runtime gate:** `(cd server && npm run test:runtime)` → the new `rfp-vote-service`, `trigger-rfp-vote-branch`, `rfp-vote-route`, and `bid-board-created-voting` runtime suites all execute and pass.
- [ ] **Run the full worker runtime gate:** `(cd worker && npm run test:runtime)` → `rfp-vote-invitation` + `rfp-bidboard-create` runtime suites pass.
- [ ] **Run the SyncHub suite:** `(cd /Users/adnaaniqbal/Developer/trocksynchubv3 && npx vitest run tests/bid-board-create-from-rfp.test.ts)` → passes.
- [ ] **Reconciliation invariant check:** confirm `computeRfpVoteState` is the ONLY tally/threshold source consumed by (a) `castRfpVote`'s decision, (b) the detail-card `rfpVoteState` (Section C), and (c) the escalation summary (Section C) — no re-implementation of approve/reject counting anywhere in this section.
## Section C: Detail join, escalation enrichment, override unification, vote UI, outcome notification & rollout

> **Depends on Sections A/B** for these canonical symbols (already built by the time this section runs):
> `rfpVotes` schema table (`shared/src/schema/rfp-votes.ts`, registered in `shared/src/schema/index.ts`),
> migration `0173_rfp_votes.sql`, `computeRfpVoteState` + `RfpVoteRecord` (`shared/src/lib/rfpVoteState.ts`),
> `isRfpVoterEmail` + `resolveRfpVoterEmails` (`shared/src/lib/rfpVoterEmails.ts`), `isRfpVoter` on the auth
> payload (`shared/src/types/auth.ts`, `client/src/lib/auth.tsx`), `requireRfpVoter` (`server/src/middleware/rbac.ts`),
> `openRfpVoteRound` / `castRfpVote` / `buildRfpVoteDeclineReason` (`server/src/modules/deals/rfp-vote-service.ts`),
> `enqueueRfpVoteInvitation` + `enqueueRfpBidBoardCreate`, and the SyncHub `create-from-rfp` endpoint.
>
> **Reconciliation invariant (standing rule):** `computeRfpVoteState` is the ONE place threshold/tally/outcome
> logic lives. Section C consumes it in three surfaces — the detail card panel (Task 17), the escalation page
> summary (Task 15), and the detail payload (Task 14). It must never re-implement the tally; every surface reads
> the same helper so card == decision == escalation can never drift.
>
> **All git commands run in the worktree** `/Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting`.
> **Service/type-4 path stays 100% unchanged** across every task below.

---

### Task 14 — `getDealDetail` joins `rfp_votes` → `rfpVotes: RfpVoteView[]` + `rfpVoteState` (contract #14)

Add a small, purpose-built loader `loadRfpVoteDetail` (its own sibling file, so the runtime test imports a tiny
dependency graph instead of `service.ts`'s huge one), call it from `getDealDetail`, and extend the client
`DealDetail` type. The loader scopes votes to the deal's **current** round (`rfp_approval_request_event_id`) so a
re-trigger starts a clean tally (design §Open-item-6), and reconciles by feeding the same rows to
`computeRfpVoteState`.

**Files:**
- Create: `server/src/modules/deals/rfp-vote-detail.ts`
- Create: `server/tests/modules/deals/rfp-vote-detail.runtime.test.ts`
- Modify: `server/src/modules/deals/service.ts` (import at 5-22; call + return inside `getDealDetail` at 1961-2065, after the `dealChangeOrderTotal` block at ~2213/2214)
- Modify: `client/src/hooks/use-deals.ts` (`DealDetail` interface at 236-311)

- [ ] **Step 1: Write the failing runtime test for `loadRfpVoteDetail`.**
  Create `server/tests/modules/deals/rfp-vote-detail.runtime.test.ts`:
  ```ts
  import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
  import { PGlite } from "@electric-sql/pglite";
  import { drizzle } from "drizzle-orm/pglite";

  // Resolve the workspace package specifiers to their src under vitest (mirrors conversion-service.test).
  vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));
  vi.mock("@trock-crm/shared/lib/rfpVoteState", async () => import("../../../../shared/src/lib/rfpVoteState.js"));

  import { loadRfpVoteDetail } from "../../../src/modules/deals/rfp-vote-detail.js";
  import { computeRfpVoteState } from "../../../../shared/src/lib/rfpVoteState.js";

  const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
  const DEAL = U("d01");
  const ROUND = U("e01");
  const ROUND_OLD = U("e00"); // a prior round — must NOT leak into the current tally
  const SIDNEY = U("a01");
  const JAMES = U("a02");
  const TIM = U("a03");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tdb: any;
  let pg: PGlite;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
      CREATE TABLE rfp_votes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        deal_id uuid NOT NULL,
        round_event_id uuid NOT NULL,
        voter_user_id uuid,
        voter_email text NOT NULL,
        decision text NOT NULL,
        reason text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO users (id, display_name) VALUES
        ('${SIDNEY}', 'Sidney Gibson'),
        ('${JAMES}', 'James Helms'),
        ('${TIM}', 'Tim Estimator');
      INSERT INTO rfp_votes (deal_id, round_event_id, voter_user_id, voter_email, decision, reason, created_at) VALUES
        ('${DEAL}', '${ROUND}', '${SIDNEY}', 'sidney@trockgc.com', 'approve', NULL, '2026-07-02T14:14:00Z'),
        ('${DEAL}', '${ROUND}', '${JAMES}', 'james@trockgc.com', 'reject', 'Margins too thin for this scope', '2026-07-02T14:20:00Z'),
        -- a vote from a PRIOR round for the same deal — must be excluded by round scoping:
        ('${DEAL}', '${ROUND_OLD}', '${TIM}', 'tim@trockgc.com', 'reject', 'old round', '2026-07-01T09:00:00Z');
    `);
    tdb = drizzle(pg);
  });

  afterAll(async () => {
    await pg.close();
  });

  describe("loadRfpVoteDetail", () => {
    it("returns the current round's votes (name-joined, ISO votedAt, createdAt asc) and reconciles rfpVoteState with computeRfpVoteState", async () => {
      const { rfpVotes, rfpVoteState } = await loadRfpVoteDetail(tdb, DEAL, ROUND);

      // Only this round's two votes, oldest first.
      expect(rfpVotes.map((v) => v.voterEmail)).toEqual(["sidney@trockgc.com", "james@trockgc.com"]);
      expect(rfpVotes[0]).toMatchObject({
        voterUserId: SIDNEY,
        voterName: "Sidney Gibson",
        decision: "approve",
        reason: null,
      });
      expect(rfpVotes[1]).toMatchObject({ voterName: "James Helms", decision: "reject", reason: "Margins too thin for this scope" });
      expect(typeof rfpVotes[0].votedAt).toBe("string");
      expect(rfpVotes[0].votedAt).toBe(new Date("2026-07-02T14:14:00Z").toISOString());

      // 1 approve · 1 reject with threshold 2 => still pending.
      expect(rfpVoteState).toMatchObject({ approvals: 1, rejections: 1, outcome: "pending", decidedAt: null });

      // Reconciliation invariant: the state on the payload equals a fresh computeRfpVoteState over the same records.
      expect(rfpVoteState).toEqual(
        computeRfpVoteState(
          rfpVotes.map((v) => ({ voterUserId: v.voterUserId, voterEmail: v.voterEmail, decision: v.decision, reason: v.reason, createdAt: v.votedAt }))
        )
      );
    });

    it("returns empty votes + a pending state when the deal has no open round (null roundEventId)", async () => {
      const { rfpVotes, rfpVoteState } = await loadRfpVoteDetail(tdb, DEAL, null);
      expect(rfpVotes).toEqual([]);
      expect(rfpVoteState).toEqual(computeRfpVoteState([]));
    });
  });
  ```

- [ ] **Step 2: Run the test — expect FAIL (module not found).**
  ```
  (cd server && npx vitest run tests/modules/deals/rfp-vote-detail.runtime.test.ts)
  ```
  Expected: `Failed to resolve import "../../../src/modules/deals/rfp-vote-detail.js"` (the file does not exist yet).

- [ ] **Step 3: Create `server/src/modules/deals/rfp-vote-detail.ts` with the real loader.**
  ```ts
  import { and, asc, eq } from "drizzle-orm";
  import type { NodePgDatabase } from "drizzle-orm/node-postgres";
  import { rfpVotes, users } from "@trock-crm/shared/schema";
  import type * as schema from "@trock-crm/shared/schema";
  import { computeRfpVoteState, type RfpVoteRecord } from "@trock-crm/shared/lib/rfpVoteState";

  type TenantDb = NodePgDatabase<typeof schema>;

  /** One recorded vote as shown on the deal detail card + the /rfp-vote page (name-joined for display). */
  export type RfpVoteView = {
    voterUserId: string | null;
    voterName: string | null;
    voterEmail: string;
    decision: "approve" | "reject";
    reason: string | null;
    votedAt: string;
  };

  /**
   * Loads the CURRENT round's votes for a deal + the derived vote state. Scoped by round_event_id (the deal's
   * rfp_approval_request_event_id) so a re-triggered round starts a clean tally and old rows never leak in.
   * rfpVoteState is computed by the ONE shared helper (computeRfpVoteState) — the reconciliation invariant: the
   * value the card renders is the same value the fire-on-2 decision + escalation summary use.
   */
  export async function loadRfpVoteDetail(
    tenantDb: TenantDb,
    dealId: string,
    roundEventId: string | null
  ): Promise<{ rfpVotes: RfpVoteView[]; rfpVoteState: ReturnType<typeof computeRfpVoteState> }> {
    if (!roundEventId) {
      return { rfpVotes: [], rfpVoteState: computeRfpVoteState([]) };
    }

    const rows = await tenantDb
      .select({
        voterUserId: rfpVotes.voterUserId,
        voterName: users.displayName,
        voterEmail: rfpVotes.voterEmail,
        decision: rfpVotes.decision,
        reason: rfpVotes.reason,
        createdAt: rfpVotes.createdAt,
      })
      .from(rfpVotes)
      .leftJoin(users, eq(users.id, rfpVotes.voterUserId))
      .where(and(eq(rfpVotes.dealId, dealId), eq(rfpVotes.roundEventId, roundEventId)))
      .orderBy(asc(rfpVotes.createdAt));

    const records: RfpVoteRecord[] = rows.map((r) => ({
      voterUserId: r.voterUserId,
      voterEmail: r.voterEmail,
      decision: r.decision as "approve" | "reject",
      reason: r.reason,
      createdAt: r.createdAt,
    }));

    const rfpVoteState = computeRfpVoteState(records);
    const votesView: RfpVoteView[] = rows.map((r) => ({
      voterUserId: r.voterUserId,
      voterName: r.voterName ?? null,
      voterEmail: r.voterEmail,
      decision: r.decision as "approve" | "reject",
      reason: r.reason,
      votedAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    }));

    return { rfpVotes: votesView, rfpVoteState };
  }
  ```

- [ ] **Step 4: Run the test — expect PASS.**
  ```
  (cd server && npx vitest run tests/modules/deals/rfp-vote-detail.runtime.test.ts)
  ```
  Expected: 2 passing (`loadRfpVoteDetail > returns the current round's votes …`, `> returns empty votes …`).

- [ ] **Step 5: Wire `loadRfpVoteDetail` into `getDealDetail`.**
  In `server/src/modules/deals/service.ts`, add to the existing sibling import (the block importing
  `listDealChangeOrders` at 87-89 area — add a new line near it):
  ```ts
  import { loadRfpVoteDetail, type RfpVoteView } from "./rfp-vote-detail.js";
  ```
  Then, inside `getDealDetail`, immediately after the `const dealChangeOrderTotal = await sumDealChangeOrders(tenantDb, dealId);` line (dossier service.ts:214), add one more **sequential** read (the single-transaction-client rule forbids parallel reads):
  ```ts
    // Current-round RFP votes for the vote panel / focused vote page. Scoped to the deal's live round event id
    // so a re-trigger shows a clean tally. rfpVoteState comes from the ONE shared helper (reconciliation rule).
    const { rfpVotes: rfpVotesView, rfpVoteState } = await loadRfpVoteDetail(
      tenantDb,
      dealId,
      dealWithMetadata.rfpApprovalRequestEventId ?? null
    );
  ```
  And add both fields to the returned object (alongside `dealChangeOrders` / `dealChangeOrderTotal` at dossier service.ts:232-233):
  ```ts
      dealChangeOrders: dealChangeOrderRows,
      dealChangeOrderTotal,
      rfpVotes: rfpVotesView,
      rfpVoteState,
  ```

- [ ] **Step 6: Confirm `redactDealResponse` / `stripPrivateDealFieldsForViewer` pass the new fields through.**
  Read `server/src/modules/deals/redact.ts` and verify both functions are **denylists** (they delete named private
  scalar fields; they do not allowlist keys). `rfpVotes` (array) and `rfpVoteState` (object) are not in any private
  denylist, so they pass through untouched. No change needed — this is a read-only verification (the dossier flagged
  it as a must-check).

- [ ] **Step 7: Extend the client `DealDetail` type.**
  In `client/src/hooks/use-deals.ts`, inside `interface DealDetail extends Deal { … }` (236-311), add after
  `dealChangeOrderTotal: string;`:
  ```ts
    // Current-round RFP vote records + derived state (from the server's computeRfpVoteState). rfpVoteState.decidedAt
    // is an ISO string on the wire (toJsonSafe serializes the Date). Empty/`pending` when the deal has no open round.
    rfpVotes: Array<{
      voterUserId: string | null;
      voterName: string | null;
      voterEmail: string;
      decision: "approve" | "reject";
      reason: string | null;
      votedAt: string;
    }>;
    rfpVoteState: {
      approvals: number;
      rejections: number;
      outcome: "pending" | "approved" | "rejected";
      decidedAt: string | null;
    };
  ```

- [ ] **Step 8: Re-run the server test + typecheck the client type.**
  ```
  (cd server && npx vitest run tests/modules/deals/rfp-vote-detail.runtime.test.ts)
  (cd client && npx tsc -p tsconfig.json --noEmit)
  ```
  Expected: server test green; client typecheck clean.

- [ ] **Step 9: Commit.**
  ```
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting add server/src/modules/deals/rfp-vote-detail.ts server/tests/modules/deals/rfp-vote-detail.runtime.test.ts server/src/modules/deals/service.ts client/src/hooks/use-deals.ts
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting commit -m "feat(rfp-voting): join rfp_votes into deal detail with reconciled rfpVoteState

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 15 — Escalation enrichment: `getRfpReviewDetail` returns the round's votes; `/rfp-review` renders all three (contract #15)

On a 2/3 no-go the deal is declined and the existing Takashi/Adam escalation fires. Enrich the review page so the
reviewers see **why** — the three voters' choices + reasons — instead of only the aggregated decline reason. Reuse
`loadRfpVoteDetail` (Task 14) so the escalation summary is the same data as the card (reconciliation invariant).

**Files:**
- Modify: `server/src/modules/deals/rfp-override-service.ts` (`RfpReviewDetail` interface 1104-1127; `getRfpReviewDetail` 302-359)
- Modify: `client/src/hooks/use-rfp-review.ts` (`RfpReviewDetail` interface 5-24)
- Modify: `client/src/pages/rfp-review/rfp-review-page.tsx` (`DealFacts` render; card content)
- Create: `server/tests/modules/deals/rfp-review-votes.runtime.test.ts`

- [ ] **Step 1: Write the failing runtime test for the enriched `getRfpReviewDetail`.**
  Create `server/tests/modules/deals/rfp-review-votes.runtime.test.ts`:
  ```ts
  import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
  import { PGlite } from "@electric-sql/pglite";
  import { drizzle } from "drizzle-orm/pglite";

  vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));
  vi.mock("@trock-crm/shared/lib/rfpVoteState", async () => import("../../../../shared/src/lib/rfpVoteState.js"));

  import { getRfpReviewDetail } from "../../../src/modules/deals/rfp-override-service.js";

  const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
  const DEAL = U("d01");
  const ROUND = U("e01");
  const REQ = U("a09");
  const SIDNEY = U("a01");
  const JAMES = U("a02");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tdb: any;
  let pg: PGlite;

  beforeAll(async () => {
    pg = new PGlite();
    // getRfpReviewDetail runs raw SQL over `deals` + `public.users`; loadRfpVoteDetail reads `rfp_votes` + `users`.
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS public;
      CREATE TABLE public.users (id uuid PRIMARY KEY, display_name text, email text);
      CREATE TABLE deals (
        id uuid PRIMARY KEY, name text, deal_number text, project_number text,
        rfp_approval_status text, rfp_approval_request_id bigint,
        rfp_approval_request_event_id uuid,
        rfp_approval_requested_at timestamptz, rfp_approval_requested_by uuid,
        rfp_declined_reason text, rfp_declined_at timestamptz,
        rfp_override_reviewed_at timestamptz, rfp_override_reviewed_by uuid,
        rfp_override_decision text, rfp_override_note text,
        rfp_override_state text, rfp_override_error text
      );
      CREATE TABLE rfp_votes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        deal_id uuid NOT NULL, round_event_id uuid NOT NULL,
        voter_user_id uuid, voter_email text NOT NULL, decision text NOT NULL, reason text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO public.users (id, display_name, email) VALUES
        ('${REQ}', 'Rep Requester', 'rep@trockgc.com'),
        ('${SIDNEY}', 'Sidney Gibson', 'sidney@trockgc.com'),
        ('${JAMES}', 'James Helms', 'james@trockgc.com');
      INSERT INTO deals (id, name, deal_number, project_number, rfp_approval_status, rfp_approval_request_id,
        rfp_approval_request_event_id, rfp_approval_requested_at, rfp_approval_requested_by,
        rfp_declined_reason, rfp_declined_at)
      VALUES ('${DEAL}', 'Terraces Re-Roof', 'DFW-1-100', 'DFW-1-100', 'declined', NULL,
        '${ROUND}', '2026-07-02T14:00:00Z', '${REQ}',
        'Rejected by vote (2 of 3). sidney@trockgc.com: cost; james@trockgc.com: scope', '2026-07-02T14:25:00Z');
      INSERT INTO rfp_votes (deal_id, round_event_id, voter_user_id, voter_email, decision, reason, created_at) VALUES
        ('${DEAL}', '${ROUND}', '${SIDNEY}', 'sidney@trockgc.com', 'reject', 'cost', '2026-07-02T14:14:00Z'),
        ('${DEAL}', '${ROUND}', '${JAMES}', 'james@trockgc.com', 'reject', 'scope', '2026-07-02T14:20:00Z');
    `);
    tdb = drizzle(pg);
  });

  afterAll(async () => {
    await pg.close();
  });

  describe("getRfpReviewDetail (vote-enriched)", () => {
    it("returns the round's votes alongside the declined-RFP facts", async () => {
      const detail = await getRfpReviewDetail(tdb, DEAL);
      expect(detail).not.toBeNull();
      expect(detail!.rfpApprovalStatus).toBe("declined");
      expect(detail!.votes.map((v) => v.voterEmail)).toEqual(["sidney@trockgc.com", "james@trockgc.com"]);
      expect(detail!.votes.every((v) => v.decision === "reject")).toBe(true);
      expect(detail!.votes[1]).toMatchObject({ voterName: "James Helms", reason: "scope" });
    });
  });
  ```

- [ ] **Step 2: Run the test — expect FAIL.**
  ```
  (cd server && npx vitest run tests/modules/deals/rfp-review-votes.runtime.test.ts)
  ```
  Expected: FAIL — `detail.votes` is `undefined` (property does not exist yet).

- [ ] **Step 3: Add `votes` to the server `RfpReviewDetail` interface + enrich `getRfpReviewDetail`.**
  In `server/src/modules/deals/rfp-override-service.ts`, add the import near the top (after line 6, `import { deals } …`):
  ```ts
  import { loadRfpVoteDetail, type RfpVoteView } from "./rfp-vote-detail.js";
  ```
  Add to the `RfpReviewDetail` interface (after `actionable: boolean;`, dossier 1126):
  ```ts
    /** The round's recorded votes (voter + choice + reason + time), for the escalation summary. */
    votes: RfpVoteView[];
  ```
  In the raw SQL of `getRfpReviewDetail`, add the round-event column to the `SELECT` (after
  `d.rfp_approval_request_id AS "rfpApprovalRequestId",`, dossier 1023):
  ```ts
             d.rfp_approval_request_event_id AS "roundEventId",
  ```
  Then, just before the `return { … }`, load the votes and include them in the returned object:
  ```ts
    const { rfpVotes } = await loadRfpVoteDetail(tenantDb, dealId, (row.roundEventId as string | null) ?? null);
  ```
  and add to the returned object (after `overrideError: row.overrideError ?? null,`, dossier 1066):
  ```ts
      votes: rfpVotes,
  ```

- [ ] **Step 4: Run the test — expect PASS.**
  ```
  (cd server && npx vitest run tests/modules/deals/rfp-review-votes.runtime.test.ts)
  ```
  Expected: 1 passing.

- [ ] **Step 5: Add `votes` to the client `RfpReviewDetail` type.**
  In `client/src/hooks/use-rfp-review.ts`, add to the `RfpReviewDetail` interface (after `actionable: boolean;`, line 24):
  ```ts
    votes: Array<{
      voterUserId: string | null;
      voterName: string | null;
      voterEmail: string;
      decision: "approve" | "reject";
      reason: string | null;
      votedAt: string;
    }>;
  ```

- [ ] **Step 6: Render the votes on the `/rfp-review` page.**
  In `client/src/pages/rfp-review/rfp-review-page.tsx`, add a `VotesPanel` component (place it next to `DealFacts`, after the `DealFacts` function, ~line 269):
  ```tsx
  function VotesPanel({ review }: { review: RfpReviewDetail }) {
    if (!review.votes || review.votes.length === 0) return null;
    return (
      <div className="rounded-lg border border-border">
        <div className="border-b border-border px-4 py-2.5">
          <span className="text-sm font-medium text-foreground">Vote record (2/3 no-go)</span>
        </div>
        <ul className="divide-y divide-border px-4">
          {review.votes.map((vote) => (
            <li key={`${vote.voterEmail}-${vote.votedAt}`} className="flex items-start justify-between gap-3 py-2.5">
              <div>
                <span className="text-sm font-medium text-foreground">{vote.voterName ?? vote.voterEmail}</span>
                <span className={`ml-2 text-sm ${vote.decision === "reject" ? "text-destructive" : "text-emerald-600"}`}>
                  {vote.decision === "reject" ? "Rejected" : "Approved"}
                </span>
                {vote.reason ? <p className="mt-0.5 text-sm text-muted-foreground">{vote.reason}</p> : null}
              </div>
              <span className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(vote.votedAt)}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  ```
  Render it right after `<DealFacts review={review} />` in the `RfpReviewPage` card content (dossier 431):
  ```tsx
          <DealFacts review={review} />
          <VotesPanel review={review} />
  ```

- [ ] **Step 7: Typecheck client + re-run server test.**
  ```
  (cd client && npx tsc -p tsconfig.json --noEmit)
  (cd server && npx vitest run tests/modules/deals/rfp-review-votes.runtime.test.ts)
  ```
  Expected: both clean/green.

- [ ] **Step 8: Commit.**
  ```
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting add server/src/modules/deals/rfp-override-service.ts server/tests/modules/deals/rfp-review-votes.runtime.test.ts client/src/hooks/use-rfp-review.ts client/src/pages/rfp-review/rfp-review-page.tsx
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting commit -m "feat(rfp-voting): surface the round's votes on the escalation review page

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 16 — Override-approve unification: voting-path deals funnel through `enqueueRfpBidBoardCreate` (contract #16)

Voting-path deals never create a SyncHub request row, so `deals.rfp_approval_request_id` is null and the legacy
`override-approve` POST (which needs that id) can't work. For a voting-path deal, Takashi/Adam's override-approve
uses the **same** `create-from-rfp` path as a 2/3-yes vote — i.e. `enqueueRfpBidBoardCreate` (Section B, contract
#11) — instead of POSTing SyncHub. The legacy service/type-4 path (which has a request id) is unchanged.

**Files:**
- Modify: `server/src/modules/deals/rfp-override-service.ts` (`RfpOverrideApprovalResult` 1085-1093; `requestOverrideApproval` input type + body 801-846)
- Modify: `server/src/modules/deals/routes.ts` (override-approve route call, 1576-1582)
- Create: `server/tests/modules/deals/rfp-override-unification.runtime.test.ts`

- [ ] **Step 1: Write the failing runtime test — voting-path enqueues, legacy still POSTs SyncHub.**
  Create `server/tests/modules/deals/rfp-override-unification.runtime.test.ts`:
  ```ts
  import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
  import { PGlite } from "@electric-sql/pglite";
  import { drizzle } from "drizzle-orm/pglite";

  vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));
  // Isolate the enqueue + audit side-effects so the test only needs the `deals` + `deal_history` tables.
  const mocks = vi.hoisted(() => ({ enqueue: vi.fn(async () => {}), logActivity: vi.fn(async () => {}) }));
  vi.mock("../../../src/modules/deals/rfp-enqueue.js", async (orig) => ({ ...((await orig()) as object), enqueueRfpBidBoardCreate: mocks.enqueue }));
  vi.mock("../../../src/modules/audit/audit-logger.js", () => ({
    logActivity: mocks.logActivity,
    buildAuditActorFromUser: () => ({ actorType: "user", userId: "x", name: "x", role: "x" }),
  }));

  import { requestOverrideApproval } from "../../../src/modules/deals/rfp-override-service.js";

  const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
  const VOTING_DEAL = U("d01"); // rfp_approval_request_id NULL — voting path
  const LEGACY_DEAL = U("d02"); // rfp_approval_request_id 4242 — service/type-4 legacy path
  const ACTOR = U("a01");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tdb: any;
  let pg: PGlite;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE deals (
        id uuid PRIMARY KEY, name text, deal_number text, project_number text,
        rfp_approval_status text, rfp_approval_request_id bigint,
        rfp_override_state text, rfp_override_error text, rfp_override_reviewed_at timestamptz,
        rfp_override_reviewed_by uuid, rfp_override_decision text, rfp_override_note text, updated_at timestamptz
      );
      CREATE TABLE deal_history (
        deal_id uuid, field_name text, old_value text, new_value text,
        changed_by uuid, source text, reason text, changed_at timestamptz
      );
    `);
    tdb = drizzle(pg);
  });

  afterAll(async () => { await pg.close(); });

  beforeEach(async () => {
    mocks.enqueue.mockClear();
    mocks.logActivity.mockClear();
    await pg.query("DELETE FROM deals");
    await pg.query("DELETE FROM deal_history");
    await pg.query(
      `INSERT INTO deals (id, name, rfp_approval_status, rfp_approval_request_id) VALUES ($1,'Voting deal','declined',NULL),($2,'Legacy deal','declined',4242)`,
      [VOTING_DEAL, LEGACY_DEAL]
    );
  });

  describe("requestOverrideApproval unification", () => {
    it("voting-path deal (request_id null): enqueues create-from-rfp, does NOT POST SyncHub", async () => {
      const fetchImpl = vi.fn();
      const result = await requestOverrideApproval(
        { tenantDb: tdb, dealId: VOTING_DEAL, officeId: "office-1", actor: { userId: ACTOR, name: "Adam", role: "admin" }, approverEmail: "adam@trockgc.com", note: null },
        { fetchImpl: fetchImpl as unknown as typeof fetch, env: { SYNCHUB_SHARED_SECRET: "s" } }
      );
      expect(result.ok).toBe(true);
      expect(mocks.enqueue).toHaveBeenCalledTimes(1);
      expect(mocks.enqueue.mock.calls[0][0]).toMatchObject({ officeId: "office-1" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("legacy path (request_id present): POSTs SyncHub, does NOT enqueue create-from-rfp", async () => {
      const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
      const result = await requestOverrideApproval(
        { tenantDb: tdb, dealId: LEGACY_DEAL, officeId: "office-1", actor: { userId: ACTOR, name: "Adam", role: "admin" }, approverEmail: "adam@trockgc.com", note: null },
        { fetchImpl: fetchImpl as unknown as typeof fetch, env: { SYNCHUB_SHARED_SECRET: "s", SYNCHUB_BASE_URL: "http://synchub.test" } }
      );
      expect(result.ok).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(String(fetchImpl.mock.calls[0][0])).toContain("/api/rfp-requests/4242/override-approve");
      expect(mocks.enqueue).not.toHaveBeenCalled();
    });
  });
  ```

  > **Mock path (reconciled with Section B).** `enqueueRfpBidBoardCreate` is a SERVER helper that lives in
  > `server/src/modules/deals/rfp-enqueue.ts` (Section B, Task 7 — next to `enqueueRfpVoteInvitation` /
  > `enqueueRfpVoteOutcome`); the server enqueues jobs itself and never imports the worker package (the worker's
  > job **handler** stays in `worker/src/jobs/rfp-bidboard-create.ts`). The test **partial-mocks** that module
  > (`{ ...(await orig()), enqueueRfpBidBoardCreate: mocks.enqueue }`) so the module's other real exports still load.

- [ ] **Step 2: Run the test — expect FAIL.**
  ```
  (cd server && npx vitest run tests/modules/deals/rfp-override-unification.runtime.test.ts)
  ```
  Expected: FAIL — today the voting-path deal returns `{ ok:false, reason:"missing_request_id" }` (the `requestId <= 0` guard), so `result.ok` is false and the enqueue is never called.

- [ ] **Step 3: Add `officeId` to the input + the voting-path branch in `requestOverrideApproval`.**
  In `server/src/modules/deals/rfp-override-service.ts`, add the import (near line 7):
  ```ts
  import { enqueueRfpBidBoardCreate } from "./rfp-enqueue.js";
  ```
  Add `officeId` to the `requestOverrideApproval` input object type (dossier 801-808):
  ```ts
    input: {
      tenantDb: TenantDb;
      dealId: string;
      officeId: string | null;
      actor: RfpOverrideActor;
      approverEmail: string;
      note: string | null;
    },
  ```
  Replace the current `requestId` guard block (dossier 841-846) with the branch. Today it reads:
  ```ts
    const requestId = reset.rfpApprovalRequestId;
    if (typeof requestId !== "number" || !Number.isInteger(requestId) || requestId <= 0) {
      // Declined deals that ran the pipeline always carry the SyncHub request id; guard defensively so the route
      // rolls back rather than POSTing to a `/null/override-approve` URL.
      return { ok: false, reason: "missing_request_id" };
    }
  ```
  Change to:
  ```ts
    const requestId = reset.rfpApprovalRequestId;

    // VOTING-PATH deals never create a SyncHub request row (rfp_approval_request_id stays null). Their
    // override-approve funnels through the SAME create-from-rfp path as a 2/3-yes vote (enqueueRfpBidBoardCreate),
    // not SyncHub's override-approve (which requires a pre-existing declined request row). One create path, two
    // triggers (vote-yes + override-approve). The 'approving' write persists; the bid-board-created callback
    // advances the deal exactly as the legacy path's callback does.
    if (requestId == null) {
      await writeOverrideHistory(input.tenantDb, {
        dealId: input.dealId,
        fieldName: "rfp_override_state",
        oldValue: priorOverrideState,
        newValue: "approving",
        changedBy: input.actor.userId,
        source: "rfp_override_approve",
        reason: input.note,
      });
      await logActivity({
        tenantDb: input.tenantDb,
        actor: buildAuditActorFromUser({ userId: input.actor.userId, name: input.actor.name, role: input.actor.role }),
        action: "update",
        entity: {
          tableName: "deals",
          entityType: "deal",
          recordId: input.dealId,
          nameSnapshot: String(reset.name ?? "Deal"),
          secondaryIdSnapshot: (reset.projectNumber ?? reset.dealNumber ?? null) as string | null,
        },
        fieldChanges: { rfpOverrideState: { from: priorOverrideState, to: "approving" } },
        metadata: { rfpOverrideAction: "override_approve_via_create_from_rfp", approverEmail: input.approverEmail, rfpOverrideNote: input.note },
      });
      await enqueueRfpBidBoardCreate({ tenantDb: input.tenantDb, officeId: input.officeId, deal: reset });
      return { ok: true, status: "approving", requestId: 0 };
    }

    // LEGACY (service/type-4): a declined deal that ran the SyncHub pipeline always carries the request id.
    if (typeof requestId !== "number" || !Number.isInteger(requestId) || requestId <= 0) {
      return { ok: false, reason: "missing_request_id" };
    }
  ```
  (The legacy branch below — `writeOverrideHistory` / `logActivity` / SyncHub POST at dossier 848-940 — is unchanged.)

- [ ] **Step 4: Thread `officeId` from the override-approve route.**
  In `server/src/modules/deals/routes.ts`, the `requestOverrideApproval({ … })` call at 1576-1582 — add `officeId`:
  ```ts
      const result = await requestOverrideApproval({
        tenantDb: req.tenantDb!,
        dealId: req.params.id as string,
        officeId: req.user!.activeOfficeId ?? req.user!.officeId ?? null,
        actor: { userId: req.user!.id, name: req.user!.displayName, role: req.user!.role },
        approverEmail: req.user!.email,
        note: normalizeRfpOverrideNote(req.body?.note),
      });
  ```

- [ ] **Step 5: Run the test — expect PASS.**
  ```
  (cd server && npx vitest run tests/modules/deals/rfp-override-unification.runtime.test.ts)
  ```
  Expected: 2 passing (voting-path enqueues + no POST; legacy POSTs + no enqueue).

- [ ] **Step 6: Commit.**
  ```
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting add server/src/modules/deals/rfp-override-service.ts server/src/modules/deals/routes.ts server/tests/modules/deals/rfp-override-unification.runtime.test.ts
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting commit -m "feat(rfp-voting): route voting-path override-approve through create-from-rfp

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 17 — Read-only vote panel in `RfpApprovalStatusBlock` + poll-while-pending (contract #17)

Add a read-only panel (extracted to its own file so it is unit-testable without mounting the whole detail page)
showing each cast vote (choice / reason / time), the running tally, "needs 2 of 3", and — only when
`user.isRfpVoter` and the user hasn't voted — an inline "Cast your vote" link to `/rfp-vote/:dealId`. Poll the detail
every 5s while the round is unresolved, reusing the `/rfp-review` interval pattern.

**Files:**
- Create: `client/src/pages/deals/rfp-vote-panel.tsx`
- Create: `client/src/pages/deals/rfp-vote-panel.runtime.test.tsx`
- Modify: `client/src/pages/deals/deal-detail-page.tsx` (import; `RfpApprovalStatusBlock` signature + render at 1460-1584; poll near the `useDealDetail` call at 315-320; block render at 944-953)

- [ ] **Step 1: Write the failing client test for `RfpVotePanel`.**
  Create `client/src/pages/deals/rfp-vote-panel.runtime.test.tsx`:
  ```tsx
  // @vitest-environment jsdom
  import { act } from "react";
  import { createRoot, type Root } from "react-dom/client";
  import { MemoryRouter } from "react-router-dom";
  import { beforeEach, describe, expect, it } from "vitest";
  import { RfpVotePanel } from "./rfp-vote-panel";

  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const baseDeal = {
    id: "deal-1",
    rfpApprovalStatus: "pending",
    rfpVotes: [
      { voterUserId: "u-sid", voterName: "Sidney Gibson", voterEmail: "sidney@trockgc.com", decision: "approve", reason: null, votedAt: "2026-07-02T19:14:00Z" },
      { voterUserId: "u-jam", voterName: "James Helms", voterEmail: "james@trockgc.com", decision: "reject", reason: "Margins too thin for this scope", votedAt: "2026-07-02T19:20:00Z" },
    ],
    rfpVoteState: { approvals: 1, rejections: 1, outcome: "pending", decidedAt: null },
  } as never;

  let container: HTMLDivElement;
  let root: Root | null = null;

  async function render(node: React.ReactElement) {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(<MemoryRouter>{node}</MemoryRouter>);
    });
  }

  beforeEach(() => {
    root?.unmount();
    root = null;
    document.body.innerHTML = "";
  });

  describe("RfpVotePanel", () => {
    it("renders each cast vote (choice + reason + time), the tally, and 'needs 2 of 3'", async () => {
      await render(<RfpVotePanel deal={baseDeal} user={{ id: "u-x", email: "someone@trockgc.com", isRfpVoter: false, officeId: null }} officeId={null} />);
      expect(container.textContent).toContain("Sidney Gibson");
      expect(container.textContent).toContain("Approved");
      expect(container.textContent).toContain("James Helms");
      expect(container.textContent).toContain("Margins too thin for this scope");
      expect(container.textContent).toContain("1 approve");
      expect(container.textContent).toContain("1 reject");
      expect(container.textContent).toContain("needs 2 of 3");
    });

    it("shows a 'Cast your vote' link only for an eligible voter who has not voted", async () => {
      // Eligible + not yet voted -> link present.
      await render(<RfpVotePanel deal={baseDeal} user={{ id: "u-tim", email: "tim@trockgc.com", isRfpVoter: true, officeId: null }} officeId="office-1" />);
      const link = container.querySelector('a[href*="/rfp-vote/deal-1"]');
      expect(link).not.toBeNull();
      expect((link as HTMLAnchorElement).getAttribute("href")).toContain("officeId=office-1");
    });

    it("hides 'Cast your vote' when the eligible voter has already voted", async () => {
      await render(<RfpVotePanel deal={baseDeal} user={{ id: "u-sid", email: "sidney@trockgc.com", isRfpVoter: true, officeId: null }} officeId={null} />);
      expect(container.querySelector('a[href*="/rfp-vote/deal-1"]')).toBeNull();
    });
  });
  ```

- [ ] **Step 2: Run the test — expect FAIL (module missing).**
  ```
  (cd client && npx vitest run src/pages/deals/rfp-vote-panel.runtime.test.tsx)
  ```
  Expected: FAIL — cannot resolve `./rfp-vote-panel`.

- [ ] **Step 3: Create `client/src/pages/deals/rfp-vote-panel.tsx`.**
  ```tsx
  import { Link } from "react-router-dom";
  import type { DealDetail } from "@/hooks/use-deals";
  import type { User } from "@/lib/auth";

  function formatVoteTime(value: string): string {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  /**
   * Read-only vote panel shown inside the RFP approval status block for a Pending-RFP non-service deal. Displays
   * each cast vote (choice + reason + time), the running tally, and the "needs 2 of 3" caption. An eligible voter
   * (user.isRfpVoter) who has not yet voted gets an inline "Cast your vote" deep link to the focused vote page.
   * The tally/outcome come straight from deal.rfpVoteState (the server's computeRfpVoteState) — never recomputed.
   */
  export function RfpVotePanel({
    deal,
    user,
    officeId,
  }: {
    deal: DealDetail;
    user: User | null;
    officeId: string | null;
  }) {
    const state = deal.rfpVoteState;
    if (!state) return null;

    const votes = deal.rfpVotes ?? [];
    const awaiting = Math.max(0, 3 - votes.length);
    const hasVoted = votes.some(
      (v) => (user?.id != null && v.voterUserId === user.id) || (!!user?.email && v.voterEmail.toLowerCase() === user.email.toLowerCase())
    );
    const canCast = state.outcome === "pending" && Boolean(user?.isRfpVoter) && !hasVoted;
    const voteHref = `/rfp-vote/${deal.id}${officeId ? `?officeId=${encodeURIComponent(officeId)}` : ""}`;

    const tally =
      state.outcome === "approved"
        ? "Approved by vote (2 of 3) — creating Bid Board…"
        : state.outcome === "rejected"
          ? "Rejected by vote (2 of 3)"
          : `${state.approvals} approve · ${state.rejections} reject — no decision yet`;

    return (
      <div className="mt-3 rounded-md border border-border bg-background/60 p-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">RFP Approval Vote</p>
          <span className="text-xs text-muted-foreground">Pending · needs 2 of 3</span>
        </div>
        <ul className="mt-2 divide-y divide-border">
          {votes.map((vote) => (
            <li key={`${vote.voterEmail}-${vote.votedAt}`} className="flex items-start justify-between gap-3 py-1.5">
              <div>
                <span className="text-sm font-medium">{vote.voterName ?? vote.voterEmail}</span>
                <span className={`ml-2 text-sm ${vote.decision === "reject" ? "text-red-600" : "text-emerald-600"}`}>
                  {vote.decision === "reject" ? "Rejected" : "Approved"}
                </span>
                {vote.reason ? <p className="mt-0.5 text-sm text-muted-foreground">{vote.reason}</p> : null}
              </div>
              <span className="whitespace-nowrap text-xs text-muted-foreground">{formatVoteTime(vote.votedAt)}</span>
            </li>
          ))}
          {awaiting > 0 &&
            Array.from({ length: awaiting }).map((_, i) => (
              <li key={`awaiting-${i}`} className="py-1.5 text-sm text-muted-foreground">
                ⏳ Awaiting vote
              </li>
            ))}
        </ul>
        <p className="mt-2 text-sm">
          Tally: {tally}
        </p>
        {canCast && (
          <Link
            to={voteHref}
            className="mt-2 inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent"
          >
            Cast your vote
          </Link>
        )}
      </div>
    );
  }
  ```

- [ ] **Step 4: Run the test — expect PASS.**
  ```
  (cd client && npx vitest run src/pages/deals/rfp-vote-panel.runtime.test.tsx)
  ```
  Expected: 3 passing.

- [ ] **Step 5: Render `RfpVotePanel` inside `RfpApprovalStatusBlock` + thread `user`/`officeId`.**
  In `client/src/pages/deals/deal-detail-page.tsx`:
  - Add the import near the top imports (after line ~74):
    ```tsx
    import { RfpVotePanel } from "./rfp-vote-panel";
    ```
  - Extend the `RfpApprovalStatusBlock` prop object type (dossier 79-92) with two props:
    ```tsx
      user,
      officeId,
    }: {
      deal: DealDetail;
      onRetry: () => void;
      retrying: boolean;
      onCancel?: () => void;
      canCancel?: boolean;
      cancelling?: boolean;
      isOpportunityStage: boolean;
      isBidBoardOwned: boolean;
      user: ReturnType<typeof useAuth>["user"];
      officeId: string | null;
    }) {
    ```
  - Inside the block's returned `<section>`, render the panel just before the closing `</section>` (after the actions `</div>`, dossier 190-192):
    ```tsx
        <RfpVotePanel deal={deal} user={user} officeId={officeId} />
      </section>
    ```
  - At the render site (dossier 944-953), pass the two new props:
    ```tsx
        <RfpApprovalStatusBlock
          deal={deal}
          onRetry={handleRfpRetry}
          retrying={rfpRetrying}
          onCancel={handleCancelRfp}
          canCancel={canCancelRfp}
          cancelling={rfpCancelling}
          isOpportunityStage={isOpportunityStage}
          isBidBoardOwned={isBidBoardOwned}
          user={user}
          officeId={detailOfficeId}
        />
    ```
    (`user` is already in scope from `const { user } = useAuth();` at dossier 317; `detailOfficeId` from `searchParams.get("officeId")` at dossier 318.)

- [ ] **Step 6: Add the poll-while-pending effect near the `useDealDetail` call.**
  In `deal-detail-page.tsx`, after `const { deal, loading, error, refetch } = useDealDetail(id, { officeId: detailOfficeId });` (dossier 319), add:
  ```tsx
    // Poll the detail every 5s while the RFP vote round is unresolved so the panel flips to decided (go/no-go)
    // without a manual refresh. Mirrors the /rfp-review 5s interval; stops once the outcome is decided (votes are
    // final) or there's no open round.
    useEffect(() => {
      if (deal?.rfpVoteState?.outcome !== "pending") return;
      if (deal?.rfpApprovalStatus !== "pending" && deal?.rfpApprovalStatus !== "pending_outbox") return;
      const interval = setInterval(() => {
        refetch();
      }, 5000);
      return () => clearInterval(interval);
    }, [deal?.rfpVoteState?.outcome, deal?.rfpApprovalStatus, refetch]);
  ```
  (`useEffect` is already imported in this page.)

- [ ] **Step 7: Re-run the panel test + typecheck the page.**
  ```
  (cd client && npx vitest run src/pages/deals/rfp-vote-panel.runtime.test.tsx)
  (cd client && npx tsc -p tsconfig.json --noEmit)
  ```
  Expected: 3 passing; typecheck clean.

- [ ] **Step 8: Commit.**
  ```
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting add client/src/pages/deals/rfp-vote-panel.tsx client/src/pages/deals/rfp-vote-panel.runtime.test.tsx client/src/pages/deals/deal-detail-page.tsx
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting commit -m "feat(rfp-voting): read-only vote panel + poll-while-pending on the deal card

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 18 — Focused `/rfp-vote/:dealId` page + `useRfpVote` hook (contract #18)

Mirror `rfp-review-page.tsx` / `use-rfp-review.ts`: a login-gated, single-purpose page reached from the invitation
email. It reuses the detail payload (which already carries `rfpVotes` + `rfpVoteState` from Task 14) and POSTs
`/deals/:id/rfp-vote`. Selecting **Reject** reveals a required reason field.

**Files:**
- Create: `client/src/hooks/use-rfp-vote.ts`
- Create: `client/src/pages/rfp-vote/rfp-vote-page.tsx`
- Create: `client/src/pages/rfp-vote/rfp-vote-page.runtime.test.tsx`
- Modify: `client/src/App.tsx` (import at ~11; route registration after line 223)

- [ ] **Step 1: Write the failing page test.**
  Create `client/src/pages/rfp-vote/rfp-vote-page.runtime.test.tsx`:
  ```tsx
  // @vitest-environment jsdom
  import { act } from "react";
  import { createRoot, type Root } from "react-dom/client";
  import { MemoryRouter, Routes, Route } from "react-router-dom";
  import { beforeEach, describe, expect, it, vi } from "vitest";

  const mocks = vi.hoisted(() => ({ apiMock: vi.fn(), useAuthMock: vi.fn() }));
  vi.mock("@/lib/api", () => ({ api: mocks.apiMock }));
  vi.mock("@/lib/auth", () => ({ useAuth: mocks.useAuthMock }));

  import { RfpVotePage } from "./rfp-vote-page";

  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const detail = {
    deal: {
      id: "deal-1",
      name: "Terraces Re-Roof",
      projectNumber: "DFW-1-100",
      rfpApprovalStatus: "pending",
      rfpVotes: [],
      rfpVoteState: { approvals: 0, rejections: 0, outcome: "pending", decidedAt: null },
    },
  };

  let container: HTMLDivElement;
  let root: Root | null = null;

  async function render() {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(
        <MemoryRouter initialEntries={["/rfp-vote/deal-1"]}>
          <Routes>
            <Route path="/rfp-vote/:dealId" element={<RfpVotePage />} />
          </Routes>
        </MemoryRouter>
      );
    });
    // let the detail fetch settle
    await act(async () => { await Promise.resolve(); });
  }

  function click(el: Element | null) { return act(async () => { (el as HTMLElement).click(); }); }

  beforeEach(() => {
    root?.unmount();
    root = null;
    document.body.innerHTML = "";
    mocks.apiMock.mockReset();
    mocks.useAuthMock.mockReturnValue({ user: { id: "u-tim", email: "tim@trockgc.com", isRfpVoter: true, officeId: null } });
  });

  describe("RfpVotePage", () => {
    it("reveals a required reason field when Reject is chosen and POSTs decision+reason", async () => {
      mocks.apiMock.mockResolvedValueOnce(detail); // GET /deals/deal-1/detail
      await render();

      // Choose Reject -> reason textarea appears.
      const rejectRadio = container.querySelector('input[value="reject"]');
      expect(rejectRadio).not.toBeNull();
      await click(rejectRadio);
      const reason = container.querySelector("textarea");
      expect(reason).not.toBeNull();

      // Submitting with an empty reason is blocked (button disabled), then enabled once a reason is typed.
      const submit = Array.from(container.querySelectorAll("button")).find((b) => /submit vote/i.test(b.textContent ?? ""))!;
      expect((submit as HTMLButtonElement).disabled).toBe(true);

      await act(async () => {
        const ta = reason as HTMLTextAreaElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
        setter.call(ta, "Margins too thin");
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect((submit as HTMLButtonElement).disabled).toBe(false);

      mocks.apiMock.mockResolvedValueOnce({ outcome: "pending", votes: [] }); // POST /deals/deal-1/rfp-vote
      await click(submit);

      const postCall = mocks.apiMock.mock.calls.find((c) => String(c[0]).includes("/rfp-vote"));
      expect(postCall).toBeTruthy();
      expect(postCall![1]).toMatchObject({ method: "POST", json: { decision: "reject", reason: "Margins too thin" } });
    });

    it("blocks a non-voter with an access-restricted message", async () => {
      mocks.useAuthMock.mockReturnValue({ user: { id: "u-x", email: "x@trockgc.com", isRfpVoter: false, officeId: null } });
      await render();
      expect(container.textContent).toMatch(/only the designated rfp voters/i);
      expect(mocks.apiMock).not.toHaveBeenCalled();
    });
  });
  ```

- [ ] **Step 2: Run the test — expect FAIL (page missing).**
  ```
  (cd client && npx vitest run src/pages/rfp-vote/rfp-vote-page.runtime.test.tsx)
  ```
  Expected: FAIL — cannot resolve `./rfp-vote-page`.

- [ ] **Step 3: Create the `useRfpVote` hook.**
  Create `client/src/hooks/use-rfp-vote.ts`:
  ```ts
  import { useCallback, useEffect, useRef, useState } from "react";
  import { api } from "@/lib/api";
  import { getOfficeRequestOptions } from "@/lib/office-selection";
  import type { DealDetail } from "@/hooks/use-deals";

  export interface RfpVoteDeal {
    id: string;
    name: string;
    projectNumber: string | null;
    rfpApprovalStatus: string | null;
    rfpVotes: DealDetail["rfpVotes"];
    rfpVoteState: DealDetail["rfpVoteState"];
  }

  /**
   * Loads a deal's vote detail (reusing the deal detail payload, which carries rfpVotes + rfpVoteState) and casts a
   * vote. Mirrors use-rfp-review: target-change vs silent-poll refetch, gated to voters by the caller (dealId is
   * passed undefined for non-voters so no request fires).
   */
  export function useRfpVote(dealId: string | undefined, officeId?: string | null) {
    const [deal, setDeal] = useState<RfpVoteDeal | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const loadedKeyRef = useRef<string | null>(null);

    const fetchDeal = useCallback(async () => {
      if (!dealId) {
        setLoading(false);
        return;
      }
      const key = `${dealId}|${officeId ?? ""}`;
      const isTargetChange = loadedKeyRef.current !== key;
      if (isTargetChange) {
        setLoading(true);
        setDeal(null);
        setError(null);
      }
      try {
        const data = await api<{ deal: DealDetail }>(`/deals/${dealId}/detail`, getOfficeRequestOptions(officeId));
        setDeal({
          id: data.deal.id,
          name: data.deal.name,
          projectNumber: (data.deal.projectNumber as string | null) ?? null,
          rfpApprovalStatus: data.deal.rfpApprovalStatus ?? null,
          rfpVotes: data.deal.rfpVotes,
          rfpVoteState: data.deal.rfpVoteState,
        });
        setError(null);
        loadedKeyRef.current = key;
      } catch (err: unknown) {
        if (isTargetChange) setError(err instanceof Error ? err.message : "Failed to load the RFP vote");
      } finally {
        if (isTargetChange) setLoading(false);
      }
    }, [dealId, officeId]);

    useEffect(() => {
      fetchDeal();
    }, [fetchDeal]);

    return { deal, loading, error, refetch: fetchDeal };
  }

  /** Cast a vote. Reject requires a non-empty reason (the server also enforces this: 400 RFP_VOTE_REASON_REQUIRED). */
  export async function castRfpVote(
    dealId: string,
    input: { decision: "approve" | "reject"; reason?: string | null; officeId?: string | null }
  ): Promise<{ outcome: "pending" | "approved" | "rejected"; votes: unknown[] }> {
    return api<{ outcome: "pending" | "approved" | "rejected"; votes: unknown[] }>(`/deals/${dealId}/rfp-vote`, {
      method: "POST",
      json: input.decision === "reject" ? { decision: "reject", reason: input.reason ?? "" } : { decision: "approve" },
      ...getOfficeRequestOptions(input.officeId),
    });
  }
  ```

- [ ] **Step 4: Create the `/rfp-vote/:dealId` page.**
  Create `client/src/pages/rfp-vote/rfp-vote-page.tsx`:
  ```tsx
  import { useState } from "react";
  import { Link, useParams, useSearchParams } from "react-router-dom";
  import { toast } from "sonner";
  import { useAuth } from "@/lib/auth";
  import { castRfpVote, useRfpVote } from "@/hooks/use-rfp-vote";
  import { Button, buttonVariants } from "@/components/ui/button";
  import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
  import { Textarea } from "@/components/ui/textarea";
  import { Label } from "@/components/ui/label";

  function PageFrame({ children }: { children: React.ReactNode }) {
    return <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-8">{children}</div>;
  }

  export function RfpVotePage() {
    const { dealId } = useParams<{ dealId: string }>();
    const [searchParams] = useSearchParams();
    const officeId = searchParams.get("officeId");
    const { user } = useAuth();
    const { deal, loading, error, refetch } = useRfpVote(user?.isRfpVoter ? dealId : undefined, officeId);
    const [decision, setDecision] = useState<"approve" | "reject" | null>(null);
    const [reason, setReason] = useState("");
    const [submitting, setSubmitting] = useState(false);

    if (!user?.isRfpVoter) {
      return (
        <PageFrame>
          <Card>
            <CardHeader>
              <CardTitle>Vote access restricted</CardTitle>
              <CardDescription>Only the designated RFP voters can open this page. Contact an administrator if this is a mistake.</CardDescription>
            </CardHeader>
            <CardFooter>
              <Link to="/" className={buttonVariants({ variant: "outline" })}>Back to dashboard</Link>
            </CardFooter>
          </Card>
        </PageFrame>
      );
    }

    if (loading) {
      return <PageFrame><p className="text-sm text-muted-foreground">Loading the RFP…</p></PageFrame>;
    }

    if (error || !deal) {
      return (
        <PageFrame>
          <Card>
            <CardHeader>
              <CardTitle>Couldn’t load this RFP</CardTitle>
              <CardDescription>{error ?? "The deal could not be found."}</CardDescription>
            </CardHeader>
            <CardFooter className="gap-2">
              <Button variant="outline" onClick={() => refetch()}>Try again</Button>
              <Link to="/" className={buttonVariants({ variant: "ghost" })}>Back to dashboard</Link>
            </CardFooter>
          </Card>
        </PageFrame>
      );
    }

    const alreadyVoted = deal.rfpVotes.some(
      (v) => (user.id != null && v.voterUserId === user.id) || (!!user.email && v.voterEmail.toLowerCase() === user.email.toLowerCase())
    );
    const decided = deal.rfpVoteState.outcome !== "pending";
    const rejectNeedsReason = decision === "reject" && reason.trim().length === 0;
    const canSubmit = decision !== null && !rejectNeedsReason && !submitting && !alreadyVoted && !decided;

    async function onSubmit() {
      if (!dealId || decision === null) return;
      setSubmitting(true);
      try {
        const result = await castRfpVote(dealId, { decision, reason: decision === "reject" ? reason.trim() : null, officeId });
        toast.success(
          result.outcome === "approved"
            ? "Vote recorded — 2/3 approved, creating the Bid Board project."
            : result.outcome === "rejected"
              ? "Vote recorded — 2/3 rejected, escalating for review."
              : "Vote recorded."
        );
        await refetch();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to record your vote");
      } finally {
        setSubmitting(false);
      }
    }

    const dealHref = `/deals/${deal.id}${officeId ? `?officeId=${encodeURIComponent(officeId)}` : ""}`;

    return (
      <PageFrame>
        <Card>
          <CardHeader>
            <CardTitle>Vote on this RFP</CardTitle>
            <CardDescription>
              {deal.name} · {deal.projectNumber ?? "Pending"} — two of three approvals create the Bid Board project;
              two rejections escalate for a final decision. Rejections require a reason.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Tally so far: {deal.rfpVoteState.approvals} approve · {deal.rfpVoteState.rejections} reject — needs 2 of 3.
            </p>

            {alreadyVoted || decided ? (
              <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
                <p className="font-medium text-foreground">
                  {decided ? "This round has been decided." : "You’ve already cast your vote."}
                </p>
                <p className="mt-1 text-muted-foreground">Votes are final. Open the deal to see the live tally.</p>
              </div>
            ) : (
              <>
                <fieldset className="flex flex-col gap-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name="decision" value="approve" checked={decision === "approve"} onChange={() => setDecision("approve")} />
                    Approve
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name="decision" value="reject" checked={decision === "reject"} onChange={() => setDecision("reject")} />
                    Reject
                  </label>
                </fieldset>

                {decision === "reject" && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="rfp-vote-reason">Reason (required)</Label>
                    <Textarea
                      id="rfp-vote-reason"
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="Why are you rejecting this RFP?"
                      rows={3}
                      disabled={submitting}
                    />
                  </div>
                )}

                <div>
                  <Button onClick={onSubmit} disabled={!canSubmit}>
                    {submitting ? "Submitting…" : "Submit vote"}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
          <CardFooter>
            <Link to={dealHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>Open the full deal</Link>
          </CardFooter>
        </Card>
      </PageFrame>
    );
  }
  ```

- [ ] **Step 5: Run the page test — expect PASS.**
  ```
  (cd client && npx vitest run src/pages/rfp-vote/rfp-vote-page.runtime.test.tsx)
  ```
  Expected: 2 passing.

- [ ] **Step 6: Register the route in `App.tsx`.**
  Add the import next to the existing `RfpReviewPage` import (App.tsx:11):
  ```tsx
  import { RfpVotePage } from "@/pages/rfp-vote/rfp-vote-page";
  ```
  Add the route immediately after the `/rfp-review/:dealId` route (App.tsx:223):
  ```tsx
                <Route path="/rfp-vote/:dealId" element={<RfpVotePage />} />
  ```

- [ ] **Step 7: Typecheck the client.**
  ```
  (cd client && npx tsc -p tsconfig.json --noEmit)
  ```
  Expected: clean.

- [ ] **Step 8: Commit.**
  ```
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting add client/src/hooks/use-rfp-vote.ts client/src/pages/rfp-vote/rfp-vote-page.tsx client/src/pages/rfp-vote/rfp-vote-page.runtime.test.tsx client/src/App.tsx
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting commit -m "feat(rfp-voting): focused /rfp-vote page + useRfpVote hook + route

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 19 — Rep outcome notification on a decided GO (contract #18)

On a decided round, notify by outcome. **GO (2/3 approve):** email the requesting rep "RFP approved (2/3) — creating
Bid Board". **NO-GO (2/3 reject):** email the requesting rep **+ the Takashi/Adam reviewers** (`resolveRfpReviewerEmails`)
the escalation with the `/rfp-review/:dealId` link. This NO-GO email is **app-driven** (not the DB trigger): migration
0148's `enqueue_rfp_rejected_email` trigger stays inert for a null-request-id voting decline (see Section B, Task 7),
so a voting no-go would otherwise send **nothing**. `castRfpVote` (Section B, Task 7) enqueues this `rfp_vote_outcome`
job in **both** decided branches via `enqueueRfpVoteOutcome`, carrying `outcome`. Mirror
`worker/src/jobs/rfp-rejection-email.ts`'s plumbing (branded template, `sendSystemEmailWithMetadata`,
`resolveFrontendUrl`, `escapeHtml`, and `resolveRfpReviewerEmails` for the reviewer set).

**Files:**
- Create: `worker/src/jobs/rfp-vote-outcome.ts`
- Create: `worker/tests/jobs/rfp-vote-outcome.runtime.test.ts`
- Modify: `worker/src/jobs/index.ts` (imports ~28-37; `registerAllJobs` block 121-133)

- [ ] **Step 1: Write the failing worker runtime test.**
  Create `worker/tests/jobs/rfp-vote-outcome.runtime.test.ts`:
  ```ts
  import { describe, expect, it, vi } from "vitest";
  import { handleRfpVoteOutcomeEmail } from "../../src/jobs/rfp-vote-outcome.js";

  function makeQuery(rows: Record<string, unknown[]>) {
    return vi.fn(async (sql: string) => {
      if (/FROM public\.users/i.test(sql)) return { rows: rows.users ?? [] };
      if (/FROM public\.offices/i.test(sql)) return { rows: rows.offices ?? [] };
      return { rows: [] };
    });
  }

  describe("handleRfpVoteOutcomeEmail (GO)", () => {
    it("emails ONLY the requesting rep with the 2/3-approved copy", async () => {
      const sendEmail = vi.fn(async () => ({ success: true, messageId: "m-1" }));
      const query = makeQuery({
        users: [{ email: "rep@trockgc.com" }],
        offices: [{ id: "office-1" }],
      });

      await handleRfpVoteOutcomeEmail(
        {
          tenantSchema: "office_dallas",
          dealId: "00000000-0000-0000-0000-000000000d01",
          dealName: "Terraces Re-Roof",
          dealNumber: "DFW-1-100",
          requestedByUserId: "00000000-0000-0000-0000-000000000a09",
          outcome: "approved",
          approvals: 2,
          rejections: 0,
        },
        null,
        { query: query as never, sendEmail: sendEmail as never, env: { FRONTEND_URL: "https://trockcrm.com" } }
      );

      expect(sendEmail).toHaveBeenCalledTimes(1);
      const [to, subject, html] = sendEmail.mock.calls[0];
      expect(to).toEqual(["rep@trockgc.com"]); // rep only — leadership is the NO-GO path, not this one
      expect(String(subject)).toMatch(/approved/i);
      expect(String(html)).toContain("2 of 3");
      expect(String(html)).toMatch(/creating the Bid Board/i);
    });

    it("no-ops (no throw, no send) when the requesting rep can't be resolved", async () => {
      const sendEmail = vi.fn(async () => ({ success: true, messageId: "m-2" }));
      const query = makeQuery({ users: [], offices: [{ id: "office-1" }] });
      await handleRfpVoteOutcomeEmail(
        { tenantSchema: "office_dallas", dealId: "00000000-0000-0000-0000-000000000d01", dealName: "X", dealNumber: null, requestedByUserId: null, approvals: 2, rejections: 0 },
        null,
        { query: query as never, sendEmail: sendEmail as never, env: {} }
      );
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it("NO-GO emails the requesting rep AND the Takashi/Adam reviewers with the /rfp-review link", async () => {
      const sendEmail = vi.fn(async () => ({ success: true, messageId: "m-3" }));
      const query = makeQuery({ users: [{ email: "rep@trockgc.com" }], offices: [{ id: "office-1" }] });
      await handleRfpVoteOutcomeEmail(
        { tenantSchema: "office_dallas", dealId: "00000000-0000-0000-0000-000000000d01", dealName: "Terraces Re-Roof", dealNumber: "DFW-1-100", requestedByUserId: "00000000-0000-0000-0000-000000000a09", outcome: "rejected", approvals: 1, rejections: 2 },
        null,
        { query: query as never, sendEmail: sendEmail as never, env: { FRONTEND_URL: "https://trockcrm.com", RFP_REJECTION_EMAIL_RECIPIENTS: "takashi@trockgc.com, adam@trockgc.com" } }
      );
      expect(sendEmail).toHaveBeenCalledTimes(1);
      const [to, subject, html] = sendEmail.mock.calls[0];
      expect(to).toEqual(expect.arrayContaining(["rep@trockgc.com", "takashi@trockgc.com", "adam@trockgc.com"]));
      expect(String(subject)).toMatch(/rejected|review/i);
      expect(String(html)).toContain("/rfp-review/00000000-0000-0000-0000-000000000d01");
    });
  });
  ```

- [ ] **Step 2: Run the test — expect FAIL (module missing).**
  ```
  (cd worker && npx vitest run tests/jobs/rfp-vote-outcome.runtime.test.ts)
  ```
  Expected: FAIL — cannot resolve `../../src/jobs/rfp-vote-outcome.js`.

- [ ] **Step 3: Create `worker/src/jobs/rfp-vote-outcome.ts`.**
  ```ts
  import { pool } from "../db.js";
  import { sendSystemEmailWithMetadata, type SendSystemEmailResult } from "../lib/system-email.js";
  import { resolveFrontendUrl, TROCK_LOGO_EMAIL_URL } from "./project-number-email.js";
  import { escapeHtml, normalizeText, isSafeTenantSchema } from "../lib/email-format.js";
  import { resolveRfpReviewerEmails } from "@trock-crm/shared/lib/rfpReviewerEmails";

  export const RFP_VOTE_OUTCOME_JOB = "rfp_vote_outcome";

  interface RfpVoteOutcomePayload {
    tenantSchema?: string;
    dealId?: string;
    dealName?: string;
    dealNumber?: string | null;
    requestedByUserId?: string | null;
    outcome?: "approved" | "rejected";
    approvals?: number;
    rejections?: number;
  }

  interface HandlerDeps {
    query?: typeof pool.query;
    sendEmail?: (
      to: string | string[],
      subject: string,
      html: string,
      options: { text: string; idempotencyKey: string }
    ) => Promise<SendSystemEmailResult>;
    env?: NodeJS.ProcessEnv;
    logger?: Pick<Console, "log" | "warn" | "error">;
  }

  /**
   * Outcome notification for a DECIDED vote round. GO (approved): email the requesting rep that the RFP passed and
   * the Bid Board project is being created. NO-GO (rejected): email the requesting rep + the Takashi/Adam reviewers
   * (resolveRfpReviewerEmails) the escalation with the /rfp-review link — the APP-DRIVEN no-go escalation, because
   * migration 0148's trigger stays inert for a null-request-id voting decline (no double-send). Enqueued by
   * castRfpVote in BOTH decided branches (enqueueRfpVoteOutcome, carrying `outcome`). If no recipient resolves we
   * log + no-op (the create/decline already happened — this is an FYI, not a gate).
   */
  export async function handleRfpVoteOutcomeEmail(
    payload: RfpVoteOutcomePayload,
    _officeId: string | null,
    deps: HandlerDeps = {}
  ) {
    const logger = deps.logger ?? console;
    const tenantSchema = payload.tenantSchema;
    const dealId = payload.dealId;
    if (!isSafeTenantSchema(tenantSchema) || !dealId) {
      logger.warn("[RfpVoteOutcome] Invalid job payload - skipping", { tenantSchema, dealId });
      return;
    }

    const query = deps.query ?? pool.query.bind(pool);

    const env = deps.env ?? process.env;
    const outcome = payload.outcome === "rejected" ? "rejected" : "approved";

    const requestedByUserId = normalizeText(payload.requestedByUserId);
    let repEmail: string | null = null;
    if (requestedByUserId) {
      const repResult = await query(`SELECT email FROM public.users WHERE id = $1::uuid LIMIT 1`, [requestedByUserId]);
      repEmail = normalizeText(repResult.rows[0]?.email ?? null);
    }

    // GO -> just the requesting rep. NO-GO -> rep + the Takashi/Adam reviewers (same allowlist the DB-trigger
    // escalation would have used), deduped. If nothing resolves we log + no-op (the create/decline already happened).
    const reviewerEmails = outcome === "rejected" ? resolveRfpReviewerEmails(env) : [];
    const recipients = Array.from(new Set([repEmail, ...reviewerEmails].filter((e): e is string => !!e)));
    if (recipients.length === 0) {
      logger.warn("[RfpVoteOutcome] No resolvable recipients - skipping outcome notification", { dealId, outcome });
      return;
    }

    const officeResult = await query(
      `SELECT id FROM public.offices WHERE ('office_' || slug) = $1 AND is_active = true LIMIT 1`,
      [tenantSchema]
    );
    const officeId = (officeResult.rows[0]?.id as string | undefined) ?? null;

    const emailInput = {
      dealId,
      dealName: normalizeText(payload.dealName) ?? "Deal",
      dealNumber: normalizeText(payload.dealNumber),
      officeId,
      frontendUrl: resolveFrontendUrl(env),
    };
    const email = outcome === "rejected" ? buildRfpVoteRejectedEmail(emailInput) : buildRfpVoteApprovedEmail(emailInput);

    try {
      const sendEmail = deps.sendEmail ?? sendSystemEmailWithMetadata;
      const sendResult = await sendEmail(recipients, email.subject, email.html, {
        text: email.text,
        idempotencyKey: `rfp-vote-${outcome}-${tenantSchema}-${dealId}`,
      });
      if (!sendResult.success) throw new Error("Email provider returned unsuccessful result");
      logger.log("[RfpVoteOutcome] Sent outcome notification", { dealId, outcome, recipientCount: recipients.length, messageId: sendResult.messageId });
    } catch (error) {
      logger.error("[RfpVoteOutcome] Failed to send outcome notification", { dealId, outcome, error });
      throw error;
    }
  }

  export function buildRfpVoteApprovedEmail(input: {
    dealId: string;
    dealName: string;
    dealNumber: string | null;
    officeId?: string | null;
    frontendUrl: string;
  }) {
    const officeParam = input.officeId ? `?officeId=${encodeURIComponent(input.officeId)}` : "";
    const baseUrl = input.frontendUrl.replace(/\/+$/, "");
    const dealUrl = `${baseUrl}/deals/${encodeURIComponent(input.dealId)}${officeParam}`;
    const safeDealUrl = escapeHtml(dealUrl);
    const subject = input.dealNumber
      ? `RFP approved (2/3): ${input.dealNumber} (${input.dealName})`
      : `RFP approved (2/3): ${input.dealName}`;
    const text = `Your RFP for ${input.dealName}${input.dealNumber ? ` (${input.dealNumber})` : ""} was approved by vote (2 of 3). We're creating the Bid Board project now. Open the deal: ${dealUrl}`;
    const html = `<!DOCTYPE html>
  <html><body style="margin:0;padding:0;background-color:#f4f4f5;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
      <tr><td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid #e2e8f0;">
          <tr><td style="background-color:#059669;height:4px;line-height:4px;font-size:4px;">&nbsp;</td></tr>
          <tr><td align="center" style="padding:28px 24px 8px 24px;">
            <img src="${TROCK_LOGO_EMAIL_URL}" alt="T Rock Construction" width="220" height="246" style="display:block;width:220px;height:246px;border:0;" />
          </td></tr>
          <tr><td align="center" style="padding:4px 24px 0 24px;">
            <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:26px;color:#111111;font-weight:bold;">RFP Approved (2 of 3)</h1>
          </td></tr>
          <tr><td align="center" style="padding:6px 24px 16px 24px;">
            <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#64748b;">
              Your RFP for ${escapeHtml(input.dealName)} was approved by vote. We’re creating the Bid Board project now — the deal will advance to Estimating automatically when it’s done.
            </p>
          </td></tr>
          <tr><td align="center" style="padding:24px 24px 28px 24px;">
            <a href="${safeDealUrl}" style="display:inline-block;background-color:#059669;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;line-height:44px;text-align:center;text-decoration:none;width:240px;border-radius:4px;">View Deal in CRM</a>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>`;
    return { subject, html, text, dealNumber: input.dealNumber };
  }

  export function buildRfpVoteRejectedEmail(input: {
    dealId: string;
    dealName: string;
    dealNumber: string | null;
    officeId?: string | null;
    frontendUrl: string;
  }) {
    const officeParam = input.officeId ? `?officeId=${encodeURIComponent(input.officeId)}` : "";
    const baseUrl = input.frontendUrl.replace(/\/+$/, "");
    const reviewUrl = `${baseUrl}/rfp-review/${encodeURIComponent(input.dealId)}${officeParam}`;
    const safeReviewUrl = escapeHtml(reviewUrl);
    const subject = input.dealNumber
      ? `RFP rejected (2/3) — review needed: ${input.dealNumber} (${input.dealName})`
      : `RFP rejected (2/3) — review needed: ${input.dealName}`;
    const text = `The RFP for ${input.dealName}${input.dealNumber ? ` (${input.dealNumber})` : ""} was rejected by vote (2 of 3). Review & decide (approve the override or confirm the denial): ${reviewUrl}`;
    const html = `<!DOCTYPE html>
  <html><body style="margin:0;padding:0;background-color:#f4f4f5;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
      <tr><td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid #e2e8f0;">
          <tr><td style="background-color:#CC0000;height:4px;line-height:4px;font-size:4px;">&nbsp;</td></tr>
          <tr><td align="center" style="padding:28px 24px 8px 24px;">
            <img src="${TROCK_LOGO_EMAIL_URL}" alt="T Rock Construction" width="220" height="246" style="display:block;width:220px;height:246px;border:0;" />
          </td></tr>
          <tr><td align="center" style="padding:4px 24px 0 24px;">
            <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:26px;color:#111111;font-weight:bold;">RFP Rejected (2 of 3) — Review Needed</h1>
          </td></tr>
          <tr><td align="center" style="padding:6px 24px 16px 24px;">
            <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#64748b;">
              The RFP for ${escapeHtml(input.dealName)} was rejected by a 2-of-3 vote. As a designated reviewer you can approve the override (create the Bid Board project anyway) or confirm the denial.
            </p>
          </td></tr>
          <tr><td align="center" style="padding:24px 24px 28px 24px;">
            <a href="${safeReviewUrl}" style="display:inline-block;background-color:#CC0000;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;line-height:44px;text-align:center;text-decoration:none;width:240px;border-radius:4px;">Review &amp; Decide</a>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>`;
    return { subject, html, text, dealNumber: input.dealNumber };
  }
  ```

- [ ] **Step 4: Run the test — expect PASS.**
  ```
  (cd worker && npx vitest run tests/jobs/rfp-vote-outcome.runtime.test.ts)
  ```
  Expected: 2 passing (rep-only recipient + "2 of 3"/"creating the Bid Board" copy; no-op when rep unresolved).

- [ ] **Step 5: Register the job handler.**
  In `worker/src/jobs/index.ts`, add the import next to the other RFP job imports (dossier index.ts:28-37 area):
  ```ts
  import { handleRfpVoteOutcomeEmail, RFP_VOTE_OUTCOME_JOB } from "./rfp-vote-outcome.js";
  ```
  Add the registration inside `registerAllJobs()` next to `RFP_OVERRIDE_APPROVED_JOB` (dossier index.ts:121-133):
  ```ts
    registerJobHandler(RFP_VOTE_OUTCOME_JOB, handleRfpVoteOutcomeEmail);
  ```

  > **Enqueue seam (Section B, Task 7).** `castRfpVote` calls `enqueueRfpVoteOutcome` in BOTH decided branches — a
  > `job_queue` row `jobType: RFP_VOTE_OUTCOME_JOB` with payload `{ tenantSchema, dealId, dealName, dealNumber,
  > requestedByUserId, outcome, approvals, rejections }` — in the same transaction as the create (GO) / decline
  > (NO-GO). So the rep GO email fires when the create is dispatched, and the NO-GO escalation fires when the deal is
  > declined. Section B owns that insert; Task 19 owns the handler (both outcomes) + registration + email copy above.

- [ ] **Step 6: Commit.**
  ```
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting add worker/src/jobs/rfp-vote-outcome.ts worker/tests/jobs/rfp-vote-outcome.runtime.test.ts worker/src/jobs/index.ts
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting commit -m "feat(rfp-voting): rep GO-outcome notification (2/3 approved)

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 20 — Feature flag `isRfpVotingEnabled` (contract #19) + Rollout & config

The flag `isRfpVotingEnabled` that gates the non-service voting branch is **defined in Task 8 (Section B)** — it
reads `ENABLE_RFP_VOTING` and ships **inert** (OFF). This task adds a dedicated flag test and the code-free rollout
checklist; it does **not** redefine the flag (re-adding it would be a duplicate export / compile error).

**Files:**
- Create: `server/src/config/feature-flags-voting.runtime.test.ts`
- (Flag `isRfpVotingEnabled` already added to `server/src/config/feature-flags.ts` by Task 8 — do NOT redefine it.)

- [ ] **Step 1: Write the failing flag test.**
  Create `server/src/config/feature-flags-voting.runtime.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { isRfpVotingEnabled } from "./feature-flags.js";

  describe("isRfpVotingEnabled", () => {
    it("is OFF by default (unset) — the feature ships inert", () => {
      expect(isRfpVotingEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    });
    it("is OFF for any value other than the exact string 'true'", () => {
      expect(isRfpVotingEnabled({ ENABLE_RFP_VOTING: "1" } as unknown as NodeJS.ProcessEnv)).toBe(false);
      expect(isRfpVotingEnabled({ ENABLE_RFP_VOTING: "false" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    });
    it("is ON only when ENABLE_RFP_VOTING === 'true'", () => {
      expect(isRfpVotingEnabled({ ENABLE_RFP_VOTING: "true" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    });
  });
  ```

- [ ] **Step 2: Run the test — expect FAIL.**
  ```
  (cd server && npx vitest run --config vitest.ci.config.ts src/config/feature-flags-voting.runtime.test.ts)
  ```
  (The `src/**` include lives in the CI config; the default `vitest.config.ts` include is `tests/**` only.)
  Expected: FAIL — `isRfpVotingEnabled` is not exported.

- [ ] **Step 3: Confirm the flag exists (added by Task 8) — do NOT redefine it.**
  `isRfpVotingEnabled` already lives in `server/src/config/feature-flags.ts` from Task 8 (reads `ENABLE_RFP_VOTING`,
  OFF by default). Re-adding it here would be a duplicate export. This task only adds the dedicated test below.
  Verify it is present:
  ```
  grep -n "export function isRfpVotingEnabled" server/src/config/feature-flags.ts
  ```
  Expected: exactly one match (from Task 8).

- [ ] **Step 4: Run the test — expect PASS.**
  ```
  (cd server && npx vitest run --config vitest.ci.config.ts src/config/feature-flags-voting.runtime.test.ts)
  ```
  Expected: 3 passing.

  > **Consumer (Section B, contract #9).** trigger-rfp's non-service branch is wrapped:
  > `if (isServiceRfp(deal)) { /* existing SyncHub email path, unchanged */ } else if (isRfpVotingEnabled()) { await openRfpVoteRound(...); } else { /* existing behavior */ }`.
  > With the flag OFF the whole voting feature is dead code at runtime — safe to merge before rollout.

- [ ] **Step 5: Commit.**
  ```
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting add server/src/config/feature-flags-voting.runtime.test.ts
  git -C /Users/adnaaniqbal/Developer/trockcrm--wt-rfp-voting commit -m "test(rfp-voting): dedicated isRfpVotingEnabled flag test

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

#### Rollout & config checklist (NOT code — verification only)

> **Prod data writes / env changes are run by Adnaan, not the implementer.** The implementer prepares the migration
> and inert code; Adnaan runs `migrations/0173_rfp_votes.sql` against prod, sets the env vars, and flips the flag.
> These steps are verification + a runbook, not TDD.

- [ ] **V1 — Migration applied per office.** Confirm `migrations/0173_rfp_votes.sql` ran on prod and created
  `rfp_votes` in **every** `office_%` schema (not just `office_dallas`) plus the `TENANT_SCHEMA` template for new
  offices. Verify (read-only):
  ```sql
  SELECT table_schema FROM information_schema.tables WHERE table_name = 'rfp_votes' ORDER BY 1;
  ```
  Expect one row per active office schema. (Migration numbers are not enforced unique; 0172 is the current highest —
  re-confirm 0173 is still free at apply time.)

- [ ] **V2 — `RFP_VOTER_EMAILS` set on BOTH server and worker.** The trio (Sidney, Tim, James) must be present on
  the **server** service (auth `isRfpVoter` flag + `requireRfpVoter` gate) AND the **worker** service (invitation +
  outcome emails). Unset ⇒ `resolveRfpVoterEmails` fails closed (`[]`) in prod, so no one can vote. Cross-check that
  the resolved list matches the auth flag: a voter logging in must see `user.isRfpVoter === true`.

- [ ] **V3 — Confirm Tim's exact CRM user + email.** Known Tim-vs-Timothy ambiguity in the estimator mapping. Before
  enabling, verify the email in `RFP_VOTER_EMAILS` resolves to a real, active `public.users` row (so
  `voter_user_id` binds and the `UNIQUE(deal_id, round_event_id, voter_user_id)` locks work). Read-only:
  ```sql
  SELECT id, display_name, email, is_active FROM public.users WHERE lower(email) = lower('<tim-email>');
  ```
  Expect exactly one active row. (If Tim votes while unmatched, `voter_user_id` would be null and two null-voter
  rows could both insert — the unique index treats nulls as distinct. So a real user row is required before flip.)

- [ ] **V4 — `RFP_REQUEST_SYNC_SECRET` / `SYNCHUB_SHARED_SECRET` + `TROCK_CRM_BASE_URL` provisioned both directions.**
  The GO path posts CRM→SyncHub `/api/bid-board/create-from-rfp` (HMAC via the shared secret) and SyncHub calls back
  CRM `/api/internal/bid-board-created` (verified with `SYNCHUB_SHARED_SECRET`). These are used in code but were
  missing from SyncHub's `.env.example` — confirm both services actually have them, and that `TROCK_CRM_BASE_URL`
  (SyncHub→CRM callback host) points at prod. Without these, a 2/3-yes vote records votes but never creates the
  Bid Board project.

- [ ] **V5 — SyncHub `create-from-rfp` deployed.** The new HMAC endpoint (Section B / SyncHub companion change) must
  be live in `trocksynchubv3` before the flag flips, or GO-path enqueued jobs will 404 and dead-letter.

- [ ] **V6 — Flip the flag.** Set `ENABLE_RFP_VOTING=true` on the **server** (gates the trigger branch). Since
  `ENABLE_OPPORTUNITY_RFP_EVENT` must already be `true` for RFP to trigger at all, confirm it is on. After the flip,
  trigger an RFP on one non-service test deal and confirm: (a) no SyncHub `/api/rfp-requests` call fires, (b) three
  invitation emails go out, (c) the deal shows the vote panel on the card, (d) two approvals create the Bid Board
  project and advance the deal to Estimating, (e) two rejections escalate to the Takashi/Adam review page showing the
  votes.

- [ ] **V7 — Rollback lever.** If anything misbehaves, set `ENABLE_RFP_VOTING=false` — trigger-rfp immediately
  reverts to prior behavior; service/type-4 was never affected; already-cast `rfp_votes` rows are inert (nothing
  reads them once the branch is off). No data migration needed to roll back.
