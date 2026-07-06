import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runtime coverage for migration 0178: files_search_vector_trigger() now indexes original_filename
// (weight B), EXCEPT for SYNTHETIC photos (field-photo-<ts>/companycam_) whose machine name is blanked so
// its synthetic-only token ('field') never pollutes search. This boots PGlite, builds a tenant `files`
// table, attaches the REAL 0178 TENANT-block function body, and proves: a document AND a real web photo
// are searchable by their real filename; a field photo still matches 'photo' (via weight-A display_name)
// but NOT 'field'. It also asserts the two in-file function-body copies (DO-loop %I + TENANT block) are
// byte-identical (the lockstep guard).

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const SIG = "files_search_vector_trigger()";

function latestMigrationDefining(): string {
  const target = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => readFileSync(`${MIGRATIONS_DIR}/${f}`, "utf8").includes(SIG))
    .pop();
  if (!target) throw new Error("files_search_vector_trigger() is not defined in any migration");
  return readFileSync(`${MIGRATIONS_DIR}/${target}`, "utf8");
}

/** The bare `CREATE OR REPLACE FUNCTION office_dallas.files_search_vector_trigger() ...` between the
 *  TENANT_SCHEMA markers — this is the copy attached (office_dallas -> office_test) into PGlite. */
function tenantBlockFn(sql: string): string {
  const m = sql.match(/-- TENANT_SCHEMA_START\n([\s\S]*?)\n-- TENANT_SCHEMA_END/);
  if (!m) throw new Error("TENANT_SCHEMA block not found in 0178");
  return m[1].trim();
}

/** The inner BEGIN...END; body of the DO-loop `EXECUTE format($fn$ ... $fn$, schema_name)` copy. */
function doLoopInnerBody(sql: string): string {
  const fn = sql.match(/EXECUTE format\(\$fn\$([\s\S]*?)\$fn\$, schema_name\)/);
  if (!fn) throw new Error("DO-loop EXECUTE format(...) copy not found in 0178");
  const body = fn[1].match(/AS \$body\$([\s\S]*?)\$body\$ LANGUAGE plpgsql/);
  if (!body) throw new Error("DO-loop function body not found in 0178");
  return body[1];
}

function tenantInnerBody(fnText: string): string {
  const body = fnText.match(/AS \$body\$([\s\S]*?)\$body\$ LANGUAGE plpgsql/);
  if (!body) throw new Error("TENANT-block function body not found in 0178");
  return body[1];
}

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

const T = "office_test";
let db: PGlite;
let seq = 0;

beforeAll(async () => {
  const sql = latestMigrationDefining();
  // Sanity: we loaded the 0178 (original_filename-indexing) definition, not the 0001 one.
  expect(sql).toContain("original_filename");

  db = new PGlite();
  await db.exec(`SET TimeZone='UTC';`);
  await db.exec(`
    CREATE SCHEMA ${T};
    CREATE TABLE ${T}.files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      category text NOT NULL,
      display_name text NOT NULL,
      original_filename text NOT NULL,
      description text,
      tags text[] NOT NULL DEFAULT '{}',
      notes text,
      search_vector tsvector
    );
  `);
  // Attach the REAL TENANT-block function (office_dallas -> office_test), then the trigger.
  await db.exec(tenantBlockFn(sql).replace(/office_dallas/g, T));
  await db.exec(`CREATE TRIGGER files_search_vector_update BEFORE INSERT OR UPDATE ON ${T}.files
    FOR EACH ROW EXECUTE FUNCTION ${T}.files_search_vector_trigger();`);
}, 30000);

afterAll(async () => {
  await db?.close();
});

async function insert(row: { category: string; displayName: string; originalFilename: string }): Promise<string> {
  seq += 1;
  const r = await db.query<{ id: string }>(
    `INSERT INTO ${T}.files (category, display_name, original_filename) VALUES ($1,$2,$3) RETURNING id`,
    [row.category, row.displayName, row.originalFilename],
  );
  return r.rows[0].id;
}

async function matches(id: string, query: string): Promise<boolean> {
  const r = await db.query<{ id: string }>(
    `SELECT id FROM ${T}.files WHERE id = $1 AND search_vector @@ to_tsquery('english', $2)`,
    [id, query],
  );
  return r.rows.length > 0;
}

describe("0178 files_search_vector_trigger indexes original_filename (synthetic-photo exclusion)", () => {
  it("keeps the DO-loop and TENANT-block function bodies byte-identical (lockstep)", () => {
    const sql = latestMigrationDefining();
    expect(normalize(doLoopInnerBody(sql))).toBe(normalize(tenantInnerBody(tenantBlockFn(sql))));
  });

  it("indexes a DOCUMENT by its real original_filename", async () => {
    const id = await insert({
      category: "other",
      displayName: "TR-2026-0142 Other 2026-01-01 001 aa11bb22",
      originalFilename: "Foundation Warranty.pdf",
    });
    expect(await matches(id, "foundation & warranty")).toBe(true);
  });

  it("indexes a real WEB PHOTO by its real original_filename", async () => {
    const id = await insert({
      category: "photo",
      displayName: "TR-2026-0142 Photo 2026-01-01 002 cc33dd44",
      originalFilename: "Kitchen Damage.jpg",
    });
    expect(await matches(id, "kitchen & damage")).toBe(true);
  });

  it("a SYNTHETIC field photo still matches 'photo' (display_name) but NOT 'field' (excluded token)", async () => {
    const id = await insert({
      category: "photo",
      displayName: "TR-2026-0142 Photo 2026-04-01 001 ab12cd34",
      originalFilename: "field-photo-1699999999999.jpg",
    });
    expect(await matches(id, "photo")).toBe(true);
    expect(await matches(id, "field")).toBe(false);
  });
});
