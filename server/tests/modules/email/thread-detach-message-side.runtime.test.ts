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

// The REAL router over a REAL (PGlite) tenant db, and — the point of this suite — the REAL reads the
// user actually looks at afterwards. Detaching a thread was a 200 that changed nothing a user could
// see: it cleared email_thread_bindings.detached_at and stopped, while every surface that shows a
// deal's mail reads the MESSAGE columns. Asserting on bindings alone is exactly how that survived
// review, so nothing here asserts on a binding.
const { emailRoutes } = await import("../../../src/modules/email/routes.js");
const { getEmails, getEmailAssignmentQueue, DETACHED_ASSIGNMENT_AMBIGUITY_REASON } = await import(
  "../../../src/modules/email/service.js"
);

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;

const USER_OWNER = U("a01");
const USER_SECOND = U("a02");
const USER_COLLAB = U("a03");
const USER_REP = U("a05");
const MBX_OWNER = U("e01"), MBX_SECOND = U("e02"), MBX_COLLAB = U("e03");
const OFFICE_DALLAS = U("0f1");
const DEAL_OLD = U("d01");
const CONV = "conv-detach-message-side";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

type Viewer = { id: string; role: string; officeId: string | null; activeOfficeId: string | null };

const collaboratorUser: Viewer = {
  id: USER_COLLAB, role: "rep", officeId: OFFICE_DALLAS, activeOfficeId: OFFICE_DALLAS,
};
// Owns a message in the thread, and carries a NULL office so the deal-write path can never admit them.
// Used for the no-binding case, where there is no bound deal to authorize against at all.
const mailboxOwnerUser: Viewer = {
  id: USER_OWNER, role: "rep", officeId: null, activeOfficeId: null,
};

function findRouteHandler(method: "get" | "post", routePath: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (emailRoutes as any).stack.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (entry: any) => entry.route?.path === routePath && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[0].handle as (
    req: unknown,
    res: unknown,
    next: (err?: unknown) => void
  ) => unknown;
}

