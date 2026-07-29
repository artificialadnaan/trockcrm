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
// The deal's ACTIVITY tab, for the same reason: it is a SECOND view of the same mail, reading a
// different table, and the two disagreeing is what the user actually sees.
const { getActivities } = await import("../../../src/modules/activities/service.js");

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;

const USER_OWNER = U("a01");
const USER_SECOND = U("a02");
const USER_COLLAB = U("a03");
const USER_REP = U("a05");
const MBX_OWNER = U("e01"), MBX_SECOND = U("e02"), MBX_COLLAB = U("e03");
const OFFICE_DALLAS = U("0f1");
const DEAL_OLD = U("d01"), DEAL_NEW = U("d02");
const COMPANY_ACME = U("b01");
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

/**
 * The activity rows backAssociateStoredMessagesForBinding writes for a bound conversation — one per
 * message, carrying the deal AND everything the deal implies (its company, property and source lead).
 * Written by hand here rather than by running a bind first, so the detach cases start from exactly the
 * state a real bind leaves and nothing else.
 */
async function seedDealActivitiesForConversation() {
  await tdb.execute(sql`
    INSERT INTO activities
      (type, responsible_user_id, performed_by_user_id, source_entity_type, source_entity_id,
       company_id, lead_id, deal_id, email_id, subject, occurred_at)
    SELECT 'email', e.user_id, e.user_id, 'deal', ${DEAL_OLD},
           d.company_id, d.source_lead_id, ${DEAL_OLD}, e.id, e.subject, e.sent_at
    FROM emails e CROSS JOIN deals d
    WHERE e.graph_conversation_id = ${CONV} AND d.id = ${DEAL_OLD}
  `);
}

