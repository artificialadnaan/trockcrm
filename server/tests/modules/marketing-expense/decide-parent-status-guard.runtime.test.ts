// A committed withdrawal must not be overwritten by a decision that was authorised against `pending`.
//
// WHERE THE WINDOW ACTUALLY IS. "Withdraw, then decide" is already refused — `decideMarketingExpenseRequest`
// re-reads the request first and 409s on anything that is not `pending`. A test shaped like that passes
// with or without the fix and proves nothing. The real gap is INSIDE the decide call: it reads `pending`,
// writes the approval row, and only then writes the parent status. A withdrawal that commits between the
// approval write and the parent write hits an ID-only `UPDATE`, which happily overwrites `withdrawn` with
// `approved` — and a decision email then goes out for a request the submitter had already pulled.
//
// That interleaving IS expressible sequentially, which is what separates this from the approval-row race
// documented in service-decide-guard.test.ts. The withdrawal is a complete, committed operation; it just
// has to land at a specific point in the decide call. `dbWithWithdrawalBeforeParentWrite` puts it there by
// delegating to the real connection and running the withdrawal when — and only when — the parent UPDATE is
// awaited. No second connection and no overlapping transaction is required.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { marketingExpenseRequests } from "@trock-crm/shared/schema";
import {
  createMarketingExpenseRequest,
  decideMarketingExpenseRequest,
  submitMarketingExpenseRequest,
  withdrawMarketingExpenseRequest,
} from "../../../src/modules/marketing-expense/service.js";

const MIGRATION_0232 = readFileSync(
  fileURLToPath(new URL("../../../../migrations/0232_marketing_expense_requests.sql", import.meta.url)),
  "utf8",
);

const SCHEMA = "office_dallas";
const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const SUBMITTER = U("1");
const APPROVER = U("3");

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tenantDb: any;

