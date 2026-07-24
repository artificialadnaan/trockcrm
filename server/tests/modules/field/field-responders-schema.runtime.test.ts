import { readFileSync } from "fs";
import { resolve } from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { fieldResponders, dealTeamMembers } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

// FOUNDATION phase (migration 0198): the field_responders roster table + its ACTIVE-only case-insensitive
// email unique index + deal_team_members.responder_id (FK ON DELETE SET NULL). This applies the REAL
// migration DDL against PGlite and proves:
//   1. the table shape (columns + role CHECK),
//   2. case-insensitive email uniqueness among ACTIVE rows only (a deactivated email can be re-added),
//   3. ON DELETE SET NULL clears responder_id on deal_team_members without deleting the assignment,
//   4. the migration file's DO-loop + TENANT_SCHEMA block parity for the office provisioner.
// It also asserts the Drizzle table exposes the expected columns (schema/migration parity).

const RESPONDER = "aaaaaaaa-0000-0000-0000-000000000001";
const DEAL = "11111111-1111-1111-1111-111111111111";

let pg: PGlite;
let tdb: any;

// The REAL DDL from migration 0198's TENANT_SCHEMA block, re-targeted at `public` for the test (the
// migration's DO-loop and TENANT_SCHEMA block emit identical statements per schema).
const MIGRATION_DDL = `
  CREATE TABLE IF NOT EXISTS public.field_responders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    email text NOT NULL,
    role text NOT NULL CHECK (role IN ('superintendent', 'project_manager')),
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS field_responders_active_email_uidx
    ON public.field_responders (lower(email))
    WHERE is_active = TRUE;
  ALTER TABLE public.deal_team_members
    ADD COLUMN IF NOT EXISTS responder_id uuid;
  CREATE INDEX IF NOT EXISTS deal_team_members_responder_idx
    ON public.deal_team_members (responder_id)
    WHERE responder_id IS NOT NULL;
`;

// tenantSchemaSql already emits the responder_id COLUMN (it's in the Drizzle def), so the migration's
// `ADD COLUMN IF NOT EXISTS responder_id ... REFERENCES ...` would no-op the FK in this test harness (in
// prod the column does not pre-exist, so the migration adds it WITH the FK). Add the FK explicitly here so
// the ON DELETE SET NULL behavior the migration ships is actually exercised — this is the exact FK the
// migration's ADD COLUMN clause creates.
const RESPONDER_FK_DDL = `
  ALTER TABLE public.deal_team_members
    ADD CONSTRAINT deal_team_members_responder_id_fkey
    FOREIGN KEY (responder_id) REFERENCES public.field_responders(id) ON DELETE SET NULL;
`;

beforeAll(async () => {
  pg = new PGlite();
  // deal_team_members from the real Drizzle def (tenantSchemaSql omits its FKs/indexes, which is fine —
  // the migration DDL below adds responder_id + its FK). Then apply the migration's field_responders DDL.
  await pg.exec(tenantSchemaSql("public", [dealTeamMembers]));
  await pg.exec(MIGRATION_DDL);
  await pg.exec(RESPONDER_FK_DDL);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await tdb.execute(sql`DELETE FROM deal_team_members`);
  await tdb.execute(sql`DELETE FROM field_responders`);
});

describe("field_responders table (migration 0198)", () => {
  it("inserts a roster row and defaults is_active TRUE", async () => {
    await tdb.execute(sql`
      INSERT INTO field_responders (id, name, email, role)
      VALUES (${RESPONDER}, 'Jane Super', 'jane@example.com', 'superintendent')
    `);
    const res = await tdb.execute(sql`
      SELECT is_active AS "isActive", role FROM field_responders WHERE id = ${RESPONDER}
    `);
    expect((res.rows[0] as { isActive: boolean }).isActive).toBe(true);
    expect((res.rows[0] as { role: string }).role).toBe("superintendent");
  });

  it("rejects a role outside the CHECK list", async () => {
    await expect(
      tdb.execute(sql`
        INSERT INTO field_responders (name, email, role)
        VALUES ('Bad Role', 'bad@example.com', 'estimator')
      `),
    ).rejects.toThrow();
  });

  it("enforces case-insensitive email uniqueness among ACTIVE rows", async () => {
    await tdb.execute(sql`
      INSERT INTO field_responders (name, email, role)
      VALUES ('Active One', 'dup@example.com', 'superintendent')
    `);
    // Same email, different case, still active -> collides on the partial unique index.
    await expect(
      tdb.execute(sql`
        INSERT INTO field_responders (name, email, role)
        VALUES ('Active Two', 'DUP@example.com', 'project_manager')
      `),
    ).rejects.toThrow();
  });

  it("allows re-adding an email once the prior holder is INACTIVE (partial index)", async () => {
    await tdb.execute(sql`
      INSERT INTO field_responders (id, name, email, role, is_active)
      VALUES (${RESPONDER}, 'Left Company', 'reuse@example.com', 'superintendent', FALSE)
    `);
    // The active partial index does not cover the inactive row, so an ACTIVE row with the same email is OK.
    await expect(
      tdb.execute(sql`
        INSERT INTO field_responders (name, email, role)
        VALUES ('Rehired Or New', 'reuse@example.com', 'project_manager')
      `),
    ).resolves.toBeDefined();
  });
});