/** What GET /api/activities?dealId=… returns, i.e. what the deal's Activity tab shows. */
async function dealActivityEmailIds(): Promise<string[]> {
  const result = await getActivities(tdb, { dealId: DEAL_OLD, page: 1, limit: 50 });
  return result.activities
    .map((row: { emailId: string | null }) => row.emailId)
    .filter((emailId: string | null): emailId is string => emailId !== null)
    .sort();
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

  // Third and fourth hand-rolled islands: a sibling message filed to a COMPANY makes the rollup refresh
  // that table, and the company rollup's own predicate reaches into leads.
  await tdb.execute(sql`
    CREATE TABLE companies (
      id uuid PRIMARY KEY,
      name text,
      email_count integer NOT NULL DEFAULT 0,
      last_email_at timestamptz
    )
  `);
  await tdb.execute(sql`
    CREATE TABLE leads (
      id uuid PRIMARY KEY,
      company_id uuid,
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
    VALUES (${DEAL_OLD}, 'Old Deal', ${USER_REP}, 'DAL', 2, '2026-07-02T00:00:00Z'),
           (${DEAL_NEW}, 'New Deal', ${USER_REP}, 'DAL', 0, NULL)
  `);
  await tdb.execute(sql`INSERT INTO companies (id, name) VALUES (${COMPANY_ACME}, 'Acme')`);
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

  it("picks a DETERMINISTIC deal for the audit recordId when the conversation spans two", async () => {
    // record_id is the key this audit row is looked up BY, so it cannot depend on which row the planner
    // happened to return first. Ordered by sent_at then id, matching previewThreadReassignmentImpact,
    // so the OLDEST message's deal wins every time.
    await tdb.execute(sql`DELETE FROM email_thread_bindings`);
    await tdb.execute(sql`
      UPDATE emails SET deal_id = ${DEAL_NEW}, assigned_entity_id = ${DEAL_NEW}
      WHERE graph_message_id = 'm2'
    `);

    await postDetach(mailboxOwnerUser);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].record_id).toBe(DEAL_OLD);
    expect(rows[0].full_row).toMatchObject({ previousMessageDealIds: [DEAL_OLD, DEAL_NEW] });
  });

  it("returns an IGNORED copy to the queue rather than leaving it hidden", async () => {
    // Documented consequence of the blanket clear. Leaving one copy 'ignored' would hide it from the
    // very surface the detach is sending the conversation to.
    await tdb.execute(sql`UPDATE emails SET assignment_status = 'ignored' WHERE graph_message_id = 'm2'`);

    await postDetach(collaboratorUser);

    expect(await assignmentQueueMessageIds()).toEqual(["m1", "m2"]);
  });

  // -----------------------------------------------------------------------------------------------
  // ARCHIVED / DELETED COPIES. The detach's message-side clear writes exactly the three columns the
  // assignment queue selects on — assignment_status = 'unassigned' plus a non-null ambiguity reason —
  // and bumps synced_at, which both queues order by. The queue query filtered NEITHER archived_at NOR
  // deleted_at, so a participant who had tidied their copy away got it back, at the TOP of their
  // parking lot, because somebody else unfiled the thread.
  //
  // Fixed in the QUEUE, not in the detach: the detach must still clear the association on those rows
  // (they are on the deal until it does, archived or not), and "is this row listable" is the queue's
  // question about every row it returns, not a fact about how one of them got there. The same gap
  // showed for a message archived after any other unassignment, which a detach-side fix would have
  // left open.
  // -----------------------------------------------------------------------------------------------
  it("keeps an ARCHIVED copy out of the queue while still taking it off the deal", async () => {
    await tdb.execute(sql`UPDATE emails SET archived_at = now() WHERE graph_message_id = 'm2'`);

    await postDetach(collaboratorUser);

    expect(await assignmentQueueMessageIds()).toEqual(["m1"]);
    expect(await dealTabEmailIds()).toEqual([]);
    const rows = await messageAssignmentRows();
    expect(rows.every((row) => row.deal_id === null && row.assigned_entity_id === null)).toBe(true);
  });

  it("keeps a DELETED copy out of the queue while still taking it off the deal", async () => {
    await tdb.execute(sql`UPDATE emails SET deleted_at = now() WHERE graph_message_id = 'm2'`);

    await postDetach(collaboratorUser);

    expect(await assignmentQueueMessageIds()).toEqual(["m1"]);
    expect(await dealTabEmailIds()).toEqual([]);
  });

  it("does not COUNT an archived copy in the queue's pagination either", async () => {
    // The count runs its own query over the same predicate, so a filter added to the row read alone
    // would answer "1 of 2" and paginate against a total nothing can reach.
    await tdb.execute(sql`UPDATE emails SET archived_at = now() WHERE graph_message_id = 'm2'`);

    await postDetach(collaboratorUser);

    const result = await getEmailAssignmentQueue(tdb, {});
    expect(result.pagination.total).toBe(1);
  });

  it("clears a sibling filed to a COMPANY, and reports no deal to audit for it", async () => {
    // The other documented consequence: assigned_entity_type is not deal-only, so a conversation-scoped
    // unfile takes company/lead/property associations with it. The audit fallback only recovers DEAL
    // ids, so a conversation filed solely to a company is cleared with no app-level audit row — pinned
    // here so that gap is a known one rather than a surprise.
    await tdb.execute(sql`DELETE FROM email_thread_bindings`);
    await tdb.execute(sql`
      UPDATE emails
      SET deal_id = NULL, assigned_entity_type = 'company', assigned_entity_id = ${COMPANY_ACME}
      WHERE graph_conversation_id = ${CONV}
    `);

    await postDetach(mailboxOwnerUser);

    const rows = await messageAssignmentRows();
    expect(rows.every((row) => row.assigned_entity_type === null && row.assigned_entity_id === null)).toBe(true);
    expect(await auditRows()).toHaveLength(0);
  });

  // -----------------------------------------------------------------------------------------------
  // THE OTHER VIEW OF THE SAME MAIL. A deal shows its email twice — the Emails tab (getEmails, over
  // `emails`) and the Activity tab (getActivities, over `activities`) — and the bind writes both. A
  // detach that cleared only the message rows left the conversation on the Activity tab, so Unassign
  // appeared to work on one tab and to have done nothing on the other.
  // -----------------------------------------------------------------------------------------------
  it("takes the conversation off the deal's ACTIVITY tab, not just its Emails tab", async () => {
    await seedDealActivitiesForConversation();
    expect(await dealActivityEmailIds()).toHaveLength(2);

    await postDetach(collaboratorUser);

    expect(await dealTabEmailIds()).toEqual([]);
    expect(await dealActivityEmailIds()).toEqual([]);
  });

  it("clears the activity's LEAD link too, so a deal with a source lead keeps no back door", async () => {
    // getActivities does not filter on deal_id alone: when the deal has a source_lead_id it ORs in
    // `lead_id = <that lead>` (modules/activities/service.ts), because a deal's tab shows the history
    // of the lead it came from. The bind copies that lead onto the activity row, so nulling deal_id and
    // stopping there leaves the mail on the tab through the lead — the identical bug, one column over.
    const LEAD_SOURCE = U("c01");
    await tdb.execute(sql`INSERT INTO leads (id) VALUES (${LEAD_SOURCE})`);
    await tdb.execute(sql`UPDATE deals SET source_lead_id = ${LEAD_SOURCE} WHERE id = ${DEAL_OLD}`);
    await seedDealActivitiesForConversation();
    expect(await dealActivityEmailIds()).toHaveLength(2);

    await postDetach(collaboratorUser);

    expect(await dealActivityEmailIds()).toEqual([]);
  });

  it("leaves an activity belonging to a DIFFERENT conversation alone", async () => {
    // The re-point is keyed on the detached messages' ids, not on the deal — an UPDATE that swept the
    // deal would unfile every other email activity on it.
    await seedDealActivitiesForConversation();
    await tdb.execute(sql`
      INSERT INTO emails
        (graph_message_id, graph_conversation_id, subject, direction, from_address, to_addresses,
         deal_id, assigned_entity_type, assigned_entity_id, assignment_status, user_id, sent_at)
      VALUES ('other-1', 'conv-unrelated', 'Other', 'inbound', 'someone@example.com', '{}',
              ${DEAL_OLD}, 'deal', ${DEAL_OLD}, 'assigned', ${USER_OWNER}, '2026-07-05T00:00:00Z')
    `);
    await tdb.execute(sql`
      INSERT INTO activities
        (type, responsible_user_id, performed_by_user_id, source_entity_type, source_entity_id, deal_id, email_id, subject, occurred_at)
      SELECT 'email', e.user_id, e.user_id, 'deal', ${DEAL_OLD}, ${DEAL_OLD}, e.id, e.subject, e.sent_at
      FROM emails e WHERE e.graph_message_id = 'other-1'
    `);

    await postDetach(collaboratorUser);

    const survivors = await tdb.execute(sql`
      SELECT e.graph_message_id FROM activities a JOIN emails e ON e.id = a.email_id
      WHERE a.deal_id = ${DEAL_OLD}
    `);
    const rows = Array.isArray(survivors) ? survivors : survivors.rows;
    expect(rows.map((r: { graph_message_id: string }) => r.graph_message_id)).toEqual(["other-1"]);
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
