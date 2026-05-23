import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";

const { Client } = pg;

const OFFICE_SCHEMA = "office_dallas";
const EXPECTED_NEED_A_COUNT = 61;
const EXPECTED_NEED_B_HISTORY_COUNT = 39;
const EXPECTED_NEED_B_ACTUAL_CLOSE_COUNT = 34;
const EXPECTED_NEED_B_COUNT = EXPECTED_NEED_B_HISTORY_COUNT + EXPECTED_NEED_B_ACTUAL_CLOSE_COUNT;

const WON_TERMINAL_STAGE_SLUGS = [
  "won",
  "sent_to_production",
  "service_sent_to_production",
  "closed_won",
] as const;
const LOST_TERMINAL_STAGE_SLUGS = [
  "lost",
  "production_lost",
  "service_lost",
  "closed_lost",
] as const;
const TERMINAL_STAGE_SLUGS = [...WON_TERMINAL_STAGE_SLUGS, ...LOST_TERMINAL_STAGE_SLUGS] as const;

type Mode = "dry-run" | "rollback-check" | "commit";

interface Args {
  mode: Mode;
  backupDir: string;
}

interface CandidateRow {
  operation: "need_a_stage_entry" | "need_b_terminal_history" | "need_b_won_actual_close";
  office_schema: string;
  deal_id: string;
  deal_number: string | null;
  project_number: string | null;
  name: string;
  stage_slug: string;
  target_column: "bid_board_stage_entered_at" | "contract_signed_at" | "lost_at";
  proposed_value: Date | string;
  source_value: Date | string;
  source_kind: "current_stage_history" | "terminal_stage_history" | "actual_close_date";
  needs_update: boolean;
  current_bid_board_stage_entered_at: Date | string | null;
  current_contract_signed_at: Date | string | null;
  current_contract_signed_date: Date | string | null;
  current_lost_at: Date | string | null;
  current_actual_close_date: Date | string | null;
  stage_entered_at: Date | string | null;
  import_extracted_at: Date | string;
}

interface CandidatePayload {
  latestRun: unknown;
  counts: {
    needA: number;
    needB: number;
    needBHistory: number;
    needBWonActualClose: number;
    total: number;
    needsUpdate: number;
    alreadyCorrect: number;
    needANeedsUpdate: number;
    needBNeedsUpdate: number;
  };
  exclusions: unknown;
  candidates: CandidateRow[];
}

const USAGE = `Usage:
  node --import tsx scripts/reseed-bid-board-stage-dates.ts --dry-run [--backup-dir=/private/tmp]
  node --import tsx scripts/reseed-bid-board-stage-dates.ts --rollback-check [--backup-dir=/private/tmp]
  node --import tsx scripts/reseed-bid-board-stage-dates.ts --commit [--backup-dir=/private/tmp]

Exactly one mode flag is required. --commit writes production data.`;

function parseArgs(argv: string[]): Args {
  const hasDryRun = argv.includes("--dry-run");
  const hasRollbackCheck = argv.includes("--rollback-check");
  const hasCommit = argv.includes("--commit");
  const modes = [hasDryRun, hasRollbackCheck, hasCommit].filter(Boolean).length;
  if (modes !== 1) {
    throw new Error(`Specify exactly one of --dry-run, --rollback-check, or --commit.\n${USAGE}`);
  }

  const backupDirArg = argv.find((arg) => arg.startsWith("--backup-dir="));
  const backupDir = backupDirArg ? backupDirArg.slice("--backup-dir=".length) : os.tmpdir();
  if (!path.isAbsolute(backupDir)) {
    throw new Error("--backup-dir must be an absolute path");
  }

  return {
    mode: hasCommit ? "commit" : hasRollbackCheck ? "rollback-check" : "dry-run",
    backupDir,
  };
}

function loadEnv() {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../..", ".env"),
  ];
  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
      return;
    }
  }
  dotenv.config();
}

function connectionString() {
  const selected = process.env.DATABASE_PUBLIC_URL?.trim();
  if (!selected) {
    throw new Error("DATABASE_PUBLIC_URL is required");
  }
  if (/railway\.internal/.test(selected)) {
    throw new Error("DATABASE_PUBLIC_URL must be externally reachable, not railway.internal");
  }
  return selected;
}

function quoteIdent(value: string) {
  return pg.escapeIdentifier(value);
}

