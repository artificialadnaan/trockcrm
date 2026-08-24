// REAL-SQL (PGlite) proof for migration 0232 — the marketing & advertising expense request tables.
//
// This suite executes the file that actually ships (migrationSql reads it from disk) rather than a retyped
// copy, because the whole point of the DO-loop/TENANT-block pair is that the two halves stay in step, and a
// hand copy would let one of them rot silently.
//
// Three fixture schemas, deliberately:
//   office_dallas  — fully provisioned (deals + files), the DO-loop's happy path AND the string the
//                    TENANT block is written against.
//   office_atlanta — fully provisioned, proving the loop is per-schema and not "whichever one is first".
//   office_partial — has NO `deals` table. This is the ONLY way to exercise the
//                    `to_regclass(...) IS NULL THEN CONTINUE` guard: a fixture set where every schema has
//                    a deals table can never tell a working guard from a missing one.
//
// The `public.users` / `notification_recipient_*` tables are in the fixture because 0232's seed statements
// reference them. Without them the migration file aborts and every assertion below fails for the wrong
// reason.
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrationSql } from "../../helpers/migration-sql.js";

const MIGRATION = migrationSql("0232_marketing_expense_requests");

const FULL_OFFICES = ["office_dallas", "office_atlanta"];
const PARTIAL_OFFICE = "office_partial";

const TAKASHI = "00000000-0000-4000-8000-000000000001";
const SUBMITTER = "00000000-0000-4000-8000-000000000002";

let pg: PGlite;

/** The `files` table as migration 0001's TENANT block creates it, plus 0044's lead_id. */
function filesDdl(schema: string, withLeadId: boolean) {
  return `
    CREATE TABLE ${schema}.files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id uuid,
      ${withLeadId ? "lead_id uuid," : ""}
      contact_id uuid,
      procore_project_id bigint,
      change_order_id uuid,
      created_at timestamptz NOT NULL DEFAULT NOW()
    );
    ALTER TABLE ${schema}.files ADD CONSTRAINT files_association_check
      CHECK (deal_id IS NOT NULL${withLeadId ? " OR lead_id IS NOT NULL" : ""} OR contact_id IS NOT NULL
             OR procore_project_id IS NOT NULL OR change_order_id IS NOT NULL);
  `;
}

beforeAll(async () => {
  pg = new PGlite();

  await pg.exec(`
    CREATE TABLE public.users (
      id uuid PRIMARY KEY,
      email text NOT NULL,
      display_name text,
      role text,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE public.notification_recipient_groups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key text NOT NULL,
      name text NOT NULL,
      description text,
      created_at timestamptz NOT NULL DEFAULT NOW()
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

    INSERT INTO public.users (id, email, display_name, role) VALUES
      ('${TAKASHI}', 'tyamashita@trockgc.com', 'Takashi Yamashita', 'director'),
      ('${SUBMITTER}', 'rep@trockgc.com', 'Reggie Rep', 'rep');
  `);

  for (const office of FULL_OFFICES) {
    await pg.exec(`
      CREATE SCHEMA ${office};
      CREATE TABLE ${office}.deals (id uuid PRIMARY KEY);
      ${filesDdl(office, true)}
    `);
  }

  // Partially provisioned: a files table but NO deals table. The guard must skip it wholesale.
  await pg.exec(`
    CREATE SCHEMA ${PARTIAL_OFFICE};
    ${filesDdl(PARTIAL_OFFICE, true)}
  `);

  await pg.exec(MIGRATION);
});

afterAll(async () => {
  await pg?.close?.();
});

async function regclass(qualified: string): Promise<string | null> {
  const result = await pg.query<{ name: string | null }>(`SELECT to_regclass('${qualified}') AS name`);
  return result.rows[0]?.name ?? null;
}

/** A complete, valid request row. Callers override one field to prove one constraint. */
function insertRequest(office: string, overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    request_number: `'MER-0001'`,
    status: `'draft'`,
    submitted_by: `'${SUBMITTER}'`,
    requested_by_name: `'Reggie Rep'`,
    vendor_event: `'Multifamily Expo'`,
    purpose: `'Booth at the regional expo'`,
    expected_return: `'Lead generation'`,
    total_requested: `0`,
    ...overrides,
  };
  const cols = Object.keys(values).join(", ");
  const vals = Object.values(values).join(", ");
  return pg.exec(`INSERT INTO ${office}.marketing_expense_requests (${cols}) VALUES (${vals})`);
}