describe("deal_team_members.responder_id link (migration 0198)", () => {
  it("ON DELETE SET NULL clears responder_id but keeps the assignment + its copied email", async () => {
    await tdb.execute(sql`
      INSERT INTO field_responders (id, name, email, role)
      VALUES (${RESPONDER}, 'Linked Super', 'linked@example.com', 'superintendent')
    `);
    await tdb.execute(sql`
      INSERT INTO deal_team_members (deal_id, role, member_name, member_email, responder_id)
      VALUES (${DEAL}, 'superintendent', 'Linked Super', 'linked@example.com', ${RESPONDER})
    `);

    await tdb.execute(sql`DELETE FROM field_responders WHERE id = ${RESPONDER}`);

    const res = await tdb.execute(sql`
      SELECT responder_id AS "responderId", member_email AS "memberEmail", is_active AS "isActive"
        FROM deal_team_members WHERE deal_id = ${DEAL}
    `);
    const row = res.rows[0] as {
      responderId: string | null;
      memberEmail: string;
      isActive: boolean;
    };
    // The link is cleared, but the assignment survives with its copied email intact and still active.
    expect(row.responderId).toBeNull();
    expect(row.memberEmail).toBe("linked@example.com");
    expect(row.isActive).toBe(true);
  });
});

describe("fieldResponders Drizzle table shape", () => {
  it("exposes the roster columns", () => {
    const cols = Object.keys(fieldResponders);
    for (const c of ["id", "name", "email", "role", "isActive", "createdAt", "updatedAt"]) {
      expect(cols).toContain(c);
    }
  });

  it("deal_team_members exposes responderId", () => {
    expect(Object.keys(dealTeamMembers)).toContain("responderId");
  });
});

describe("migration 0198 file shape", () => {
  const migrationPath = resolve(
    import.meta.dirname,
    "../../../../migrations/0198_field_responders.sql",
  );
  const migration = readFileSync(migrationPath, "utf8");

  it("creates field_responders in the per-office DO-loop with the role CHECK", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS %I.field_responders");
    expect(migration).toContain("role text NOT NULL CHECK (role IN (''superintendent'', ''project_manager''))");
    expect(migration).toContain("LIKE 'office\\_%'");
    expect(migration).toContain("to_regclass(format('%I.deal_team_members', schema_name))");
  });

  it("creates the ACTIVE-only case-insensitive email unique index", () => {
    expect(migration).toContain("field_responders_active_email_uidx");
    expect(migration).toContain("(lower(email))");
    expect(migration).toContain("WHERE is_active = TRUE");
  });

  it("adds deal_team_members.responder_id with ON DELETE SET NULL", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS responder_id uuid");
    expect(migration).toContain("REFERENCES %I.field_responders(id) ON DELETE SET NULL");
  });

  it("has a matching TENANT_SCHEMA block for the office provisioner (parity with the DO-loop)", () => {
    expect(migration).toContain("-- TENANT_SCHEMA_START");
    expect(migration).toContain("-- TENANT_SCHEMA_END");
    const block = migration.slice(
      migration.indexOf("-- TENANT_SCHEMA_START"),
      migration.indexOf("-- TENANT_SCHEMA_END"),
    );
    expect(block).toContain("CREATE TABLE IF NOT EXISTS office_dallas.field_responders");
    expect(block).toContain(
      "ON office_dallas.field_responders (lower(email))",
    );
    expect(block).toContain(
      "REFERENCES office_dallas.field_responders(id) ON DELETE SET NULL",
    );
  });
});
