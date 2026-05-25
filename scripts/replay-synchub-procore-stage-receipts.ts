import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Mode = "dry-run" | "commit";

type Args = {
  mode: Mode;
  limit: number;
};

const USAGE = `Usage:
  node --import tsx scripts/replay-synchub-procore-stage-receipts.ts --dry-run [--limit=100]
  node --import tsx scripts/replay-synchub-procore-stage-receipts.ts --commit [--limit=100]

Exactly one mode flag is required. --commit reprocesses unresolved SyncHub Procore stage-change receipts.`;

function parseArgs(argv: string[]): Args {
  const hasDryRun = argv.includes("--dry-run");
  const hasCommit = argv.includes("--commit");
  if ([hasDryRun, hasCommit].filter(Boolean).length !== 1) {
    throw new Error(`Specify exactly one of --dry-run or --commit.\n${USAGE}`);
  }

  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : 100;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) {
    throw new Error("--limit must be an integer between 1 and 1000");
  }

  return {
    mode: hasCommit ? "commit" : "dry-run",
    limit,
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
      break;
    }
  }
  dotenv.config();

  const publicUrl = process.env.DATABASE_PUBLIC_URL?.trim();
  const currentUrl = process.env.DATABASE_URL?.trim();
  if (publicUrl && (!currentUrl || /railway\.internal/.test(currentUrl))) {
    process.env.DATABASE_URL = publicUrl;
  }
}

export async function runReplaySyncHubProcoreStageReceipts(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  loadEnv();

  const { replayUnresolvedSyncHubProcoreProjectStageReceipts } = await import(
    "../server/src/modules/synchub/procore-project-stage-relay-service.js"
  );
  const { pool } = await import("../server/src/db.js");

  try {
    const result = await replayUnresolvedSyncHubProcoreProjectStageReceipts({
      commit: args.mode === "commit",
      limit: args.limit,
    });

    console.log(JSON.stringify({
      mode: result.mode,
      scanned: result.scanned,
      wouldReplay: result.wouldReplay,
      replayed: result.replayed,
      stillUnresolved: result.stillUnresolved,
      duplicates: result.duplicates,
      failed: result.failed,
      results: result.results,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  runReplaySyncHubProcoreStageReceipts().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
