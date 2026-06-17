// Real-types (PGlite) tests for the Sent-folder extension of the email-sync worker.
// Focus — the load-bearing dedup guarantee: a CRM-composed outbound email must NOT double-store when its
// Sent-folder copy is later synced carrying a DIFFERENT graph_message_id but the SAME internet_message_id.
// Plus: outbound matches the RECIPIENT (not sender), selective-store keeps noise out, and a sent reply on
// a bound thread inherits the inbound side's deal.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

// The worker module imports a real pg pool at load time — stub it; tests pass an explicit PGlite client.
vi.mock("../../src/db.js", () => ({
  pool: { connect: async () => ({ query: vi.fn(), release: vi.fn() }) },
}));

// Deterministic assignment — the assignment ENGINE is tested in the server suite; here we test the
// worker's direction-aware wiring around it.
let nextAssignment: any = null;
vi.mock("../../../server/src/modules/email/assignment-service.js", () => ({
  resolveEmailAssignment: (_input: any) => nextAssignment,
  buildPropertyCandidatesFromDeals: () => [],
}));
vi.mock("../../../server/src/modules/tasks/rules/evaluator.js", () => ({ evaluateTaskRules: vi.fn() }));
vi.mock("../../../server/src/modules/tasks/rules/config.js", () => ({ TASK_RULES: [] }));
vi.mock("../../../server/src/modules/tasks/rules/persistence.js", () => ({
  createTenantTaskRulePersistence: () => ({}),
}));

const mod = await import("../../src/jobs/email-sync.js");
const processMailMessage = (mod as any).processMailMessage as (
  client: any,
  schemaName: string,
  userId: string,
  officeId: string,
  msg: any,
  direction: "inbound" | "outbound"
) => Promise<boolean>;

const SCHEMA = "office_test";
const OFFICE_ID = "00000000-0000-4000-8000-000000000fff";
const USER_ID = "00000000-0000-4000-8000-0000000000aa";
const MAILBOX_ID = "00000000-0000-4000-8000-0000000000bb";

const UNASSIGNED = {
  assignedEntityType: null,
  assignedEntityId: null,
  assignedDealId: null,
  confidence: "low",
  ambiguityReason: null,
  matchedBy: "none",
  requiresClassificationTask: false,
  candidateDealIds: [],
};

let db: PGlite;

async function setupSchema(pg: PGlite) {
  await pg.exec(`
    CREATE SCHEMA IF NOT EXISTS ${SCHEMA};

    CREATE TABLE ${SCHEMA}.emails (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      graph_message_id varchar(500) UNIQUE NOT NULL,
      internet_message_id varchar(1000),
      graph_conversation_id varchar(500),
      direction varchar(20) NOT NULL,
      from_address varchar(255) NOT NULL,
      to_addresses text[] NOT NULL,
      cc_addresses text[],
      subject varchar(1000),
      body_preview varchar(500),
      body_html text,
      has_attachments boolean NOT NULL DEFAULT false,
      is_starred boolean NOT NULL DEFAULT false,
      ai_suggestions jsonb NOT NULL DEFAULT '[]'::jsonb,
      archived_at timestamptz,
      deleted_at timestamptz,
      contact_id uuid,
      deal_id uuid,
      assigned_entity_type varchar(20),
      assigned_entity_id uuid,
      assignment_status varchar(20) NOT NULL DEFAULT 'unassigned',
      assignment_confidence varchar(20),
      assignment_ambiguity_reason varchar(255),
      thread_binding_id uuid,
      user_id uuid NOT NULL,
      sent_at timestamptz NOT NULL,
      synced_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE ${SCHEMA}.contacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      first_name text, last_name text, company_id uuid, company_name text,
      email text, is_active boolean DEFAULT true
    );
    CREATE TABLE ${SCHEMA}.deals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_number text, name text, company_id uuid, stage_id uuid,
      property_address text, property_city text, property_state text, property_zip text,
      is_active boolean DEFAULT true
    );
    CREATE TABLE ${SCHEMA}.contact_deal_associations (contact_id uuid, deal_id uuid);
    CREATE TABLE ${SCHEMA}.email_thread_bindings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mailbox_account_id uuid, provider varchar(50), provider_conversation_id varchar(500),
      normalized_subject varchar(500), participant_fingerprint varchar(500),
      deal_id uuid, detached_at timestamptz, provisional_until timestamptz
    );
    CREATE TABLE ${SCHEMA}.activities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      type text, responsible_user_id uuid, performed_by_user_id uuid,
      source_entity_type text, source_entity_id uuid, deal_id uuid, contact_id uuid,
      email_id uuid, subject text, body text, occurred_at timestamptz
    );

    CREATE TABLE public.pipeline_stage_config (id uuid PRIMARY KEY, slug text, display_order int);
    CREATE TABLE public.user_graph_tokens (id uuid, user_id uuid, status varchar(20));
    CREATE TABLE public.job_queue (
      id bigserial PRIMARY KEY, job_type varchar(100), payload jsonb,
      office_id uuid, status varchar(20), run_after timestamptz
    );

    INSERT INTO public.pipeline_stage_config (id, slug, display_order)
      VALUES (gen_random_uuid(), 'estimate_in_progress', 2);
    INSERT INTO public.user_graph_tokens (id, user_id, status)
      VALUES ('${MAILBOX_ID}', '${USER_ID}', 'active');
  `);
}