function asIso(value: Date | string | null | undefined) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function candidateSql(schema: string) {
  const q = quoteIdent(schema);
  return `
WITH latest_run AS (
  SELECT id, extracted_at, created_at, source_filename, matched_count, updated_count, row_count
  FROM ${q}.bid_board_sync_runs
  WHERE extracted_at IS NOT NULL AND matched_count > 0
  ORDER BY created_at DESC
  LIMIT 1
), known_import_times AS (
  SELECT extracted_at
  FROM ${q}.bid_board_sync_runs
  WHERE extracted_at IS NOT NULL
    AND created_at >= (SELECT date_trunc('day', extracted_at) FROM latest_run)
    AND created_at < (SELECT date_trunc('day', extracted_at) + interval '1 day' FROM latest_run)
), imported AS (
  SELECT
    d.id,
    d.deal_number,
    d.project_number,
    d.name,
    d.stage_id,
    d.source,
    d.created_at,
    d.bid_board_stage_entered_at,
    d.contract_signed_at,
    d.contract_signed_date,
    d.lost_at,
    d.actual_close_date,
    d.stage_entered_at,
    psc.slug AS stage_slug,
    psc.is_terminal,
    lr.extracted_at,
    date_trunc('day', lr.extracted_at) AS import_day
  FROM ${q}.deals d
  CROSS JOIN latest_run lr
  JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
  WHERE d.bid_board_last_updated_at = lr.extracted_at
), current_history AS (
  SELECT i.id AS deal_id, max(h.created_at) AS history_at
  FROM imported i
  JOIN ${q}.deal_stage_history h
    ON h.deal_id = i.id
   AND h.to_stage_id = i.stage_id
  WHERE h.created_at < i.import_day
  GROUP BY i.id
), terminal_history AS (
  SELECT i.id AS deal_id, max(h.created_at) AS history_at
  FROM imported i
  JOIN ${q}.deal_stage_history h
    ON h.deal_id = i.id
   AND h.to_stage_id = i.stage_id
  WHERE h.created_at < i.import_day
    AND i.stage_slug = ANY($1::text[])
  GROUP BY i.id
), need_a AS (
  SELECT
    'need_a_stage_entry'::text AS operation,
    $4::text AS office_schema,
    i.id AS deal_id,
    i.deal_number,
    i.project_number,
    i.name,
    i.stage_slug,
    'bid_board_stage_entered_at'::text AS target_column,
    ch.history_at AS proposed_value,
    ch.history_at AS source_value,
    'current_stage_history'::text AS source_kind,
    i.bid_board_stage_entered_at IS DISTINCT FROM ch.history_at AS needs_update,
    i.bid_board_stage_entered_at AS current_bid_board_stage_entered_at,
    i.contract_signed_at AS current_contract_signed_at,
    i.contract_signed_date AS current_contract_signed_date,
    i.lost_at AS current_lost_at,
    i.actual_close_date AS current_actual_close_date,
    i.stage_entered_at,
    i.extracted_at AS import_extracted_at
  FROM imported i
  JOIN current_history ch ON ch.deal_id = i.id
  WHERE NOT (i.stage_slug = ANY($1::text[]) OR i.is_terminal)
), need_b_history AS (
  SELECT
    'need_b_terminal_history'::text AS operation,
    $4::text AS office_schema,
    i.id AS deal_id,
    i.deal_number,
    i.project_number,
    i.name,
    i.stage_slug,
    CASE WHEN i.stage_slug = ANY($2::text[]) THEN 'contract_signed_at' ELSE 'lost_at' END AS target_column,
    th.history_at AS proposed_value,
    th.history_at AS source_value,
    'terminal_stage_history'::text AS source_kind,
    (
      (i.stage_slug = ANY($2::text[]) AND i.contract_signed_at IS DISTINCT FROM th.history_at)
      OR (i.stage_slug = ANY($3::text[]) AND i.lost_at IS DISTINCT FROM th.history_at)
    ) AS needs_update,
    i.bid_board_stage_entered_at AS current_bid_board_stage_entered_at,
    i.contract_signed_at AS current_contract_signed_at,
    i.contract_signed_date AS current_contract_signed_date,
    i.lost_at AS current_lost_at,
    i.actual_close_date AS current_actual_close_date,
    i.stage_entered_at,
    i.extracted_at AS import_extracted_at
  FROM imported i
  JOIN terminal_history th ON th.deal_id = i.id
  WHERE i.stage_slug = ANY($1::text[])
), need_b_won_actual_close AS (
  SELECT
    'need_b_won_actual_close'::text AS operation,
    $4::text AS office_schema,
    i.id AS deal_id,
    i.deal_number,
    i.project_number,
    i.name,
    i.stage_slug,
    'contract_signed_at'::text AS target_column,
    i.actual_close_date::timestamptz AS proposed_value,
    i.actual_close_date::timestamptz AS source_value,
    'actual_close_date'::text AS source_kind,
    i.contract_signed_at IS DISTINCT FROM i.actual_close_date::timestamptz AS needs_update,
    i.bid_board_stage_entered_at AS current_bid_board_stage_entered_at,
    i.contract_signed_at AS current_contract_signed_at,
    i.contract_signed_date AS current_contract_signed_date,
    i.lost_at AS current_lost_at,
    i.actual_close_date AS current_actual_close_date,
    i.stage_entered_at,
    i.extracted_at AS import_extracted_at
  FROM imported i
  LEFT JOIN terminal_history th ON th.deal_id = i.id
  WHERE i.stage_slug = ANY($2::text[])
    AND th.history_at IS NULL
    AND i.actual_close_date IS NOT NULL
    AND i.actual_close_date < i.import_day::date
), candidates AS (
  SELECT * FROM need_a
  UNION ALL
  SELECT * FROM need_b_history
  UNION ALL
  SELECT * FROM need_b_won_actual_close
), exclusions AS (
  SELECT jsonb_build_object(
    'nonterminal_missing_pre_import_history', count(*) FILTER (
      WHERE NOT (i.stage_slug = ANY($1::text[]) OR i.is_terminal)
        AND ch.history_at IS NULL
    ),
    'terminal_missing_approved_source', count(*) FILTER (
      WHERE i.stage_slug = ANY($1::text[])
        AND th.history_at IS NULL
        AND NOT (
          i.stage_slug = ANY($2::text[])
          AND i.actual_close_date IS NOT NULL
          AND i.actual_close_date < i.import_day::date
        )
    ),
    'won_actual_close_equals_import_date', count(*) FILTER (
      WHERE i.stage_slug = ANY($2::text[])
        AND th.history_at IS NULL
        AND i.actual_close_date = i.import_day::date
    ),
    'lost_at_within_5_minutes_known_import', count(*) FILTER (
      WHERE i.stage_slug = ANY($3::text[])
        AND th.history_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM known_import_times kit
          WHERE i.lost_at IS NOT NULL
            AND abs(extract(epoch FROM (i.lost_at - kit.extracted_at))) <= 300
        )
    ),
    'lost_at_same_import_day_not_within_5_minutes', count(*) FILTER (
      WHERE i.stage_slug = ANY($3::text[])
        AND th.history_at IS NULL
        AND i.lost_at IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM known_import_times kit
          WHERE i.lost_at::date = kit.extracted_at::date
        )
        AND NOT EXISTS (
          SELECT 1
          FROM known_import_times kit
          WHERE abs(extract(epoch FROM (i.lost_at - kit.extracted_at))) <= 300
        )
    )
  ) AS data
  FROM imported i
  LEFT JOIN current_history ch ON ch.deal_id = i.id
  LEFT JOIN terminal_history th ON th.deal_id = i.id
)
SELECT jsonb_build_object(
  'latestRun', (
    SELECT jsonb_build_object(
      'id', id,
      'extractedAt', extracted_at,
      'createdAt', created_at,
      'sourceFilename', source_filename,
      'matchedCount', matched_count,
      'updatedCount', updated_count,
      'rowCount', row_count
    )
    FROM latest_run
  ),
  'counts', jsonb_build_object(
    'needA', (SELECT count(*) FROM need_a),
    'needBHistory', (SELECT count(*) FROM need_b_history),
    'needBWonActualClose', (SELECT count(*) FROM need_b_won_actual_close),
    'needB', (SELECT count(*) FROM need_b_history) + (SELECT count(*) FROM need_b_won_actual_close),
    'total', (SELECT count(*) FROM candidates),
    'needsUpdate', (SELECT count(*) FROM candidates WHERE needs_update),
    'alreadyCorrect', (SELECT count(*) FROM candidates WHERE NOT needs_update),
    'needANeedsUpdate', (SELECT count(*) FROM candidates WHERE operation = 'need_a_stage_entry' AND needs_update),
    'needBNeedsUpdate', (SELECT count(*) FROM candidates WHERE operation IN ('need_b_terminal_history', 'need_b_won_actual_close') AND needs_update)
  ),
  'exclusions', (SELECT data FROM exclusions),
  'candidates', COALESCE((SELECT jsonb_agg(to_jsonb(candidates) ORDER BY operation, deal_number, deal_id) FROM candidates), '[]'::jsonb)
) AS payload;
`;
}

