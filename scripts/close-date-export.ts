/**
 * Per-rep Excel export of OPEN deals that are missing an expected close date.
 *
 * Produces one workbook per sales rep (NULL rep -> "unassigned") so each rep can
 * be sent just their deals. The matching-key columns (Deal ID + Office) are
 * hidden + locked and the sheet is protected so only the "Expected Close Date"
 * column is editable; the re-import (`close-date-reimport.ts`) reads those keys
 * back to update the exact deal.
 *
 * Read-only on the database. Usage (Railway injects DATABASE_URL):
 *   railway run --service=Postgres npx tsx scripts/close-date-export.ts                 # all offices -> ./close-date-exports/<date>/
 *   railway run --service=Postgres npx tsx scripts/close-date-export.ts --tenant=office_dallas
 *   railway run --service=Postgres npx tsx scripts/close-date-export.ts --out=./out
 *   railway run --service=Postgres npx tsx scripts/close-date-export.ts --dry-run       # preview per-rep counts, write no files
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  discoverDealTenants,
  fetchMissingCloseDateDeals,
  groupDealsByRep,
} from "./lib/close-date-workflow.js";
import { buildRepWorkbook, workbookToBuffer } from "./lib/close-date-xlsx.js";

export type ExportArgs = { tenant: string | null; outDir: string | null; dryRun: boolean };

export function parseExportArgs(argv: string[]): ExportArgs {
  const tenantArg = argv.find((a) => a.startsWith("--tenant="))?.split("=")[1] ?? null;
  const outArg = argv.find((a) => a.startsWith("--out="))?.split("=")[1] ?? null;
  return {
    tenant: tenantArg && tenantArg !== "all" ? tenantArg : null,
    outDir: outArg,
    dryRun: argv.includes("--dry-run"),
  };
}

function resolveDatabaseUrl(): { url: string; ssl: boolean } {
  const url =
    process.env.DATABASE_URL?.trim() ||
    process.env.CRM_DATABASE_URL?.trim() ||
    process.env.DATABASE_PUBLIC_URL?.trim() ||
    "";
  if (!url) {
    throw new Error(
      "Missing database URL. Run via: railway run --service=Postgres npx tsx scripts/close-date-export.ts",
    );
  }
  const ssl = /proxy\.rlwy\.net|\.rlwy\.net/.test(url) || url === process.env.DATABASE_PUBLIC_URL?.trim();
  return { url, ssl };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseExportArgs(argv);
  const { url, ssl } = resolveDatabaseUrl();
  const client = new pg.Client({ connectionString: url, ssl: ssl ? { rejectUnauthorized: false } : undefined });
  await client.connect();

  try {
    const tenants = args.tenant ? [args.tenant] : await discoverDealTenants(client);
    const deals = await fetchMissingCloseDateDeals(client, tenants);
    const groups = groupDealsByRep(deals);

    // Guard against any residual filename collision so one rep's workbook can never
    // silently overwrite another's (groupDealsByRep already id-suffixes name clashes).
    const slugCounts = new Map<string, number>();
    for (const g of groups) slugCounts.set(g.fileSlug, (slugCounts.get(g.fileSlug) ?? 0) + 1);
    const collisions = [...slugCounts.entries()].filter(([, n]) => n > 1).map(([s]) => s);
    if (collisions.length > 0) {
      throw new Error(`Duplicate export filenames would collide (${collisions.join(", ")}); aborting to avoid overwriting a rep's file.`);
    }

    console.log(`close-date export | tenants: ${tenants.join(", ") || "(none)"}`);
    console.log(`Found ${deals.length} open deal(s) missing an expected close date across ${groups.length} rep(s).`);

    if (groups.length === 0) {
      console.log("Nothing to export.");
      return;
    }

    if (args.dryRun) {
      console.log("\nDRY-RUN — no files written. Per-rep breakdown:");
      for (const g of groups) console.log(`  ${g.fileSlug.padEnd(28)} ${String(g.deals.length).padStart(4)} deal(s)  [${g.repName}]`);
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const outDir = args.outDir ?? path.join("close-date-exports", today);
    fs.mkdirSync(outDir, { recursive: true });

    console.log(`\nWriting ${groups.length} file(s) to ${outDir}/`);
    for (const group of groups) {
      const wb = await buildRepWorkbook(group, { generatedOn: today });
      const buffer = await workbookToBuffer(wb);
      const filePath = path.join(outDir, `close-dates-${group.fileSlug}.xlsx`);
      fs.writeFileSync(filePath, buffer);
      console.log(`  ${path.basename(filePath).padEnd(40)} ${String(group.deals.length).padStart(4)} deal(s)  [${group.repName}]`);
    }
    console.log("\nDone. Send each rep their file; collect the filled files for close-date-reimport.ts.");
  } finally {
    await client.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