function emailCount(direction?: string) {
  const sql = direction
    ? `SELECT count(*)::int AS n FROM ${SCHEMA}.emails WHERE direction = '${direction}'`
    : `SELECT count(*)::int AS n FROM ${SCHEMA}.emails`;
  return db.query<{ n: number }>(sql).then((r) => r.rows[0].n);
}

beforeEach(async () => {
  db = new PGlite();
  await setupSchema(db);
  nextAssignment = { ...UNASSIGNED };
});

afterAll(async () => {
  await db?.close();
});

describe("Sent-folder dedup (load-bearing)", () => {
  it("does NOT double-store a CRM-composed email when its Sent copy returns with a different graph id", async () => {
    // CRM composed + stored this outbound email (draft graph id 'A', Message-ID 'M', signature already in body).
    await db.query(
      `INSERT INTO ${SCHEMA}.emails
         (graph_message_id, internet_message_id, direction, from_address, to_addresses, body_html, user_id, sent_at)
       VALUES ('graph-A', '<mid-M@trock>', 'outbound', 'rep@trockgc.com', ARRAY['client@acme.com'],
               'Body with CRM signature', '${USER_ID}', now())`
    );
    expect(await emailCount()).toBe(1);

    // The Sent-folder sync now sees the SAME message: different graph id 'B', SAME internetMessageId 'M'.
    const sentCopy = {
      id: "graph-B",
      internetMessageId: "<mid-M@trock>",
      from: { emailAddress: { address: "rep@trockgc.com" } },
      toRecipients: [{ emailAddress: { address: "client@acme.com" } }],
      subject: "Hi",
      body: { content: "Body with server-appended signature" },
      sentDateTime: new Date().toISOString(),
    };
    const stored = await processMailMessage(db, SCHEMA, USER_ID, OFFICE_ID, sentCopy, "outbound");

    expect(stored).toBe(false);
    expect(await emailCount()).toBe(1); // still exactly one row — no duplicate
  });

  it("a DIFFERENT user's inbound copy with the same Message-ID does NOT block the outbound store (internal A→B)", async () => {
    const OTHER_USER = "00000000-0000-4000-8000-0000000000cc";
    const CONTACT = "00000000-0000-4000-8000-0000000000c9";
    // B's Inbox already synced this internal email (inbound, user B) — SAME RFC822 Message-ID as A's copy.
    await db.query(
      `INSERT INTO ${SCHEMA}.emails
         (graph_message_id, internet_message_id, direction, from_address, to_addresses, user_id, sent_at)
       VALUES ('graph-inbound-B', '<M-internal@trock>', 'inbound', 'rep-a@trockgc.com',
               ARRAY['rep-b@trockgc.com'], '${OTHER_USER}', now())`
    );
    // The recipient is a known contact so A's outbound copy is selective-stored.
    await db.query(`INSERT INTO ${SCHEMA}.contacts (id, email, is_active) VALUES ('${CONTACT}', 'rep-b@trockgc.com', true)`);

    // A's Sent sync sees A's OWN outbound copy: same Message-ID, different graph id, A's user_id.
    const stored = await processMailMessage(
      db, SCHEMA, USER_ID, OFFICE_ID,
      { id: "graph-outbound-A", internetMessageId: "<M-internal@trock>",
        from: { emailAddress: { address: "rep-a@trockgc.com" } },
        toRecipients: [{ emailAddress: { address: "rep-b@trockgc.com" } }], subject: "internal",
        body: { content: "x" }, sentDateTime: new Date().toISOString() },
      "outbound"
    );

    expect(stored).toBe(true); // NOT swallowed by B's inbound copy — dedup is scoped to A's own outbound
    expect(await emailCount("outbound")).toBe(1);
  });

  it("OPTION (a) default: the collision does NOT overwrite the CRM-stored body", async () => {
    await db.query(
      `INSERT INTO ${SCHEMA}.emails
         (graph_message_id, internet_message_id, direction, from_address, to_addresses, body_html, user_id, sent_at)
       VALUES ('graph-A', '<mid-M@trock>', 'outbound', 'rep@trockgc.com', ARRAY['client@acme.com'],
               'CRM body', '${USER_ID}', now())`
    );
    await processMailMessage(
      db, SCHEMA, USER_ID, OFFICE_ID,
      { id: "graph-B", internetMessageId: "<mid-M@trock>", from: { emailAddress: { address: "rep@trockgc.com" } },
        toRecipients: [{ emailAddress: { address: "client@acme.com" } }], subject: "Hi",
        body: { content: "SERVER body" }, sentDateTime: new Date().toISOString() },
      "outbound"
    );
    const row = await db.query<{ body_html: string }>(`SELECT body_html FROM ${SCHEMA}.emails LIMIT 1`);
    expect(row.rows[0].body_html).toBe("CRM body"); // option (a): trust the compose-time body
  });
});