const INPUT = {
  requestedByName: "Reggie Rep",
  vendorEvent: "Multifamily Expo",
  purpose: "Booth",
  expectedReturn: "Leads",
  costAdvertising: "100",
};

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE public.users (
      id uuid PRIMARY KEY, email text NOT NULL, display_name text, role text NOT NULL,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE public.notification_recipient_groups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text NOT NULL, name text NOT NULL,
      description text, created_at timestamptz NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX notification_recipient_groups_key_uidx
      ON public.notification_recipient_groups (key);
    CREATE TABLE public.notification_recipient_assignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id uuid NOT NULL REFERENCES public.notification_recipient_groups(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX notification_recipient_assignments_group_user_uidx
      ON public.notification_recipient_assignments (group_id, user_id);
    CREATE TYPE job_status AS ENUM ('pending','processing','completed','failed','dead');
    CREATE TABLE public.job_queue (
      id bigserial PRIMARY KEY, job_type varchar(100) NOT NULL, payload jsonb NOT NULL,
      office_id uuid, status job_status NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 3, last_error text, started_processing_at timestamptz,
      run_after timestamptz NOT NULL DEFAULT NOW(), created_at timestamptz NOT NULL DEFAULT NOW(),
      completed_at timestamptz
    );
    INSERT INTO public.users (id, email, display_name, role) VALUES
      ('${SUBMITTER}', 'reggie@trockgc.com', 'Reggie Rep', 'rep'),
      ('${APPROVER}', 'tyamashita@trockgc.com', 'Takashi Yamashita', 'director');

    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.deals (id uuid PRIMARY KEY);
    CREATE TABLE ${SCHEMA}.files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id uuid, contact_id uuid, procore_project_id bigint, change_order_id uuid,
      is_active boolean NOT NULL DEFAULT true,
      display_name varchar(500) NOT NULL DEFAULT 'doc.pdf',
      file_size_bytes bigint NOT NULL DEFAULT 1,
      -- loadDetail's attachment projection resolves a version family before every decision response.
      -- Keep these load-bearing production columns in this hand-built fixture.
      parent_file_id uuid,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT NOW()
    );
    ALTER TABLE ${SCHEMA}.files ADD CONSTRAINT files_association_check
      CHECK (deal_id IS NOT NULL OR contact_id IS NOT NULL
             OR procore_project_id IS NOT NULL OR change_order_id IS NOT NULL);
  `);
  await pg.exec(MIGRATION_0232);
  await pg.exec(`SET search_path TO ${SCHEMA}, public`);
  tenantDb = drizzle(pg);
}, 30_000);

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await pg.exec(`
    DELETE FROM ${SCHEMA}.marketing_expense_request_approvals;
    DELETE FROM ${SCHEMA}.marketing_expense_requests;
    DELETE FROM public.job_queue;
    UPDATE public.marketing_expense_request_sequences SET last_number = 0;
    DELETE FROM public.notification_recipient_assignments;
    INSERT INTO public.notification_recipient_assignments (group_id, user_id)
    SELECT g.id, '${APPROVER}' FROM public.notification_recipient_groups g
     WHERE g.key = 'marketing_expense_approver';
  `);
});

/**
 * A tenant db that delegates everything to the real connection, but runs `effect` exactly once, at the
 * moment the parent-status UPDATE is awaited — i.e. after the approval row has been written and before the
 * request row is. That is the window the guard has to close.
 */
function dbWithWithdrawalBeforeParentWrite(realDb: any, effect: () => Promise<unknown>) {
  let fired = false;
  return {
    select: (...args: unknown[]) => realDb.select(...args),
    insert: (...args: unknown[]) => realDb.insert(...args),
    execute: (...args: unknown[]) => realDb.execute(...args),
    update: (table: unknown) => {
      const builder = realDb.update(table);
      if (table !== marketingExpenseRequests || fired) return builder;
      fired = true;
      const set = builder.set.bind(builder);
      builder.set = (values: unknown) => {
        const afterSet = set(values);
        const where = afterSet.where.bind(afterSet);
        afterSet.where = (...clause: unknown[]) => {
          const query = where(...clause);
          const then = query.then.bind(query);
          // The effect runs against the REAL db, so it cannot re-enter this wrapper.
          query.then = (onOk: unknown, onErr: unknown) =>
            effect().then(() => then(onOk, onErr), onErr as never);
          return query;
        };
        return afterSet;
      };
      return builder;
    },
  };
}

async function pendingRequest() {
  const draft = await createMarketingExpenseRequest(tenantDb, {
    tenantSchema: SCHEMA,
    userId: SUBMITTER,
    input: INPUT,
  });
  await submitMarketingExpenseRequest(tenantDb, {
    tenantSchema: SCHEMA,
    officeId: null,
    userId: SUBMITTER,
    requestId: draft.id,
  });
  return draft;
}

async function statusOf(id: string) {
  const result = await pg.query<{ status: string }>(
    `SELECT status FROM ${SCHEMA}.marketing_expense_requests WHERE id = '${id}'`,
  );
  return result.rows[0]?.status;
}

async function decisionEmails() {
  const result = await pg.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM public.job_queue WHERE payload->>'emailKind' = 'decided_submitter'`,
  );
  return result.rows[0]?.count ?? 0;
}

