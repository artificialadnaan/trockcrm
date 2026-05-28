/**
 * Marks suspected test/demo deals as `is_test_data = true`, driven by the audit
 * CSV at `.reviews/deals-endpoint-hygiene/test-data-suspected.csv`.
 *
 * Defaults to --dry-run. Nothing is written unless --commit is passed.
 *
 *   node --import tsx scripts/mark-test-data.ts                 # dry-run, all auto-safe patterns
 *   node --import tsx scripts/mark-test-data.ts --pattern demo  # limit to one pattern
 *   node --import tsx scripts/mark-test-data.ts --tenant office_dallas
 *   node --import tsx scripts/mark-test-data.ts --commit        # actually write (single transaction)
 *
 * Safety rules:
 *   - Rows flagged REVIEW_REQUIRED in the CSV are always skipped.
 *   - Only rows whose primary matched pattern is in the auto-mark safe list are eligible
 *     (the broad `template` pattern is never auto-marked).
 *   - --commit wraps all writes in a single transaction on a single client (no Promise.all).
 *   - Every committed write is snapshotted to /private/tmp/test-data-cleanup-<ts>.json with
 *     before/after values for rollback.
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "../.env") });

// Mirror of the audit's auto-mark safe list. `template` is intentionally excluded:
// it is a broad word-substring with a high false-positive rate (e.g. "Templeton").
const AUTO_SAFE_PATTERNS = new Set([
  "tides fire demo",
  "trock template",
  "test project",
  "sandbox",
  "demo",
  "example",
  "dummy",
  "placeholder",
]);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CSV = path.join(SCRIPT_DIR, "../.reviews/deals-endpoint-hygiene/test-data-suspected.csv");

interface CliOptions {
  commit: boolean;
  pattern: string | null;
  tenant: string;
  csvPath: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    commit: argv.includes("--commit"),
    pattern: null,
    tenant: "office_dallas",
    csvPath: DEFAULT_CSV,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--pattern") opts.pattern = argv[i + 1] ?? null;
    if (argv[i] === "--tenant") opts.tenant = argv[i + 1] ?? opts.tenant;
    if (argv[i] === "--csv") opts.csvPath = argv[i + 1] ?? opts.csvPath;
  }
  return opts;
}

function validateSchemaName(schemaName: string): string {
  if (!/^office_[a-z0-9_]+$/.test(schemaName)) throw new Error(`Invalid tenant schema name: ${schemaName}`);
  return schemaName;
}

function connectionString(): string {
  const publicUrl = process.env.DATABASE_PUBLIC_URL?.trim();
  const privateUrl = process.env.DATABASE_URL?.trim();
  const selected = publicUrl || privateUrl;
  if (!selected) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  if (!publicUrl && /railway\.internal/.test(selected)) {
    throw new Error("DATABASE_URL points at railway.internal. Export DATABASE_PUBLIC_URL in .env and retry.");
  }
  return selected;
}

// Minimal RFC4180 CSV parser (handles quoted cells with commas/quotes/newlines).
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    if (row.some((c) => c !== "")) rows.push(row);
  }
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    header.forEach((key, idx) => {
      obj[key] = cells[idx] ?? "";
    });
    return obj;
  });
}

export function selectCandidates(
  csvRows: Record<string, string>[],
  pattern: string | null
): Record<string, string>[] {
  return csvRows.filter((r) => {
    if (r.review_required === "REVIEW_REQUIRED") return false;
    if (r.auto_mark_safe !== "yes") return false;
    if (!AUTO_SAFE_PATTERNS.has(r.matched_pattern)) return false;
    if (pattern && r.matched_pattern !== pattern) return false;
    return true;
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tenant = validateSchemaName(opts.tenant);
  const mode = opts.commit ? "COMMIT" : "DRY-RUN";

  if (!fs.existsSync(opts.csvPath)) {
    throw new Error(`CSV not found: ${opts.csvPath}. Run the audit first.`);
  }
  const csvRows = parseCsv(fs.readFileSync(opts.csvPath, "utf8"));
  const candidates = selectCandidates(csvRows, opts.pattern);

  console.log(`[${mode}] mark-test-data — tenant=${tenant} pattern=${opts.pattern ?? "(all auto-safe)"}`);
  console.log(`CSV rows: ${csvRows.length} | eligible candidates: ${candidates.length}`);
  console.log(
    `Skipped: ${csvRows.length - candidates.length} ` +
      `(REVIEW_REQUIRED=${csvRows.filter((r) => r.review_required === "REVIEW_REQUIRED").length}, ` +
      `not-auto-safe=${csvRows.filter((r) => r.auto_mark_safe !== "yes").length})`
  );

  if (candidates.length === 0) {
    console.log("Nothing to do — no eligible candidates.");
    return;
  }

  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  try {
    // Read current values for accurate logging / backup (sequential — single client).
    const planned: Array<{ id: string; name: string; pattern: string; before: boolean }> = [];
    for (const r of candidates) {
      const res = await client.query(
        `SELECT id::text, name, COALESCE(is_test_data, false) AS is_test_data FROM ${tenant}.deals WHERE id = $1`,
        [r.id]
      );
      if (res.rowCount === 0) {
        console.log(`  ! ${r.id} (${r.name}) — not found in ${tenant}.deals, skipping`);
        continue;
      }
      const current = res.rows[0];
      planned.push({ id: current.id, name: current.name, pattern: r.matched_pattern, before: current.is_test_data });
      console.log(
        `  - ${current.id} | "${current.name}" | pattern="${r.matched_pattern}" | is_test_data ${current.is_test_data} -> true`
      );
    }

    if (!opts.commit) {
      console.log(`\nDRY-RUN complete. ${planned.length} row(s) would be marked. No writes performed.`);
      return;
    }

    const snapshot: Array<{ id: string; name: string; pattern: string; before: boolean; after: boolean }> = [];
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `/private/tmp/test-data-cleanup-${ts}.json`;
    await client.query("BEGIN");
    try {
      for (const p of planned) {
        const res = await client.query(
          `UPDATE ${tenant}.deals SET is_test_data = true WHERE id = $1
           RETURNING id::text, COALESCE(is_test_data, false) AS is_test_data`,
          [p.id]
        );
        snapshot.push({ id: p.id, name: p.name, pattern: p.pattern, before: p.before, after: res.rows[0].is_test_data });
      }
      // Persist the rollback snapshot before COMMIT: if the write fails we ROLLBACK,
      // so we never end up with a committed change and no rollback record.
      fs.writeFileSync(backupPath, JSON.stringify({ tenant, ranAt: new Date().toISOString(), updates: snapshot }, null, 2));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    console.log(`\nCOMMIT complete. ${snapshot.length} row(s) updated.`);
    console.log(`Rollback snapshot: ${backupPath}`);
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
