import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

/**
 * One-off drain: dismiss the automated tasks that accumulated on deals which have already reached a
 * terminal stage (Won / Lost).
 *
 * WHY THIS EXISTS. The daily generators never consulted the deal's stage, and `stage-change.ts` dismisses
 * open tasks AT the terminal transition — which is exactly what cleared each generator's "no open task of
 * this kind exists" guard. So closing a deal granted the next 6 AM run permission to re-mint, forever.
 * Census on prod 2026-09-12 (office_dallas): 3,395 open tasks on Won/Lost deals across 14 reps, the oldest
 * from 2026-05-08 and 114 of them minted in the preceding 7 days. Reported by a rep as "CRM not
 * communicating with Procore" — Procore is not involved; the CRM held the correct stage the whole time.
 *
 * The create-side filters shipped with this script, so the backlog no longer refills. This drains what is
 * already there.
 *
 * HOW IT STAYS HONEST. It does not re-implement the predicate. It imports and calls the production
 * `dismissResolvedTerminalDealTasks` from the worker job, so the census and the write are produced by the
 * same code the 6 AM run uses. A dry-run does the real work inside a transaction and ROLLS BACK, which
 * means the reported numbers are what a commit would actually do — not a separate query's opinion of it.
 *
 * Safety invariants (mirrors scripts/backfill-null-deal-regions.ts):
 *  - allowlisted: only the five forward-motion origin rules are touched. MANUAL tasks (origin_rule NULL)
 *    and post-close rules (won-handoff, cross-sell, competitor-intel, estimating-review) are left alone —
 *    see TERMINAL_DEAL_DISMISSIBLE_ORIGIN_RULES for why.
 *  - open-only: a completed / already-dismissed task is never rewritten.
 *  - dry-run by default: pass --commit to write.
 *  - transactional: one BEGIN/COMMIT per office; a failing office ROLLS BACK and is skipped, not fatal.
 *  - idempotent: a second run finds nothing (the rows it closed are no longer open).
 *  - auditable/reversible: a committed run writes an owner-only JSON snapshot of every dismissed task id
 *    per office. Revert = set status/completed_at back for those ids and delete the matching
 *    task_resolution_state rows.
 *
 * Usage — run from the repo root:
 *   CRM_DATABASE_URL="$DATABASE_PUBLIC_URL" node --import tsx scripts/backfill-dismiss-terminal-deal-tasks.ts
 *   CRM_DATABASE_URL="$DATABASE_PUBLIC_URL" node --import tsx scripts/backfill-dismiss-terminal-deal-tasks.ts --commit
 */

const OFFICE_SCHEMA_PATTERN = /^office_[a-z0-9_]+$/;
const LABEL = "[terminal-deal-task-drain]";

export type BackfillMode = "dry-run" | "commit";

export function parseBackfillArgs(argv = process.argv): { mode: BackfillMode } {
  const args = argv.slice(2);
  const hasCommit = args.includes("--commit");
  const hasDryRun = args.includes("--dry-run");
  if (hasCommit && hasDryRun) {
    throw new Error("Choose exactly one of --dry-run or --commit");
  }
  return { mode: hasCommit ? "commit" : "dry-run" };
}

function resolveConnectionString(): string {
  const url =
    process.env.CRM_DATABASE_URL || process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error("Set CRM_DATABASE_URL (preferred), DATABASE_PUBLIC_URL, or DATABASE_URL");
  }
  return url;
}

interface CensusRow {
  origin_rule: string;
  stage: string;
  open_tasks: number;
  reps: number;
  oldest: string | null;
  newest: string | null;
}

/** The per-office breakdown, for eyeballing before a commit. Reports only what the drain will act on. */
async function census(
  client: pg.Client,
  schemaName: string,
  originRules: readonly string[]
): Promise<CensusRow[]> {
  const { rows } = await client.query<CensusRow>(
    `SELECT t.origin_rule,
            psc.name AS stage,
            COUNT(*)::int AS open_tasks,
            COUNT(DISTINCT t.assigned_to)::int AS reps,
            MIN(t.created_at)::date::text AS oldest,
            MAX(t.created_at)::date::text AS newest
       FROM ${schemaName}.tasks t
       JOIN ${schemaName}.deals d ON d.id = t.deal_id
       JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE t.origin_rule = ANY($1::text[])
        AND t.status IN ('pending', 'scheduled', 'in_progress', 'waiting_on', 'blocked')
        AND psc.is_terminal = true
      GROUP BY t.origin_rule, psc.name
      ORDER BY open_tasks DESC`,
    [[...originRules]]
  );
  return rows;
}

