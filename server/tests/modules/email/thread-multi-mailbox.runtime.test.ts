import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { emails, emailThreadBindings, activities, userGraphTokens } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import {
  resolveMailboxAccountIdsForConversation,
  bindConversationToDealAcrossMailboxes,
  detachConversationAcrossMailboxes,
  previewThreadReassignmentImpact,
} from "../../../src/modules/email/service.js";

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
// USER_C is a third participant on the conversation with NO user_graph_tokens row (no connected
// mailbox) — used to pin the join's inherent skip of a mailbox-less participant.
const USER_A = U("a01"), USER_B = U("b01"), USER_C = U("c01");
// "m" is not a valid hex digit, so U("m0a")/U("m0b") would not be valid UUID literals — use hex-safe
// suffixes instead.
const MBX_A = U("e0a"), MBX_B = U("e0b");
const DEAL_OLD = U("d001"), DEAL_NEW = U("d002");
const CONV = "conv-multi-mailbox-1";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeEach(async () => {
  pg = new PGlite();
  tdb = drizzle(pg);

  // emails / email_thread_bindings / activities / user_graph_tokens come straight from the real Drizzle
  // definitions (#677 helper) rather than hand-rolled DDL, so column types/enums/NOT NULL/defaults can't
  // silently drift from prod. deals stays a hand-rolled island — same pattern as
  // tests/modules/tasks/task-sort.runtime.test.ts — since we only need a handful of columns off it and
  // don't want to stand up the full company/property/lead graph.
  await pg.exec(tenantSchemaSql("public", [emails, emailThreadBindings, activities, userGraphTokens]));
  await tdb.execute(sql`
    CREATE TABLE deals (
      id uuid PRIMARY KEY,
      company_id uuid,
      property_id uuid,
      source_lead_id uuid,
      email_count integer NOT NULL DEFAULT 0,
      last_email_at timestamptz
    )
  `);

  await tdb.execute(sql`
    INSERT INTO user_graph_tokens (id, user_id, access_token, refresh_token, token_expires_at, scopes) VALUES
      (${MBX_A}, ${USER_A}, 'x', 'x', now(), '{}'),
      (${MBX_B}, ${USER_B}, 'x', 'x', now(), '{}')
  `);
  await tdb.execute(sql`
    INSERT INTO deals (id) VALUES (${DEAL_OLD}), (${DEAL_NEW})
  `);
  // The same conversation landed in BOTH mailboxes, bound to the wrong deal in each. Distinct sent_at
  // values (oldest first: m1, m2, m3) keep affectedMessageIds ordering deterministic.
  await tdb.execute(sql`
    INSERT INTO emails
      (graph_message_id, graph_conversation_id, direction, from_address, to_addresses, deal_id, assignment_status, user_id, sent_at)
    VALUES
      ('m1', ${CONV}, 'inbound', 'sender@example.com', '{}', ${DEAL_OLD}, 'assigned', ${USER_A}, '2026-07-01T00:00:00Z'),
      ('m2', ${CONV}, 'inbound', 'sender@example.com', '{}', ${DEAL_OLD}, 'assigned', ${USER_A}, '2026-07-02T00:00:00Z'),
      ('m3', ${CONV}, 'inbound', 'sender@example.com', '{}', ${DEAL_OLD}, 'assigned', ${USER_B}, '2026-07-03T00:00:00Z')
  `);
  await tdb.execute(sql`
    INSERT INTO email_thread_bindings
      (mailbox_account_id, provider, provider_conversation_id, deal_id, binding_source, confidence)
    VALUES (${MBX_A}, 'microsoft_graph', ${CONV}, ${DEAL_OLD}, 'manual', 'high'),
           (${MBX_B}, 'microsoft_graph', ${CONV}, ${DEAL_OLD}, 'manual', 'high')
  `);
}, 30000); // PGlite cold-start can exceed the default 10s under parallel runtime suites

afterEach(async () => {
  await pg.close();
});

async function activeBindings() {
  const res = await tdb.execute(sql`
    SELECT mailbox_account_id, deal_id FROM email_thread_bindings
    WHERE detached_at IS NULL ORDER BY mailbox_account_id
  `);
  return Array.isArray(res) ? res : res.rows;
}