async function loadCandidates(client: pg.Client): Promise<CandidatePayload> {
  const result = await client.query(candidateSql(OFFICE_SCHEMA), [
    TERMINAL_STAGE_SLUGS,
    WON_TERMINAL_STAGE_SLUGS,
    LOST_TERMINAL_STAGE_SLUGS,
    OFFICE_SCHEMA,
  ]);
  const payload = result.rows[0]?.payload;
  if (!payload?.latestRun) {
    throw new Error(`No latest Bid Board run found for ${OFFICE_SCHEMA}`);
  }
  return {
    latestRun: payload.latestRun,
    counts: {
      needA: Number(payload.counts.needA),
      needB: Number(payload.counts.needB),
      needBHistory: Number(payload.counts.needBHistory),
      needBWonActualClose: Number(payload.counts.needBWonActualClose),
      total: Number(payload.counts.total),
      needsUpdate: Number(payload.counts.needsUpdate),
      alreadyCorrect: Number(payload.counts.alreadyCorrect),
      needANeedsUpdate: Number(payload.counts.needANeedsUpdate),
      needBNeedsUpdate: Number(payload.counts.needBNeedsUpdate),
    },
    exclusions: payload.exclusions,
    candidates: payload.candidates,
  };
}

function assertApprovedShape(payload: CandidatePayload) {
  const mismatches: string[] = [];
  if (payload.counts.needA !== EXPECTED_NEED_A_COUNT) {
    mismatches.push(`Need A expected ${EXPECTED_NEED_A_COUNT}, got ${payload.counts.needA}`);
  }
  if (payload.counts.needBHistory !== EXPECTED_NEED_B_HISTORY_COUNT) {
    mismatches.push(`Need B history expected ${EXPECTED_NEED_B_HISTORY_COUNT}, got ${payload.counts.needBHistory}`);
  }
  if (payload.counts.needBWonActualClose !== EXPECTED_NEED_B_ACTUAL_CLOSE_COUNT) {
    mismatches.push(
      `Need B won actual_close_date expected ${EXPECTED_NEED_B_ACTUAL_CLOSE_COUNT}, got ${payload.counts.needBWonActualClose}`,
    );
  }
  if (payload.counts.needB !== EXPECTED_NEED_B_COUNT) {
    mismatches.push(`Need B total expected ${EXPECTED_NEED_B_COUNT}, got ${payload.counts.needB}`);
  }
  if (payload.candidates.length !== payload.counts.total) {
    mismatches.push(`Candidate list length ${payload.candidates.length} did not match total ${payload.counts.total}`);
  }
  if (mismatches.length > 0) {
    throw new Error(`Approved safe-set shape mismatch:\n${mismatches.join("\n")}`);
  }
}

