import "dotenv/config";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  findDealsByProjectNumber,
  getActiveOffices,
  processSyncHubProcoreProjectCreated,
  type SyncHubRelayResult,
} from "../modules/synchub/procore-project-relay-service.js";

/**
 * One-off replay: re-process the OPEN SyncHub project-created orphans so the deals we missed get
 * linked and their "T Rock Photos" Procore link created.
 *
 * WHY THIS EXISTS: the created-project relay used to match the incoming Procore number against
 * deals.deal_number ONLY. For HubSpot-imported / bid-board deals the canonical number lives in
 * deals.project_number, so those relays filed a "No CRM deal matched project number" orphan, never
 * set procore_project_id, and the worker never created the photo link. The relay is now fixed to
 * match project_number OR deal_number (excluding change-order children). This script retro-fixes the
 * ALREADY-orphaned projects by replaying each open orphan's stored payload through the fixed relay.
 *
 * Design / safety:
 *  - Reuses the FIXED relay verbatim: the actual linking (procore_project_id, procore_sync_state,
 *    job_queue create_project, project mirror, audit) is `processSyncHubProcoreProjectCreated` — no
 *    re-implemented link logic that could drift from production.
 *  - Preview via the SAME resolver the relay uses (`findDealsByProjectNumber`), so dry-run reports
 *    exactly which orphans will link WITHOUT any writes.
 *  - Only replays orphans that resolve to EXACTLY ONE deal. A 0-match (genuine orphan, e.g. no CRM
 *    deal) or >1-match (ambiguous) is skipped and left open — so a replay can NEVER insert a duplicate
 *    orphan, regardless of whether the row carries a webhook-log id.
 *  - Idempotent: a linked deal replays to `already_linked` (re-marked resolved); a resolved orphan is
 *    no longer `status='open'`, so a second run does not re-select it.
 *  - dry-run by DEFAULT; pass --commit to write. Dry-run prints the full plan.
 *
 * Usage — run from the server workspace (tsx resolves the intra-workspace imports):
 *   node --import tsx src/scripts/replay-synchub-relay-orphans.ts            # dry-run (default)
 *   node --import tsx src/scripts/replay-synchub-relay-orphans.ts --commit   # apply
 */

export type ReplayMode = "dry-run" | "commit";

export function parseReplayArgs(argv = process.argv): { mode: ReplayMode } {
  const args = argv.slice(2);
  const hasCommit = args.includes("--commit");
  const hasDryRun = args.includes("--dry-run");
  if (hasCommit && hasDryRun) {
    throw new Error("Choose exactly one of --dry-run or --commit");
  }
  return { mode: hasCommit ? "commit" : "dry-run" };
}

/** Minimal query surface so the runner can be driven by a PGlite-backed client in tests. */
export interface QueryClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export interface OpenOrphan {
  id: string;
  projectNumber: string;
  portfolioProjectId: string;
  projectName: string | null;
  rawPayload: unknown;
}

export async function fetchOpenOrphans(client: QueryClient): Promise<OpenOrphan[]> {
  const { rows } = await client.query(
    `SELECT id::text AS id,
            project_number,
            procore_portfolio_project_id,
            project_name,
            raw_payload
       FROM public.synchub_webhook_orphans
      WHERE status = 'open'
      ORDER BY received_at ASC, id ASC`
  );
  return rows.map((row) => ({
    id: String(row.id),
    projectNumber: String(row.project_number ?? ""),
    portfolioProjectId: String(row.procore_portfolio_project_id ?? ""),
    projectName: row.project_name == null ? null : String(row.project_name),
    rawPayload: row.raw_payload,
  }));
}

export type OrphanDisposition =
  | "would_link"
  | "linked"
  | "already_linked"
  | "skipped_no_match"
  | "skipped_ambiguous"
  | "skipped_conflict"
  | "error";

export interface OrphanOutcome {
  orphanId: string;
  projectNumber: string;
  portfolioProjectId: string;
  disposition: OrphanDisposition;
  dealId?: string;
  officeId?: string;
  matchCount?: number;
  error?: string;
}

export interface ReplayReport {
  mode: ReplayMode;
  total: number;
  counts: Record<OrphanDisposition, number>;
  outcomes: OrphanOutcome[];
}

function emptyCounts(): Record<OrphanDisposition, number> {
  return {
    would_link: 0,
    linked: 0,
    already_linked: 0,
    skipped_no_match: 0,
    skipped_ambiguous: 0,
    skipped_conflict: 0,
    error: 0,
  };
}

async function markOrphanResolved(client: QueryClient, orphanId: string, now: Date): Promise<void> {
  await client.query(
    `UPDATE public.synchub_webhook_orphans
        SET status = 'resolved', resolved_at = $2
      WHERE id = $1 AND status = 'open'`,
    [orphanId, now]
  );
}

async function reopenOrphan(client: QueryClient, orphanId: string): Promise<void> {
  await client.query(
    `UPDATE public.synchub_webhook_orphans
        SET status = 'open', resolved_at = NULL
      WHERE id = $1 AND status = 'resolved'`,
    [orphanId]
  );
}

