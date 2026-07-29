import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql, eq } from "drizzle-orm";
import { emails, emailThreadBindings, userGraphTokens, users } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import {
  assertCanMutateEmailThread,
  type EmailThreadMutationContext,
} from "../../../src/modules/email/service.js";
import { AppError } from "../../../src/middleware/error-handler.js";

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;

// USER_OWNER holds the thread's mailbox. Their VIEWER object (ownerUser, below) carries a null office
// so path 2 can never admit them — anything they are allowed to do here came from path 1 (mailbox
// ownership) and nothing else. NOTE their users ROW still has a real office_id, because that column is
// .notNull() (shared/src/schema/public/users.ts): the null lives on the viewer, and only on the viewer.
// Do NOT "fix" the viewer to match the row — that would make the first case pass via path 2 and stop it
// proving anything.
const USER_OWNER = U("a01");
// USER_COLLAB is a different human with their own, DIFFERENT mailbox and an office — path 1 misses,
// path 2 must admit.
const USER_COLLAB = U("a02");
// USER_OUTSIDER also has their own mailbox, but their viewer object carries no office — both paths must
// miss. Same row-vs-viewer split as USER_OWNER above.
const USER_OUTSIDER = U("a03");
// USER_NO_MAILBOX has an office but no user_graph_tokens row at all: resolveMailboxAccountIdForCrmUser
// throws 409 "Connect mailbox first" for them, which must NOT escape ahead of path 2.
const USER_NO_MAILBOX = U("a04");
// The deal's assigned rep — present only so the getDealOfficeAccess leftJoin has a real row to hit.
const USER_REP = U("a05");

// "m" is not a hex digit, so mailbox ids use hex-safe suffixes.
const MBX_OWNER = U("e01"), MBX_COLLAB = U("e02"), MBX_OUTSIDER = U("e03");
const OFFICE_DALLAS = U("0f1"), OFFICE_ATLANTA = U("0f2");
const DEAL_OLD = U("d01");
// A deal that exists only in ANOTHER office's schema — the real cross-office boundary in this codebase
// is the tenant search_path, not a column comparison. See the cross-office case at the bottom.
const DEAL_ATLANTA = U("d02");
const CONV = "conv-thread-mutation-1";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;
let thread: EmailThreadMutationContext;
let unboundThread: EmailThreadMutationContext;

const ownerUser = { id: USER_OWNER, role: "rep", officeId: null, activeOfficeId: null };
const collaboratorUser = { id: USER_COLLAB, role: "rep", officeId: OFFICE_DALLAS, activeOfficeId: OFFICE_DALLAS };
const outsiderUser = { id: USER_OUTSIDER, role: "rep", officeId: null, activeOfficeId: null };
const noMailboxUser = { id: USER_NO_MAILBOX, role: "rep", officeId: OFFICE_DALLAS, activeOfficeId: OFFICE_DALLAS };

/** Await a rejection and hand back the AppError, so a case can assert BOTH status code and message
 *  rather than a loose message regex — and so a call that wrongly RESOLVES fails loudly. Anything that
 *  is not an AppError (a PGlite failure, say) is re-thrown rather than cast, so it surfaces as itself
 *  instead of as "expected undefined to be 403". */
async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return err;
  }
  throw new Error("expected assertCanMutateEmailThread to reject, but it resolved");
}