function backupPath(backupDir: string, mode: Mode) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(backupDir, `trockcrm-stage-date-recovery-${mode}-${stamp}.json`);
}

function writeBackup(backupDir: string, mode: Mode, payload: CandidatePayload) {
  fs.mkdirSync(backupDir, { recursive: true });
  const outPath = backupPath(backupDir, mode);
  const backup = {
    createdAt: new Date().toISOString(),
    mode,
    officeSchema: OFFICE_SCHEMA,
    latestRun: payload.latestRun,
    counts: payload.counts,
    exclusions: payload.exclusions,
    currentValues: payload.candidates.map((row) => ({
      operation: row.operation,
      dealId: row.deal_id,
      dealNumber: row.deal_number,
      projectNumber: row.project_number,
      name: row.name,
      stageSlug: row.stage_slug,
      targetColumn: row.target_column,
      proposedValue: asIso(row.proposed_value),
      sourceKind: row.source_kind,
      sourceValue: asIso(row.source_value),
      current: {
        bidBoardStageEnteredAt: asIso(row.current_bid_board_stage_entered_at),
        contractSignedAt: asIso(row.current_contract_signed_at),
        contractSignedDate: asIso(row.current_contract_signed_date),
        lostAt: asIso(row.current_lost_at),
        actualCloseDate: asIso(row.current_actual_close_date),
        stageEnteredAt: asIso(row.stage_entered_at),
      },
      importExtractedAt: asIso(row.import_extracted_at),
    })),
  };
  fs.writeFileSync(outPath, `${JSON.stringify(backup, null, 2)}\n`, "utf8");
  return outPath;
}

