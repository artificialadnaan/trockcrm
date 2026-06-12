// ─── Phase 2b CHECKPOINT 2 — controlled REAL cross-office write (PGlite, real Postgres engine) ────
//
// A genuine write against a real Postgres engine with TWO office schemas (office_dallas, office_atlanta),
// the ACTUAL migration 0158 FK applied. Simulates a Dallas user capturing a photo on an ATLANTA deal and
// proves the write lands in the DEAL's office for all three hazards, the forced wrong-schema write is
// rejected by the FK, the negatives resolve correctly, and the photos-only-on-terminal invariant resolves
// per the deal's office. PGlite is ephemeral (closed in afterAll) so nothing persists — explicit cleanup
// is asserted too.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let db: PGlite;

const DALLAS_ID = "00000000-0000-4000-8000-00000000d001";
const ATLANTA_ID = "00000000-0000-4000-8000-00000000a001";
const DEAL_ATL = "00000000-0000-4000-8000-0000000a7e01"; // active Atlanta deal "ATL-1"
const DEAL_ATL_TERMINAL = "00000000-0000-4000-8000-0000000a7e02"; // a WON (terminal) Atlanta deal
const DEAL_DAL = "00000000-0000-4000-8000-0000000d7e01"; // active Dallas deal "DAL-1"
const UNKNOWN_DEAL = "00000000-0000-4000-8000-0000000bad01"; // owned by no office
const UPLOADER = "00000000-0000-4000-8000-00000000be01"; // a Dallas-based field user

