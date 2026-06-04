/**
 * Re-import filled close-date workbooks back into the CRM.
 *
 * Reads the hidden Deal ID + Office key columns from each filled workbook and
 * writes the rep-entered expected_close_date onto the exact deal. Safe by
 * default: DRY-RUN previews and writes nothing; --commit writes; an existing
 * date is NEVER clobbered (reported as CONFLICT) unless --overwrite-existing is
 * passed. Blank rows are skipped; bad dates / bad keys / unmatched rows are
 * reported, never crashing the run. Idempotent. Only expected_close_date is
 * written, which is side-effect-safe vs the deal triggers (stage-history /
 * stage_entered_at are guarded on stage changes; the close-date email triggers
 * are column-scoped to other columns).
 *
 * Usage (Railway injects DATABASE_URL):
 *   railway run --service=Postgres npx tsx scripts/close-date-reimport.ts --dir=./filled            # dry-run preview
 *   railway run --service=Postgres npx tsx scripts/close-date-reimport.ts --dir=./filled --commit   # write
 *   railway run --service=Postgres npx tsx scripts/close-date-reimport.ts --file=close-dates-alice.xlsx --commit
 *   railway run --service=Postgres npx tsx scripts/close-date-reimport.ts --dir=./filled --commit --overwrite-existing
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  discoverDealTenants,
  runReimport,
  type ImportRowResult,
  type ReimportMode,
} from "./lib/close-date-workflow.js";
import { readWorkbookRows } from "./lib/close-date-xlsx.js";

export type ReimportArgs = {
  file: string | null;
  dir: string | null;
  mode: ReimportMode;
  overwriteExisting: boolean;
};

export function parseReimportArgs(argv: string[]): ReimportArgs {
  const file = argv.find((a) => a.startsWith("--file="))?.split("=")[1] ?? null;
  const dir = argv.find((a) => a.startsWith("--dir="))?.split("=")[1] ?? null;
  if (!file && !dir) throw new Error("Provide --file=<path> or --dir=<folder> of filled .xlsx files.");
  if (file && dir) throw new Error("Provide only one of --file or --dir, not both.");
  return {
    file,
    dir,
    mode: argv.includes("--commit") ? "commit" : "dry-run",
    overwriteExisting: argv.includes("--overwrite-existing"),
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
      "Missing database URL. Run via: railway run --service=Postgres npx tsx scripts/close-date-reimport.ts",
    );
  }
  const ssl = /proxy\.rlwy\.net|\.rlwy\.net/.test(url) || url === process.env.DATABASE_PUBLIC_URL?.trim();
  return { url, ssl };
}

function resolveFiles(args: ReimportArgs): string[] {
  if (args.file) return [args.file];
  const dir = args.dir as string;
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".xlsx") && !f.startsWith("~$"))
    .sort()
    .map((f) => path.join(dir, f));
}

function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeAuditCsv(rows: Array<ImportRowResult & { sourceFile: string }>): string {
  const auditDir = path.join("docs", "audit");
  fs.mkdirSync(auditDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(auditDir, `close-date-reimport-${stamp}.csv`);
  const header = ["sourceFile", "rowNumber", "tenantSchema", "dealId", "dealNumber", "outcome", "value", "existing", "message"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [r.sourceFile, r.rowNumber ?? "", r.tenantSchema, r.dealId, r.dealNumber ?? "", r.outcome, r.value ?? "", r.existing ?? "", r.message ?? ""]
        .map(csvCell)
        .join(","),
    );
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseReimportArgs(argv);
  const files = resolveFiles(args);
  if (files.length === 0) {
    console.log("No .xlsx files found to import.");
    return;
  }

  const { url, ssl } = resolveDatabaseUrl();
  const client = new pg.Client({ connectionString: url, ssl: ssl ? { rejectUnauthorized: false } : undefined });
  await client.connect();

  try {
    const validSchemas = new Set(await discoverDealTenants(client));
    console.log(`close-date re-import | mode: ${args.mode.toUpperCase()}${args.overwriteExisting ? " | OVERWRITE-EXISTING" : ""}`);
    console.log(`Tenants: ${[...validSchemas].join(", ") || "(none)"} | files: ${files.length}`);

    const allResults: Array<ImportRowResult & { sourceFile: string }> = [];
    const totals: Record<string, number> = {};

    for (const filePath of files) {
      let rows;
      try {
        rows = await readWorkbookRows(filePath);
      } catch (err) {
        console.error(`  ${path.basename(filePath)}: SKIPPED — ${err instanceof Error ? err.message : err}`);
        continue;
      }
      const report = await runReimport({
        client,
        rows,
        validSchemas,
        mode: args.mode,
        overwriteExisting: args.overwriteExisting,
      });
      for (const r of report.results) {
        allResults.push({ ...r, sourceFile: path.basename(filePath) });
        totals[r.outcome] = (totals[r.outcome] ?? 0) + 1;
      }
      const c = report.counts;
      console.log(
        `  ${path.basename(filePath).padEnd(40)} ` +
          `written:${c.WRITTEN} overwritten:${c.OVERWRITTEN} noop:${c.NOOP} conflict:${c.CONFLICT} ` +
          `blank:${c.SKIPPED_BLANK} invalid-date:${c.INVALID_DATE} invalid-key:${c.INVALID_KEY} unmatched:${c.UNMATCHED} error:${c.ERROR}`,
      );
    }

    console.log("\nTotals:", JSON.stringify(totals));
    if (allResults.length > 0) {
      const audit = writeAuditCsv(allResults);
      console.log(`Per-row audit written to ${audit}`);
    }

    if (args.mode === "dry-run") {
      console.log("\nDRY-RUN — nothing written. Re-run with --commit to apply.");
    } else {
      console.log("\nCommit complete.");
    }

    // Surface genuine failures (not conflicts/unmatched, which are informational) to the exit code.
    if ((totals.ERROR ?? 0) > 0) process.exitCode = 1;
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