describe("0232 marketing expense requests — tenant DDL", () => {
  it("creates both tables in every fully-provisioned office schema", async () => {
    for (const office of FULL_OFFICES) {
      expect(await regclass(`${office}.marketing_expense_requests`)).toBe(`${office}.marketing_expense_requests`);
      expect(await regclass(`${office}.marketing_expense_request_approvals`)).toBe(
        `${office}.marketing_expense_request_approvals`,
      );
    }
  });

  it("SKIPS a partially-provisioned schema that has no deals table", async () => {
    expect(await regclass(`${PARTIAL_OFFICE}.marketing_expense_requests`)).toBeNull();
    expect(await regclass(`${PARTIAL_OFFICE}.marketing_expense_request_approvals`)).toBeNull();
    // ...and leaves its files table untouched rather than half-migrating it.
    const column = await pg.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM information_schema.columns
       WHERE table_schema = '${PARTIAL_OFFICE}' AND table_name = 'files'
         AND column_name = 'marketing_expense_request_id'
    `);
    expect(column.rows[0]?.count).toBe(0);
  });

  // `to_regclass` renders a name UNqualified when its schema is already on the search_path, which `public`
  // always is — so these two compare against the bare name while the office_* assertions above compare
  // against the qualified one.
  it("creates the public sequence and receipt ledger", async () => {
    expect(await regclass("public.marketing_expense_request_sequences")).toBe(
      "marketing_expense_request_sequences",
    );
    expect(await regclass("public.marketing_expense_request_email_receipts")).toBe(
      "marketing_expense_request_email_receipts",
    );
  });

  it("leaves sent_at NULLABLE with no default — the receipt row is a CLAIM, stamped only after a send", async () => {
    const column = await pg.query<{ is_nullable: string; column_default: string | null }>(`
      SELECT is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'marketing_expense_request_email_receipts'
         AND column_name = 'sent_at'
    `);
    expect(column.rows[0]?.is_nullable).toBe("YES");
    expect(column.rows[0]?.column_default).toBeNull();
  });

  it("keys the receipt ledger by step_order so a two-stage decision sends more than one email", async () => {
    const key = await pg.query<{ column_name: string }>(`
      SELECT a.attname AS column_name
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.conrelid = 'public.marketing_expense_request_email_receipts'::regclass
         AND c.contype = 'p'
       ORDER BY a.attname
    `);
    expect(key.rows.map((row) => row.column_name)).toEqual([
      "email_kind",
      "request_id",
      "step_order",
      "tenant_schema",
    ]);
  });

  it("creates the browse indexes the queue and the my-requests page read through", async () => {
    for (const office of FULL_OFFICES) {
      const indexes = await pg.query<{ indexname: string }>(`
        SELECT indexname FROM pg_indexes
         WHERE schemaname = '${office}' AND tablename = 'marketing_expense_requests'
         ORDER BY indexname
      `);
      const names = indexes.rows.map((row) => row.indexname);
      expect(names).toContain("marketing_expense_requests_submitter_idx");
      expect(names).toContain("marketing_expense_requests_status_idx");
    }
  });

  it("seeds the approver recipient group and assigns Takashi", async () => {
    const group = await pg.query<{ name: string }>(`
      SELECT name FROM public.notification_recipient_groups WHERE key = 'marketing_expense_approver'
    `);
    expect(group.rows[0]?.name).toBe("Marketing Expense Approver");

    const assignment = await pg.query<{ email: string }>(`
      SELECT u.email FROM public.notification_recipient_assignments a
        JOIN public.notification_recipient_groups g ON g.id = a.group_id
        JOIN public.users u ON u.id = a.user_id
       WHERE g.key = 'marketing_expense_approver'
    `);
    expect(assignment.rows.map((row) => row.email)).toEqual(["tyamashita@trockgc.com"]);
  });

  it("is idempotent — re-executing the whole file changes nothing and raises nothing", async () => {
    await expect(pg.exec(MIGRATION)).resolves.toBeDefined();
    const assignment = await pg.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM public.notification_recipient_assignments a
        JOIN public.notification_recipient_groups g ON g.id = a.group_id
       WHERE g.key = 'marketing_expense_approver'
    `);
    expect(assignment.rows[0]?.count).toBe(1);
  });
});