beforeEach(async () => {
  pg = new PGlite();
  tdb = drizzle(pg);

  // emails / email_thread_bindings / user_graph_tokens / users come straight from the real Drizzle
  // definitions (#677 helper) rather than hand-rolled DDL — `users` matters here because
  // getDealOfficeAccess leftJoins it for the assignee's office. deals stays a hand-rolled island (same
  // pattern as thread-multi-mailbox.runtime.test.ts): getDealOfficeAccess reads exactly four columns off
  // it, and generating the real table would drag in the whole company/property/lead/stage graph.
  await pg.exec(tenantSchemaSql("public", [emails, emailThreadBindings, userGraphTokens, users]));
  await tdb.execute(sql`
    CREATE TABLE deals (
      id uuid PRIMARY KEY,
      assigned_rep_id uuid,
      source_lead_id uuid,
      office_code text
    )
  `);
  // A second tenant schema standing in for another office. Nothing sets search_path to it — that is the
  // point: tdb can only ever see public."deals".
  await tdb.execute(sql`CREATE SCHEMA office_atlanta`);
  await tdb.execute(sql`
    CREATE TABLE office_atlanta.deals (
      id uuid PRIMARY KEY,
      assigned_rep_id uuid,
      source_lead_id uuid,
      office_code text
    )
  `);
  await tdb.execute(sql`INSERT INTO office_atlanta.deals (id) VALUES (${DEAL_ATLANTA})`);

  await tdb.execute(sql`
    INSERT INTO users (id, email, display_name, role, office_id) VALUES
      (${USER_OWNER},      'owner@example.com',    'Owner',       'rep', ${OFFICE_DALLAS}),
      (${USER_COLLAB},     'collab@example.com',   'Collaborator','rep', ${OFFICE_DALLAS}),
      (${USER_OUTSIDER},   'outsider@example.com', 'Outsider',    'rep', ${OFFICE_ATLANTA}),
      (${USER_NO_MAILBOX}, 'nomailbox@example.com','No Mailbox',  'rep', ${OFFICE_DALLAS}),
      (${USER_REP},        'rep@example.com',      'Assigned Rep','rep', ${OFFICE_DALLAS})
  `);
  // Three connected mailboxes; USER_NO_MAILBOX deliberately has none.
  await tdb.execute(sql`
    INSERT INTO user_graph_tokens (id, user_id, access_token, refresh_token, token_expires_at, scopes) VALUES
      (${MBX_OWNER},    ${USER_OWNER},    'x', 'x', now(), '{}'),
      (${MBX_COLLAB},   ${USER_COLLAB},   'x', 'x', now(), '{}'),
      (${MBX_OUTSIDER}, ${USER_OUTSIDER}, 'x', 'x', now(), '{}')
  `);
  await tdb.execute(sql`
    INSERT INTO deals (id, assigned_rep_id, office_code) VALUES (${DEAL_OLD}, ${USER_REP}, 'DAL')
  `);
  // The thread lives in USER_OWNER's mailbox and is bound to DEAL_OLD — the shape the deal Emails tab
  // shows to every user on the deal, not just the mailbox owner.
  await tdb.execute(sql`
    INSERT INTO emails
      (graph_message_id, graph_conversation_id, direction, from_address, to_addresses, deal_id, assignment_status, user_id, sent_at)
    VALUES ('m1', ${CONV}, 'inbound', 'sender@example.com', '{}', ${DEAL_OLD}, 'assigned', ${USER_OWNER}, '2026-07-01T00:00:00Z')
  `);
  await tdb.execute(sql`
    INSERT INTO email_thread_bindings
      (mailbox_account_id, provider, provider_conversation_id, deal_id, binding_source, confidence)
    VALUES (${MBX_OWNER}, 'microsoft_graph', ${CONV}, ${DEAL_OLD}, 'manual', 'high')
  `);

  // Read the rows back so the contexts are REAL records, not hand-shaped literals that could drift.
  const threadEmails = await tdb.select().from(emails).where(eq(emails.graphConversationId, CONV));
  const [binding] = await tdb
    .select()
    .from(emailThreadBindings)
    .where(eq(emailThreadBindings.providerConversationId, CONV));

  thread = { mailboxAccountId: MBX_OWNER, binding, emails: threadEmails };
  unboundThread = { mailboxAccountId: MBX_OWNER, binding: null, emails: threadEmails };
}, 30000); // PGlite cold-start can exceed the default 10s under parallel runtime suites

afterEach(async () => {
  await pg.close();
});

