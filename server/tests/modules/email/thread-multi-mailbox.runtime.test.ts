import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import {
  resolveMailboxAccountIdsForConversation,
  bindConversationToDealAcrossMailboxes,
  detachConversationAcrossMailboxes,
  previewThreadReassignmentImpact,
} from "../../../src/modules/email/service.js";

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
// USER_C is a third participant on the conversation with NO user_graph_tokens row (no connected
// mailbox) — used to pin the swallow half of the catch in resolveMailboxAccountIdsForConversation.
const USER_A = U("a01"), USER_B = U("b01"), USER_C = U("c01");
// "m" is not a valid hex digit, so U("m0a")/U("m0b") would not be valid UUID literals — use hex-safe
// suffixes instead.
const MBX_A = U("e0a"), MBX_B = U("e0b");
const DEAL_OLD = U("d001"), DEAL_NEW = U("d002");
// The oldest seeded message lives on a THIRD deal, distinct from DEAL_OLD, so the oldest-first
// ordering in previewThreadReassignmentImpact is actually exercised rather than being unverified.
const DEAL_OLDEST = U("d000");
const CONV = "conv-multi-mailbox-1";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeEach(async () => {
  pg = new PGlite();
  tdb = drizzle(pg);
  await tdb.execute(sql`
    CREATE TABLE emails (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      graph_message_id varchar(500) NOT NULL,
      graph_conversation_id varchar(500),
      direction varchar(20) NOT NULL DEFAULT 'inbound',
      from_address varchar(255) NOT NULL DEFAULT 'a@example.com',
      to_addresses text[] NOT NULL DEFAULT '{}',
      cc_addresses text[],
      subject varchar(1000),
      body_preview varchar(500),
      body_html text,
      has_attachments boolean NOT NULL DEFAULT false,
      is_starred boolean NOT NULL DEFAULT false,
      archived_at timestamptz,
      deleted_at timestamptz,
      contact_id uuid,
      deal_id uuid,
      assigned_entity_type varchar(20),
      assigned_entity_id uuid,
      assignment_status varchar(20) NOT NULL DEFAULT 'assigned',
      assignment_confidence varchar(20),
      assignment_ambiguity_reason varchar(255),
      ai_suggestions jsonb,
      thread_binding_id uuid,
      internet_message_id varchar(1000),
      user_id uuid NOT NULL,
      sent_at timestamptz NOT NULL DEFAULT now(),
      synced_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await tdb.execute(sql`
    CREATE TABLE email_thread_bindings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mailbox_account_id uuid NOT NULL,
      provider varchar(50) NOT NULL,
      provider_conversation_id varchar(500),
      normalized_subject varchar(500),
      participant_fingerprint varchar(500),
      deal_id uuid,
      project_id uuid,
      binding_source varchar(32) NOT NULL DEFAULT 'manual',
      confidence varchar(16) NOT NULL DEFAULT 'high',
      assignment_reason varchar(64),
      provisional_until timestamptz,
      created_by uuid, updated_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      detached_at timestamptz
    )
  `);
  // resolveMailboxAccountIdForCrmUser / resolveMailboxUserId both read public.user_graph_tokens:
  // (user_id, status='active') -> id is the mailbox account id, and the reverse lookup by id -> user_id.
  await tdb.execute(sql`
    CREATE TABLE user_graph_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'active'
    )
  `);
  // bindThreadToDeal -> backAssociateStoredMessagesForBinding looks up the deal and writes
  // email-stat columns back onto it.
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
  // backAssociateStoredMessagesForBinding upserts one activity per reassigned message.
  await tdb.execute(sql`
    CREATE TABLE activities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      type varchar(50) NOT NULL,
      responsible_user_id uuid NOT NULL,
      performed_by_user_id uuid,
      source_entity_type varchar(20) NOT NULL,
      source_entity_id uuid NOT NULL,
      company_id uuid,
      property_id uuid,
      lead_id uuid,
      deal_id uuid,
      contact_id uuid,
      email_id uuid,
      subject varchar(500),
      body text,
      outcome varchar(100),
      next_step text,
      next_step_due_at timestamptz,
      duration_minutes integer,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await tdb.execute(sql`
    INSERT INTO user_graph_tokens (id, user_id, status) VALUES
      (${MBX_A}, ${USER_A}, 'active'),
      (${MBX_B}, ${USER_B}, 'active')
  `);
  await tdb.execute(sql`
    INSERT INTO deals (id) VALUES (${DEAL_OLD}), (${DEAL_NEW}), (${DEAL_OLDEST})
  `);
  // The same conversation landed in BOTH mailboxes, bound to the wrong deal in each. Distinct sent_at
  // values (oldest first: m1, m2, m3) with the oldest message on its own deal exercise the
  // oldest-first ordering in previewThreadReassignmentImpact instead of leaving it to random uuid tie-
  // breaking.
  await tdb.execute(sql`
    INSERT INTO emails (graph_message_id, graph_conversation_id, deal_id, user_id, sent_at) VALUES
      ('m1', ${CONV}, ${DEAL_OLDEST}, ${USER_A}, '2026-07-01T00:00:00Z'),
      ('m2', ${CONV}, ${DEAL_OLD}, ${USER_A}, '2026-07-02T00:00:00Z'),
      ('m3', ${CONV}, ${DEAL_OLD}, ${USER_B}, '2026-07-03T00:00:00Z')
  `);
  await tdb.execute(sql`
    INSERT INTO email_thread_bindings (mailbox_account_id, provider, provider_conversation_id, deal_id)
    VALUES (${MBX_A}, 'microsoft_graph', ${CONV}, ${DEAL_OLD}),
           (${MBX_B}, 'microsoft_graph', ${CONV}, ${DEAL_OLD})
  `);
});

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
    // A third participant on the SAME conversation with no user_graph_tokens row at all — the exact
    // case the try/catch's 409 swallow exists for. This must not break the whole rebind; it should
    // just be left out of the result, leaving MBX_A/MBX_B intact.
    await tdb.execute(sql`
      INSERT INTO emails (graph_message_id, graph_conversation_id, deal_id, user_id, sent_at) VALUES
        ('m4', ${CONV}, ${DEAL_OLD}, ${USER_C}, '2026-07-04T00:00:00Z')
    `);
    const ids = await resolveMailboxAccountIdsForConversation(tdb, CONV);
    expect(ids.sort()).toEqual([MBX_A, MBX_B].sort());
  });

  it("propagates a non-409 mailbox-lookup error instead of silently dropping the mailbox", async () => {
    // The only INTENTIONAL swallow is the "Connect mailbox first" 409 for a participant with no
    // mailbox. Anything else — a DB outage, a transport failure — must not be swallowed: doing so
    // would drop a mailbox from the result and let the rebind proceed over the surviving subset,
    // silently reproducing the exact stranded-binding bug this module exists to fix. Dropping the
    // table simulates that kind of failure (a non-AppError thrown from the lookup).
    await tdb.execute(sql`DROP TABLE user_graph_tokens`);
    await expect(resolveMailboxAccountIdsForConversation(tdb, CONV)).rejects.toThrow();
  });

  it("rebinds EVERY mailbox, stranding none", async () => {
    await bindConversationToDealAcrossMailboxes(tdb, {
      providerConversationId: CONV, dealId: DEAL_NEW, actingUserId: USER_A,
    });
    const rows = await activeBindings();
    expect(rows).toHaveLength(2);
    expect(rows.every((r: { deal_id: string }) => r.deal_id === DEAL_NEW)).toBe(true);
  });

  it("detaches EVERY mailbox", async () => {
    await detachConversationAcrossMailboxes(tdb, CONV, USER_A);
    expect(await activeBindings()).toHaveLength(0);
  });

  it("counts messages across ALL mailboxes in the impact preview", async () => {
    const preview = await previewThreadReassignmentImpact(tdb, {
      providerConversationId: CONV, nextDealId: DEAL_NEW,
    });
    expect(preview.affectedMessageCount).toBe(3);
  });

  it("currentDealId is the OLDEST message's deal, not an arbitrary one", async () => {
    // m1 is the oldest (2026-07-01) and sits on DEAL_OLDEST, while m2/m3 (later) sit on DEAL_OLD —
    // if the ordering added to previewThreadReassignmentImpact regressed to unordered, this would be
    // flaky/arbitrary instead of deterministically DEAL_OLDEST.
    const preview = await previewThreadReassignmentImpact(tdb, {
      providerConversationId: CONV, nextDealId: DEAL_NEW,
    });
    expect(preview.currentDealId).toBe(DEAL_OLDEST);
  });
});
