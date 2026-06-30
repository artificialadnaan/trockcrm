# Pending RFP Bucket — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface RFP-triggered-but-not-approved deals in a dedicated "Pending RFP" bucket (a pipeline-board column + a shared dashboard) so they stop getting overlooked in Opportunity.

**Architecture:** Approach B — a *derived* bucket. No new pipeline stage, no migration, no change to trigger/approve/decline logic. A single shared predicate (`stage=opportunity ∧ ¬is_bid_board_owned ∧ rfp_approval_status ∈ pending-set`) drives one new cross-rep read endpoint (`GET /deals/pending-rfp`), which feeds both a dedicated dashboard page and a client-merged synthetic board column. A `POST /deals/:id/cancel-rfp` escape hatch returns a deal to plain Opportunity.

**Tech Stack:** TypeScript monorepo — `shared` (Drizzle schema + pure types, vitest), `server` (Express + Drizzle + PGlite tests), `client` (React + react-router + vitest/jsdom). Shared alias `@trock-crm/shared/...`, client alias `@/...`. Spec: `docs/superpowers/specs/2026-06-29-pending-rfp-bucket-design.md`.

---

## File structure

**Create:**
- `shared/src/types/rfp-pending.ts` — the pending-RFP status constants + pure helpers (`isPendingRfpDeal`, `pendingRfpSubStateForStatus`).
- `shared/src/types/rfp-pending.test.ts` — unit tests for the helpers.
- `server/src/modules/deals/pending-rfp-service.ts` — `getPendingRfpDeals(tenantDb)` + the SQL predicate, and `cancelPendingRfp(...)`.
- `server/tests/modules/deals/pending-rfp-service.runtime.test.ts` — PGlite predicate/query test.
- `server/tests/modules/deals/pending-rfp-routes.test.ts` — route permission/guard tests (mock-stack).
- `client/src/pages/deals/pending-rfp-page.tsx` — the dashboard page.
- `client/src/pages/deals/pending-rfp-page.test.tsx` — page render test.

**Modify:**
- `shared/src/types/index.ts` — add `export * from "./rfp-pending.js";`.
- `server/src/modules/deals/routes.ts` — register `GET /pending-rfp` (above `/:id`) and `POST /:id/cancel-rfp`.
- `client/src/hooks/use-deals.ts` — add `usePendingRfp()` hook + `PendingRfpDeal` type.
- `client/src/App.tsx` — register `/deals/pending-rfp` route (above `/deals/:id`).
- `client/src/components/layout/sidebar.tsx` (+ `mobile-nav.tsx`) — add nav item.
- `client/src/lib/canonical-deal-board.ts` — add the synthetic "Pending RFP" column + exclude those deals from Opportunity (extra `pendingRfpDeals` param).
- `client/src/lib/pipeline-ownership.ts` — add `pending_rfp` to the board slug order + its label.
- `client/src/pages/deals/deal-list-page.tsx` (or the board page) — fetch `usePendingRfp()` and pass to `buildCanonicalDealBoardColumns`.
- `client/src/pages/deals/deal-detail-page.tsx` — "Return to Opportunity (cancel pending RFP)" button.

---

## Task 1: Shared predicate + status constants

**Files:**
- Create: `shared/src/types/rfp-pending.ts`
- Create (test): `shared/src/types/rfp-pending.test.ts`
- Modify: `shared/src/types/index.ts`

- [ ] **Step 1: Write the failing test** — `shared/src/types/rfp-pending.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  PENDING_RFP_STATUSES,
  pendingRfpSubStateForStatus,
  isPendingRfpDeal,
} from "./rfp-pending.js";

describe("pendingRfpSubStateForStatus", () => {
  it.each([
    ["pending_outbox", "awaiting"],
    ["pending", "awaiting"],
    ["declined", "attention"],
    ["conflict", "attention"],
    ["send_failed", "attention"],
  ] as const)("maps %s -> %s", (status, expected) => {
    expect(pendingRfpSubStateForStatus(status)).toBe(expected);
  });

  it.each([null, undefined, "", "approved", "cancelled_source_ineligible"] as const)(
    "returns null for non-pending status %s",
    (status) => {
      expect(pendingRfpSubStateForStatus(status)).toBeNull();
    },
  );

  it("exposes the full pending set", () => {
    expect([...PENDING_RFP_STATUSES].sort()).toEqual(
      ["conflict", "declined", "pending", "pending_outbox", "send_failed"],
    );
  });
});

describe("isPendingRfpDeal", () => {
  const base = { stageSlug: "opportunity", isBidBoardOwned: false, rfpApprovalStatus: "pending" };
  it("is true for an opportunity deal with a pending status and not bid-board-owned", () => {
    expect(isPendingRfpDeal(base)).toBe(true);
    expect(isPendingRfpDeal({ ...base, rfpApprovalStatus: "declined" })).toBe(true);
  });
  it("is false off-opportunity, bid-board-owned, approved, or no status", () => {
    expect(isPendingRfpDeal({ ...base, stageSlug: "estimating" })).toBe(false);
    expect(isPendingRfpDeal({ ...base, isBidBoardOwned: true })).toBe(false);
    expect(isPendingRfpDeal({ ...base, rfpApprovalStatus: "approved" })).toBe(false);
    expect(isPendingRfpDeal({ ...base, rfpApprovalStatus: null })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd shared && npx vitest run src/types/rfp-pending.test.ts`