describe("0232 marketing expense requests — constraints", () => {
  it("accepts a well-formed draft", async () => {
    await expect(insertRequest("office_dallas")).resolves.toBeDefined();
  });

  it("rejects a duplicate request_number within an office", async () => {
    await expect(
      insertRequest("office_dallas", { request_number: `'MER-0001'` }),
    ).rejects.toThrow();
  });

  it("scopes request_number uniqueness PER OFFICE — the same number is free in another schema", async () => {
    await expect(insertRequest("office_atlanta", { request_number: `'MER-0001'` })).resolves.toBeDefined();
  });

  it("rejects an unknown status", async () => {
    await expect(
      insertRequest("office_dallas", { request_number: `'MER-9001'`, status: `'in_review'` }),
    ).rejects.toThrow();
  });

  it("rejects a non-draft row with no submitted_at — a pending request always has a submit time", async () => {
    await expect(
      insertRequest("office_dallas", { request_number: `'MER-9002'`, status: `'pending'` }),
    ).rejects.toThrow();
  });

  it("accepts a pending row that carries submitted_at", async () => {
    await expect(
      insertRequest("office_dallas", {
        request_number: `'MER-9003'`,
        status: `'pending'`,
        submitted_at: "NOW()",
      }),
    ).resolves.toBeDefined();
  });

  it("rejects a negative cost line", async () => {
    await expect(
      insertRequest("office_dallas", { request_number: `'MER-9004'`, cost_travel: `-1` }),
    ).rejects.toThrow();
  });

  it("rejects a negative total", async () => {
    await expect(
      insertRequest("office_dallas", { request_number: `'MER-9005'`, total_requested: `-0.01` }),
    ).rejects.toThrow();
  });

  it("rejects an unknown payment method", async () => {
    await expect(
      insertRequest("office_dallas", { request_number: `'MER-9006'`, payment_method: `'crypto'` }),
    ).rejects.toThrow();
  });

  it("rejects an attachment kind outside the documented set", async () => {
    await expect(
      insertRequest("office_dallas", {
        request_number: `'MER-9007'`,
        attachment_kinds: `ARRAY['quote_proposal','receipts']::text[]`,
      }),
    ).rejects.toThrow();
  });

  it("accepts the documented attachment kinds", async () => {
    await expect(
      insertRequest("office_dallas", {
        request_number: `'MER-9008'`,
        attachment_kinds: `ARRAY['quote_proposal','event_details','travel_estimate','other']::text[]`,
      }),
    ).resolves.toBeDefined();
  });

  it("rejects steps_required below 1 — a request with no approval step could never be decided", async () => {
    await expect(
      insertRequest("office_dallas", { request_number: `'MER-9009'`, steps_required: `0` }),
    ).rejects.toThrow();
  });

  it("defaults steps_required to 1 so today's single-stage flow needs no writer", async () => {
    await insertRequest("office_dallas", { request_number: `'MER-9010'` });
    const row = await pg.query<{ steps_required: number }>(`
      SELECT steps_required FROM office_dallas.marketing_expense_requests WHERE request_number = 'MER-9010'
    `);
    expect(row.rows[0]?.steps_required).toBe(1);
  });
});