export async function replayOrphans(
  client: QueryClient,
  opts: {
    mode: ReplayMode;
    now?: Date;
    /** Injectable for tests; defaults to the real, fixed relay. */
    relay?: (input: unknown, deps: { client: QueryClient }) => Promise<SyncHubRelayResult>;
  }
): Promise<ReplayReport> {
  const relay = opts.relay ?? ((input, deps) => processSyncHubProcoreProjectCreated(input, deps));
  const now = opts.now ?? new Date();
  const offices = await getActiveOffices(client as any);
  const orphans = await fetchOpenOrphans(client);
  const counts = emptyCounts();
  const outcomes: OrphanOutcome[] = [];

  for (const orphan of orphans) {
    const base = {
      orphanId: orphan.id,
      projectNumber: orphan.projectNumber,
      portfolioProjectId: orphan.portfolioProjectId,
    };
    // Tracks whether we flipped this orphan to 'resolved' before the relay call, so a THROWN relay
    // error (invalid payload, DB/audit/job failure) re-opens it in the catch — otherwise a failed
    // backfill would stay 'resolved' and be hidden from subsequent runs.
    let markedResolved = false;
    try {
      // Preview with the SAME resolver the relay uses. Only an exact single match is replayed, so a
      // still-unresolvable orphan is never re-run (and can never spawn a duplicate orphan row).
      const matches = await findDealsByProjectNumber(client as any, offices, orphan.projectNumber);
      if (matches.length === 0) {
        counts.skipped_no_match += 1;
        outcomes.push({ ...base, disposition: "skipped_no_match" });
        continue;
      }
      if (matches.length > 1) {
        counts.skipped_ambiguous += 1;
        outcomes.push({ ...base, disposition: "skipped_ambiguous", matchCount: matches.length });
        continue;
      }

      const target = matches[0];

      // The single match is already linked to a DIFFERENT Procore project: the relay would reject this
      // as `matched_deal_has_different_procore_project` and file a fresh orphan. Skip it and leave the
      // orphan open for a human — never replay a conflicting link.
      if (target.procoreProjectId != null && String(target.procoreProjectId) !== orphan.portfolioProjectId) {
        counts.skipped_conflict += 1;
        outcomes.push({ ...base, disposition: "skipped_conflict", dealId: target.dealId, officeId: target.officeId });
        continue;
      }

      if (opts.mode === "dry-run") {
        counts.would_link += 1;
        outcomes.push({ ...base, disposition: "would_link", dealId: target.dealId, officeId: target.officeId });
        continue;
      }

      // Mark THIS orphan resolved BEFORE replaying. The relay's open-orphan dedup
      // (findExistingOrphanBySyncHubLogId, status='open') would otherwise find the very row we're
      // replaying — 7 of 8 prod orphans carry synchub.webhookLogId — and short-circuit to
      // `duplicate_orphan` before ever reaching the fixed matcher. Preview guaranteed a single,
      // non-conflicting match, so the relay links (procore_project_id null) or already_linked (same
      // project); it never files a new orphan. Re-open on any unexpected result so nothing is lost.
      await markOrphanResolved(client, orphan.id, now);
      markedResolved = true;
      const result = await relay(orphan.rawPayload, { client });
      if (result.status === "linked" || result.status === "already_linked") {
        counts[result.status] += 1;
        outcomes.push({ ...base, disposition: result.status, dealId: result.dealId, officeId: result.officeId });
      } else {
        await reopenOrphan(client, orphan.id);
        markedResolved = false;
        counts.error += 1;
        outcomes.push({ ...base, disposition: "error", error: `relay returned ${result.status} after resolve` });
      }
    } catch (err) {
      // If we already flipped it to 'resolved' but the relay threw, re-open so the failed backfill
      // isn't silently hidden from re-runs (best-effort; don't mask the original error).
      if (markedResolved) await reopenOrphan(client, orphan.id).catch(() => {});
      counts.error += 1;
      outcomes.push({ ...base, disposition: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { mode: opts.mode, total: orphans.length, counts, outcomes };
}

function resolveDatabaseUrl(): string {
  const url =
    process.env.CRM_DATABASE_URL?.trim() ||
    process.env.DATABASE_PUBLIC_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    "";
  if (!url) {
    throw new Error("Missing database URL. Set CRM_DATABASE_URL, DATABASE_PUBLIC_URL, or DATABASE_URL.");
  }
  return url;
}

function printReport(report: ReplayReport): void {
  console.log(`[synchub-orphan-replay] mode=${report.mode} | open orphans: ${report.total}`);
  for (const o of report.outcomes) {
    const detail =
      o.disposition === "skipped_ambiguous"
        ? ` (matched ${o.matchCount} deals)`
        : o.disposition === "error"
          ? ` (${o.error})`
          : o.dealId
            ? ` → deal ${o.dealId} [office ${o.officeId}]`
            : "";
    console.log(`  ${o.projectNumber} [portfolio ${o.portfolioProjectId}]: ${o.disposition}${detail}`);
  }
  const c = report.counts;
  const linkedLabel = report.mode === "commit" ? `linked=${c.linked} alreadyLinked=${c.already_linked}` : `wouldLink=${c.would_link}`;
  console.log(
    `[synchub-orphan-replay] ${linkedLabel} | skipped: noMatch=${c.skipped_no_match} ambiguous=${c.skipped_ambiguous} conflict=${c.skipped_conflict} | errors=${c.error}`
  );
  if (report.mode !== "commit") {
    console.log("[synchub-orphan-replay] dry-run only — re-run with --commit to apply.");
  }
}

export async function main(argv = process.argv): Promise<void> {
  const { mode } = parseReplayArgs(argv);
  // No explicit `ssl` object — let the connection string dictate TLS (sslmode=...), mirroring the
  // repo's read-only prod runner (scripts/run-sql.cjs). Passing { rejectUnauthorized: false } would
  // silently disable certificate verification and can also be overridden by the connection string.
  const client = new pg.Client({ connectionString: resolveDatabaseUrl() });
  await client.connect();
  try {
    const report = await replayOrphans(client as unknown as QueryClient, { mode });
    printReport(report);
  } finally {
    await client.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  main().catch((error) => {
    console.error("[synchub-orphan-replay] failed:", error);
    process.exit(1);
  });
}