Expected: FAIL — `Cannot find module './rfp-pending.js'`.

- [ ] **Step 3: Implement** — `shared/src/types/rfp-pending.ts`

```ts
// Single source of truth for the "Pending RFP" bucket: deals whose RFP was triggered but not yet
// approved. Mirrors the rfp_approval_status strings written by the trigger/decline flows.
// Note: the failed-delivery status is stored as "send_failed" (not "failed"); "approved" leaves the
// bucket via the stage advance; "cancelled_source_ineligible" is a terminal cancellation (excluded).
export const PENDING_RFP_AWAITING_STATUSES = ["pending_outbox", "pending"] as const;
export const PENDING_RFP_ATTENTION_STATUSES = ["declined", "conflict", "send_failed"] as const;
export const PENDING_RFP_STATUSES = [
  ...PENDING_RFP_AWAITING_STATUSES,
  ...PENDING_RFP_ATTENTION_STATUSES,
] as const;

export type PendingRfpStatus = (typeof PENDING_RFP_STATUSES)[number];
export type PendingRfpSubState = "awaiting" | "attention";

export function pendingRfpSubStateForStatus(
  status: string | null | undefined,
): PendingRfpSubState | null {
  if (!status) return null;
  if ((PENDING_RFP_AWAITING_STATUSES as readonly string[]).includes(status)) return "awaiting";
  if ((PENDING_RFP_ATTENTION_STATUSES as readonly string[]).includes(status)) return "attention";
  return null;
}

export function isPendingRfpDeal(deal: {
  stageSlug?: string | null;
  isBidBoardOwned?: boolean | null;
  rfpApprovalStatus?: string | null;
}): boolean {
  return (
    deal.stageSlug === "opportunity" &&
    !deal.isBidBoardOwned &&
    pendingRfpSubStateForStatus(deal.rfpApprovalStatus) !== null
  );
}
```

- [ ] **Step 4: Export it** — append to `shared/src/types/index.ts`

```ts
export * from "./rfp-pending.js";
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `cd shared && npx vitest run src/types/rfp-pending.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Build shared so server/client (tsc) can resolve it**

Run: `cd shared && npm run build`
Expected: exits 0 (the new file compiles into `dist/`).

- [ ] **Step 7: Commit**

```bash
git add shared/src/types/rfp-pending.ts shared/src/types/rfp-pending.test.ts shared/src/types/index.ts
git commit -m "feat(shared): pending-RFP status constants + isPendingRfpDeal predicate"
```

---

## Task 2: Server `getPendingRfpDeals` service + SQL predicate

**Files:**
- Create: `server/src/modules/deals/pending-rfp-service.ts`
- Create (test): `server/tests/modules/deals/pending-rfp-service.runtime.test.ts`

Pattern refs: office scoping is by tenant SCHEMA, not a WHERE clause (`service.ts:222-232`) — so a cross-rep office read needs **no owner filter and no office WHERE**; mirror the owner join + test-data filter from `service.ts:3092-3104` / `242-245`; resolve the stage slug → ids via `pipeline_stage_config` (`routes.ts:661-671`).

- [ ] **Step 1: Write the failing PGlite test** — `server/tests/modules/deals/pending-rfp-service.runtime.test.ts`

Mirror `server/tests/modules/deals/involved-rep-predicate.runtime.test.ts`. Seed a minimal `pipeline_stage_config`, `users`, and `deals`, then assert membership + ordering + fields.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getPendingRfpDeals } from "../../../src/modules/deals/pending-rfp-service.js";