async function postDetach(user: Viewer, conversationId: string = CONV) {
  const handler = findRouteHandler("post", "/thread/:conversationId/detach");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: Record<string, any> & { _resolve?: () => void } = {
    statusCode: 200,
    body: undefined,
    status(code: number) { res.statusCode = code; return res; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json(payload: any) { res.body = payload; res._resolve?.(); return res; },
  };
  const req = {
    method: "POST",
    params: { conversationId },
    query: {},
    body: {},
    user,
    tenantDb: tdb,
    commitTransaction: async () => {},
    headers: {},
  };

  await new Promise<void>((resolve, reject) => {
    res._resolve = resolve;
    Promise.resolve(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler(req as any, res as any, (err?: unknown) => { if (err) reject(err); })
    ).catch(reject);
  });

  return res;
}

/**
 * What GET /api/email/deal/:dealId returns, i.e. what the deal's Emails tab shows.
 *
 * The route's own filters, called one layer below the handler. Its RBAC preamble
 * (assertDealCollaboratorAccess + getDealById) is skipped deliberately: it decides WHO may read the
 * tab, never WHICH rows come back, and reproducing it would need the whole deal read against a
 * hand-rolled deals table. getEmails is the part that answers "did the mail leave the deal".
 *
 * Sorted, not in list order: both reads order newest-first, and nothing here is about ordering.
 */
async function dealTabEmailIds(): Promise<string[]> {
  const result = await getEmails(tdb, { dealId: DEAL_OLD, page: 1, limit: 20 }, undefined, "rep");
  return result.emails.map((row: { graphMessageId: string }) => row.graphMessageId).sort();
}

async function assignmentQueueMessageIds(): Promise<string[]> {
  const result = await getEmailAssignmentQueue(tdb, {});
  return result.items.map((item: { email: { graphMessageId: string } }) => item.email.graphMessageId).sort();
}

async function messageAssignmentRows(): Promise<
  Array<{
    graph_message_id: string;
    deal_id: string | null;
    assigned_entity_type: string | null;
    assigned_entity_id: string | null;
    assignment_status: string;
    assignment_ambiguity_reason: string | null;
    thread_binding_id: string | null;
    contact_id: string | null;
  }>
> {
  const res = await tdb.execute(sql`
    SELECT graph_message_id, deal_id, assigned_entity_type, assigned_entity_id,
           assignment_status, assignment_ambiguity_reason, thread_binding_id, contact_id
    FROM emails WHERE graph_conversation_id = ${CONV} ORDER BY graph_message_id
  `);
  return Array.isArray(res) ? res : res.rows;
}

async function dealStats(): Promise<{ email_count: number; last_email_at: string | null }> {
  const res = await tdb.execute(sql`
    SELECT email_count, last_email_at FROM deals WHERE id = ${DEAL_OLD}
  `);
  const rows = Array.isArray(res) ? res : res.rows;
  return rows[0];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function auditRows(): Promise<any[]> {
  const res = await tdb.execute(sql`
    SELECT record_id, action, changed_by, entity_type, full_row FROM audit_log ORDER BY id
  `);
  return Array.isArray(res) ? res : res.rows;
}

beforeEach(async () => {
  pg = new PGlite();
  tdb = drizzle(pg);

  await pg.exec(
    tenantSchemaSql("public", [emails, emailThreadBindings, activities, userGraphTokens, users, auditLog])
  );
  // Hand-rolled island, same pattern as the sibling runtime suites: only a few columns are read off
  // deals here, and generating the real table drags in the whole company/property/lead/stage graph.
  // email_count / last_email_at are present because the detach now has to keep them honest.
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

  // Second hand-rolled island: the stat rollup resolves a message's contact through to its company,
  // and refreshEntityEmailStats writes the contact's own email_count/last_email_at.
  await tdb.execute(sql`
    CREATE TABLE contacts (
      id uuid PRIMARY KEY,
      company_id uuid,
      first_name text,
      last_name text,
      company_name text,
      email_count integer NOT NULL DEFAULT 0,
      last_email_at timestamptz
    )
  `);

  await tdb.execute(sql`
    INSERT INTO users (id, email, display_name, role, office_id) VALUES
      (${USER_OWNER},  'owner@example.com',  'Owner',        'rep', ${OFFICE_DALLAS}),
      (${USER_SECOND}, 'second@example.com', 'Second',       'rep', ${OFFICE_DALLAS}),
      (${USER_COLLAB}, 'collab@example.com', 'Collaborator', 'rep', ${OFFICE_DALLAS}),
      (${USER_REP},    'rep@example.com',    'Assigned Rep', 'rep', ${OFFICE_DALLAS})
  `);
  await tdb.execute(sql`
    INSERT INTO user_graph_tokens (id, user_id, access_token, refresh_token, token_expires_at, scopes) VALUES
      (${MBX_OWNER},  ${USER_OWNER},  'x', 'x', now(), '{}'),
      (${MBX_SECOND}, ${USER_SECOND}, 'x', 'x', now(), '{}'),
      (${MBX_COLLAB}, ${USER_COLLAB}, 'x', 'x', now(), '{}')
  `);
  await tdb.execute(sql`
    INSERT INTO deals (id, name, assigned_rep_id, office_code, email_count, last_email_at)
    VALUES (${DEAL_OLD}, 'Old Deal', ${USER_REP}, 'DAL', 2, '2026-07-02T00:00:00Z')
  `);
  // One conversation in TWO mailboxes, filed on the deal the way bindThreadToDeal leaves it: both the
  // legacy deal_id column AND the assigned_entity_* pair, since the deal-tab predicate is an OR over
  // the two and clearing only one of them would leave the mail on the tab.
  await tdb.execute(sql`
    INSERT INTO emails
      (graph_message_id, graph_conversation_id, subject, direction, from_address, to_addresses,
       deal_id, assigned_entity_type, assigned_entity_id, assignment_status, assignment_confidence,
       user_id, sent_at)
    VALUES
      ('m1', ${CONV}, 'Roof scope', 'inbound', 'sender@example.com', '{}',
       ${DEAL_OLD}, 'deal', ${DEAL_OLD}, 'assigned', 'high', ${USER_OWNER},  '2026-07-01T00:00:00Z'),
      ('m2', ${CONV}, 'Roof scope', 'inbound', 'sender@example.com', '{}',
       ${DEAL_OLD}, 'deal', ${DEAL_OLD}, 'assigned', 'high', ${USER_SECOND}, '2026-07-02T00:00:00Z')
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

describe("thread detach — the message side", () => {
  it("the fixture starts on the deal tab and NOT in the queue", async () => {
    // The control. Without it, every assertion below would also pass against a fixture that was never
    // on the deal in the first place.
    expect(await dealTabEmailIds()).toEqual(["m1", "m2"]);
    expect(await assignmentQueueMessageIds()).toEqual([]);
  });

  it("removes the conversation from the deal Emails tab", async () => {
    const res = await postDetach(collaboratorUser);

    expect(res.statusCode).toBe(200);
    expect(await dealTabEmailIds()).toEqual([]);
  });

  it("returns the conversation to the assignment queue", async () => {
    await postDetach(collaboratorUser);

    // Both copies, not just the caller's: the queue is per-mailbox, so a message-side clear that
    // missed a mailbox would strand that rep's copy filed on a deal nobody can see it from.
    expect(await assignmentQueueMessageIds()).toEqual(["m1", "m2"]);
  });

  it("clears the assignment columns in EVERY mailbox holding the conversation", async () => {
    await postDetach(collaboratorUser);

    for (const row of await messageAssignmentRows()) {
      expect(row.deal_id).toBeNull();
      expect(row.assigned_entity_type).toBeNull();
      expect(row.assigned_entity_id).toBeNull();
      expect(row.thread_binding_id).toBeNull();
      // The two the queue predicate selects on.
      expect(row.assignment_status).toBe("unassigned");
      expect(row.assignment_ambiguity_reason).toBe(DETACHED_ASSIGNMENT_AMBIGUITY_REASON);
    }
  });

  it("leaves contact_id alone — unassigning from a DEAL is not unassigning from a contact", async () => {
    const CONTACT = U("c01");
    await tdb.execute(sql`INSERT INTO contacts (id, first_name, last_name) VALUES (${CONTACT}, 'Casey', 'Customer')`);
    await tdb.execute(sql`UPDATE emails SET contact_id = ${CONTACT} WHERE graph_conversation_id = ${CONV}`);

    await postDetach(collaboratorUser);

    expect((await messageAssignmentRows()).every((row) => row.contact_id === CONTACT)).toBe(true);
    // …and the contact association must not drag the mail back onto the deal tab.
    expect(await dealTabEmailIds()).toEqual([]);
  });

  it("recomputes the deal's denormalised email rollup", async () => {
    expect(await dealStats()).toMatchObject({ email_count: 2 });

    await postDetach(collaboratorUser);

    const stats = await dealStats();
    expect(stats.email_count).toBe(0);
    expect(stats.last_email_at).toBeNull();
  });

  it("audits a conversation that was filed message-by-message, with no binding to report", async () => {
    // The assignment queue assigns ONE message at a time (associateEmailToEntity), which writes
    // emails.deal_id and creates no binding. Before the message-side clear existed, a null boundDealId
    // provably meant "nothing was unfiled"; now it does not, and auditing on the binding alone would
    // wipe real associations silently.
    await tdb.execute(sql`DELETE FROM email_thread_bindings`);

    await postDetach(mailboxOwnerUser);

    expect(await dealTabEmailIds()).toEqual([]);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].record_id).toBe(DEAL_OLD);
    expect(rows[0].changed_by).toBe(USER_OWNER);
    expect(rows[0].full_row).toMatchObject({
      providerConversationId: CONV,
      previousDealId: DEAL_OLD,
      previousMessageDealIds: [DEAL_OLD],
      nextDealId: null,
      detached: true,
    });
  });

  it("writes no audit row when there was genuinely nothing filed", async () => {
    await tdb.execute(sql`DELETE FROM email_thread_bindings`);
    await tdb.execute(sql`
      UPDATE emails SET deal_id = NULL, assigned_entity_type = NULL, assigned_entity_id = NULL
      WHERE graph_conversation_id = ${CONV}
    `);

    await postDetach(mailboxOwnerUser);

    expect(await auditRows()).toHaveLength(0);
  });
});
