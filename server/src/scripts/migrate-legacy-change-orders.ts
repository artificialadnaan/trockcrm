/**
 * One-time fix-forward migration: convert every legacy `deal_change_orders` row into a real CO CHILD deal
 * (the #657 model) and delete the legacy row, so ZERO legacy COs remain in the system.
 *
 *   npm run migrate:legacy-cos             # DRY-RUN (default): classify-only, no writes — report N/$
 *   npm run migrate:legacy-cos -- --execute   # EXECUTE: convert + delete (per-row transaction)
 *
 * WINDOWLESS: run --execute against prod while the #650 fold is STILL live (fold-removal NOT yet deployed).
 * Each CO is counted exactly once throughout — a remaining legacy row (via the fold) OR a child deal (via
 * canonical Won), never both — because each row is deleted in the same transaction that creates its child.
 * Deploy the fold-removal AFTER execute reports 0 remaining; it is then a no-op on the emptied table.
 */
import pg from "pg";
import dotenv from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";
import { migrateLegacyChangeOrders, addMoney } from "../modules/deals/change-order-migration.js";

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const EXECUTE = process.argv.includes("--execute");

async function run() {
  const dryRun = !EXECUTE;
  console.log(`[co-migration] mode: ${dryRun ? "DRY-RUN (no writes)" : "EXECUTE (converting + deleting)"}`);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows: schemas } = await pool.query(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'office_%' ORDER BY schema_name"
    );

    let gTotal = 0,
      gEligible = 0,
      gSkipped = 0,
      gMigrated = 0,
      gFailed = 0;
    let gEligibleAmt = "0.00",
      gSkippedAmt = "0.00";
    const blockers: string[] = [];

    for (const { schema_name } of schemas) {
      if (!/^office_[a-z0-9_]+$/.test(schema_name)) continue; // SQL-injection guard (matches geocode-backfill)
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO ${schema_name}, public`);
        const tdb = drizzle(client, { schema });
        const r = await migrateLegacyChangeOrders(tdb as never, { dryRun });
        console.log(
          `[${schema_name}] legacy=${r.totalRows} eligible=${r.eligibleCount} ($${r.eligibleAmount})` +
            ` blocked=${r.skippedCount} ($${r.skippedAmount})` +
            (dryRun ? "" : ` migrated=${r.migrated} failed=${r.failedCount}`)
        );
        if (r.skippedCount > 0) blockers.push(`${schema_name}: ${r.skippedCount} blocked ($${r.skippedAmount})`);
        if (!dryRun && r.failedIds.length) console.log(`  failed ids: ${r.failedIds.join(", ")}`);
        gTotal += r.totalRows;
        gEligible += r.eligibleCount;
        gSkipped += r.skippedCount;
        gMigrated += r.migrated;
        gFailed += r.failedCount;
        gEligibleAmt = addMoney(gEligibleAmt, r.eligibleAmount);
        gSkippedAmt = addMoney(gSkippedAmt, r.skippedAmount);
      } finally {
        client.release();
      }
    }

    console.log(`\n[co-migration] ${dryRun ? "DRY-RUN" : "EXECUTE"} TOTAL across all offices:`);
    console.log(`  legacy change orders found:      ${gTotal}`);
    console.log(`  ${dryRun ? "WOULD migrate" : "migrated"} (eligible): ${dryRun ? gEligible : gMigrated} child deals, $${gEligibleAmt}`);
    if (!dryRun && gFailed > 0) console.log(`  FAILED during convert:           ${gFailed} (legacy row kept — investigate)`);
    if (gSkipped > 0) {
      console.log(`  BLOCKED (ineligible parent):     ${gSkipped}, $${gSkippedAmt}`);
      console.log(`  >>> FIX-FORWARD NOT CLEAN: ${gSkipped} legacy rows would remain. Resolve before completing:`);
      for (const b of blockers) console.log(`        ${b}`);
    } else {
      console.log(`  BLOCKED (ineligible parent):     0  ✓ clean fix-forward (zero legacy will remain)`);
    }
    if (dryRun) {
      console.log(`\nReview the eligible count + $ above. Re-run with --execute to migrate (zero legacy remaining).`);
    } else {
      console.log(`\nDone. deal_change_orders should now be empty (legacy=${gTotal - gMigrated - gSkipped} unexpected remaining).`);
    }
  } finally {
    await pool.end();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