let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text, is_active_pipeline boolean DEFAULT true);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text, project_number text, deal_number text, workflow_route text,
      stage_id uuid, is_bid_board_owned boolean DEFAULT false, is_active boolean DEFAULT true,
      is_test_data boolean DEFAULT false, assigned_rep_id uuid,
      rfp_approval_status text, rfp_approval_requested_at timestamptz, rfp_approval_requested_by uuid,
      rfp_declined_reason text
    );
    INSERT INTO pipeline_stage_config (id, slug) VALUES
      ('00000000-0000-0000-0000-0000000000aa','opportunity'),
      ('00000000-0000-0000-0000-0000000000bb','estimating');
    INSERT INTO users (id, display_name) VALUES
      ('00000000-0000-0000-0000-0000000000r1','Rep One'),
      ('00000000-0000-0000-0000-0000000000d1','Director One');
    -- pending (oldest) — should be FIRST, owned by rep1, triggered by director1
    INSERT INTO deals (id,name,workflow_route,stage_id,assigned_rep_id,rfp_approval_status,rfp_approval_requested_at,rfp_approval_requested_by)
      VALUES ('00000000-0000-0000-0000-00000000d001','Older Pending','normal','00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-0000000000r1','pending','2026-06-01T00:00:00Z','00000000-0000-0000-0000-0000000000d1');
    -- declined (newer) — should be SECOND, attention
    INSERT INTO deals (id,name,workflow_route,stage_id,assigned_rep_id,rfp_approval_status,rfp_approval_requested_at,rfp_declined_reason)
      VALUES ('00000000-0000-0000-0000-00000000d002','Newer Declined','service','00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-0000000000r1','declined','2026-06-10T00:00:00Z','missing docs');
    -- excluded: approved
    INSERT INTO deals (id,name,stage_id,rfp_approval_status) VALUES ('00000000-0000-0000-0000-00000000d003','Approved','00000000-0000-0000-0000-0000000000aa','approved');
    -- excluded: bid-board-owned
    INSERT INTO deals (id,name,stage_id,rfp_approval_status,is_bid_board_owned) VALUES ('00000000-0000-0000-0000-00000000d004','Owned','00000000-0000-0000-0000-0000000000aa','pending',true);
    -- excluded: not opportunity
    INSERT INTO deals (id,name,stage_id,rfp_approval_status) VALUES ('00000000-0000-0000-0000-00000000d005','Estimating','00000000-0000-0000-0000-0000000000bb','pending');
    -- excluded: test data
    INSERT INTO deals (id,name,stage_id,rfp_approval_status,is_test_data) VALUES ('00000000-0000-0000-0000-00000000d006','Test','00000000-0000-0000-0000-0000000000aa','pending',true);
    -- excluded: soft-deleted
    INSERT INTO deals (id,name,stage_id,rfp_approval_status,is_active) VALUES ('00000000-0000-0000-0000-00000000d007','Inactive','00000000-0000-0000-0000-0000000000aa','pending',false);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => { await pg?.close?.(); });

