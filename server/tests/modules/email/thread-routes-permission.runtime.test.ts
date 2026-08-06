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
// The read the deal Emails tab actually performs. A move asserted only on emails.deal_id can leave
// assigned_entity_id pointing at the old deal, which keeps the message listed under BOTH tabs — so the
// "did it really move" cases below go through the same query the user's screen does.
const { getEmails } = await import("../../../src/modules/email/service.js");

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
// A deal this tenantDb cannot see at all — deliberately NEVER inserted into `deals`. The real
// office boundary in this codebase is the tenant search_path, so "a deal the caller cannot reach"
// is modelled as a deal whose row is not in this schema; assertDealCollaboratorAccess 404s on it.
// This is the same shape the existing "body-supplied dealId" case uses.
const DEAL_FOREIGN = U("d09");
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
// The SAME participant, but carrying a real office so the deal-write path admits them too. The pair
// (this and laterMessageOwnerUser) is how the read-scope cases below tell "admitted by mailbox
// ownership ONLY" apart from "admitted by the bound deal" without changing which messages the viewer
// owns.
const participantWithDealAccessUser: Viewer = {
  id: USER_SECOND, role: "rep", officeId: OFFICE_DALLAS, activeOfficeId: OFFICE_DALLAS,
};
// Neither mailbox nor deal access. CAVEAT, same as thread-mutation-permission.runtime.test.ts: the
// no-office viewer is how a "no deal access" user is modelled, because assertDealCollaboratorAccess's
// office check only asks whether the viewer has an office at all — the production-reachable denial is
// the cross-schema 404. What matters here is that the denial happens BEFORE any mutation.
const outsiderUser: Viewer = {
  id: USER_OUTSIDER, role: "rep", officeId: null, activeOfficeId: null,
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

async function getThreadRoute(user: Viewer, conversationId: string = CONV) {
  return invokeThreadHandler(findRouteHandler("get", "/thread/:conversationId"), "GET", user, {}, conversationId);
}

async function postThreadRoute(
  action: "assign" | "reassign" | "detach",
  user: Viewer,
  body: Record<string, unknown> = {},
  conversationId: string = CONV
) {
  return invokeThreadHandler(
    findRouteHandler("post", `/thread/:conversationId/${action}`),
    "POST",
    user,
    body,
    conversationId
  );
}

async function invokeThreadHandler(
  handler: (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown,
  method: "GET" | "POST",
  user: Viewer,
  body: Record<string, unknown>,
  conversationId: string
) {
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
    method,
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
      -- Read by getEmailThread's binding lookup (the thread payload carries the change-order flag so the
      -- assigned-deal label does not have to guess from the name). Same NOT NULL DEFAULT false as prod.
      is_change_order boolean NOT NULL DEFAULT false,
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
  // 0. THE WAY IN. The Reassign/Unassign controls are rendered from the GET payload
  //    (email-thread-view.tsx), so an owner-only read makes every gate below unreachable no matter how
  //    permissive it is: the collaborator lands on the component's error branch and never sees a button.
  // ---------------------------------------------------------------------------------------------
  it("GET: admits a deal collaborator who owns no mailbox on the thread", async () => {
    const { res } = await getThreadRoute(collaboratorUser);

    expect(res.statusCode).toBe(200);
    expect(res.body.emails).toHaveLength(2);
    expect(res.body.binding?.dealId).toBe(DEAL_OLD);
  });

  it("GET: rejects a caller with neither mailbox nor deal access", async () => {
    const err = await rejection(getThreadRoute(outsiderUser));
    expect(err.statusCode).toBe(403);
  });

  it("GET: admits the owner of a LATER message, not just the oldest one", async () => {
    // ADMISSION is what this pins. The PAYLOAD is scoped to their own copy, because this viewer carries
    // a null office and so was admitted by mailbox ownership alone — see section 8 for that rule and
    // for the case where a participant WITH deal access gets the whole conversation.
    const { res } = await getThreadRoute(laterMessageOwnerUser);
    expect(res.statusCode).toBe(200);
    expect(res.body.emails.map((e: { graphMessageId: string }) => e.graphMessageId)).toEqual(["m2"]);
  });

  it("GET: returns an empty payload for a conversation with no messages", async () => {
    const { res } = await getThreadRoute(collaboratorUser, "conv-does-not-exist");
    expect(res.body).toEqual({ binding: null, preview: null, emails: [] });
  });

  // ---------------------------------------------------------------------------------------------
  // 0b. AUTHORIZATION IS NOT A GRAPH CONCERN. The gate resolved a "the mailbox this thread is described
  //     by" id before it did anything else, and every lookup that could produce one filtered on
  //     status = 'active'. So a conversation none of whose participants currently has a WORKING Outlook
  //     connection 409'd "Connect mailbox first" — for a caller who could see the thread on the deal in
  //     front of them, and on the detach route, which touches nothing but local rows.
  //
  //     Non-active tokens are ordinary: an expired/revoked/reauth_needed row is what a failed refresh
  //     leaves behind, and a disconnect deletes the row outright. Neither says anything about whether
  //     THIS caller may read or re-file the thread.
  // ---------------------------------------------------------------------------------------------
  it("GET: admits a collaborator when no participant's token is ACTIVE any more", async () => {
    await tdb.execute(sql`UPDATE user_graph_tokens SET status = 'expired'`);

    const { res } = await getThreadRoute(collaboratorUser);

    expect(res.statusCode).toBe(200);
    expect(res.body.emails).toHaveLength(2);
    expect(res.body.binding?.dealId).toBe(DEAL_OLD);
  });

  it("GET: admits a collaborator when every participant has DISCONNECTED Outlook", async () => {
    // The harder half: revokeGraphTokens hard-DELETEs the row, so there is no mailbox to name at all.
    await tdb.execute(sql`DELETE FROM user_graph_tokens`);

    const { res } = await getThreadRoute(collaboratorUser);

    expect(res.statusCode).toBe(200);
    expect(res.body.emails).toHaveLength(2);
    expect(res.body.binding?.dealId).toBe(DEAL_OLD);
  });

  it("detach: unfiles a thread whose participants have all disconnected Outlook", async () => {
    // Detach needs no Graph connection whatsoever — it is a local UPDATE of bindings and message rows.
    // Refusing it for want of a connected mailbox left a misfiled conversation permanently stuck on the
    // wrong deal once its participants disconnected.
    await tdb.execute(sql`DELETE FROM user_graph_tokens`);

    const { res } = await postThreadRoute("detach", collaboratorUser);

    expect(res.statusCode).toBe(200);
    expect(await activeBindings()).toHaveLength(0);
    expect((await messageDealIds()).every((id) => id === null)).toBe(true);
  });

  it("reassign: still 403s an outsider on a thread with no connected mailbox anywhere", async () => {
    // The relaxation must not become a fall-open. With no mailbox to resolve, path 1 is decided purely
    // by message ownership and path 2 by deal access — an outsider satisfies neither, and the denial has
    // to stay a 403 rather than turning into the old 409 (or a 200).
    await tdb.execute(sql`DELETE FROM user_graph_tokens`);

    const err = await rejection(postThreadRoute("reassign", outsiderUser, { dealId: DEAL_NEW }));
    expect(err.statusCode).toBe(403);
    expect((await activeBindings()).every((r) => r.deal_id === DEAL_OLD)).toBe(true);
  });

  it("GET: hands a collaborator the other mailbox's archived, deleted and ignored messages", async () => {
    // DELIBERATE, and wider than the deal Emails LIST, which drops archived/deleted/ignored rows
    // (activeEmailConditions + assignmentStatus <> 'ignored'). The thread endpoint has never filtered
    // them for anyone, and archive/delete/ignore are personal INBOX actions — filtering a deal's thread
    // by whose inbox has been tidied would hand two people on the same deal different, gappy versions of
    // the same conversation. Pinned so a change in either direction is a decision, not a drift.
    //
    // deleted_at is the sharpest of the three — a rep's DELETED mail surfacing to a colleague — so it is
    // asserted here rather than merely named in a comment.
    await tdb.execute(sql`UPDATE emails SET archived_at = now() WHERE graph_message_id = 'm1'`);
    await tdb.execute(sql`UPDATE emails SET deleted_at = now() WHERE graph_message_id = 'm1'`);
    await tdb.execute(sql`UPDATE emails SET assignment_status = 'ignored' WHERE graph_message_id = 'm2'`);

    const { res } = await getThreadRoute(collaboratorUser);

    expect(res.body.emails).toHaveLength(2);
    expect(res.body.emails.map((e: { graphMessageId: string }) => e.graphMessageId).sort()).toEqual(["m1", "m2"]);
  });

  it("GET: a 404 from the deal gate reaches the client instead of reading as an empty thread", async () => {
    // THE CARVE-OUT TRAP. The GET answers 200-with-nothing for a conversation that holds no messages,
    // which used to be implemented by swallowing any 404 out of the gate. TWO things throw 404 in there:
    // getEmailThreadForMutation's "Email thread not found" AND assertDealCollaboratorAccess's "Deal not
    // found" — and swallowing the second turns a real authorization denial into a 200 that says the
    // thread is empty. The conversation here very much has messages; only the bound deal is gone.
    await tdb.execute(sql`UPDATE emails SET deal_id = NULL WHERE graph_conversation_id = ${CONV}`);
    await tdb.execute(sql`DELETE FROM deals WHERE id = ${DEAL_OLD}`);

    const err = await rejection(getThreadRoute(collaboratorUser));
    expect(err.statusCode).toBe(404);
    expect(err.message).toMatch(/Deal not found/i);
  });

  // ---------------------------------------------------------------------------------------------
  // 0b. The worker stores ONE emails row PER MAILBOX (graph_message_id is unique per mailbox, and the
  //     internet_message_id dedup is deliberately scoped to the mailbox's own outbound rows — see
  //     worker/src/jobs/email-sync.ts). Unscoped, this read therefore returns every real message once
  //     per participant. Collapsing those copies is PRESENTATION only: it changes which ROW represents
  //     a message, never which messages the caller may see.
  // ---------------------------------------------------------------------------------------------
  it("GET: collapses a message stored once per mailbox into a single row", async () => {
    // Distinct sent_at values on purpose, so "the oldest copy" is unambiguous — real copies of one
    // message usually share a timestamp, and which of those two wins is not what this pins.
    await tdb.execute(sql`
      UPDATE emails SET internet_message_id = '<shared@example.com>' WHERE graph_conversation_id = ${CONV}
    `);

    const { res } = await getThreadRoute(collaboratorUser);

    expect(res.body.emails).toHaveLength(1);
    // The caller owns neither copy, so the oldest one represents the message.
    expect(res.body.emails[0].graphMessageId).toBe("m1");
  });

  it("GET: represents a collapsed message by the CALLER'S OWN copy when they hold one", async () => {
    // Starred/archived/read state lives on the per-mailbox ROW. Handing a participant someone else's
    // copy would show them their own mail with someone else's state on it.
    await tdb.execute(sql`
      UPDATE emails SET internet_message_id = '<shared@example.com>' WHERE graph_conversation_id = ${CONV}
    `);
    await tdb.execute(sql`UPDATE emails SET is_starred = true WHERE graph_message_id = 'm2'`);

    const { res } = await getThreadRoute(laterMessageOwnerUser);

    expect(res.body.emails).toHaveLength(1);
    expect(res.body.emails[0].graphMessageId).toBe("m2");
    expect(res.body.emails[0].isStarred).toBe(true);
  });

  it("GET: never collapses two rows sharing an id inside ONE mailbox", async () => {
    // internet_message_id is a SENDER-SUPPLIED RFC822 header. A repeated or spoofed one would, keyed on
    // the id alone, silently hide a real message from the thread view while the deal Emails LIST — which
    // does not collapse — went on showing it, leaving two surfaces disagreeing about the conversation.
    // Two copies of one message live in two DIFFERENT mailboxes by definition, so requiring a differing
    // user_id removes the class outright. m1/m2 are the legitimate cross-mailbox pair and DO collapse;
    // m3 repeats the id inside USER_OWNER's own mailbox and must survive.
    await tdb.execute(sql`
      UPDATE emails SET internet_message_id = '<shared@example.com>' WHERE graph_conversation_id = ${CONV}
    `);
    await tdb.execute(sql`
      INSERT INTO emails
        (graph_message_id, graph_conversation_id, internet_message_id, subject, direction, from_address, to_addresses, deal_id, assignment_status, user_id, sent_at)
      VALUES
        ('m3', ${CONV}, '<shared@example.com>', 'Roof scope', 'inbound', 'sender@example.com', '{}', ${DEAL_OLD}, 'assigned', ${USER_OWNER}, '2026-07-03T00:00:00Z')
    `);

    const { res } = await getThreadRoute(collaboratorUser);

    expect(res.body.emails.map((e: { graphMessageId: string }) => e.graphMessageId)).toEqual(["m1", "m3"]);
  });

  it("GET: keeps a SECOND same-mailbox message that shares an id with another mailbox's copy", async () => {
    // The same-mailbox rule above has to survive more than one prior occurrence. With ONE global slot
    // per internet_message_id, m2 collapsed into m1 (a legitimate cross-mailbox copy) and m3 was then
    // compared against m1 as well — a different mailbox, so it collapsed too, and a real message
    // vanished even though the two rows sharing the id live in the SAME mailbox.
    //
    // Occurrences are therefore tracked per (message id, mailbox): the k-th row bearing an id inside a
    // mailbox is the copy of the k-th row bearing it in every other mailbox, and m3 is USER_SECOND's
    // SECOND occurrence, which nothing in USER_OWNER's mailbox stands for. Ordered so m3 is last, which
    // is the case that used to lose it.
    await tdb.execute(sql`
      UPDATE emails SET internet_message_id = '<shared@example.com>' WHERE graph_conversation_id = ${CONV}
    `);
    await tdb.execute(sql`
      INSERT INTO emails
        (graph_message_id, graph_conversation_id, internet_message_id, subject, direction, from_address, to_addresses, deal_id, assignment_status, user_id, sent_at)
      VALUES
        ('m3', ${CONV}, '<shared@example.com>', 'Roof scope', 'inbound', 'sender@example.com', '{}', ${DEAL_OLD}, 'assigned', ${USER_SECOND}, '2026-07-03T00:00:00Z')
    `);

    // The viewer owns NEITHER mailbox, which is the losing case: preferring their own copy would have
    // rewritten the slot and masked the bug.
    const { res } = await getThreadRoute(collaboratorUser);

    expect(res.body.emails.map((e: { graphMessageId: string }) => e.graphMessageId)).toEqual(["m1", "m3"]);
  });

  it("GET: still collapses a message held in THREE mailboxes down to one row", async () => {
    // The converse of the case above: per-mailbox occurrence tracking must not turn every extra mailbox
    // into an extra row. Three mailboxes, one occurrence each, one message.
    await tdb.execute(sql`
      UPDATE emails SET internet_message_id = '<shared@example.com>' WHERE graph_conversation_id = ${CONV}
    `);
    await tdb.execute(sql`
      INSERT INTO emails
        (graph_message_id, graph_conversation_id, internet_message_id, subject, direction, from_address, to_addresses, deal_id, assignment_status, user_id, sent_at)
      VALUES
        ('m3', ${CONV}, '<shared@example.com>', 'Roof scope', 'inbound', 'sender@example.com', '{}', ${DEAL_OLD}, 'assigned', ${USER_OUTSIDER}, '2026-07-03T00:00:00Z')
    `);

    const { res } = await getThreadRoute(collaboratorUser);

    expect(res.body.emails.map((e: { graphMessageId: string }) => e.graphMessageId)).toEqual(["m1"]);
  });

  it("GET: never collapses rows that carry NO internet_message_id", async () => {
    // internet_message_id is nullable, and a NULL is the ABSENCE of an identity, not an identity shared
    // with every other NULL. Keying on it would collapse a whole conversation of un-idd messages into
    // one — losing real messages, which is far worse than the doubling being fixed here. m1/m2 collapse
    // (shared id); m3/m4 are two DIFFERENT messages with no id at all and must both survive.
    await tdb.execute(sql`
      UPDATE emails SET internet_message_id = '<shared@example.com>' WHERE graph_conversation_id = ${CONV}
    `);
    await tdb.execute(sql`
      INSERT INTO emails
        (graph_message_id, graph_conversation_id, subject, direction, from_address, to_addresses, deal_id, assignment_status, user_id, sent_at)
      VALUES
        ('m3', ${CONV}, 'Roof scope', 'inbound', 'sender@example.com', '{}', ${DEAL_OLD}, 'assigned', ${USER_OWNER},  '2026-07-03T00:00:00Z'),
        ('m4', ${CONV}, 'Roof scope', 'inbound', 'sender@example.com', '{}', ${DEAL_OLD}, 'assigned', ${USER_SECOND}, '2026-07-04T00:00:00Z')
    `);

    const { res } = await getThreadRoute(collaboratorUser);

    expect(res.body.emails.map((e: { graphMessageId: string }) => e.graphMessageId)).toEqual(["m1", "m3", "m4"]);
  });

  it("reassign: hands back a refreshed thread that is collapsed too", async () => {
    // The mutation routes re-read through the same helper, so a doubled payload would come straight back
    // out of a successful reassign and the count in the header would jump on save.
    await tdb.execute(sql`
      UPDATE emails SET internet_message_id = '<shared@example.com>' WHERE graph_conversation_id = ${CONV}
    `);

    const { res } = await postThreadRoute("reassign", collaboratorUser, { dealId: DEAL_NEW });

    expect(res.body.thread.emails).toHaveLength(1);
    // The impact preview counts ROWS the mutation moves, not messages the reader sees — both copies
    // really did move, so it stays at 2. Pinned so the dedup is not "fixed" into the mutation side.
    expect(res.body.preview.affectedMessageCount).toBe(2);
  });

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

  it("assign: a non-participant collaborator cannot touch a thread filed under NO deal", async () => {
    // A thread filed nowhere has no deal to authorize against, so path 2 cannot run at all. Pinned so a
    // future "just let anyone file an unassigned thread" change is a deliberate one.
    //
    // "Filed nowhere" means BOTH sides: detaching the bindings is not enough now that the source-deal
    // set also reads the messages' own associations (section 9), and those messages are still on
    // DEAL_OLD until they are cleared too.
    await tdb.execute(sql`UPDATE email_thread_bindings SET detached_at = now()`);
    await tdb.execute(sql`
      UPDATE emails SET deal_id = NULL, assigned_entity_type = NULL, assigned_entity_id = NULL
      WHERE graph_conversation_id = ${CONV}
    `);

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

  it("assign: authorizes off ANY active binding when the OLDEST message's mailbox is detached", async () => {
    // Same trap, on the third route. The derivation is shared, but per-route coverage is what stops a
    // future revert landing on one route and going unnoticed.
    await tdb.execute(sql`
      UPDATE email_thread_bindings SET detached_at = now() WHERE mailbox_account_id = ${MBX_OWNER}
    `);

    const { res } = await postThreadRoute("assign", collaboratorUser, { dealId: DEAL_NEW });

    expect(res.statusCode).toBe(200);
    expect((await activeBindings()).every((r) => r.deal_id === DEAL_NEW)).toBe(true);
  });

  it("GET: authorizes off ANY active binding when the OLDEST message's mailbox is detached", async () => {
    await tdb.execute(sql`
      UPDATE email_thread_bindings SET detached_at = now() WHERE mailbox_account_id = ${MBX_OWNER}
    `);

    const { res } = await getThreadRoute(collaboratorUser);
    expect(res.statusCode).toBe(200);
  });

  it("GET: REPORTS that binding too, instead of rendering the thread as unassigned", async () => {
    // The other half of the case above, and the one the user actually sees. The gate is
    // conversation-wide, but the payload's `binding` used to be built from the mutation context — one
    // arbitrary mailbox's binding (the oldest connected participant's). Detach only THAT mailbox and
    // the gate still admits the caller while the payload says binding: null, so EmailThreadView
    // (client/src/components/email/email-thread-view.tsx) renders the thread as UNASSIGNED and hides
    // the Reassign/Unassign controls — on a thread that is very much filed on a deal, and that this
    // caller is authorized to move.
    await tdb.execute(sql`
      UPDATE email_thread_bindings SET detached_at = now() WHERE mailbox_account_id = ${MBX_OWNER}
    `);

    const { res } = await getThreadRoute(collaboratorUser);

    expect(res.body.binding).not.toBeNull();
    expect(res.body.binding.dealId).toBe(DEAL_OLD);
    expect(res.body.binding.dealName).toBe("Old Deal");
    // ...and it names the mailbox the surviving binding actually belongs to, not the detached one.
    expect(res.body.binding.mailboxAccountId).toBe(MBX_SECOND);
  });

  it("GET: still reports NO binding once every mailbox is detached", async () => {
    // The converse, so "read the conversation-wide binding" cannot quietly become "always report
    // something". A fully detached conversation IS unassigned, and the controls should say so.
    await tdb.execute(sql`UPDATE email_thread_bindings SET detached_at = now()`);

    // Nothing is bound any more, so only path 1 can admit — use a participant.
    const { res } = await getThreadRoute(laterMessageOwnerUser);

    expect(res.statusCode).toBe(200);
    expect(res.body.binding).toBeNull();
  });

  // ---------------------------------------------------------------------------------------------
  // 3b. ORPHANED bindings — a binding whose mailbox_account_id no longer exists in user_graph_tokens.
  //     Every disconnect→reconnect makes one: revokeGraphTokens hard-DELETEs the row while
  //     upsertGraphTokens only updates in place, so reconnecting mints a NEW id and strands the old
  //     bindings. detachConversationAcrossMailboxes clears them regardless of token, so the deal
  //     resolver has to see the same set or the two disagree.
  // ---------------------------------------------------------------------------------------------
  it("detach: a conversation held only by an ORPHANED binding is still authorized, and still audited", async () => {
    // Filtering orphans out of the resolver would report boundDealId = null here: the collaborator whose
    // deal it is actually filed under gets a 403, and if a mailbox owner detaches it the filing is wiped
    // with NO audit row at all — the deal's email silently disappears with no record of who did it.
    await tdb.execute(sql`UPDATE email_thread_bindings SET detached_at = now()`);
    const MBX_DISCONNECTED = U("00d"); // sorts FIRST, so it also proves the ordering is not the filter
    await tdb.execute(sql`
      INSERT INTO email_thread_bindings
        (mailbox_account_id, provider, provider_conversation_id, deal_id, binding_source, confidence)
      VALUES (${MBX_DISCONNECTED}, 'microsoft_graph', ${CONV}, ${DEAL_OLD}, 'manual', 'high')
    `);
    // Deliberately NO user_graph_tokens row for MBX_DISCONNECTED.

    const { res } = await postThreadRoute("detach", collaboratorUser);

    expect(res.statusCode).toBe(200);
    expect(await activeBindings()).toHaveLength(0);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].table_name).toBe("deals");
    expect(rows[0].record_id).toBe(DEAL_OLD);
    expect(rows[0].changed_by).toBe(USER_COLLAB);
    expect(rows[0].full_row).toMatchObject({ previousDealId: DEAL_OLD, detached: true });
  });

  it("a LIVE binding still wins over an orphan with a lower mailbox id", async () => {
    // The other half of the same decision: orphans must be visible, but they must never outrank a live
    // binding, or a reassign would report the deal the thread has already left (the rebind cannot move
    // an orphan, so it keeps pointing at the old deal forever).
    const MBX_DISCONNECTED = U("00d"), DEAL_STALE = U("d03");
    await tdb.execute(sql`INSERT INTO deals (id, name) VALUES (${DEAL_STALE}, 'Stale Deal')`);
    await tdb.execute(sql`
      INSERT INTO email_thread_bindings
        (mailbox_account_id, provider, provider_conversation_id, deal_id, binding_source, confidence)
      VALUES (${MBX_DISCONNECTED}, 'microsoft_graph', ${CONV}, ${DEAL_STALE}, 'manual', 'high')
    `);

    const { res } = await postThreadRoute("reassign", collaboratorUser, { dealId: DEAL_NEW });

    expect(res.body.preview.currentDealId).toBe(DEAL_OLD);
    expect(res.body.preview.currentDealId).not.toBe(DEAL_STALE);
  });

  // ---------------------------------------------------------------------------------------------
  // 3c. PRIVILEGE ESCALATION. A binding is keyed per (mailbox, conversation) and nothing forces two
  //     mailboxes' bindings for one conversation to name the SAME deal — a message can be filed from
  //     each mailbox independently. Reassign and detach are conversation-WIDE: they move every binding
  //     and every message. So "the deal this thread is on" is a SET, and authorizing against one member
  //     of it lets access to that member buy a mutation on the others.
  //
  //     The gate must therefore require access to EVERY distinct active source deal, not just whichever
  //     one the resolver's ORDER BY happens to return first. These cases put the REACHABLE deal first
  //     on purpose: with the unreachable one sorting first the old code already refused, so only this
  //     arrangement demonstrates the escalation.
  // ---------------------------------------------------------------------------------------------
  async function crossFileSecondMailboxToAForeignDeal() {
    await tdb.execute(sql`
      UPDATE email_thread_bindings SET deal_id = ${DEAL_FOREIGN}
      WHERE mailbox_account_id = ${MBX_SECOND}
    `);
  }

  it("reassign: refuses when a second mailbox's binding names a deal the caller cannot reach", async () => {
    // collaboratorUser can reach DEAL_OLD (MBX_OWNER's binding, which sorts first) and cannot reach
    // DEAL_FOREIGN (MBX_SECOND's). Authorizing off the first binding alone would let their access to
    // DEAL_OLD move DEAL_FOREIGN's email too.
    await crossFileSecondMailboxToAForeignDeal();

    const err = await rejection(postThreadRoute("reassign", collaboratorUser, { dealId: DEAL_NEW }));
    expect(err.statusCode).toBe(404);
    expect(err.message).toMatch(/Deal not found/i);

    // Refused, and nothing moved — not the binding they COULD reach, not the one they could not, and
    // not the messages. A gate that ran after a partial mutation would be no gate at all.
    const byMailbox = Object.fromEntries(
      (await activeBindings()).map((r) => [r.mailbox_account_id, r.deal_id])
    );
    expect(byMailbox[MBX_OWNER]).toBe(DEAL_OLD);
    expect(byMailbox[MBX_SECOND]).toBe(DEAL_FOREIGN);
    expect((await messageDealIds()).every((id) => id === DEAL_OLD)).toBe(true);
    expect(commits).toBe(0);
  });

  it("detach: refuses when a second mailbox's binding names a deal the caller cannot reach", async () => {
    // Detach is the sharper half: it clears EVERY active binding and every message association in one
    // statement, so an unauthorized detach silently unfiles the other deal's email entirely.
    await crossFileSecondMailboxToAForeignDeal();

    const err = await rejection(postThreadRoute("detach", collaboratorUser));
    expect(err.statusCode).toBe(404);
    expect(err.message).toMatch(/Deal not found/i);

    expect(await activeBindings()).toHaveLength(2);
    expect((await messageDealIds()).every((id) => id === DEAL_OLD)).toBe(true);
    expect(await auditRows()).toHaveLength(0);
    expect(commits).toBe(0);
  });

  it("assign: refuses when a second mailbox's binding names a deal the caller cannot reach", async () => {
    // Per-route on purpose: the derivation is shared, but the realistic regression on this branch has
    // repeatedly been "landed on two routes, forgotten on the third".
    await crossFileSecondMailboxToAForeignDeal();

    const err = await rejection(postThreadRoute("assign", collaboratorUser, { dealId: DEAL_NEW }));
    expect(err.statusCode).toBe(404);
    expect((await activeBindings()).map((r) => r.deal_id).sort()).toEqual(
      [DEAL_OLD, DEAL_FOREIGN].sort()
    );
    expect(commits).toBe(0);
  });

  it("GET: refuses a collaborator when a second mailbox's binding names a deal they cannot reach", async () => {
    // A DELIBERATE consequence of gating the read with the same helper as the mutations. The
    // Reassign/Unassign controls are rendered from this payload, so leaving the read permissive while
    // the mutations tightened would hand this caller two buttons that always fail. Denying the read is
    // the honest answer: they may not act on this thread, so they are not shown it.
    //
    // It costs them nothing they can otherwise reach — the deal Emails LIST for DEAL_OLD still shows the
    // message — and it only bites a caller who owns NONE of the conversation's messages (path 1 admits
    // any participant regardless).
    await crossFileSecondMailboxToAForeignDeal();

    const err = await rejection(getThreadRoute(collaboratorUser));
    expect(err.statusCode).toBe(404);
    expect(err.message).toMatch(/Deal not found/i);
  });

  it("a mailbox owner may still act on a conversation cross-filed to a deal they cannot reach", async () => {
    // THE DECISION on path 1 (mailbox ownership), pinned rather than left to drift. Owning a message in
    // the conversation still admits the caller on its own, even though the conversation-wide detach then
    // clears a binding belonging to a deal they have no access to.
    //
    // WHY it stays: path 1 is about the caller's OWN mail, which they can already read and re-file in
    // Outlook itself, so it is not a confidentiality boundary. Narrowing it to "owner AND deal access"
    // would 403 exactly the person best placed to fix a misfiling — a misfiled thread is BY DEFINITION
    // on the wrong deal, frequently one the owner cannot reach, which is the whole reason this feature
    // exists. The escalation closed above is a path-2 one: it let a caller who owns NONE of the mail
    // convert access to one deal into a mutation on another.
    //
    // The residue is accepted and audited: a participant can unfile a conversation from a deal they
    // cannot see. laterMessageOwnerUser carries a NULL office, so path 2 can never rescue them — passing
    // here proves mailbox ownership alone did it.
    await crossFileSecondMailboxToAForeignDeal();

    const { res } = await postThreadRoute("detach", laterMessageOwnerUser);

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

  it("reassign: moves a disconnected participant's copy too, so the preview is not a lie", async () => {
    // THE USER-VISIBLE CLAIM, not a claim about bindings: the route answers 200 with a preview that
    // counts every message in the conversation, so every message has to have moved. It used to not.
    // bindConversationToDealAcrossMailboxes reaches mailboxes through user_graph_tokens, and a
    // participant who used the Graph disconnect endpoint has that row hard-DELETED — so their copy of
    // the thread was silently skipped and stayed on the OLD deal while the response told the user the
    // whole conversation had moved. The disconnected copy needs no Graph call to move: it is a local
    // UPDATE, exactly like the one detach already does conversation-wide.
    const USER_GONE = U("a08");
    await tdb.execute(sql`
      INSERT INTO users (id, email, display_name, role, office_id)
      VALUES (${USER_GONE}, 'gone@example.com', 'Disconnected', 'rep', ${OFFICE_DALLAS})
    `);
    // Deliberately NO user_graph_tokens row for USER_GONE, and an ORPHANED binding for the mailbox id
    // their disconnect left behind — the two halves of the same disconnect, and both were skipped.
    const MBX_GONE = U("f0e");
    await tdb.execute(sql`
      INSERT INTO emails
        (graph_message_id, graph_conversation_id, direction, from_address, to_addresses, deal_id, assignment_status, user_id, sent_at)
      VALUES ('m3', ${CONV}, 'inbound', 'sender@example.com', '{}', ${DEAL_OLD}, 'assigned', ${USER_GONE}, '2026-07-03T00:00:00Z')
    `);
    await tdb.execute(sql`
      INSERT INTO email_thread_bindings
        (mailbox_account_id, provider, provider_conversation_id, deal_id, binding_source, confidence)
      VALUES (${MBX_GONE}, 'microsoft_graph', ${CONV}, ${DEAL_OLD}, 'manual', 'high')
    `);

    const { res } = await postThreadRoute("reassign", collaboratorUser, { dealId: DEAL_NEW });

    // Every message the preview counted is a message that actually moved.
    expect(res.body.preview.affectedMessageCount).toBe(3);
    const dealIds = await messageDealIds();
    expect(dealIds).toHaveLength(3);
    expect(dealIds.filter((id) => id === DEAL_NEW)).toHaveLength(3);
    expect(dealIds.filter((id) => id === DEAL_OLD)).toHaveLength(0);

    // ...and nothing is still filed under the deal the thread has left, orphaned binding included.
    const rows = await activeBindings();
    expect(rows.every((r) => r.deal_id === DEAL_NEW)).toBe(true);
    expect(rows.map((r) => r.mailbox_account_id).sort()).toEqual(
      [MBX_OWNER, MBX_SECOND, MBX_GONE].sort()
    );
  });

  it("reassign: the disconnected copy leaves the OLD deal's Emails tab and lands on the new one", async () => {
    // The reason the assertion above is not enough on its own: emails.deal_id is only half of what the
    // deal Emails tab reads. getEmails filters on `deal_id OR (assigned_entity_type = 'deal' AND
    // assigned_entity_id = …)`, so a move that set deal_id and left assigned_entity_id pointing at the
    // old deal would keep the message listed under BOTH — and the tab, not the column, is what the user
    // sees. Asserting through getEmails is how the original detach no-op would have been caught.
    const USER_GONE = U("a08");
    await tdb.execute(sql`
      INSERT INTO users (id, email, display_name, role, office_id)
      VALUES (${USER_GONE}, 'gone@example.com', 'Disconnected', 'rep', ${OFFICE_DALLAS})
    `);
    await tdb.execute(sql`
      INSERT INTO emails
        (graph_message_id, graph_conversation_id, subject, direction, from_address, to_addresses,
         deal_id, assigned_entity_type, assigned_entity_id, assignment_status, user_id, sent_at)
      VALUES ('m3', ${CONV}, 'Roof scope', 'inbound', 'sender@example.com', '{}',
              ${DEAL_OLD}, 'deal', ${DEAL_OLD}, 'assigned', ${USER_GONE}, '2026-07-03T00:00:00Z')
    `);

    await postThreadRoute("reassign", collaboratorUser, { dealId: DEAL_NEW });

    const oldTab = await getEmails(tdb, { dealId: DEAL_OLD }, undefined, "director");
    const newTab = await getEmails(tdb, { dealId: DEAL_NEW }, undefined, "director");
    expect(oldTab.emails).toHaveLength(0);
    expect(newTab.emails.map((email: { graphMessageId: string }) => email.graphMessageId).sort()).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
  });

  it("reassign: writes one audit row naming the actor, both deals, and the message count", async () => {
    await postThreadRoute("reassign", collaboratorUser, { dealId: DEAL_NEW });

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    // (table_name, record_id) is the PAIR audit consumers index and resolve by — the feed renders
    // `table_name || ':' || record_id` as the entity name and dedupes on the pair
    // (modules/admin/audit-service.ts). record_id has to be a deal id (audit_log.record_id is uuid NOT
    // NULL and a Graph conversation id is not a uuid), so the table name has to say `deals` or the row
    // names a binding that does not exist and is discoverable from nothing at all.
    expect(rows[0].table_name).toBe("deals");
    expect(rows[0].record_id).toBe(DEAL_OLD);
    expect(rows[0].action).toBe("update");
    // entity_type still says what KIND of event this was: the feed reads
    // COALESCE(entity_type, table_name), so the pair can point at the deal while the event stays
    // filterable as an email_thread move.
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
    // Same pairing as reassign, and it has to be the same: an audit row filed under a table name whose
    // record_id is a deal id matches neither a binding nor the deal.
    expect(rows[0].table_name).toBe("deals");
    expect(rows[0].record_id).toBe(DEAL_OLD);
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

  // ---------------------------------------------------------------------------------------------
  // 8. READ SCOPE — how the caller got in decides how WIDE the payload is.
  //
  //    The thread read is unscoped, which is what lets a deal collaborator who owns none of the
  //    conversation see it at all. But path 1 (mailbox ownership) needs only ONE stored row: on an
  //    UNBOUND conversation, anyone who received a single early message passed the gate and then read
  //    every tenant user's copy of the whole conversation — including replies and forwards they were
  //    never on. Being a participant in a conversation is not being a recipient of every later message
  //    in it.
  //
  //    So the widening has to follow the DEAL, not the mailbox: a caller admitted by deal write access
  //    already sees every mailbox's copy on that deal's Emails tab, and a caller admitted by mailbox
  //    ownership alone sees their own mail — which is what they had in Outlook anyway.
  // ---------------------------------------------------------------------------------------------
  /** Filed nowhere at all: no active binding, and no message-side association either. */
  async function unfileTheConversationCompletely() {
    await tdb.execute(sql`UPDATE email_thread_bindings SET detached_at = now()`);
    await tdb.execute(sql`
      UPDATE emails SET deal_id = NULL, assigned_entity_type = NULL, assigned_entity_id = NULL
      WHERE graph_conversation_id = ${CONV}
    `);
  }

  /** A body only USER_OWNER's copy carries, so a leak is visible as content and not merely as a count. */
  async function putASecretInTheOldestMessage() {
    await tdb.execute(sql`
      UPDATE emails SET body_html = '<p>OWNER ONLY SECRET</p>', body_preview = 'OWNER ONLY SECRET'
      WHERE graph_message_id = 'm1'
    `);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function bodiesOf(payloadEmails: any[]): string {
    return payloadEmails
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((email: any) => `${email.bodyHtml ?? ""} ${email.bodyPreview ?? ""} ${email.subject ?? ""}`)
      .join(" | ");
  }

  it("GET: does not hand a participant another mailbox's message on an UNBOUND conversation", async () => {
    // THE DISCLOSURE, asserted as content rather than as a filter argument. USER_SECOND owns m2 and
    // nothing else; m1 is USER_OWNER's copy and there is no deal in the picture to justify widening.
    await unfileTheConversationCompletely();
    await putASecretInTheOldestMessage();

    const { res } = await getThreadRoute(laterMessageOwnerUser);

    expect(res.statusCode).toBe(200);
    expect(bodiesOf(res.body.emails)).not.toContain("OWNER ONLY SECRET");
    expect(res.body.emails.map((e: { graphMessageId: string }) => e.graphMessageId)).toEqual(["m2"]);
  });

  it("GET: still hands every participant's copy to a caller admitted by the BOUND DEAL", async () => {
    // The other side, and the reason the scoping cannot simply be reinstated for everyone: the deal
    // Emails LIST already shows this caller both copies, so a narrower thread read would be a strictly
    // gappier view of mail they can plainly see.
    await putASecretInTheOldestMessage();

    const { res } = await getThreadRoute(collaboratorUser);

    expect(res.body.emails.map((e: { graphMessageId: string }) => e.graphMessageId)).toEqual(["m1", "m2"]);
    expect(bodiesOf(res.body.emails)).toContain("OWNER ONLY SECRET");
  });

  it("GET: widens for a PARTICIPANT who also has deal access, not only for a non-participant", async () => {
    // "Mailbox ownership ONLY" is the narrowing condition, not "mailbox ownership at all". This viewer
    // owns m2 AND can write the deal the conversation is filed under; scoping them would make the thread
    // view narrower than the deal tab they came from, for no security gain.
    await putASecretInTheOldestMessage();

    const { res } = await getThreadRoute(participantWithDealAccessUser);

    expect(res.body.emails.map((e: { graphMessageId: string }) => e.graphMessageId)).toEqual(["m1", "m2"]);
    expect(bodiesOf(res.body.emails)).toContain("OWNER ONLY SECRET");
  });

  it("reassign: hands a mailbox owner back a refreshed thread scoped to their own copies", async () => {
    // The refresh at the end of a mutation goes through the same reader, so the scope has to follow the
    // same rule there — otherwise the leak simply moves from GET to the POST response.
    //
    // The conversation is filed on a deal this schema cannot see, so ONLY mailbox ownership can admit
    // the caller; the DESTINATION deal stays reachable, so the move itself still runs. (The viewer has
    // to hold an office — the reassign route checks the destination on its own — which is why the
    // source deal, not the viewer, is what makes path 2 miss here.)
    await putASecretInTheOldestMessage();
    await tdb.execute(sql`UPDATE email_thread_bindings SET deal_id = ${DEAL_FOREIGN}`);
    await tdb.execute(sql`
      UPDATE emails SET deal_id = ${DEAL_FOREIGN}, assigned_entity_id = ${DEAL_FOREIGN}, assigned_entity_type = 'deal'
      WHERE graph_conversation_id = ${CONV}
    `);

    const { res } = await postThreadRoute("reassign", participantWithDealAccessUser, { dealId: DEAL_NEW });

    expect(res.statusCode).toBe(200);
    expect(bodiesOf(res.body.thread.emails)).not.toContain("OWNER ONLY SECRET");
    expect(res.body.thread.emails.map((e: { graphMessageId: string }) => e.graphMessageId)).toEqual(["m2"]);
  });

  // ---------------------------------------------------------------------------------------------
  // 9. MESSAGE-SIDE associations are a source deal too.
  //
  //    associateEmailToEntity — the assignment queue's one-message-at-a-time file — writes
  //    emails.deal_id and creates NO binding. Such a conversation shows on the deal's Emails tab while
  //    the binding side has nothing to report, so a gate sourced from bindings alone handed the deal
  //    set an empty list and 403'd every collaborator who does not own a mailbox copy: the thread would
  //    not open, and neither action would run.
  //
  //    Adding those deals ADDS to the set the caller must clear in full. It can never subtract from it.
  // ---------------------------------------------------------------------------------------------
  it("GET: admits a deal collaborator on a queue-filed conversation with no binding", async () => {
    await tdb.execute(sql`DELETE FROM email_thread_bindings`);

    const { res } = await getThreadRoute(collaboratorUser);

    expect(res.statusCode).toBe(200);
    expect(res.body.emails).toHaveLength(2);
  });

  it("reassign: admits a deal collaborator on a queue-filed conversation with no binding", async () => {
    await tdb.execute(sql`DELETE FROM email_thread_bindings`);

    const { res } = await postThreadRoute("reassign", collaboratorUser, { dealId: DEAL_NEW });

    expect(res.statusCode).toBe(200);
    expect((await messageDealIds()).every((id) => id === DEAL_NEW)).toBe(true);
  });

  it("detach: admits a deal collaborator on a queue-filed conversation with no binding", async () => {
    await tdb.execute(sql`DELETE FROM email_thread_bindings`);

    const { res } = await postThreadRoute("detach", collaboratorUser);

    expect(res.statusCode).toBe(200);
    expect((await messageDealIds()).every((id) => id === null)).toBe(true);
  });

  it("reassign: refuses when a MESSAGE names a deal the caller cannot reach, though no binding does", async () => {
    // THE ESCALATION the widened set must not open. Every binding names DEAL_OLD, which this caller can
    // reach — but m2 was filed message-side onto a deal in another schema. A reassign rewrites EVERY
    // message in the conversation, so admitting on the bindings alone converts access to DEAL_OLD into
    // a move of DEAL_FOREIGN's mail. The message-side deals are authorized against, not merely used to
    // open the door.
    await tdb.execute(sql`
      UPDATE emails SET deal_id = ${DEAL_FOREIGN}, assigned_entity_id = ${DEAL_FOREIGN}, assigned_entity_type = 'deal'
      WHERE graph_message_id = 'm2'
    `);

    const err = await rejection(postThreadRoute("reassign", collaboratorUser, { dealId: DEAL_NEW }));
    expect(err.statusCode).toBe(404);
    expect(err.message).toMatch(/Deal not found/i);

    expect((await activeBindings()).every((r) => r.deal_id === DEAL_OLD)).toBe(true);
    expect(await messageDealIds()).toEqual([DEAL_OLD, DEAL_FOREIGN]);
    expect(commits).toBe(0);
  });

  it("detach: refuses when a MESSAGE names a deal the caller cannot reach, though no binding does", async () => {
    // Detach is the sharper half again: it clears every message association in one statement, so an
    // unauthorized detach unfiles the other deal's mail outright.
    await tdb.execute(sql`
      UPDATE emails SET deal_id = ${DEAL_FOREIGN}, assigned_entity_id = ${DEAL_FOREIGN}, assigned_entity_type = 'deal'
      WHERE graph_message_id = 'm2'
    `);

    const err = await rejection(postThreadRoute("detach", collaboratorUser));
    expect(err.statusCode).toBe(404);
    expect(await activeBindings()).toHaveLength(2);
    expect(await messageDealIds()).toEqual([DEAL_OLD, DEAL_FOREIGN]);
    expect(await auditRows()).toHaveLength(0);
    expect(commits).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // 10. REUSING a binding is not the same as having nothing to do.
  //
  //     The per-EMAIL Reassign (POST /api/email/:id/associate) moves ONE message and never touches the
  //     thread binding, so a conversation can be bound to DEAL_OLD with one of its messages sitting on
  //     DEAL_NEW. Reassigning the whole conversation BACK to DEAL_OLD then finds every binding already
  //     naming the target — and the per-mailbox bind returned early on exactly that condition, skipping
  //     the back-association. The route still answered 200 and still wrote an audit row saying the
  //     conversation had moved, while the stray message stayed on the wrong deal.
  // ---------------------------------------------------------------------------------------------
  it("reassign: repairs a stray message even when every binding already names the target deal", async () => {
    await tdb.execute(sql`
      UPDATE emails SET deal_id = ${DEAL_NEW}, assigned_entity_type = 'deal', assigned_entity_id = ${DEAL_NEW}
      WHERE graph_message_id = 'm2'
    `);
    // The activity row the per-email move left behind, which the deal's ACTIVITY tab reads.
    await tdb.execute(sql`
      INSERT INTO activities
        (type, responsible_user_id, performed_by_user_id, source_entity_type, source_entity_id, deal_id, email_id, subject, occurred_at)
      SELECT 'email', e.user_id, e.user_id, 'deal', ${DEAL_NEW}, ${DEAL_NEW}, e.id, e.subject, e.sent_at
      FROM emails e WHERE e.graph_message_id = 'm2'
    `);

    const { res } = await postThreadRoute("reassign", collaboratorUser, { dealId: DEAL_OLD });

    expect(res.statusCode).toBe(200);
    expect(await messageDealIds()).toEqual([DEAL_OLD, DEAL_OLD]);

    // Through the read the user actually looks at, not the column: getEmails ORs deal_id with the
    // assigned_entity pair, so a repair that moved only one of them would leave m2 on BOTH tabs.
    const oldTab = await getEmails(tdb, { dealId: DEAL_OLD }, undefined, "director");
    const newTab = await getEmails(tdb, { dealId: DEAL_NEW }, undefined, "director");
    expect(oldTab.emails.map((e: { graphMessageId: string }) => e.graphMessageId).sort()).toEqual(["m1", "m2"]);
    expect(newTab.emails).toHaveLength(0);

    const activityRows = await tdb.execute(sql`SELECT deal_id FROM activities`);
    const rows = Array.isArray(activityRows) ? activityRows : activityRows.rows;
    expect(rows.every((r: { deal_id: string | null }) => r.deal_id === DEAL_OLD)).toBe(true);
  });
});