describe("0232 marketing expense requests — approvals", () => {
  const REQUEST = "00000000-0000-4000-8000-0000000000a1";

  beforeAll(async () => {
    await insertRequest("office_dallas", { id: `'${REQUEST}'`, request_number: `'MER-0100'` });
    await pg.exec(`
      INSERT INTO office_dallas.marketing_expense_request_approvals
        (request_id, step_order, approver_group_key)
      VALUES ('${REQUEST}', 1, 'marketing_expense_approver')
    `);
  });

  it("rejects a second row for the same (request, step)", async () => {
    await expect(
      pg.exec(`
        INSERT INTO office_dallas.marketing_expense_request_approvals
          (request_id, step_order, approver_group_key)
        VALUES ('${REQUEST}', 1, 'marketing_expense_approver')
      `),
    ).rejects.toThrow();
  });

  it("rejects step_order below 1", async () => {
    await expect(
      pg.exec(`
        INSERT INTO office_dallas.marketing_expense_request_approvals
          (request_id, step_order, approver_group_key)
        VALUES ('${REQUEST}', 0, 'marketing_expense_approver')
      `),
    ).rejects.toThrow();
  });

  it("rejects an unknown decision", async () => {
    await expect(
      pg.exec(`
        UPDATE office_dallas.marketing_expense_request_approvals
           SET decision = 'maybe' WHERE request_id = '${REQUEST}' AND step_order = 1
      `),
    ).rejects.toThrow();
  });

  it("accepts approved / denied / skipped — skipped is how a later step is closed out", async () => {
    for (const decision of ["approved", "denied", "skipped"]) {
      await expect(
        pg.exec(`
          UPDATE office_dallas.marketing_expense_request_approvals
             SET decision = '${decision}' WHERE request_id = '${REQUEST}' AND step_order = 1
        `),
      ).resolves.toBeDefined();
    }
  });

  it("cascades to approvals when the parent request is deleted", async () => {
    await pg.exec(`DELETE FROM office_dallas.marketing_expense_requests WHERE id = '${REQUEST}'`);
    const remaining = await pg.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM office_dallas.marketing_expense_request_approvals
       WHERE request_id = '${REQUEST}'
    `);
    expect(remaining.rows[0]?.count).toBe(0);
  });
});

describe("0232 marketing expense requests — files attachment", () => {
  const REQUEST = "00000000-0000-4000-8000-0000000000b1";

  beforeAll(async () => {
    await insertRequest("office_dallas", { id: `'${REQUEST}'`, request_number: `'MER-0200'` });
  });

  it("lets a file attach to nothing but an expense request", async () => {
    await expect(
      pg.exec(`
        INSERT INTO office_dallas.files (marketing_expense_request_id) VALUES ('${REQUEST}')
      `),
    ).resolves.toBeDefined();
  });

  // office_dallas is covered TWICE — by the DO-loop and, because the marked block is written literally
  // against that schema name, by the TENANT block as well. So a bug in the loop's files handling is
  // repaired by the block running after it, and an assertion on office_dallas alone proves nothing about
  // the loop. office_atlanta is reached by the loop and by nothing else. (Found by mutation: deleting the
  // new column from the LOOP's predicate list left all 32 assertions green.)
  it("extends files_association_check in an office the DO-LOOP is the only thing that reaches", async () => {
    const request = "00000000-0000-4000-8000-0000000000b2";
    await insertRequest("office_atlanta", { id: `'${request}'`, request_number: `'MER-0300'` });
    await expect(
      pg.exec(`
        INSERT INTO office_atlanta.files (marketing_expense_request_id) VALUES ('${request}')
      `),
    ).resolves.toBeDefined();
    await expect(pg.exec(`INSERT INTO office_atlanta.files (deal_id) VALUES (NULL)`)).rejects.toThrow();
  });

  it("still rejects a file attached to nothing at all", async () => {
    await expect(pg.exec(`INSERT INTO office_dallas.files (deal_id) VALUES (NULL)`)).rejects.toThrow();
  });

  it("keeps every pre-existing association working", async () => {
    await expect(
      pg.exec(`INSERT INTO office_dallas.files (lead_id) VALUES (gen_random_uuid())`),
    ).resolves.toBeDefined();
    await expect(
      pg.exec(`INSERT INTO office_dallas.files (contact_id) VALUES (gen_random_uuid())`),
    ).resolves.toBeDefined();
  });
});

// The DO-loop above only ever proves the EXISTING-tenant half. New offices are provisioned by replaying the
// marked block out of each migration file (server/src/modules/office/service.ts), which the migration test
// never does — and 0117 shipping with no marked block at all is precisely how that goes unnoticed. So this
// block extracts the marker section exactly as the provisioner does and runs it against a schema that has
// never seen the DO-loop.
describe("0232 marketing expense requests — new-office provisioning block", () => {
  const NEW_OFFICE = "office_newport";

  function tenantBlock(schemaName: string): string {
    const startMarker = "-- TENANT_SCHEMA_START";
    const endMarker = "-- TENANT_SCHEMA_END";
    const startIdx = MIGRATION.indexOf(startMarker);
    const endIdx = MIGRATION.indexOf(endMarker);
    if (startIdx === -1 || endIdx === -1) {
      throw new Error("0232 has no -- TENANT_SCHEMA_START/END block: new offices would never get these tables");
    }
    return MIGRATION.substring(startIdx + startMarker.length, endIdx)
      .trim()
      .replace(/office_dallas/g, schemaName);
  }

  beforeAll(async () => {
    // A brand-new office as the provisioner builds it: 0001's files table, WITHOUT lead_id — because
    // 0044/0058 carry no marked block, so a schema provisioned today genuinely has no lead_id column.
    await pg.exec(`
      CREATE SCHEMA ${NEW_OFFICE};
      CREATE TABLE ${NEW_OFFICE}.deals (id uuid PRIMARY KEY);
      ${filesDdl(NEW_OFFICE, false)}
    `);
    await pg.exec(tenantBlock(NEW_OFFICE));
  });

  it("creates both tables for a newly provisioned office", async () => {
    expect(await regclass(`${NEW_OFFICE}.marketing_expense_requests`)).toBe(
      `${NEW_OFFICE}.marketing_expense_requests`,
    );
    expect(await regclass(`${NEW_OFFICE}.marketing_expense_request_approvals`)).toBe(
      `${NEW_OFFICE}.marketing_expense_request_approvals`,
    );
  });

  it("extends files_association_check without naming a column the new schema does not have", async () => {
    await expect(
      insertRequest(NEW_OFFICE, { id: `'${"00000000-0000-4000-8000-0000000000c1"}'`, request_number: `'MER-0001'` }),
    ).resolves.toBeDefined();
    await expect(
      pg.exec(`
        INSERT INTO ${NEW_OFFICE}.files (marketing_expense_request_id)
        VALUES ('00000000-0000-4000-8000-0000000000c1')
      `),
    ).resolves.toBeDefined();
    await expect(pg.exec(`INSERT INTO ${NEW_OFFICE}.files (deal_id) VALUES (NULL)`)).rejects.toThrow();
  });

  it("is idempotent — provisioning replays the block and it must not raise", async () => {
    await expect(pg.exec(tenantBlock(NEW_OFFICE))).resolves.toBeDefined();
  });
});
