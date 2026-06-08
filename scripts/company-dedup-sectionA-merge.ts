// One-off: execute the 31 approved Section A company merges (office_dallas) via the
// tested mergeDirectoryEntities service. Pairs are derived from the SAME normalized-name
// mapping used in the read-only dry-run (Section B's 7 uncertain groups are excluded),
// so what runs here is byte-identical to what was signed off.
//
//   DRY_RUN=true  (default) -> run everything in a transaction, print witnesses, ROLLBACK.
//   DRY_RUN=false           -> COMMIT.
//
// Won-basis invariance is re-asserted as a REAL read after the writes, inside the same tx.
//
// RECORD: ran against prod (DATABASE_PUBLIC_URL) and COMMITTED on 2026-06-08 — 41 loser
// merges across 31 groups; Won flat 361/$38,853,100.25 before==after; active 692->664; 41
// reversible directory_merge_audit rows (un-merge via unmergeDirectoryEntities). Reuse the
// pattern for Section B (edit the `sb` exclusion list to include the resolved groups) and
// for properties (2b). Reversal of THIS run: unmergeDirectoryEntities(tenantDb, auditId)
// per audit row where match_reasons LIKE '%phase2-sectionA%'.
import pg from "pg";
import dotenv from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as schema from "../shared/src/schema/index.js";
import { mergeDirectoryEntities } from "../server/src/services/directoryDedup.js";

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

const DATABASE_URL = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error("DATABASE_URL required"); process.exit(1); }
const TENANT = "office_dallas";
const dryRun = process.env.DRY_RUN !== "false";

// The normalized-name mapping: every company in a dup group, survivor = rk 1, Section B excluded.
const MAPPING_SQL = `
WITH base AS (
  SELECT c.id, c.name, c.created_at, c.address,
    trim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(lower(c.name),'[^a-z0-9]+',' ','g'),'^the\\s+',''),'\\s+(llc|inc|incorporated|ltd|limited|co|corp|corporation|company|llp|lp|pllc)\\s*$',''),'\\s+',' ','g')) norm
  FROM companies c),
m AS (SELECT b.*, (SELECT count(*) FROM deals d WHERE d.company_id=b.id) deals,
   (SELECT count(*) FROM contacts ct WHERE ct.company_id=b.id)+(SELECT count(*) FROM leads l WHERE l.company_id=b.id)+(SELECT count(*) FROM properties p WHERE p.company_id=b.id)+(SELECT count(*) FROM activities a WHERE a.company_id=b.id)+(SELECT count(*) FROM activities a WHERE a.source_entity_type='company' AND a.source_entity_id=b.id)+(SELECT count(*) FROM emails e WHERE e.assigned_entity_type='company' AND e.assigned_entity_id=b.id)+(SELECT count(*) FROM ai_document_index ad WHERE ad.company_id=b.id)+(SELECT count(*) FROM ai_disconnect_cases dc WHERE dc.company_id=b.id) othrefs FROM base b),
g AS (SELECT norm FROM m GROUP BY norm HAVING count(*)>1),
sb(norm) AS (VALUES ('cushman wakefield'),('harbor group management'),('laramar group'),('morgan properties'),('caf management'),('t rock construction'),('machine investment group')),
ranked AS (SELECT m.*, row_number() OVER (PARTITION BY norm ORDER BY deals DESC, (deals+othrefs) DESC, (address IS NOT NULL) DESC, created_at ASC, id ASC) rk
   FROM m JOIN g USING(norm) WHERE norm NOT IN (SELECT norm FROM sb)),
x AS (SELECT ranked.*, first_value(id) OVER (PARTITION BY norm ORDER BY rk) survivor_id, first_value(name) OVER (PARTITION BY norm ORDER BY rk) survivor_name FROM ranked)
SELECT norm, survivor_id, survivor_name, id AS loser_id, name AS loser_name
FROM x WHERE rk>1 ORDER BY norm, rk;`;

const WON_SQL = `
SELECT count(*)::int won_deals, COALESCE(sum(awarded_amount),0)::numeric(14,2) sum_awarded
FROM deals WHERE stage_id IN ('e8a891ca-e44e-466f-bfd0-a8bfb3d991b1','256dd04e-d597-4c52-9c1b-82221e74a46e')
  AND COALESCE(is_test_data,false)=false;`;
const ACTIVE_SQL = `SELECT count(*)::int n FROM companies WHERE is_active;`;

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('search_path',$1,true)", [`${TENANT},public`]);
    const tenantDb = drizzle(client, { schema });

    const { rows: pairs } = await client.query(MAPPING_SQL);
    const groups = new Set(pairs.map((p: any) => p.norm));
    console.log(`Section A mapping: ${pairs.length} losers across ${groups.size} groups`);
    if (pairs.length !== 41 || groups.size !== 31) {
      throw new Error(`mapping shape mismatch: expected 41 losers / 31 groups, got ${pairs.length} / ${groups.size} -- ABORT`);
    }

    const wonBefore = (await client.query(WON_SQL)).rows[0];
    const activeBefore = (await client.query(ACTIVE_SQL)).rows[0].n;
    console.log(`WON before: ${wonBefore.won_deals} deals / $${wonBefore.sum_awarded} | active companies: ${activeBefore}`);

    let n = 0;
    for (const p of pairs as any[]) {
      await mergeDirectoryEntities(tenantDb, "company", p.survivor_id, p.loser_id, {
        mode: "manual",
        mergedBy: null,
        confidenceScore: 1,
        matchReasons: ["phase2-sectionA", `group:${p.norm}`, "normalized-name-obvious", "approved-by-adnaan-2026-06-08"],
      });
      n += 1;
      console.log(`  [${n}/${pairs.length}] ${p.loser_name}  ->  ${p.survivor_name}`);
    }

    const wonAfter = (await client.query(WON_SQL)).rows[0];
    const activeAfter = (await client.query(ACTIVE_SQL)).rows[0].n;
    const auditCount = (await client.query(
      `SELECT count(*)::int n FROM directory_merge_audit WHERE entity_type='company' AND (match_reasons)::text LIKE '%phase2-sectionA%';`)).rows[0].n;
    const merged = (await client.query(
      `SELECT count(*)::int n FROM companies WHERE NOT is_active AND source_refs ? 'merged_into';`)).rows[0].n;

    console.log(`WON after:  ${wonAfter.won_deals} deals / $${wonAfter.sum_awarded} | active companies: ${activeAfter}`);
    console.log(`audit rows (phase2-sectionA): ${auditCount} | companies stamped merged_into: ${merged}`);

    const invariant = wonBefore.won_deals === wonAfter.won_deals && String(wonBefore.sum_awarded) === String(wonAfter.sum_awarded);
    console.log(`WON INVARIANT: ${invariant ? "PASS (before == after)" : "FAIL"}`);
    if (!invariant) throw new Error("Won invariance FAILED -- ABORT, rolling back");

    if (dryRun) { await client.query("ROLLBACK"); console.log("DRY_RUN -> ROLLBACK (no changes persisted)"); }
    else { await client.query("COMMIT"); console.log("COMMITTED -> Section A merges persisted"); }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