describe("a decision cannot overwrite a committed withdrawal", () => {
  it("409s when the request was withdrawn between the approval write and the parent write", async () => {
    const request = await pendingRequest();
    await pg.exec(`DELETE FROM public.job_queue`);

    const racingDb = dbWithWithdrawalBeforeParentWrite(tenantDb, () =>
      withdrawMarketingExpenseRequest(tenantDb, { requestId: request.id, userId: SUBMITTER }),
    );

    await expect(
      decideMarketingExpenseRequest(racingDb as never, {
        tenantSchema: SCHEMA,
        officeId: null,
        requestId: request.id,
        userId: APPROVER,
        decision: "approved",
        reason: null,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("leaves the request WITHDRAWN — the submitter's committed decision stands", async () => {
    const request = await pendingRequest();
    const racingDb = dbWithWithdrawalBeforeParentWrite(tenantDb, () =>
      withdrawMarketingExpenseRequest(tenantDb, { requestId: request.id, userId: SUBMITTER }),
    );
    await decideMarketingExpenseRequest(racingDb as never, {
      tenantSchema: SCHEMA,
      officeId: null,
      requestId: request.id,
      userId: APPROVER,
      decision: "approved",
      reason: null,
    }).catch(() => undefined);

    expect(await statusOf(request.id)).toBe("withdrawn");
  });

  it("sends NO decision email for a request that was withdrawn", async () => {
    const request = await pendingRequest();
    await pg.exec(`DELETE FROM public.job_queue`);
    const racingDb = dbWithWithdrawalBeforeParentWrite(tenantDb, () =>
      withdrawMarketingExpenseRequest(tenantDb, { requestId: request.id, userId: SUBMITTER }),
    );
    await decideMarketingExpenseRequest(racingDb as never, {
      tenantSchema: SCHEMA,
      officeId: null,
      requestId: request.id,
      userId: APPROVER,
      decision: "denied",
      reason: "Over budget for the quarter",
    }).catch(() => undefined);

    // The throw has to land BEFORE the enqueue, or the submitter gets told their withdrawn request was
    // denied. In production the whole call runs in the tenant transaction, so the approval-row write rolls
    // back too; here there is no wrapping transaction, which is why this asserts on the queue.
    expect(await decisionEmails()).toBe(0);
  });

  // The multi-step path writes no NEW status — `nextStatus` is still `pending` after step 1 of 2 — so it
  // would be easy to skip the write entirely and treat "nothing to change" as "nothing to check". It still
  // has to verify the request is the thing the decision was authorised against, or step 1 of a withdrawn
  // request gets approved and the submitter is emailed about it.
  it("409s on a NON-FINAL step too, where there is no new status to write", async () => {
    const request = await pendingRequest();
    await pg.exec(`
      UPDATE ${SCHEMA}.marketing_expense_requests SET steps_required = 2 WHERE id = '${request.id}';
      INSERT INTO ${SCHEMA}.marketing_expense_request_approvals (request_id, step_order, approver_group_key)
      VALUES ('${request.id}', 2, 'marketing_expense_approver');
    `);
    await pg.exec(`DELETE FROM public.job_queue`);

    const racingDb = dbWithWithdrawalBeforeParentWrite(tenantDb, () =>
      withdrawMarketingExpenseRequest(tenantDb, { requestId: request.id, userId: SUBMITTER }),
    );
    await expect(
      decideMarketingExpenseRequest(racingDb as never, {
        tenantSchema: SCHEMA,
        officeId: null,
        requestId: request.id,
        userId: APPROVER,
        decision: "approved",
        reason: null,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await statusOf(request.id)).toBe("withdrawn");
    expect(await decisionEmails()).toBe(0);
  });

  it("still advances a two-stage request normally when nothing races it", async () => {
    const request = await pendingRequest();
    await pg.exec(`
      UPDATE ${SCHEMA}.marketing_expense_requests SET steps_required = 2 WHERE id = '${request.id}';
      INSERT INTO ${SCHEMA}.marketing_expense_request_approvals (request_id, step_order, approver_group_key)
      VALUES ('${request.id}', 2, 'marketing_expense_approver');
    `);
    const decided = await decideMarketingExpenseRequest(tenantDb, {
      tenantSchema: SCHEMA,
      officeId: null,
      requestId: request.id,
      userId: APPROVER,
      decision: "approved",
      reason: null,
    });
    expect(decided.status).toBe("pending");
    expect(await statusOf(request.id)).toBe("pending");
  });

  it("still finalises normally when nothing races it", async () => {
    const request = await pendingRequest();
    const decided = await decideMarketingExpenseRequest(tenantDb, {
      tenantSchema: SCHEMA,
      officeId: null,
      requestId: request.id,
      userId: APPROVER,
      decision: "approved",
      reason: null,
    });
    expect(decided.status).toBe("approved");
    expect(await statusOf(request.id)).toBe("approved");
  });

  it("still refuses the plain sequential case — withdraw, then decide", async () => {
    const request = await pendingRequest();
    await withdrawMarketingExpenseRequest(tenantDb, { requestId: request.id, userId: SUBMITTER });
    await expect(
      decideMarketingExpenseRequest(tenantDb, {
        tenantSchema: SCHEMA,
        officeId: null,
        requestId: request.id,
        userId: APPROVER,
        decision: "approved",
        reason: null,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

// Lock ORDER, not lock existence.
//
// Decide used to take the approval row first and the parent second, while withdraw takes the parent first
// and the approval rows second. Two request-scoped transactions grabbing the same two rows in opposite
// orders is a textbook deadlock cycle: one of them dies with a Postgres error instead of the 409 the code
// carefully produces. The fix is ONE order everywhere — parent first — which means decide has to lock the
// parent up front rather than on its way out.
//
// A real deadlock needs two connections and PGlite has one, so what is asserted is the order of the
// statements the flow issues: the parent row is locked before anything touches the approvals table.
describe("lock ordering", () => {
  function sqlCapturingDb(realDb: any, log: string[]) {
    const dialect = realDb.dialect;
    const record = (builder: any) => {
      const originalThen = builder.then?.bind(builder);
      if (!originalThen) return builder;
      builder.then = (onOk: unknown, onErr: unknown) => {
        try {
          log.push(dialect.sqlToQuery(builder.getSQL()).sql.replace(/\s+/g, " ").toLowerCase());
        } catch {
          /* not every builder can render before execution; those are not the ones under test */
        }
        return originalThen(onOk, onErr);
      };
      return builder;
    };
    const wrapChain = (builder: any) => {
      for (const method of ["where", "set", "values", "from", "limit", "orderBy", "for", "returning", "leftJoin", "innerJoin", "onConflictDoNothing"]) {
        const original = builder[method]?.bind(builder);
        if (!original) continue;
        builder[method] = (...args: unknown[]) => wrapChain(record(original(...args)));
      }
      return record(builder);
    };
    return {
      select: (...a: unknown[]) => wrapChain(realDb.select(...a)),
      insert: (...a: unknown[]) => wrapChain(realDb.insert(...a)),
      update: (...a: unknown[]) => wrapChain(realDb.update(...a)),
      execute: (...a: unknown[]) => realDb.execute(...a),
      dialect,
    };
  }

  it("locks the parent request BEFORE touching the approval rows", async () => {
    const request = await pendingRequest();
    const log: string[] = [];
    await decideMarketingExpenseRequest(sqlCapturingDb(tenantDb, log) as never, {
      tenantSchema: SCHEMA,
      officeId: null,
      requestId: request.id,
      userId: APPROVER,
      decision: "approved",
      reason: null,
    });

    const firstParentLock = log.findIndex((entry) => entry.includes("for update"));
    const firstApprovalTouch = log.findIndex((entry) =>
      entry.includes("marketing_expense_request_approvals"),
    );
    expect(firstParentLock).toBeGreaterThanOrEqual(0);
    expect(firstApprovalTouch).toBeGreaterThanOrEqual(0);
    expect(firstParentLock).toBeLessThan(firstApprovalTouch);
    expect(log[firstParentLock]).toContain("marketing_expense_requests");
  });

  it("takes that lock on the withdraw path too, so both flows agree", async () => {
    const request = await pendingRequest();
    const log: string[] = [];
    await withdrawMarketingExpenseRequest(sqlCapturingDb(tenantDb, log) as never, {
      requestId: request.id,
      userId: SUBMITTER,
    });

    const firstParentLock = log.findIndex((entry) => entry.includes("for update"));
    const firstApprovalTouch = log.findIndex((entry) =>
      entry.includes("marketing_expense_request_approvals"),
    );
    expect(firstParentLock).toBeGreaterThanOrEqual(0);
    expect(firstParentLock).toBeLessThan(firstApprovalTouch);
  });
});