async function applyCandidates(client: pg.Client, candidates: CandidateRow[]) {
  const counts = {
    needA: 0,
    needBHistory: 0,
    needBWonActualClose: 0,
    needB: 0,
    total: 0,
  };

  for (const row of candidates.filter((candidate) => candidate.needs_update)) {
    let result: pg.QueryResult;
    if (row.target_column === "bid_board_stage_entered_at") {
      result = await client.query(
        `UPDATE ${quoteIdent(OFFICE_SCHEMA)}.deals
            SET bid_board_stage_entered_at = $2::timestamptz
          WHERE id = $1::uuid
            AND bid_board_stage_entered_at IS DISTINCT FROM $2::timestamptz`,
        [row.deal_id, row.proposed_value],
      );
    } else if (row.target_column === "contract_signed_at") {
      result = await client.query(
        `UPDATE ${quoteIdent(OFFICE_SCHEMA)}.deals
            SET contract_signed_at = $2::timestamptz
          WHERE id = $1::uuid
            AND contract_signed_at IS DISTINCT FROM $2::timestamptz`,
        [row.deal_id, row.proposed_value],
      );
    } else if (row.target_column === "lost_at") {
      result = await client.query(
        `UPDATE ${quoteIdent(OFFICE_SCHEMA)}.deals
            SET lost_at = $2::timestamptz
          WHERE id = $1::uuid
            AND lost_at IS DISTINCT FROM $2::timestamptz`,
        [row.deal_id, row.proposed_value],
      );
    } else {
      throw new Error(`Unsupported target column: ${row.target_column}`);
    }

    const affected = result.rowCount ?? 0;
    if (affected !== 1) {
      throw new Error(`Expected to update exactly one row for ${row.operation} ${row.deal_id}; updated ${affected}`);
    }
    counts.total += affected;
    if (row.operation === "need_a_stage_entry") counts.needA += affected;
    if (row.operation === "need_b_terminal_history") {
      counts.needBHistory += affected;
      counts.needB += affected;
    }
    if (row.operation === "need_b_won_actual_close") {
      counts.needBWonActualClose += affected;
      counts.needB += affected;
    }
  }

  return counts;
}

async function verifyCommitted(client: pg.Client) {
  const payload = await loadCandidates(client);
  return payload.counts;
}

function printSummary(label: string, payload: CandidatePayload, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({
    label,
    officeSchema: OFFICE_SCHEMA,
    latestRun: payload.latestRun,
    counts: payload.counts,
    exclusions: payload.exclusions,
    ...extra,
  }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnv();
  const client = new Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    if (args.mode === "dry-run") {
      const payload = await loadCandidates(client);
      assertApprovedShape(payload);
      printSummary("dry-run", payload);
      return;
    }

    await client.query("BEGIN");
    try {
      const payload = await loadCandidates(client);
      assertApprovedShape(payload);
      const writtenBackupPath = writeBackup(args.backupDir, args.mode, payload);
      const appliedCounts = await applyCandidates(client, payload.candidates);

      if (appliedCounts.needA !== payload.counts.needANeedsUpdate || appliedCounts.needB !== payload.counts.needBNeedsUpdate) {
        throw new Error(`Applied count mismatch: ${JSON.stringify(appliedCounts)}`);
      }

      if (args.mode === "rollback-check") {
        await client.query("ROLLBACK");
        printSummary("rollback-check", payload, { appliedCounts, backupPath: writtenBackupPath, rolledBack: true });
        return;
      }

      await client.query("COMMIT");
      const postCommitCounts = await verifyCommitted(client);
      printSummary("commit", payload, {
        appliedCounts,
        backupPath: writtenBackupPath,
        committed: true,
        postCommitRemainingCandidateCounts: postCommitCounts,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    await client.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
