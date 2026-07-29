import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { emails, emailThreadBindings, activities, userGraphTokens } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import type {
  EmailStatEmailRecord,
  EmailStatTarget,
} from "../../../src/modules/email/stats-service.js";

// Spies WRAPPING the real implementations rather than replacing them, so the detach under test does
// exactly what it does in production and the only thing added is a count of how often the per-row
// derivation actually ran. A stubbed stats-service would let a dedup that dropped real targets pass.
const statsSpies = vi.hoisted(() => ({
  collect: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("../../../src/modules/email/stats-service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/email/stats-service.js")>(
    "../../../src/modules/email/stats-service.js"
  );
  return {
    ...actual,
    collectEmailStatTargetsForEmail: (tenantDb: never, email: EmailStatEmailRecord) => {
      statsSpies.collect(email);
      return actual.collectEmailStatTargetsForEmail(tenantDb, email);
    },
    refreshEmailStatsForTargets: (tenantDb: never, targets: EmailStatTarget[]) => {
      statsSpies.refresh(targets);
      return actual.refreshEmailStatsForTargets(tenantDb, targets);
    },
  };
});

const { detachConversationAcrossMailboxes } = await import("../../../src/modules/email/service.js");

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;

const USER_A = U("a01");
const MBX_A = U("e0a");
const DEAL = U("d001");
const COMPANY = U("b001");
const CONTACT_ONE = U("c001"), CONTACT_TWO = U("c002");
const CONV = "conv-stat-target-dedup";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

/** The (entityType, entityId) pairs refreshEmailStatsForTargets was asked to recompute, deduped the
 *  same way it dedupes them itself — the SET is the contract, not the array length. */
function refreshedTargetKeys(): string[] {
  const keys = new Set<string>();
  for (const call of statsSpies.refresh.mock.calls) {
    for (const target of call[0] as EmailStatTarget[]) {
      if (target.entityId) keys.add(`${target.entityType}:${target.entityId}`);
    }
  }
  return Array.from(keys).sort();
}

beforeEach(async () => {
  pg = new PGlite();
  tdb = drizzle(pg);
  statsSpies.collect.mockClear();
  statsSpies.refresh.mockClear();

  await pg.exec(tenantSchemaSql("public", [emails, emailThreadBindings, activities, userGraphTokens]));
  // deals / contacts / companies are hand-rolled islands (same pattern as thread-multi-mailbox): the
  // stats service reads and writes a handful of columns off each, and generating the real tables would
  // drag in the whole property/lead/stage graph.
  await tdb.execute(sql`
    CREATE TABLE companies (
      id uuid PRIMARY KEY,
      email_count integer NOT NULL DEFAULT 0,
      last_email_at timestamptz
    )
  `);
  await tdb.execute(sql`
    CREATE TABLE contacts (
      id uuid PRIMARY KEY,
      company_id uuid,
      email_count integer NOT NULL DEFAULT 0,
      last_email_at timestamptz
    )
  `);
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
  // Empty, but not optional: the company rollup's SQL sub-selects `leads` unconditionally.
  await tdb.execute(sql`
    CREATE TABLE leads (
      id uuid PRIMARY KEY,
      company_id uuid,
      email_count integer NOT NULL DEFAULT 0,
      last_email_at timestamptz
    )
  `);

  await tdb.execute(sql`
    INSERT INTO user_graph_tokens (id, user_id, access_token, refresh_token, token_expires_at, scopes)
    VALUES (${MBX_A}, ${USER_A}, 'x', 'x', now(), '{}')
  `);
  await tdb.execute(sql`INSERT INTO companies (id) VALUES (${COMPANY})`);
  await tdb.execute(sql`
    INSERT INTO contacts (id, company_id) VALUES (${CONTACT_ONE}, ${COMPANY}), (${CONTACT_TWO}, ${COMPANY})
  `);
  await tdb.execute(sql`INSERT INTO deals (id, company_id) VALUES (${DEAL}, ${COMPANY})`);
  await tdb.execute(sql`
    INSERT INTO email_thread_bindings
      (mailbox_account_id, provider, provider_conversation_id, deal_id, binding_source, confidence)
    VALUES (${MBX_A}, 'microsoft_graph', ${CONV}, ${DEAL}, 'manual', 'high')
  `);
}, 30000); // PGlite cold-start can exceed the default 10s under parallel runtime suites

afterEach(async () => {
  await pg.close();
});

async function insertMessage(messageId: string, contactId: string, sentAt: string) {
  await tdb.execute(sql`
    INSERT INTO emails
      (graph_message_id, graph_conversation_id, direction, from_address, to_addresses,
       deal_id, assigned_entity_type, assigned_entity_id, contact_id, assignment_status, user_id, sent_at)
    VALUES (${messageId}, ${CONV}, 'inbound', 'sender@example.com', '{}',
            ${DEAL}, 'deal', ${DEAL}, ${contactId}, 'assigned', ${USER_A}, ${sentAt})
  `);
}

describe("detach — per-row stat-target derivation", () => {
  it("derives the stat targets ONCE for a thread whose messages share one association", async () => {
    // The real shape: a conversation filed to a deal has every message carrying the same deal_id /
    // assigned_entity_id / contact_id. collectEmailStatTargetsForEmail reads only those four columns
    // and issues up to three lookups per call, so running it per row made a long thread pay a linear
    // pile of queries inside the request transaction to compute one answer over and over.
    for (const [index, messageId] of ["m1", "m2", "m3", "m4"].entries()) {
      await insertMessage(messageId, CONTACT_ONE, `2026-07-0${index + 1}T00:00:00Z`);
    }

    await detachConversationAcrossMailboxes(tdb, CONV, USER_A);

    expect(statsSpies.collect).toHaveBeenCalledTimes(1);
    // ...and the targets are the same ones the per-row version produced: the deal, the contact, and the
    // company both of them roll up to. Deduplicating rows must not drop an entity from the recompute.
    expect(refreshedTargetKeys()).toEqual(
      [`deal:${DEAL}`, `contact:${CONTACT_ONE}`, `company:${COMPANY}`].sort()
    );
  });

  it("still derives once per DISTINCT association, not once for the whole thread", async () => {
    // The over-dedup guard. Sibling messages in one conversation can carry different contacts (each
    // mailbox's copy resolves its own), and collapsing those into a single derivation would leave one
    // contact's denormalised rollup stale after the detach.
    await insertMessage("m1", CONTACT_ONE, "2026-07-01T00:00:00Z");
    await insertMessage("m2", CONTACT_ONE, "2026-07-02T00:00:00Z");
    await insertMessage("m3", CONTACT_TWO, "2026-07-03T00:00:00Z");
    await insertMessage("m4", CONTACT_TWO, "2026-07-04T00:00:00Z");

    await detachConversationAcrossMailboxes(tdb, CONV, USER_A);

    expect(statsSpies.collect).toHaveBeenCalledTimes(2);
    expect(refreshedTargetKeys()).toEqual(
      [`deal:${DEAL}`, `contact:${CONTACT_ONE}`, `contact:${CONTACT_TWO}`, `company:${COMPANY}`].sort()
    );

    // The rollups the user sees, recomputed for BOTH contacts — the point of not over-deduping. They
    // start at the column default of 0 and only move if refreshEntityEmailStats actually ran for that
    // contact, so the two 2s are proof the target survived the dedup. (Detach deliberately leaves
    // contact_id alone — unassigning from a DEAL is not unassigning from a contact — so the count is
    // the two messages each contact still holds, not zero.)
    const res = await tdb.execute(sql`SELECT id, email_count FROM contacts ORDER BY id`);
    const rows = Array.isArray(res) ? res : res.rows;
    expect(rows.map((r: { email_count: number }) => Number(r.email_count))).toEqual([2, 2]);
  });
});