describe("multi-mailbox conversations", () => {
  it("resolves every mailbox holding the conversation", async () => {
    const ids = await resolveMailboxAccountIdsForConversation(tdb, CONV);
    expect(ids.sort()).toEqual([MBX_A, MBX_B].sort());
  });

  it("skips a participant with no connected mailbox, keeping the rest", async () => {
    // A third participant on the SAME conversation with no user_graph_tokens row at all — the join has
    // no row to match, so this must not break the whole rebind; it should just be left out of the
    // result, leaving MBX_A/MBX_B intact.
    await tdb.execute(sql`
      INSERT INTO emails
        (graph_message_id, graph_conversation_id, direction, from_address, to_addresses, deal_id, assignment_status, user_id, sent_at)
      VALUES
        ('m4', ${CONV}, 'inbound', 'sender@example.com', '{}', ${DEAL_OLD}, 'assigned', ${USER_C}, '2026-07-04T00:00:00Z')
    `);
    const ids = await resolveMailboxAccountIdsForConversation(tdb, CONV);
    expect(ids.sort()).toEqual([MBX_A, MBX_B].sort());
  });

  it("rebinds EVERY mailbox, stranding none", async () => {
    await bindConversationToDealAcrossMailboxes(tdb, {
      providerConversationId: CONV, dealId: DEAL_NEW, actingUserId: USER_A,
    });
    const rows = await activeBindings();
    expect(rows).toHaveLength(2);
    expect(rows.every((r: { deal_id: string }) => r.deal_id === DEAL_NEW)).toBe(true);

    // The binding row isn't the user-visible symptom — a regression that moved both bindings but
    // back-associated only one mailbox's messages would still pass the assertions above. Assert the
    // MESSAGES actually moved and the deal's denormalized email stats reflect it.
    const emailRows = await tdb.execute(sql`
      SELECT deal_id FROM emails WHERE graph_conversation_id = ${CONV}
    `);
    const dealIds = (Array.isArray(emailRows) ? emailRows : emailRows.rows).map(
      (r: { deal_id: string }) => r.deal_id
    );
    expect(dealIds).toHaveLength(3);
    expect(dealIds.every((id: string) => id === DEAL_NEW)).toBe(true);

    const dealRows = await tdb.execute(sql`SELECT email_count FROM deals WHERE id = ${DEAL_NEW}`);
    const dealRow = (Array.isArray(dealRows) ? dealRows : dealRows.rows)[0];
    expect(Number(dealRow.email_count)).toBe(3);
  });

  it("rebinds a mailbox that has an active binding but no surviving emails rows too", async () => {
    // A binding can outlive every message it once covered (purge, or a resync that never re-landed the
    // messages). The mailbox set for bind must be the UNION of (mailboxes with messages) and (mailboxes
    // with an active binding) — sourcing it from emails alone would silently leave this mailbox on the
    // old deal even though it's holding the conversation just as much as MBX_A/MBX_B are.
    const USER_ORPHAN = U("d9a");
    const MBX_ORPHAN = U("f0b");
    await tdb.execute(sql`
      INSERT INTO user_graph_tokens (id, user_id, access_token, refresh_token, token_expires_at, scopes) VALUES
        (${MBX_ORPHAN}, ${USER_ORPHAN}, 'x', 'x', now(), '{}')
    `);
    await tdb.execute(sql`
      INSERT INTO email_thread_bindings
        (mailbox_account_id, provider, provider_conversation_id, deal_id, binding_source, confidence)
      VALUES (${MBX_ORPHAN}, 'microsoft_graph', ${CONV}, ${DEAL_OLD}, 'manual', 'high')
    `);

    await bindConversationToDealAcrossMailboxes(tdb, {
      providerConversationId: CONV, dealId: DEAL_NEW, actingUserId: USER_A,
    });

    const rows = await activeBindings();
    expect(rows).toHaveLength(3);
    const orphanRow = rows.find((r: { mailbox_account_id: string }) => r.mailbox_account_id === MBX_ORPHAN);
    expect(orphanRow?.deal_id).toBe(DEAL_NEW);
  });

  it("does not abort the whole rebind when a binding's mailbox has no user_graph_tokens row at all", async () => {
    // A user-initiated disconnect (POST /api/auth/graph/disconnect, graph-token-service.ts) hard-DELETEs
    // the token row but leaves the binding in place — mailbox_account_id carries no FK, and nothing else
    // cleans bindings up. Handing that dead id to bindThreadToDeal throws "Mailbox not found" and would
    // abort the ENTIRE rebind, not just the orphan's — the union must filter it out before it gets there.
    const MBX_DISCONNECTED = U("f0d");
    await tdb.execute(sql`
      INSERT INTO email_thread_bindings
        (mailbox_account_id, provider, provider_conversation_id, deal_id, binding_source, confidence)
      VALUES (${MBX_DISCONNECTED}, 'microsoft_graph', ${CONV}, ${DEAL_OLD}, 'manual', 'high')
    `);
    // Deliberately NO user_graph_tokens row for MBX_DISCONNECTED — this is the point of the test.

    await bindConversationToDealAcrossMailboxes(tdb, {
      providerConversationId: CONV, dealId: DEAL_NEW, actingUserId: USER_A,
    });

    const rows = await activeBindings();
    expect(rows).toHaveLength(3);
    const byMailbox: Record<string, string> = Object.fromEntries(
      rows.map((r: { mailbox_account_id: string; deal_id: string }) => [r.mailbox_account_id, r.deal_id])
    );
    // The resolvable mailboxes still moved...
    expect(byMailbox[MBX_A]).toBe(DEAL_NEW);
    expect(byMailbox[MBX_B]).toBe(DEAL_NEW);
    // ...and the orphan was left alone rather than crashing the whole call.
    expect(byMailbox[MBX_DISCONNECTED]).toBe(DEAL_OLD);
  });

  it("detaches EVERY mailbox", async () => {
    await detachConversationAcrossMailboxes(tdb, CONV, USER_A);
    expect(await activeBindings()).toHaveLength(0);
  });

  it("detaches a binding whose mailbox has no surviving emails rows", async () => {
    // Sourcing the mailbox list from `emails` (as the old implementation did) would never discover this
    // binding at all — the same stranded-binding class this whole change exists to close.
    const MBX_ORPHAN = U("f0c");
    await tdb.execute(sql`
      INSERT INTO email_thread_bindings
        (mailbox_account_id, provider, provider_conversation_id, deal_id, binding_source, confidence)
      VALUES (${MBX_ORPHAN}, 'microsoft_graph', ${CONV}, ${DEAL_OLD}, 'manual', 'high')
    `);

    await detachConversationAcrossMailboxes(tdb, CONV, USER_A);

    expect(await activeBindings()).toHaveLength(0);
  });

  it("counts messages across ALL mailboxes in the impact preview", async () => {
    const preview = await previewThreadReassignmentImpact(tdb, {
      providerConversationId: CONV, nextDealId: DEAL_NEW,
    });
    expect(preview.affectedMessageCount).toBe(3);
  });

  it("currentDealId comes from the ACTIVE BINDING, not an unbound older message", async () => {
    // Simulates the real asymmetry backAssociateStoredMessagesForBinding produces: it writes
    // emails.deal_id scoped to ONE mailbox's messages at a time, so a mailbox that was never
    // (successfully) bound keeps deal_id = NULL even while the OTHER mailbox is actively bound. Mailbox
    // A holds the OLDER messages (m1, m2) and has no active binding here; only mailbox B (the newer m3)
    // does. If currentDealId were still derived from the oldest message, this would read null instead
    // of the real current deal.
    await tdb.execute(sql`UPDATE emails SET deal_id = NULL WHERE user_id = ${USER_A}`);
    await tdb.execute(sql`
      UPDATE email_thread_bindings SET detached_at = now()
      WHERE mailbox_account_id = ${MBX_A} AND detached_at IS NULL
    `);

    const preview = await previewThreadReassignmentImpact(tdb, {
      providerConversationId: CONV, nextDealId: DEAL_NEW,
    });
    expect(preview.currentDealId).toBe(DEAL_OLD);
    expect(preview.currentDealId).not.toBeNull();
  });

  it("currentDealId ignores an ORPHANED binding whose mailbox has no user_graph_tokens row", async () => {
    // A disconnect (POST /api/auth/graph/disconnect) hard-DELETEs the token row and leaves the binding
    // behind, so a binding can point at a mailbox id that no longer exists anywhere. currentDealId is
    // picked with LIMIT 1, and this orphan's id sorts FIRST by mailbox_account_id — without the ORDER BY
    // putting orphans last it would win and report DEAL_STALE, i.e. the preview (and the mutation gate
    // that shares this query) would name a deal the thread has not been on for however long. The orphan
    // is deliberately NOT filtered out, only outranked — see resolveActiveBindingDealIdForConversation,
    // and the orphan-only case in thread-routes-permission.runtime.test.ts.
    const MBX_ORPHAN_LOW = U("00a"); // sorts ahead of MBX_A/MBX_B
    const DEAL_STALE = U("d003");
    await tdb.execute(sql`INSERT INTO deals (id) VALUES (${DEAL_STALE})`);
    await tdb.execute(sql`
      INSERT INTO email_thread_bindings
        (mailbox_account_id, provider, provider_conversation_id, deal_id, binding_source, confidence)
      VALUES (${MBX_ORPHAN_LOW}, 'microsoft_graph', ${CONV}, ${DEAL_STALE}, 'manual', 'high')
    `);
    // Deliberately NO user_graph_tokens row for MBX_ORPHAN_LOW — that is the point of the test.

    const preview = await previewThreadReassignmentImpact(tdb, {
      providerConversationId: CONV, nextDealId: DEAL_NEW,
    });
    expect(preview.currentDealId).toBe(DEAL_OLD);
    expect(preview.currentDealId).not.toBe(DEAL_STALE);
  });

  it("currentDealId still reads a binding whose token is merely revoked, not deleted", async () => {
    // The join deliberately carries NO status filter: a revoked/error token row still resolves through
    // resolveMailboxUserId (which looks up by id, unfiltered), so that binding is live as far as every
    // rebind is concerned and must not vanish from the preview. Only a MISSING row is unhandleable.
    // Pinned so "tighten the join with status = 'active'" cannot land unnoticed.
    await tdb.execute(sql`
      UPDATE email_thread_bindings SET detached_at = now() WHERE mailbox_account_id = ${MBX_B}
    `);
    await tdb.execute(sql`UPDATE user_graph_tokens SET status = 'revoked' WHERE id = ${MBX_A}`);

    const preview = await previewThreadReassignmentImpact(tdb, {
      providerConversationId: CONV, nextDealId: DEAL_NEW,
    });
    expect(preview.currentDealId).toBe(DEAL_OLD);
  });
});