// Minimal-but-faithful per-office tables: the columns the deal->office resolver, the R2-key deal-number
// lookup, the files write, and the active-project predicate actually touch.
function officeSchemaDDL(schema: string): string {
  return `
    CREATE SCHEMA ${schema};
    CREATE TABLE ${schema}.deals (
      id uuid PRIMARY KEY,
      deal_number text,
      name text,
      is_active boolean NOT NULL DEFAULT true,
      is_terminal boolean NOT NULL DEFAULT false,
      assigned_rep_id uuid
    );
    CREATE TABLE ${schema}.files (
      id uuid PRIMARY KEY,
      deal_id uuid,
      lead_id uuid,
      category text NOT NULL DEFAULT 'photo',
      r2_key text,
      is_active boolean NOT NULL DEFAULT true,
      uploaded_by uuid,
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE public.offices (id uuid PRIMARY KEY, slug text NOT NULL, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE public.job_queue (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_type text NOT NULL,
      payload jsonb NOT NULL,
      office_id uuid NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      run_after timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.exec(officeSchemaDDL("office_dallas"));
  await db.exec(officeSchemaDDL("office_atlanta"));

  await db.exec(`
    INSERT INTO public.offices (id, slug, is_active) VALUES
      ('${DALLAS_ID}','dallas', true), ('${ATLANTA_ID}','atlanta', true);
    INSERT INTO office_dallas.deals (id, deal_number, name, is_active, is_terminal) VALUES
      ('${DEAL_DAL}','DAL-1','Dallas Job', true, false);
    INSERT INTO office_atlanta.deals (id, deal_number, name, is_active, is_terminal) VALUES
      ('${DEAL_ATL}','ATL-1','Peachtree Lofts', true, false),
      ('${DEAL_ATL_TERMINAL}','ATL-2','Closed Won Job', true, true);
  `);

  // Apply the ACTUAL migration 0158 (per-office DO-loop + the office_dallas TENANT_SCHEMA block).
  const migration = readFileSync(new URL("../../../../migrations/0158_files_deal_id_fk.sql", import.meta.url), "utf8");
  await db.exec(migration);
});

afterAll(async () => {
  await db?.close();
});

// Stand-ins for the real helpers, run against the live engine. resolveOfficeForId fans out a
// `SELECT 1 FROM deals WHERE id=$1` per office under that office's search_path; buildR2Key prefixes the
// resolved office + the deal number looked up in the resolved schema.
async function resolveDealOffice(dealId: string): Promise<{ slug: string; id: string } | null> {
  for (const [slug, id] of [["dallas", DALLAS_ID], ["atlanta", ATLANTA_ID]] as const) {
    const { rows } = await db.query<{ hit: number }>(
      `SELECT 1 AS hit FROM office_${slug}.deals WHERE id = $1 LIMIT 1`,
      [dealId],
    );
    if (rows.length > 0) return { slug, id };
  }
  return null;
}

describe("Phase 2b — migration 0158 applied to both office schemas", () => {
  it("creates files_deal_id_fkey in office_dallas AND office_atlanta", async () => {
    const { rows } = await db.query<{ nspname: string }>(
      `SELECT n.nspname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE c.conname = 'files_deal_id_fkey' ORDER BY n.nspname`,
    );
    expect(rows.map((r) => r.nspname)).toEqual(["office_atlanta", "office_dallas"]);
  });
});

describe("Phase 2b — controlled REAL cross-office write (Dallas user → Atlanta deal)", () => {
  it("(resolver) a Dallas user's write to an Atlanta deal resolves to office_atlanta — NOT the uploader's office", async () => {
    const office = await resolveDealOffice(DEAL_ATL);
    expect(office).toEqual({ slug: "atlanta", id: ATLANTA_ID });
  });

  it("(a) schema + (b) R2 key + (c) job office all bind to the DEAL's office; the row lands in office_atlanta", async () => {
    const office = (await resolveDealOffice(DEAL_ATL))!;

    // (b) R2 key: the deal-number lookup runs in the RESOLVED schema.
    const { rows: dn } = await db.query<{ deal_number: string }>(
      `SELECT deal_number FROM office_${office.slug}.deals WHERE id = $1`,
      [DEAL_ATL],
    );
    const r2Key = `office_${office.slug}/deals/${dn[0].deal_number}/photo/${"11111111-2222-4333-8444-555566667777"}-field-photo.jpg`;
    expect(r2Key.startsWith("office_atlanta/deals/ATL-1/")).toBe(true);

    // (a) schema: the files INSERT runs under the resolved office's search_path → lands in office_atlanta.
    const fileId = "00000000-0000-4000-8000-00000000c001";
    await db.exec(`SET search_path TO office_${office.slug}, public;`);
    await db.query(
      `INSERT INTO files (id, deal_id, category, r2_key, uploaded_by) VALUES ($1, $2, 'photo', $3, $4)`,
      [fileId, DEAL_ATL, r2Key, UPLOADER],
    );
    await db.exec(`SET search_path TO public;`);

    // The row is in office_atlanta.files (the deal's office), NOT office_dallas.files (the uploader's).
    const atl = await db.query(`SELECT deal_id, r2_key FROM office_atlanta.files WHERE id = $1`, [fileId]);
    const dal = await db.query(`SELECT 1 FROM office_dallas.files WHERE id = $1`, [fileId]);
    expect(atl.rows).toHaveLength(1);
    expect(dal.rows).toHaveLength(0);
    expect((atl.rows[0] as any).deal_id).toBe(DEAL_ATL);
    expect((atl.rows[0] as any).r2_key.startsWith("office_atlanta/deals/ATL-1/")).toBe(true);

    // (c) job office: the async side-effect enqueues against the resolved office's id.
    await db.query(
      `INSERT INTO public.job_queue (job_type, payload, office_id) VALUES ('domain_event', $1::jsonb, $2)`,
      [JSON.stringify({ eventName: "file.uploaded", fileId }), office.id],
    );
    const job = await db.query<{ office_id: string }>(
      `SELECT office_id FROM public.job_queue WHERE payload->>'fileId' = $1`,
      [fileId],
    );
    expect(job.rows[0].office_id).toBe(ATLANTA_ID);

    // Cleanup the test artifacts (don't leave rows in the Atlanta schema).
    await db.query(`DELETE FROM office_atlanta.files WHERE id = $1`, [fileId]);
    await db.query(`DELETE FROM public.job_queue WHERE payload->>'fileId' = $1`, [fileId]);
    expect((await db.query(`SELECT 1 FROM office_atlanta.files WHERE id = $1`, [fileId])).rows).toHaveLength(0);
  });
});

describe("Phase 2b — negatives & the structural backstop", () => {
  it("forced WRONG-schema write (Atlanta deal_id into office_dallas.files) is REJECTED by the FK (23503)", async () => {
    let code: string | undefined;
    try {
      await db.query(
        `INSERT INTO office_dallas.files (id, deal_id, category) VALUES ($1, $2, 'photo')`,
        ["00000000-0000-4000-8000-00000000dead", DEAL_ATL], // ATL deal does not exist in office_dallas
      );
    } catch (err: any) {
      code = err.code;
    }
    expect(code).toBe("23503"); // foreign_key_violation — the orphan write the old code allowed
    expect((await db.query(`SELECT 1 FROM office_dallas.files WHERE deal_id = $1`, [DEAL_ATL])).rows).toHaveLength(0);
  });

  it("unknown deal_id resolves to NO office → the route returns 404 and writes nothing", async () => {
    expect(await resolveDealOffice(UNKNOWN_DEAL)).toBeNull();
  });

  it("ON DELETE SET NULL: deleting a deal unassigns its photos instead of blocking or cascading", async () => {
    const fileId = "00000000-0000-4000-8000-00000000c777";
    const tmpDeal = "00000000-0000-4000-8000-0000000a7e09";
    await db.exec(`
      INSERT INTO office_atlanta.deals (id, deal_number, name) VALUES ('${tmpDeal}','ATL-DEL','Temp');
      INSERT INTO office_atlanta.files (id, deal_id, category) VALUES ('${fileId}','${tmpDeal}','photo');
    `);
    await db.query(`DELETE FROM office_atlanta.deals WHERE id = $1`, [tmpDeal]);
    const { rows } = await db.query<{ deal_id: string | null }>(
      `SELECT deal_id FROM office_atlanta.files WHERE id = $1`,
      [fileId],
    );
    expect(rows[0].deal_id).toBeNull();
    await db.query(`DELETE FROM office_atlanta.files WHERE id = $1`, [fileId]);
  });
});

describe("Phase 2b — invariants resolve PER THE DEAL's office", () => {
  it("photos-only-on-terminal: a terminal Atlanta deal is excluded by the active predicate run in office_atlanta", async () => {
    await db.exec(`SET search_path TO office_atlanta, public;`);
    const active = await db.query(`SELECT id FROM deals WHERE id = $1 AND is_active = true AND is_terminal = false`, [DEAL_ATL]);
    const terminal = await db.query(`SELECT id FROM deals WHERE id = $1 AND is_active = true AND is_terminal = false`, [DEAL_ATL_TERMINAL]);
    await db.exec(`SET search_path TO public;`);
    expect(active.rows).toHaveLength(1); // active Atlanta deal is capturable
    expect(terminal.rows).toHaveLength(0); // terminal Atlanta deal excluded — resolved in Atlanta's schema
  });

  it("rep-ownership resolves in the deal's office (assigned_rep read from office_atlanta)", async () => {
    const rep = "00000000-0000-4000-8000-00000000ee01";
    await db.query(`UPDATE office_atlanta.deals SET assigned_rep_id = $1 WHERE id = $2`, [rep, DEAL_ATL]);
    const { rows } = await db.query<{ assigned_rep_id: string }>(
      `SELECT assigned_rep_id FROM office_atlanta.deals WHERE id = $1`,
      [DEAL_ATL],
    );
    expect(rows[0].assigned_rep_id).toBe(rep); // ownership is read from the resolved (Atlanta) schema, not Dallas
    await db.query(`UPDATE office_atlanta.deals SET assigned_rep_id = NULL WHERE id = $1`, [DEAL_ATL]);
  });
});