describe("getPendingRfpDeals", () => {
  it("returns only pending-RFP opportunity deals, oldest-first, with owner/trigger/age fields", async () => {
    const rows = await getPendingRfpDeals(tdb);
    expect(rows.map((r) => r.id)).toEqual([
      "00000000-0000-0000-0000-00000000d001",
      "00000000-0000-0000-0000-00000000d002",
    ]);
    expect(rows[0]).toMatchObject({
      name: "Older Pending", workflowRoute: "normal", subState: "awaiting",
      assignedRepName: "Rep One", triggeredByName: "Director One",
    });
    expect(rows[1]).toMatchObject({ subState: "attention", declineReason: "missing docs" });
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd server && npx vitest run tests/modules/deals/pending-rfp-service.runtime.test.ts`
Expected: FAIL — cannot find `pending-rfp-service.js` / `getPendingRfpDeals`.

- [ ] **Step 3: Implement** — `server/src/modules/deals/pending-rfp-service.ts`

> Verify before writing: `grep -n "workflowRoute\|projectNumber\|dealNumber\|displayName" shared/src/schema/tenant/deals.ts shared/src/schema/tenant/users.ts` to confirm the Drizzle field names used below (`deals.workflowRoute`, `deals.projectNumber`, `deals.dealNumber`, `users.displayName`). Adjust the select keys if they differ.

```ts
import { alias } from "drizzle-orm/pg-core";
import { and, asc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { deals, users } from "@trock-crm/shared/schema";
import { pipelineStageConfig } from "@trock-crm/shared/schema";
import { PENDING_RFP_STATUSES, pendingRfpSubStateForStatus, type PendingRfpSubState } from "@trock-crm/shared/types";

export interface PendingRfpDeal {
  id: string;
  name: string;
  projectNumber: string | null;
  dealNumber: string | null;
  workflowRoute: string;
  assignedRepId: string | null;
  assignedRepName: string | null;
  rfpApprovalStatus: string;
  subState: PendingRfpSubState;
  triggeredById: string | null;
  triggeredByName: string | null;
  triggeredAt: string | null;
  declineReason: string | null;
}

// Cross-rep, office-scoped (office isolation is enforced by the tenant schema, so there is NO owner
// filter and NO office WHERE here). Returns the Pending-RFP bucket, oldest-first.
export async function getPendingRfpDeals(tenantDb: any): Promise<PendingRfpDeal[]> {
  const oppStages = await tenantDb
    .select({ id: pipelineStageConfig.id })
    .from(pipelineStageConfig)
    .where(eq(pipelineStageConfig.slug, "opportunity"));
  const oppStageIds = oppStages.map((s: { id: string }) => s.id);
  if (oppStageIds.length === 0) return [];

  const triggeredBy = alias(users, "triggered_by");
  const rows = await tenantDb
    .select({
      ...getTableColumns(deals),
      assignedRepName: users.displayName,
      triggeredByName: triggeredBy.displayName,
    })
    .from(deals)
    .leftJoin(users, eq(users.id, deals.assignedRepId))
    .leftJoin(triggeredBy, eq(triggeredBy.id, deals.rfpApprovalRequestedBy))
    .where(
      and(
        inArray(deals.stageId, oppStageIds),
        eq(deals.isBidBoardOwned, false),
        inArray(deals.rfpApprovalStatus, [...PENDING_RFP_STATUSES]),
        eq(deals.isActive, true),
        sql`coalesce(${deals.isTestData}, false) = false`,
      ),
    )
    .orderBy(asc(deals.rfpApprovalRequestedAt));

  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    projectNumber: r.projectNumber ?? null,
    dealNumber: r.dealNumber ?? null,
    workflowRoute: r.workflowRoute ?? "normal",
    assignedRepId: r.assignedRepId ?? null,
    assignedRepName: r.assignedRepName ?? null,
    rfpApprovalStatus: r.rfpApprovalStatus,
    subState: pendingRfpSubStateForStatus(r.rfpApprovalStatus)!,
    triggeredById: r.rfpApprovalRequestedBy ?? null,
    triggeredByName: r.triggeredByName ?? null,
    triggeredAt: r.rfpApprovalRequestedAt ? new Date(r.rfpApprovalRequestedAt).toISOString() : null,
    declineReason: r.rfpDeclinedReason ?? null,
  }));
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd server && npx vitest run tests/modules/deals/pending-rfp-service.runtime.test.ts`
Expected: PASS. (If the seeded column names differ from the Drizzle field names, fix the select keys per the Step-3 verify note and re-run.)

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/deals/pending-rfp-service.ts server/tests/modules/deals/pending-rfp-service.runtime.test.ts
git commit -m "feat(deals): getPendingRfpDeals cross-rep office-scoped bucket query"
```

---

## Task 3: `GET /deals/pending-rfp` route

**Files:**
- Modify: `server/src/modules/deals/routes.ts` (register **above** the `/:id` GET route — Express matches in order, so a literal `/pending-rfp` must precede `/:id` or it'll be captured as `id="pending-rfp"`).
- Create (test): `server/tests/modules/deals/pending-rfp-routes.test.ts`

- [ ] **Step 1: Write the failing route test** — mirror `server/tests/modules/deals/rfp-override-routes.test.ts` (mock service deps, import `{ dealRoutes }`, walk `dealRoutes.stack`, run the handler against a fake req/res). Mock `getPendingRfpDeals` to return a fixture and assert it's wrapped into `res.json` after `commitTransaction`.

```ts
import { describe, expect, it, vi } from "vitest";
// (Copy the full vi.mock block from rfp-override-routes.test.ts so importing routes.ts is side-effect free,
//  then add:)
vi.mock("../../../src/modules/deals/pending-rfp-service.js", () => ({
  getPendingRfpDeals: vi.fn().mockResolvedValue([{ id: "d1", name: "X", subState: "awaiting" }]),
  cancelPendingRfp: vi.fn(),
}));

it("GET /pending-rfp returns the bucket and commits", async () => {
  const { dealRoutes } = await import("../../../src/modules/deals/routes.js");
  const res = makeRes();
  const commitTransaction = vi.fn().mockResolvedValue(undefined);
  await runRoute(dealRoutes, "get", "/pending-rfp", {
    user: { id: "u1", role: "rep", officeId: "o1" }, tenantDb: {}, commitTransaction,
  }, res);
  expect(commitTransaction).toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledWith({ deals: [{ id: "d1", name: "X", subState: "awaiting" }] });
});
```
(`makeRes`/`runRoute` are copied from `rfp-override-routes.test.ts:95-118`.)

- [ ] **Step 2: Run it, verify it fails**

Run: `cd server && npx vitest run tests/modules/deals/pending-rfp-routes.test.ts`
Expected: FAIL — no `/pending-rfp` route on the stack.

- [ ] **Step 3: Implement** — in `server/src/modules/deals/routes.ts`

Add the import near the other deals-service imports (top of file): `import { getPendingRfpDeals, cancelPendingRfp } from "./pending-rfp-service.js";`

Register the handler **before** the `GET "/:id"` route (search for `router.get("/:id"` and place this above it; the `/pipeline` and `/sources` literal routes are already above `/:id`, put it with them):

```ts
router.get("/pending-rfp", async (req, res, next) => {
  try {
    const deals = await getPendingRfpDeals(req.tenantDb!);
    await req.commitTransaction!();
    res.json({ deals });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd server && npx vitest run tests/modules/deals/pending-rfp-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/deals/routes.ts server/tests/modules/deals/pending-rfp-routes.test.ts
git commit -m "feat(deals): GET /deals/pending-rfp endpoint"
```

---

## Task 4: `POST /deals/:id/cancel-rfp` escape hatch

**Files:**
- Modify: `server/src/modules/deals/pending-rfp-service.ts` — add `cancelPendingRfp(...)`.
- Modify: `server/src/modules/deals/routes.ts` — add the route (mirror `trigger-rfp`, `routes.ts:1187-1336`).
- Modify (test): `server/tests/modules/deals/pending-rfp-routes.test.ts` — add permission/guard cases.

- [ ] **Step 1: Write the failing route tests** — add to `pending-rfp-routes.test.ts`

```ts
it("POST /:id/cancel-rfp 403s a non-owner rep", async () => {
  const { dealRoutes } = await import("../../../src/modules/deals/routes.js");
  const res = makeRes();
  await runRoute(dealRoutes, "post", "/:id/cancel-rfp", {
    params: { id: "deal-1" }, user: { id: "rep-2", role: "rep" },
    tenantDb: stubTenantDbWithDeal({ id: "deal-1", assignedRepId: "rep-1", stageSlug: "opportunity", rfpApprovalStatus: "declined", isBidBoardOwned: false }),
    commitTransaction: vi.fn(),
  }, res, next);
  expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
});

it("POST /:id/cancel-rfp clears the RFP fields for the owning rep", async () => {
  const cancel = (await import("../../../src/modules/deals/pending-rfp-service.js")).cancelPendingRfp as any;
  cancel.mockResolvedValue({ id: "deal-1" });
  const { dealRoutes } = await import("../../../src/modules/deals/routes.js");
  const res = makeRes(); const commitTransaction = vi.fn().mockResolvedValue(undefined);
  await runRoute(dealRoutes, "post", "/:id/cancel-rfp", {
    params: { id: "deal-1" }, user: { id: "rep-1", role: "rep" },
    tenantDb: stubTenantDbWithDeal({ id: "deal-1", assignedRepId: "rep-1", stageSlug: "opportunity", rfpApprovalStatus: "declined", isBidBoardOwned: false }),
    commitTransaction,
  }, res);
  expect(cancel).toHaveBeenCalled();
  expect(commitTransaction).toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
});
```
(Define `stubTenantDbWithDeal(deal)` returning a chainable mock whose `select().from().where().limit()` resolves `[deal]`, plus a `cancelPendingRfp` mock from the Task-3 `vi.mock`. Permission/guard logic lives in the route; `cancelPendingRfp` is mocked here and unit-tested in Step 4b.)

- [ ] **Step 2: Run it, verify it fails**

Run: `cd server && npx vitest run tests/modules/deals/pending-rfp-routes.test.ts`
Expected: FAIL — no `/:id/cancel-rfp` route.

- [ ] **Step 3: Implement the route** — `server/src/modules/deals/routes.ts` (place near `trigger-rfp`)

```ts
router.post("/:id/cancel-rfp", async (req, res, next) => {
  try {
    const dealId = req.params.id;
    const userRole = req.user!.role;
    const userId = req.user!.id;
    const [deal] = await req.tenantDb!.select().from(deals).where(eq(deals.id, dealId)).limit(1);
    if (!deal) throw new AppError(404, "Deal not found.");

    const canCancel =
      userRole === "admin" || userRole === "director" ||
      (userRole === "rep" && deal.assignedRepId === userId);
    if (!canCancel) {
      throw new AppError(403, "Only the assigned rep, a director, or an admin can cancel a pending RFP.", "RFP_CANCEL_UNAUTHORIZED");
    }

    const stageSlug = await loadDealStageSlug(req.tenantDb!, deal.stageId);
    if (toCanonicalDealStageSlug(stageSlug) !== "opportunity" || deal.isBidBoardOwned) {
      throw new AppError(409, "This deal is no longer a pending RFP.", "RFP_CANCEL_WRONG_STATE");
    }
    if (pendingRfpSubStateForStatus(deal.rfpApprovalStatus) === null) {
      throw new AppError(409, "This deal has no pending RFP to cancel.", "RFP_CANCEL_NOT_PENDING");
    }

    const updated = await cancelPendingRfp({
      tenantDb: req.tenantDb!, deal, changedByUserId: userId,
    });
    await req.commitTransaction!();
    res.json(toJsonSafe({ success: true, dealId: updated?.id ?? dealId }));
  } catch (err) {
    next(err);
  }
});
```
Add imports at the file top: `pendingRfpSubStateForStatus` from `@trock-crm/shared/types` (if not already). `loadDealStageSlug`, `toCanonicalDealStageSlug`, `toJsonSafe`, `AppError`, `deals`, `eq` are already imported (used by `trigger-rfp`).

- [ ] **Step 4a: Implement `cancelPendingRfp`** — `server/src/modules/deals/pending-rfp-service.ts`

Clears the RFP fields and writes `deal_history` + audit (mirror `rfp-decline-service.ts:30-83` for the history/audit shape).

```ts
import { writeDealHistoryAndAudit } from "...";   // reuse the project's deal_history + audit helper
                                                  // (see rfp-decline-service.ts:49-83 / routes.ts writeAuditLog)

export async function cancelPendingRfp(input: {
  tenantDb: any;
  deal: { id: string; rfpApprovalStatus: string | null; name?: string | null };
  changedByUserId: string;
}): Promise<{ id: string } | null> {
  const [updated] = await input.tenantDb
    .update(deals)
    .set({
      rfpApprovalStatus: null,
      rfpApprovalRequestedAt: null,
      rfpApprovalRequestedBy: null,
      rfpApprovalRequestEventId: null,
      rfpDeclinedReason: null,
      rfpDeclinedAt: null,
    })
    .where(and(eq(deals.id, input.deal.id), eq(deals.isBidBoardOwned, false)))
    .returning({ id: deals.id });
  if (updated) {
    // deal_history row: field "rfp_approval_status", old=input.deal.rfpApprovalStatus, new=null,
    // source "rfp_cancel", changed_by=input.changedByUserId  (copy the INSERT + logActivity shape
    // from rfp-decline-service.ts:49-83, action "update").
  }
  return updated ?? null;
}
```

> Verify before writing the history block: open `server/src/modules/deals/rfp-decline-service.ts:49-83` and copy its `deal_history` INSERT + `logActivity` call verbatim, substituting `new_value=null`, `source="rfp_cancel"`, and the actor = `buildAuditActorFromUser(req.user)` (pass the actor in via `input`). Keep it inside the same transaction (`input.tenantDb`).

- [ ] **Step 4b: Add a PGlite test for `cancelPendingRfp`** in `pending-rfp-service.runtime.test.ts`: seed a declined opportunity deal, call `cancelPendingRfp`, assert `rfp_approval_status` is now NULL and a `deal_history` row was written.

- [ ] **Step 5: Run the route + service tests, verify they pass**

Run: `cd server && npx vitest run tests/modules/deals/pending-rfp-routes.test.ts tests/modules/deals/pending-rfp-service.runtime.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/deals/pending-rfp-service.ts server/src/modules/deals/routes.ts server/tests/modules/deals/pending-rfp-routes.test.ts server/tests/modules/deals/pending-rfp-service.runtime.test.ts
git commit -m "feat(deals): POST /deals/:id/cancel-rfp escape hatch (return to Opportunity)"
```

---

## Task 5: Client hook + dashboard page + route + nav

**Files:**
- Modify: `client/src/hooks/use-deals.ts` — `usePendingRfp()` + `PendingRfpDeal` type (mirror `useDealBoard`, `use-deals.ts:860-930`).
- Create: `client/src/pages/deals/pending-rfp-page.tsx` (mirror `client/src/pages/pipeline/my-cleanup-page.tsx`).
- Create (test): `client/src/pages/deals/pending-rfp-page.test.tsx`.
- Modify: `client/src/App.tsx` — add `<Route path="/deals/pending-rfp" element={<PendingRfpPage />} />` **above** `/deals/:id` (App.tsx:217).
- Modify: `client/src/components/layout/sidebar.tsx` + `mobile-nav.tsx` — add nav item.

- [ ] **Step 1: Add the hook + type** — `client/src/hooks/use-deals.ts`

```ts
export interface PendingRfpDeal {
  id: string; name: string; projectNumber: string | null; dealNumber: string | null;
  workflowRoute: string; assignedRepId: string | null; assignedRepName: string | null;
  rfpApprovalStatus: string; subState: "awaiting" | "attention";
  triggeredById: string | null; triggeredByName: string | null;
  triggeredAt: string | null; declineReason: string | null;
}

export function usePendingRfp() {
  const [deals, setDeals] = useState<PendingRfpDeal[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    setLoading(true); setError(null);
    return api<{ deals: PendingRfpDeal[] }>("/deals/pending-rfp")
      .then((r) => { setDeals(r.deals); return r.deals; })
      .catch((e: unknown) => { setDeals(null); setError(e instanceof Error ? e.message : "Failed to load pending RFPs"); throw e; })
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { void refetch().catch(() => undefined); }, [refetch]);
  return { deals, loading, error, refetch };
}
```
(`api`, `useState`, `useCallback`, `useEffect` are already imported in this file.)

- [ ] **Step 2: Write the failing page test** — `client/src/pages/deals/pending-rfp-page.test.tsx` (jsdom; mirror an existing page test, mock `@/hooks/use-deals`'s `usePendingRfp`). Assert: rows render with name + rep + waiting-since, oldest-first, and a deal whose `triggeredAt` is older than `PENDING_RFP_STALE_DAYS` gets the stale highlight class.

```ts
// @vitest-environment jsdom
// vi.mock("@/hooks/use-deals", () => ({ usePendingRfp: () => ({ deals: FIXTURE, loading:false, error:null, refetch: vi.fn() }) }))
// render <PendingRfpPage/> in a MemoryRouter; expect text content to include both deal names, the rep names,
// and that the row for the 30-day-old deal carries the stale style (assert via a data-testid or class).
```

- [ ] **Step 3: Run it, verify it fails** — `cd client && npx vitest run src/pages/deals/pending-rfp-page.test.tsx` → FAIL (no page).

- [ ] **Step 4: Implement the page** — `client/src/pages/deals/pending-rfp-page.tsx`

A table (mirror `my-cleanup-page.tsx` structure + existing UI table components): columns Deal (name + project #, links to `/deals/:id`), Rep, Route, Status (badge by `subState`), Triggered by, Waiting since (age in days; rows with `ageDays >= PENDING_RFP_STALE_DAYS` get a red/warning style), Reason (when declined). Sorted as received (already oldest-first). Add a top-level constant `const PENDING_RFP_STALE_DAYS = 2;` and compute `ageDays` from `triggeredAt`. Loading/error states from the hook.

- [ ] **Step 5: Register the route** — `client/src/App.tsx`, import the page and add **above** `/deals/:id`:

```tsx
<Route path="/deals/pending-rfp" element={<PendingRfpPage />} />
```

- [ ] **Step 6: Add nav** — `client/src/components/layout/sidebar.tsx` `navItems` (and the mobile twin):

```ts
{ to: "/deals/pending-rfp", icon: Hourglass, label: "Pending RFP", roles: ["admin", "director", "rep"] },
```
(Import `Hourglass` from `lucide-react` at the top with the other icons.)

- [ ] **Step 7: Run page test, verify it passes** — `cd client && npx vitest run src/pages/deals/pending-rfp-page.test.tsx` → PASS.

- [ ] **Step 8: Commit**

```bash
git add client/src/hooks/use-deals.ts client/src/pages/deals/pending-rfp-page.tsx client/src/pages/deals/pending-rfp-page.test.tsx client/src/App.tsx client/src/components/layout/sidebar.tsx client/src/components/layout/mobile-nav.tsx
git commit -m "feat(deals): Pending RFP dashboard page + nav + usePendingRfp hook"
```

---

## Task 6: Synthetic "Pending RFP" board column (client-merge)

**Files:**
- Modify: `client/src/lib/pipeline-ownership.ts` — add `pending_rfp` to `DEAL_BOARD_STAGE_SLUGS` after `opportunity` (`pipeline-ownership.ts:44-53`) + a label in `getDealStageLabelBySlug` (`195-214`).
- Modify: `client/src/lib/canonical-deal-board.ts` — `buildCanonicalDealBoardColumns(rawColumns, stages, pendingRfpDeals?)`: build the `pending_rfp` column from `pendingRfpDeals`, and exclude pending-RFP deals from the `opportunity` column.
- Modify: `client/src/pages/deals/deal-list-page.tsx` (or the board page) — call `usePendingRfp()` and pass its `deals` to `buildCanonicalDealBoardColumns`.
- Modify (test): `client/src/lib/canonical-deal-board.test.ts`.

- [ ] **Step 1: Write the failing test** — add to `canonical-deal-board.test.ts`: given raw columns where an Opportunity card has `rfpApprovalStatus:"pending"` and `stageSlug:"opportunity"`, plus a `pendingRfpDeals` arg, assert (a) a `pending_rfp` column exists right after `opportunity`, (b) the pending deal appears in it, and (c) it is NOT in the `opportunity` column.

- [ ] **Step 2: Run it, verify it fails** — `cd client && npx vitest run src/lib/canonical-deal-board.test.ts` → FAIL.

- [ ] **Step 3: Implement.** In `pipeline-ownership.ts` insert `"pending_rfp"` into `DEAL_BOARD_STAGE_SLUGS` after `"opportunity"`, and add `pending_rfp: "Pending RFP"` to the slug→label map. In `canonical-deal-board.ts` `buildCanonicalDealBoardColumns`, add the optional `pendingRfpDeals: PendingRfpDeal[] = []` param; in the `.map((slug) => …)`:
  - for `slug === "pending_rfp"`: `cards = pendingRfpDeals` (already cross-rep, oldest-first), count/value from them;
  - for `slug === "opportunity"`: keep the existing card filter but add `&& !isPendingRfpDeal({ stageSlug: "opportunity", isBidBoardOwned: deal.isBidBoardOwned, rfpApprovalStatus: deal.rfpApprovalStatus })`.
  Import `isPendingRfpDeal` from `@trock-crm/shared/types`.

- [ ] **Step 4: Wire the board page** — in `deal-list-page.tsx` (or wherever `buildCanonicalDealBoardColumns` is called), add `const { deals: pendingRfp } = usePendingRfp();` and pass `pendingRfp ?? []` as the third arg.

- [ ] **Step 5: Run the board test, verify it passes** — `cd client && npx vitest run src/lib/canonical-deal-board.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/pipeline-ownership.ts client/src/lib/canonical-deal-board.ts client/src/lib/canonical-deal-board.test.ts client/src/pages/deals/deal-list-page.tsx
git commit -m "feat(deals): synthetic Pending RFP board column (client-merge, cross-rep)"
```

---

## Task 7: "Return to Opportunity" button (escape-hatch UI)

**Files:**
- Modify: `client/src/pages/deals/deal-detail-page.tsx` — a button next to the RFP badge (mirror `handleTriggerRfp` + the badge area, `deal-detail-page.tsx:628-653,1428-1516`).
- Modify (test): `client/src/pages/deals/deal-detail-page.test.tsx` (or a focused test) — the button shows for a pending-RFP deal to an allowed user, calls `POST /deals/:id/cancel-rfp`, and refetches.

- [ ] **Step 1: Write the failing test** — render the deal-detail RFP section for a deal with `rfpApprovalStatus:"declined"` and a user who is the owning rep; assert a "Return to Opportunity" button is present, clicking it calls `api("/deals/<id>/cancel-rfp", { method: "POST" })`, and `refetch` runs. Also assert it's absent for a non-owner rep.

- [ ] **Step 2: Run it, verify it fails** → FAIL.

- [ ] **Step 3: Implement.** Add `handleCancelRfp` mirroring `handleTriggerRfp` (`628-653`): `window.confirm(...)` → `await api(\`/deals/${deal.id}/cancel-rfp\`, { method: "POST" })` → `toast.success("Returned to Opportunity")` → `await refetch()`, with `cancelling` state + error. Render a sibling `<Button>` in the RFP badge area (`~1487-1516`), gated on `canTriggerRfp && pendingRfpSubStateForStatus(deal.rfpApprovalStatus) !== null` (import `pendingRfpSubStateForStatus` from `@trock-crm/shared/types`; `canTriggerRfp` already computed at `463-477`).

- [ ] **Step 4: Run the test, verify it passes** → PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/deals/deal-detail-page.tsx client/src/pages/deals/deal-detail-page.test.tsx
git commit -m "feat(deals): Return to Opportunity (cancel pending RFP) action on deal detail"
```

---

## Final verification

- [ ] Build shared, then typecheck + test the touched workspaces:
  - `cd shared && npm run build`
  - `cd server && npx tsc -p tsconfig.typecheck.json 2>&1 | grep -E "pending-rfp|routes.ts" || echo clean` and `npx vitest run --config vitest.ci.config.ts tests/modules/deals/pending-rfp-*`
  - `cd client && npx tsc --noEmit 2>&1 | grep -E "pending-rfp|canonical-deal-board|deal-detail|deal-list" || echo clean` and `npx vitest run src/pages/deals/pending-rfp-page.test.tsx src/lib/canonical-deal-board.test.ts`
- [ ] Run the full gate locally before PR (`TZ=UTC`), since the build-gate runs the whole suite.
- [ ] Manual smoke (per the `verify` skill): trigger an RFP on an Opportunity deal → it appears in the Pending RFP column + dashboard; decline (or simulate) → stays flagged "Declined"; approve → moves to Estimating and leaves the bucket; "Return to Opportunity" → drops back to plain Opportunity.

## Self-review (done while writing)

- **Spec coverage:** predicate (Task 1), endpoint (Task 3) + query (Task 2), cancel hatch (Task 4 + Task 7), dashboard (Task 5), board column cross-rep via client-merge (Task 6), visibility cross-rep (Task 2 has no owner filter), staleness highlight (Task 5). All spec sections map to a task.
- **Status set:** uses `send_failed` (not `failed`) and excludes `approved`/`cancelled_source_ineligible` — consistent across Tasks 1/2/6/7.
- **Type consistency:** `PendingRfpDeal` shape identical in server (Task 2) and client (Task 5); `isPendingRfpDeal`/`pendingRfpSubStateForStatus` names used consistently.
- **Known verify-points (explicit, not placeholders):** exact Drizzle field names for `workflowRoute`/`projectNumber`/`dealNumber`/`users.displayName` (Task 2 Step 3 note); copy the `deal_history`+audit block verbatim from `rfp-decline-service.ts` (Task 4 Step 4a note). These are "open file X, confirm/copy" actions, not guesses to invent.
