import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import {
  emails,
  emailThreadBindings,
  activities,
  userGraphTokens,
  users,
  auditLog,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { AppError } from "../../../src/middleware/error-handler.js";

// The REAL router, over a REAL (PGlite) tenant db and the REAL services — the point of this suite is the
// wiring between the two, which a service-mocked route test cannot see.
const { emailRoutes } = await import("../../../src/modules/email/routes.js");

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;

// USER_OWNER owns the OLDEST message in the thread, so their mailbox is the one
// getEmailThreadForMutation resolves as thread.mailboxAccountId.
const USER_OWNER = U("a01");
// USER_SECOND owns a LATER message in the same conversation — a second mailbox holding the same thread.
const USER_SECOND = U("a02");
// USER_COLLAB owns NO message in the thread. They are a deal collaborator with their own, unrelated
// mailbox: the exact user this feature exists to serve, and the one an owner-only gate 403s.
const USER_COLLAB = U("a03");
// USER_OUTSIDER holds neither the mailbox nor deal access.
const USER_OUTSIDER = U("a04");
// The deals' assigned rep — present only so getDealOfficeAccess's leftJoin has a real row to hit.
const USER_REP = U("a05");

// "m" is not a hex digit, so mailbox ids use hex-safe suffixes.
const MBX_OWNER = U("e01"), MBX_SECOND = U("e02"), MBX_COLLAB = U("e03"), MBX_OUTSIDER = U("e04");
const OFFICE_DALLAS = U("0f1");
const DEAL_OLD = U("d01"), DEAL_NEW = U("d02");
const CONV = "conv-thread-routes-1";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;
let commits: number;

type Viewer = { id: string; role: string; officeId: string | null; activeOfficeId: string | null };

// A deal collaborator with no message in the thread. Path 1 (mailbox) MISSES; only path 2 can admit.
const collaboratorUser: Viewer = {
  id: USER_COLLAB, role: "rep", officeId: OFFICE_DALLAS, activeOfficeId: OFFICE_DALLAS,
};
// Owns a LATER message in the thread, and carries a NULL office so path 2 can never admit them —
// anything they are allowed to do came from mailbox ownership and nothing else. (Their users ROW still
// has a real office_id; office_id is .notNull(). The null lives on the viewer, and only on the viewer.)
const laterMessageOwnerUser: Viewer = {
  id: USER_SECOND, role: "rep", officeId: null, activeOfficeId: null,
};
// Neither mailbox nor deal access. CAVEAT, same as thread-mutation-permission.runtime.test.ts: the
// no-office viewer is how a "no deal access" user is modelled, because assertDealCollaboratorAccess's
// office check only asks whether the viewer has an office at all — the production-reachable denial is
// the cross-schema 404. What matters here is that the denial happens BEFORE any mutation.
const outsiderUser: Viewer = {
  id: USER_OUTSIDER, role: "rep", officeId: null, activeOfficeId: null,
};

function findRouteHandler(routePath: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (emailRoutes as any).stack.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (entry: any) => entry.route?.path === routePath && entry.route?.methods?.post
  );
  if (!layer) throw new Error(`Route not found: POST ${routePath}`);
  return layer.route.stack[0].handle as (
    req: unknown,
    res: unknown,
    next: (err?: unknown) => void
  ) => unknown;
}