export async function main(argv = process.argv): Promise<void> {
  const { mode } = parseBackfillArgs(argv);

  // Imported, not reimplemented: the census and the write both run the production predicate.
  const { dismissResolvedTerminalDealTasks, TERMINAL_DEAL_DISMISSIBLE_ORIGIN_RULES } = await import(
    "../worker/src/jobs/daily-tasks.js"
  );

  const client = new pg.Client({ connectionString: resolveConnectionString() });
  await client.connect();

  console.log(`${LABEL} mode=${mode}`);
  console.log(`${LABEL} origin rules in scope: ${TERMINAL_DEAL_DISMISSIBLE_ORIGIN_RULES.join(", ")}`);
  console.log(`${LABEL} NOT in scope: manual tasks (origin_rule IS NULL) and post-close rules.`);

  try {
    const { rows: offices } = await client.query<{ id: string; slug: string }>(
      "SELECT id, slug FROM public.offices WHERE is_active = true ORDER BY slug"
    );

    let totalDismissed = 0;
    let totalCandidates = 0;
    const skipped: string[] = [];
    const snapshot: Record<string, string[]> = {};

    for (const office of offices) {
      const schemaName = `office_${office.slug}`;
      if (!OFFICE_SCHEMA_PATTERN.test(schemaName)) {
        console.warn(`${LABEL} skipping office with unsafe slug: ${JSON.stringify(office.slug)}`);
        skipped.push(office.slug);
        continue;
      }

      const { rows: present } = await client.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS exists",
        [schemaName]
      );
      if (!present[0]?.exists) {
        skipped.push(office.slug);
        continue;
      }

      try {
        await client.query("BEGIN");

        const breakdown = await census(client, schemaName, TERMINAL_DEAL_DISMISSIBLE_ORIGIN_RULES);
        const candidates = breakdown.reduce((sum, row) => sum + row.open_tasks, 0);
        totalCandidates += candidates;

        console.log(`\n=== ${schemaName} === ${candidates} open task(s) on terminal-stage deals`);
        for (const row of breakdown) {
          console.log(
            `    ${row.open_tasks.toString().padStart(5)}  ${row.stage.padEnd(6)}  ${row.origin_rule}` +
              `  (${row.reps} rep(s), ${row.oldest} → ${row.newest})`
          );
        }

        // Capture the ids BEFORE the write, so a committed run has a reversibility snapshot and a dry-run
        // can still name what it would have touched.
        const { rows: targets } = await client.query<{ id: string }>(
          `SELECT t.id
             FROM ${schemaName}.tasks t
             JOIN ${schemaName}.deals d ON d.id = t.deal_id
             JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
            WHERE t.origin_rule = ANY($1::text[])
              AND t.status IN ('pending', 'scheduled', 'in_progress', 'waiting_on', 'blocked')
              AND psc.is_terminal = true`,
          [[...TERMINAL_DEAL_DISMISSIBLE_ORIGIN_RULES]]
        );

        const dismissed = await dismissResolvedTerminalDealTasks(client, schemaName, office.id);

        // The production predicate and the id capture above must agree. If they do not, something about the
        // schema drifted and the snapshot would not describe the write — refuse the office rather than
        // commit a change we cannot reverse.
        if (dismissed !== targets.length) {
          throw new Error(
            `census/write disagree for ${schemaName}: captured ${targets.length} id(s), dismissed ${dismissed}`
          );
        }

        if (mode === "commit") {
          await client.query("COMMIT");
          snapshot[schemaName] = targets.map((row) => row.id);
          totalDismissed += dismissed;
          console.log(`    -> dismissed ${dismissed}`);
        } else {
          await client.query("ROLLBACK");
          totalDismissed += dismissed;
          console.log(`    -> would dismiss ${dismissed} (rolled back)`);
        }
      } catch (schemaError) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(`\n=== ${schemaName} === SKIPPED due to error:`, schemaError);
        skipped.push(office.slug);
      }
    }

    console.log(
      `\n${LABEL} ${mode === "commit" ? "dismissed" : "would dismiss"} ${totalDismissed} of ` +
        `${totalCandidates} candidate task(s) across ${offices.length - skipped.length} office(s)`
    );
    if (skipped.length > 0) {
      console.warn(`${LABEL} skipped ${skipped.length} office(s): ${skipped.join(", ")}`);
    }

    if (mode === "commit" && Object.keys(snapshot).length > 0) {
      const file = path.join(
        os.tmpdir(),
        `terminal-deal-task-drain-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
      );
      fs.writeFileSync(file, JSON.stringify({ dismissedAt: new Date().toISOString(), snapshot }, null, 2), {
        mode: 0o600,
      });
      console.log(`${LABEL} reversibility snapshot: ${file}`);
      console.log(`${LABEL} copy it to .audit/backfills/ — the OS temp dir is cleared on reboot.`);
    }
    if (mode !== "commit") {
      console.log(`${LABEL} dry-run only — re-run with --commit to apply.`);
    }
  } finally {
    await client.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  main().catch((error) => {
    console.error(`${LABEL} failed:`, error);
    process.exit(1);
  });
}