describe("assertCanMutateEmailThread — deal write access", () => {
  it("allows the mailbox owner even without deal access", async () => {
    // ownerUser has no office, so assertDealCollaboratorAccess would 403 them. Path 1 has to stand on
    // its own: a user can always fix the filing of their own email.
    await expect(
      assertCanMutateEmailThread(tdb, thread, ownerUser, { boundDealId: DEAL_OLD })
    ).resolves.not.toThrow();
  });

  it("allows a non-owner who can write the deal", async () => {
    await expect(
      assertCanMutateEmailThread(tdb, thread, collaboratorUser, { boundDealId: DEAL_OLD })
    ).resolves.not.toThrow();
  });

  it("allows a caller with deal access but no connected mailbox of their own", async () => {
    // resolveMailboxAccountIdForCrmUser throws 409 "Connect mailbox first" for this user. That 409 is a
    // path-1 MISS, not a failure — it must not escape before path 2 gets its turn, or the widening does
    // nothing for anyone who hasn't linked Outlook.
    await expect(
      assertCanMutateEmailThread(tdb, thread, noMailboxUser, { boundDealId: DEAL_OLD })
    ).resolves.not.toThrow();
  });

  it("rejects a non-owner with no deal access", async () => {
    // CAVEAT, deliberate: this 403 arm is not production-reachable. It fires only when the viewer has no
    // office at all, and auth.ts copies officeId off a NOT NULL column with activeOfficeId defaulting to
    // it, so getViewerOfficeId can never return null for an authenticated user. This case proves the
    // wiring reaches assertDealCollaboratorAccess and that its denial propagates; the REAL reachable
    // denial is the cross-schema 404 in the last case below.
    const err = await rejection(
      assertCanMutateEmailThread(tdb, thread, outsiderUser, { boundDealId: DEAL_OLD })
    );
    expect(err.statusCode).toBe(403);
    expect(err.message).toMatch(/Access denied/i);
  });

  it("rejects a non-owner on an UNBOUND thread with no deal to authorize against", async () => {
    // No deal means nothing to authorize against, so path 2 cannot run at all — the only admissible
    // caller on an unbound thread is its mailbox owner.
    const err = await rejection(
      assertCanMutateEmailThread(tdb, unboundThread, outsiderUser, { boundDealId: null })
    );
    expect(err.statusCode).toBe(403);
    expect(err.message).toMatch(/own email threads/i);
  });

  it("rejects a caller who can write the deal when there is no deal in context", async () => {
    // Same as above but for a user who WOULD pass path 2 on DEAL_OLD. context.boundDealId is the sole
    // source of the deal to authorize against; a null there must close the gate rather than fall open.
    const err = await rejection(
      assertCanMutateEmailThread(tdb, unboundThread, collaboratorUser, { boundDealId: null })
    );
    expect(err.statusCode).toBe(403);
    expect(err.message).toMatch(/own email threads/i);
  });

  it("rejects a caller with neither a mailbox nor a deal in context", async () => {
    // The 409-swallow must not turn into a fall-open: with mailboxAccountId unresolved AND no deal, the
    // caller has satisfied nothing.
    const err = await rejection(
      assertCanMutateEmailThread(tdb, unboundThread, noMailboxUser, { boundDealId: null })
    );
    expect(err.statusCode).toBe(403);
    expect(err.message).toMatch(/own email threads/i);
  });

  it("rejects a thread whose bound deal lives in another office's schema", async () => {
    // The office boundary in this codebase is the tenant search_path, NOT a column comparison —
    // assertDealCollaboratorAccess's own office check only asks whether the viewer has an office at all
    // (see collaboration-access.ts), which is why THIS is the production-reachable denial and the 403
    // above is not. A deal in office_atlanta is simply not visible to this tenantDb, so the lookup misses
    // and the call 404s. Asserted here so a future change that starts resolving deals cross-schema
    // cannot quietly widen path 2 into a cross-office write.
    const err = await rejection(
      assertCanMutateEmailThread(tdb, thread, collaboratorUser, { boundDealId: DEAL_ATLANTA })
    );
    expect(err.statusCode).toBe(404);
    expect(err.message).toMatch(/Deal not found/i);
  });
});