describe("Sent-folder selective store + recipient match", () => {
  it("does NOT store a sent email to a non-contact recipient with no thread binding (noise stays out)", async () => {
    const stored = await processMailMessage(
      db, SCHEMA, USER_ID, OFFICE_ID,
      { id: "graph-noise", internetMessageId: "<noise@x>", from: { emailAddress: { address: "rep@trockgc.com" } },
        toRecipients: [{ emailAddress: { address: "no-reply@newsletter.com" } }], subject: "promo",
        body: { content: "x" }, sentDateTime: new Date().toISOString() },
      "outbound"
    );
    expect(stored).toBe(false);
    expect(await emailCount()).toBe(0);
  });

  it("matches the RECIPIENT (not the rep sender) to a contact and stores the outbound email", async () => {
    const CONTACT = "00000000-0000-4000-8000-0000000000c1";
    const DEAL = "00000000-0000-4000-8000-0000000000d1";
    await db.query(
      `INSERT INTO ${SCHEMA}.contacts (id, first_name, last_name, email, is_active)
       VALUES ('${CONTACT}', 'Cory', 'Client', 'client@acme.com', true)`
    );
    await db.query(
      `INSERT INTO ${SCHEMA}.deals (id, deal_number, name, stage_id, is_active)
       VALUES ('${DEAL}', 'DFW-2026-0001', 'Acme job',
               (SELECT id FROM public.pipeline_stage_config LIMIT 1), true)`
    );
    await db.query(`INSERT INTO ${SCHEMA}.contact_deal_associations (contact_id, deal_id) VALUES ('${CONTACT}', '${DEAL}')`);
    nextAssignment = { ...UNASSIGNED, assignedEntityType: "deal", assignedEntityId: DEAL, assignedDealId: DEAL, confidence: "high" };

    const stored = await processMailMessage(
      db, SCHEMA, USER_ID, OFFICE_ID,
      { id: "graph-sent-1", internetMessageId: "<sent1@x>", from: { emailAddress: { address: "rep@trockgc.com" } },
        toRecipients: [{ emailAddress: { address: "client@acme.com" } }], subject: "Quote",
        body: { content: "here is your quote" }, sentDateTime: new Date().toISOString() },
      "outbound"
    );

    expect(stored).toBe(true);
    const row = await db.query<{ direction: string; from_address: string; contact_id: string; deal_id: string }>(
      `SELECT direction, from_address, contact_id, deal_id FROM ${SCHEMA}.emails WHERE graph_message_id = 'graph-sent-1'`
    );
    expect(row.rows[0].direction).toBe("outbound");
    expect(row.rows[0].from_address).toBe("rep@trockgc.com"); // sender stored as the rep
    expect(row.rows[0].contact_id).toBe(CONTACT); // matched on the recipient
    expect(row.rows[0].deal_id).toBe(DEAL);
  });
});

describe("Sent reply on a bound thread", () => {
  it("inherits the deal the inbound side already bound to the conversation", async () => {
    const DEAL = "00000000-0000-4000-8000-0000000000d2";
    await db.query(
      `INSERT INTO ${SCHEMA}.deals (id, deal_number, name, stage_id, is_active)
       VALUES ('${DEAL}', 'DFW-2026-0002', 'Bound job', (SELECT id FROM public.pipeline_stage_config LIMIT 1), true)`
    );
    await db.query(
      `INSERT INTO ${SCHEMA}.email_thread_bindings
         (id, mailbox_account_id, provider, provider_conversation_id, deal_id)
       VALUES (gen_random_uuid(), '${MAILBOX_ID}', 'microsoft_graph', 'conv-XYZ', '${DEAL}')`
    );

    const stored = await processMailMessage(
      db, SCHEMA, USER_ID, OFFICE_ID,
      { id: "graph-reply", internetMessageId: "<reply@x>", conversationId: "conv-XYZ",
        from: { emailAddress: { address: "rep@trockgc.com" } },
        toRecipients: [{ emailAddress: { address: "stranger@nowhere.com" } }], subject: "Re: Bound job",
        body: { content: "reply" }, sentDateTime: new Date().toISOString() },
      "outbound"
    );

    expect(stored).toBe(true); // bound thread overrides selective-store even though recipient is unknown
    const row = await db.query<{ deal_id: string }>(
      `SELECT deal_id FROM ${SCHEMA}.emails WHERE graph_message_id = 'graph-reply'`
    );
    expect(row.rows[0].deal_id).toBe(DEAL);
  });
});