async function postThreadRoute(
  action: "assign" | "reassign" | "detach",
  user: Viewer,
  body: Record<string, unknown> = {},
  conversationId: string = CONV
) {
  const handler = findRouteHandler(`/thread/:conversationId/${action}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: Record<string, any> & { _resolve?: () => void } = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json(payload: any) {
      res.body = payload;
      res._resolve?.();
      return res;
    },
  };
  const req = {
    method: "POST",
    params: { conversationId },
    query: {},
    body,
    user,
    tenantDb: tdb,
    commitTransaction: async () => {
      commits += 1;
    },
    headers: {},
  };

  await new Promise<void>((resolve, reject) => {
    res._resolve = resolve;
    Promise.resolve(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler(req as any, res as any, (err?: unknown) => {
        if (err) reject(err);
      })
    ).catch(reject);
  });

  return { req, res };
}

/** Await a rejection and hand back the AppError, so a case can assert BOTH status code and message —
 *  and so a call that wrongly RESOLVES fails loudly instead of silently passing. */
async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return err;
  }
  throw new Error("expected the route to reject, but it resolved");
}

async function activeBindings(): Promise<Array<{ mailbox_account_id: string; deal_id: string }>> {
  const res = await tdb.execute(sql`
    SELECT mailbox_account_id, deal_id FROM email_thread_bindings
    WHERE detached_at IS NULL ORDER BY mailbox_account_id
  `);
  return Array.isArray(res) ? res : res.rows;
}

async function messageDealIds(): Promise<Array<string | null>> {
  const res = await tdb.execute(sql`
    SELECT deal_id FROM emails WHERE graph_conversation_id = ${CONV} ORDER BY sent_at
  `);
  const rows = Array.isArray(res) ? res : res.rows;
  return rows.map((r: { deal_id: string | null }) => r.deal_id);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function auditRows(): Promise<any[]> {
  const res = await tdb.execute(sql`
    SELECT table_name, record_id, action, changed_by, entity_type, full_row
    FROM audit_log ORDER BY id
  `);
  return Array.isArray(res) ? res : res.rows;
}

beforeEach(async () => {
  pg = new PGlite();
  tdb = drizzle(pg);
  commits = 0;

  // Real Drizzle definitions (#677 helper) for everything the routes actually write, so column
  // types/enums/NOT NULLs cannot drift from prod — audit_log especially, since record_id's type is the
  // whole question behind the audit entries below. `deals` stays a hand-rolled island (same pattern as
  // thread-multi-mailbox / thread-mutation-permission): only a handful of columns are read off it and
  // generating the real table would drag in the whole company/property/lead/stage graph.
  await pg.exec(
    tenantSchemaSql("public", [emails, emailThreadBindings, activities, userGraphTokens, users, auditLog])
  );
  await tdb.execute(sql`
    CREATE TABLE deals (
      id uuid PRIMARY KEY,
      name text,
      company_id uuid,
      property_id uuid,
      source_lead_id uuid,
      assigned_rep_id uuid,
      office_code text,
      email_count integer NOT NULL DEFAULT 0,
      last_email_at timestamptz
    )
  `);

  await tdb.execute(sql`
    INSERT INTO users (id, email, display_name, role, office_id) VALUES
      (${USER_OWNER},    'owner@example.com',    'Owner',       'rep', ${OFFICE_DALLAS}),
      (${USER_SECOND},   'second@example.com',   'Second',      'rep', ${OFFICE_DALLAS}),
      (${USER_COLLAB},   'collab@example.com',   'Collaborator','rep', ${OFFICE_DALLAS}),
      (${USER_OUTSIDER}, 'outsider@example.com', 'Outsider',    'rep', ${OFFICE_DALLAS}),
      (${USER_REP},      'rep@example.com',      'Assigned Rep','rep', ${OFFICE_DALLAS})
  `);
  await tdb.execute(sql`
    INSERT INTO user_graph_tokens (id, user_id, access_token, refresh_token, token_expires_at, scopes) VALUES
      (${MBX_OWNER},    ${USER_OWNER},    'x', 'x', now(), '{}'),
      (${MBX_SECOND},   ${USER_SECOND},   'x', 'x', now(), '{}'),
      (${MBX_COLLAB},   ${USER_COLLAB},   'x', 'x', now(), '{}'),
      (${MBX_OUTSIDER}, ${USER_OUTSIDER}, 'x', 'x', now(), '{}')
  `);
  await tdb.execute(sql`
    INSERT INTO deals (id, name, assigned_rep_id, office_code) VALUES
      (${DEAL_OLD}, 'Old Deal', ${USER_REP}, 'DAL'),
      (${DEAL_NEW}, 'New Deal', ${USER_REP}, 'DAL')
  `);
  // ONE conversation landed in TWO mailboxes — the shape the deal Emails tab shows to everyone on the
  // deal, not just to the two humans who happen to hold copies. m1 is the OLDER message.
  await tdb.execute(sql`
    INSERT INTO emails
      (graph_message_id, graph_conversation_id, subject, direction, from_address, to_addresses, deal_id, assignment_status, user_id, sent_at)
    VALUES
      ('m1', ${CONV}, 'Roof scope', 'inbound', 'sender@example.com', '{}', ${DEAL_OLD}, 'assigned', ${USER_OWNER},  '2026-07-01T00:00:00Z'),
      ('m2', ${CONV}, 'Roof scope', 'inbound', 'sender@example.com', '{}', ${DEAL_OLD}, 'assigned', ${USER_SECOND}, '2026-07-02T00:00:00Z')
  `);
  await tdb.execute(sql`
    INSERT INTO email_thread_bindings
      (mailbox_account_id, provider, provider_conversation_id, deal_id, binding_source, confidence)
    VALUES (${MBX_OWNER},  'microsoft_graph', ${CONV}, ${DEAL_OLD}, 'manual', 'high'),
           (${MBX_SECOND}, 'microsoft_graph', ${CONV}, ${DEAL_OLD}, 'manual', 'high')
  `);
}, 30000); // PGlite cold-start can exceed the default 10s under parallel runtime suites

afterEach(async () => {
  await pg.close();
});

describe("thread mutation routes — deal-collaborator access", () => {
  // ---------------------------------------------------------------------------------------------
  // 1. Each route, independently, admits a deal collaborator who owns none of the thread's mailboxes.
  //    Tested route-by-route on purpose: the realistic regression is the gate (and the widened
  //    getEmailThreadForMutation call) landing on two routes and being forgotten on the third.
  // ---------------------------------------------------------------------------------------------
  it("assign: admits a deal collaborator who owns no mailbox on the thread", async () => {
    const { res } = await postThreadRoute("assign", collaboratorUser, { dealId: DEAL_NEW });

    expect(res.statusCode).toBe(200);
    expect(commits).toBe(1);
    expect((await activeBindings()).every((r) => r.deal_id === DEAL_NEW)).toBe(true);
  });

  it("reassign: admits a deal collaborator who owns no mailbox on the thread", async () => {
    const { res } = await postThreadRoute("reassign", collaboratorUser, { dealId: DEAL_NEW });

    expect(res.statusCode).toBe(200);
    expect(commits).toBe(1);
    expect((await activeBindings()).every((r) => r.deal_id === DEAL_NEW)).toBe(true);
  });

  it("detach: admits a deal collaborator who owns no mailbox on the thread", async () => {
    const { res } = await postThreadRoute("detach", collaboratorUser);

    expect(res.statusCode).toBe(200);
    expect(commits).toBe(1);
    expect(await activeBindings()).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------------------------
  // 2. Each route, independently, rejects a caller with neither the mailbox nor deal access — and
  //    rejects BEFORE mutating anything.
  // ---------------------------------------------------------------------------------------------
  it("assign: rejects a caller with neither mailbox nor deal access, without mutating", async () => {
    const err = await rejection(postThreadRoute("assign", outsiderUser, { dealId: DEAL_NEW }));
    expect(err.statusCode).toBe(403);
    expect((await activeBindings()).every((r) => r.deal_id === DEAL_OLD)).toBe(true);
    expect(commits).toBe(0);
  });

  it("reassign: rejects a caller with neither mailbox nor deal access, without mutating", async () => {
    const err = await rejection(postThreadRoute("reassign", outsiderUser, { dealId: DEAL_NEW }));
    expect(err.statusCode).toBe(403);
    expect((await activeBindings()).every((r) => r.deal_id === DEAL_OLD)).toBe(true);
    expect(commits).toBe(0);
  });

  it("detach: rejects a caller with neither mailbox nor deal access, without mutating", async () => {
    const err = await rejection(postThreadRoute("detach", outsiderUser));
    expect(err.statusCode).toBe(403);
    expect(await activeBindings()).toHaveLength(2);
    expect(commits).toBe(0);
  });

  it("assign: a non-participant collaborator cannot touch a thread bound to NO deal", async () => {
    // An unbound thread has no deal to authorize against, so path 2 cannot run at all. Pinned so a
    // future "just let anyone file an unassigned thread" change is a deliberate one.
    await tdb.execute(sql`UPDATE email_thread_bindings SET detached_at = now()`);

    const err = await rejection(postThreadRoute("assign", collaboratorUser, { dealId: DEAL_NEW }));
    expect(err.statusCode).toBe(403);
    expect(err.message).toMatch(/own email threads/i);
    expect(await activeBindings()).toHaveLength(0);
  });

  it("detach: admits the owner of a LATER message, not just the oldest one", async () => {
    // thread.mailboxAccountId is derived from the OLDEST message, so a gate that only compares the
    // caller's mailbox against it would 403 the owner of every other copy of the thread — a capability
    // they hold today (the pre-change routes pre-filtered the thread to the caller's own messages, so
    // "owns the thread" meant "owns ANY message in it"). This viewer carries a null office, so path 2
    // cannot rescue them: passing here proves mailbox ownership still admits them.
    const { res } = await postThreadRoute("detach", laterMessageOwnerUser);

    expect(res.statusCode).toBe(200);
    expect(await activeBindings()).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------------------------
  // 3. THE TRAP: boundDealId must come from ANY active binding on the conversation, never from the one
  //    arbitrary mailbox thread.binding happens to describe.
  // ---------------------------------------------------------------------------------------------
  it("reassign: authorizes off ANY active binding when the OLDEST message's mailbox is detached", async () => {
    // thread.mailboxAccountId resolves to MBX_OWNER (oldest message). Detach ONLY that mailbox's
    // binding and the conversation is still very much bound to DEAL_OLD via MBX_SECOND — but
    // thread.binding, which is looked up for MBX_OWNER alone, is now null. Deriving boundDealId from
    // thread.binding?.dealId would hand the gate a null and 403 exactly the collaborator this feature
    // exists to serve.
    await tdb.execute(sql`
      UPDATE email_thread_bindings SET detached_at = now() WHERE mailbox_account_id = ${MBX_OWNER}
    `);

    const { res } = await postThreadRoute("reassign", collaboratorUser, { dealId: DEAL_NEW });

    expect(res.statusCode).toBe(200);
    const rows = await activeBindings();
    expect(rows.every((r) => r.deal_id === DEAL_NEW)).toBe(true);
  });

  it("detach: authorizes off ANY active binding when the OLDEST message's mailbox is detached", async () => {
    await tdb.execute(sql`
      UPDATE email_thread_bindings SET detached_at = now() WHERE mailbox_account_id = ${MBX_OWNER}
    `);

    const { res } = await postThreadRoute("detach", collaboratorUser);

    expect(res.statusCode).toBe(200);
    expect(await activeBindings()).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------------------------
  // 4. Reassign moves EVERY mailbox, and the audit row describes what actually happened.
  // ---------------------------------------------------------------------------------------------
  it("reassign: moves every mailbox and every message, and the preview matches the mutation", async () => {
    const { res } = await postThreadRoute("reassign", collaboratorUser, { dealId: DEAL_NEW });

    const rows = await activeBindings();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.mailbox_account_id).sort()).toEqual([MBX_OWNER, MBX_SECOND].sort());
    expect(rows.every((r) => r.deal_id === DEAL_NEW)).toBe(true);

    // The preview is the number the UI shows the user before they confirm. It has to be the number of
    // messages the mutation ACTUALLY moved, or the confirmation dialog is lying.
    const moved = (await messageDealIds()).filter((id) => id === DEAL_NEW);
    expect(res.body.preview.affectedMessageCount).toBe(moved.length);
    expect(res.body.preview.affectedMessageCount).toBe(2);
    expect(res.body.preview.currentDealId).toBe(DEAL_OLD);
    expect(res.body.preview.nextDealId).toBe(DEAL_NEW);
  });

  it("reassign: counts a disconnected participant's copy it cannot actually move", async () => {
    // KNOWN, NARROW GAP — pinned so closing it is a deliberate change rather than a surprise.
    // bindConversationToDealAcrossMailboxes can only act on mailboxes that HAVE a mailbox account, so a
    // participant whose Outlook was disconnected keeps their copy of the thread filed on the OLD deal,
    // while previewThreadReassignmentImpact counts every message in the conversation regardless. The
    // preview therefore overstates by exactly the disconnected participants' messages. Closing it means
    // teaching the rebind to move orphaned message rows with no binding to hang them off — a change to
    // the bind contract, not to this route.
    const USER_GONE = U("a08");
    await tdb.execute(sql`
      INSERT INTO users (id, email, display_name, role, office_id)
      VALUES (${USER_GONE}, 'gone@example.com', 'Disconnected', 'rep', ${OFFICE_DALLAS})
    `);
    // Deliberately NO user_graph_tokens row for USER_GONE.
    await tdb.execute(sql`
      INSERT INTO emails
        (graph_message_id, graph_conversation_id, direction, from_address, to_addresses, deal_id, assignment_status, user_id, sent_at)
      VALUES ('m3', ${CONV}, 'inbound', 'sender@example.com', '{}', ${DEAL_OLD}, 'assigned', ${USER_GONE}, '2026-07-03T00:00:00Z')
    `);

    const { res } = await postThreadRoute("reassign", collaboratorUser, { dealId: DEAL_NEW });

    expect(res.body.preview.affectedMessageCount).toBe(3);
    const dealIds = await messageDealIds();
    expect(dealIds.filter((id) => id === DEAL_NEW)).toHaveLength(2);
    expect(dealIds.filter((id) => id === DEAL_OLD)).toHaveLength(1);
  });

  it("reassign: writes one audit row naming the actor, both deals, and the message count", async () => {
    await postThreadRoute("reassign", collaboratorUser, { dealId: DEAL_NEW });

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].table_name).toBe("email_thread_bindings");
    expect(rows[0].action).toBe("update");
    expect(rows[0].entity_type).toBe("email_thread");
    expect(rows[0].changed_by).toBe(USER_COLLAB);
    expect(rows[0].full_row).toMatchObject({
      providerConversationId: CONV,
      previousDealId: DEAL_OLD,
      nextDealId: DEAL_NEW,
      affectedMessageCount: 2,
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5. Detach removes EVERY mailbox's binding and writes its own audit row naming the actor.
  // ---------------------------------------------------------------------------------------------
  it("detach: removes every mailbox's binding and writes an audit row naming the actor", async () => {
    await postThreadRoute("detach", collaboratorUser);

    expect(await activeBindings()).toHaveLength(0);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].table_name).toBe("email_thread_bindings");
    expect(rows[0].action).toBe("update");
    expect(rows[0].entity_type).toBe("email_thread");
    expect(rows[0].changed_by).toBe(USER_COLLAB);
    expect(rows[0].full_row).toMatchObject({
      providerConversationId: CONV,
      previousDealId: DEAL_OLD,
      nextDealId: null,
      detached: true,
      affectedMessageCount: 2,
    });
  });

  it("detach: removes a binding whose mailbox has no surviving message rows", async () => {
    // The stranded-binding class this whole change exists to close: a mailbox-scoped detach sourced
    // from `emails` would never discover this row.
    const MBX_ORPHAN = U("f0c"), USER_ORPHAN = U("a09");
    await tdb.execute(sql`
      INSERT INTO user_graph_tokens (id, user_id, access_token, refresh_token, token_expires_at, scopes)
      VALUES (${MBX_ORPHAN}, ${USER_ORPHAN}, 'x', 'x', now(), '{}')
    `);
    await tdb.execute(sql`
      INSERT INTO email_thread_bindings
        (mailbox_account_id, provider, provider_conversation_id, deal_id, binding_source, confidence)
      VALUES (${MBX_ORPHAN}, 'microsoft_graph', ${CONV}, ${DEAL_OLD}, 'manual', 'high')
    `);

    await postThreadRoute("detach", collaboratorUser);

    expect(await activeBindings()).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------------------------
  // 6. The refreshed payload the routes hand back must not re-apply a mailbox-owner filter — that
  //    filter 403s exactly the collaborator the gate just admitted.
  // ---------------------------------------------------------------------------------------------
  it("reassign: returns the full refreshed thread to a collaborator who owns none of its messages", async () => {
    const { res } = await postThreadRoute("reassign", collaboratorUser, { dealId: DEAL_NEW });

    expect(res.body.thread.emails).toHaveLength(2);
    expect(res.body.thread.binding?.dealId).toBe(DEAL_NEW);
  });

  // ---------------------------------------------------------------------------------------------
  // 7. The gate authorizes against the deal the thread is bound TO, never the deal named in the body.
  // ---------------------------------------------------------------------------------------------
  it("reassign: a body-supplied dealId cannot stand in for the thread's own binding", async () => {
    // The bound deal moves to a schema this tenantDb cannot see (deleted here, which is the same thing
    // as far as getDealOfficeAccess is concerned) while the TARGET deal stays perfectly reachable. A
    // gate fed from the request body would sail through; a gate fed from the binding must 404.
    await tdb.execute(sql`UPDATE emails SET deal_id = NULL WHERE graph_conversation_id = ${CONV}`);
    await tdb.execute(sql`DELETE FROM deals WHERE id = ${DEAL_OLD}`);

    const err = await rejection(postThreadRoute("reassign", collaboratorUser, { dealId: DEAL_NEW }));
    expect(err.statusCode).toBe(404);
    expect(err.message).toMatch(/Deal not found/i);
    expect((await activeBindings()).every((r) => r.deal_id === DEAL_OLD)).toBe(true);
  });
});
