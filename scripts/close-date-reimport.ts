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
  isUuid,
  runReimport,
  type ImportRowResult,
  type ReimportMode,
} from "./lib/close-date-workflow.js";
import { readWorkbookRows } from "./lib/close-date-xlsx.js";
import { resolveScriptDatabaseUrl } from "./lib/resolve-database-url.js";

export type ReimportArgs = {
  file: string | null;
  dir: string | null;
  mode: ReimportMode;
  overwriteExisting: boolean;
};

/** Parse the re-import CLI flags; requires exactly one of `--file`/`--dir`. */
export function parseReimportArgs(argv: string[]): ReimportArgs {
  // slice() the flag prefix (not split("=")) so a path containing '=' survives intact.
  const fileArg = argv.find((a) => a.startsWith("--file="));
  const dirArg = argv.find((a) => a.startsWith("--dir="));
  const file = fileArg ? fileArg.slice("--file=".length) : null;
  const dir = dirArg ? dirArg.slice("--dir=".length) : null;
  if (!file && !dir) throw new Error("Provide --file=<path> or --dir=<folder> of filled .xlsx files.");
  if (file && dir) throw new Error("Provide only one of --file or --dir, not both.");
  return {
    file,
    dir,
    mode: argv.includes("--commit") ? "commit" : "dry-run",
    overwriteExisting: argv.includes("--overwrite-existing"),
  };
}

export function resolveFiles(args: ReimportArgs): string[] {
  if (args.file) {
    if (!fs.existsSync(args.file)) throw new Error(`No such file: ${args.file}`);
    if (!fs.statSync(args.file).isFile()) throw new Error(`--file must be a file, got: ${args.file}`);
    if (path.extname(args.file).toLowerCase() !== ".xlsx") {
      throw new Error(`--file must point to a .xlsx workbook, got: ${args.file}`);
    }
    return [args.file];
  }
  const dir = args.dir as string;
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`No such directory: ${dir}`);
  }
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".xlsx") && !f.startsWith("~$"))
    .sort()
    .map((f) => path.join(dir, f));
}

/** Optional operator UUID (env CLOSE_DATE_ACTOR_USER_ID) used to attribute audit rows. */
export function resolveActorUserId(env = process.env): string | null {
  const raw = env.CLOSE_DATE_ACTOR_USER_ID?.trim();
  if (!raw) return null;
  if (!isUuid(raw)) throw new Error(`CLOSE_DATE_ACTOR_USER_ID must be a UUID, got: ${raw}`);
  return raw;
}

/**
 * Render a value as a CSV cell. Neutralizes CSV/formula injection: a cell that
 * begins with =, +, -, @ (or a tab/CR that some apps strip to reveal one) is
 * prefixed with a single quote so spreadsheet apps treat it as text, not a
 * formula — workbook/rep-derived text (deal names, messages) lands in this CSV.
 */
export function csvCell(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Write the per-row outcome audit CSV to docs/audit/ (git-ignored) and return its path. */
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

/** Run the re-import: read each filled workbook, apply rows, write the audit CSV, set the exit code. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseReimportArgs(argv);
  const actorUserId = resolveActorUserId();
  const files = resolveFiles(args);
  if (files.length === 0) {
    console.warn("No .xlsx files found to import (folder contained no .xlsx files).");
    process.exitCode = 1;
    return;
  }

  const { url, ssl } = resolveScriptDatabaseUrl();
  const client = new pg.Client({ connectionString: url, ssl: ssl ? { rejectUnauthorized: false } : undefined });
  await client.connect();

  try {
    const validSchemas = new Set(await discoverDealTenants(client));
    console.log(`close-date re-import | mode: ${args.mode.toUpperCase()}${args.overwriteExisting ? " | OVERWRITE-EXISTING" : ""}`);
    console.log(`Tenants: ${[...validSchemas].join(", ") || "(none)"} | files: ${files.length}${actorUserId ? ` | actor: ${actorUserId}` : ""}`);

    const allResults: Array<ImportRowResult & { sourceFile: string }> = [];
    const totals: Record<string, number> = {};
    let filesSkipped = 0;

    for (const filePath of files) {
      let rows;
      try {
        rows = await readWorkbookRows(filePath);
      } catch (err) {
        console.error(`  ${path.basename(filePath)}: SKIPPED — ${err instanceof Error ? err.message : err}`);
        filesSkipped += 1;
        continue;
      }
      const report = await runReimport({
        client,
        rows,
        validSchemas,
        mode: args.mode,
        overwriteExisting: args.overwriteExisting,
        actorUserId,
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

    // Surface genuine failures to the exit code: per-row ERRORs, files that failed
    // to read, or a run that imported nothing at all (likely an operator mistake).
    if ((totals.ERROR ?? 0) > 0) {
      console.error(`\n${totals.ERROR} row(s) ERRORED — see the audit CSV.`);
      process.exitCode = 1;
    }
    if (filesSkipped > 0) {
      console.error(`\n${filesSkipped} file(s) could not be read and were skipped.`);
      process.exitCode = 1;
    }
    if (allResults.length === 0) {
      console.error("\nNo rows were processed from any file — nothing was imported.");
      process.exitCode = 1;
    }
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
