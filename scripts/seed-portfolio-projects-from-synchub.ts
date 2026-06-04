import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import {
  resolveSyncHubDatabaseUrl,
  runPortfolioProjectValueRefresh,
  runPortfolioProjectsSeed,
  type Mode,
} from "../server/src/modules/synchub/portfolio-projects-sync.js";

// The seed/refresh core now lives in server/src/modules/synchub/portfolio-projects-sync.ts
// so the worker cron can dynamic-import the compiled module. This script stays the manual
// CLI entry point AND re-exports the core for back-compat with existing importers/tests.
export * from "../server/src/modules/synchub/portfolio-projects-sync.js";

type Action = "seed" | "refresh-values";

type Args = {
  mode: Mode;
  action: Action;
  limit: number | null;
};

const USAGE = `Usage:
  node --import tsx scripts/seed-portfolio-projects-from-synchub.ts --dry-run [--limit=1000]
  node --import tsx scripts/seed-portfolio-projects-from-synchub.ts --commit [--limit=1000]
  node --import tsx scripts/seed-portfolio-projects-from-synchub.ts --refresh-values --dry-run [--limit=1000]
  node --import tsx scripts/seed-portfolio-projects-from-synchub.ts --refresh-values --commit [--limit=1000]

Exactly one mode flag is required.

Connection strings:
  CRM: CRM_DATABASE_URL, or DATABASE_PUBLIC_URL from the CRM .env.
  SyncHub: SYNCHUB_DATABASE_PUBLIC_URL / SYNCHUB_DATABASE_URL, or Railway-injected
           DATABASE_PUBLIC_URL / DATABASE_URL when RAILWAY_PROJECT_NAME is T-Rock-Sync-Hub.`;

function parseArgs(argv: string[]): Args {
  const hasDryRun = argv.includes("--dry-run");
  const hasCommit = argv.includes("--commit");
  if ([hasDryRun, hasCommit].filter(Boolean).length !== 1) {
    throw new Error(`Specify exactly one of --dry-run or --commit.\n${USAGE}`);
  }
  const action: Action = argv.includes("--refresh-values") ? "refresh-values" : "seed";

  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : null;
  if (limit != null && (!Number.isInteger(limit) || limit <= 0 || limit > 10_000)) {
    throw new Error("--limit must be an integer between 1 and 10000");
  }

  return {
    mode: hasCommit ? "commit" : "dry-run",
    action,
    limit,
  };
}

function findCrmEnvPath() {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../..", ".env"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function readCrmEnvFile() {
  const envPath = findCrmEnvPath();
  if (!envPath) return {};
  return dotenv.parse(fs.readFileSync(envPath));
}

function resolveConnectionStrings(crmEnv: Record<string, string>) {
  const crmDatabaseUrl =
    process.env.CRM_DATABASE_URL?.trim()
    || crmEnv.DATABASE_PUBLIC_URL?.trim()
    || crmEnv.CRM_DATABASE_URL?.trim()
    || "";

  const syncHubDatabaseUrl = resolveSyncHubDatabaseUrl();

  if (!crmDatabaseUrl) {
    throw new Error("Missing CRM database URL. Set CRM_DATABASE_URL or ensure CRM .env has DATABASE_PUBLIC_URL.");
  }
  if (!syncHubDatabaseUrl) {
    throw new Error(
      "Missing SyncHub database URL. Set SYNCHUB_DATABASE_PUBLIC_URL/SYNCHUB_DATABASE_URL, "
      + "or run this script under Railway against the T-Rock-Sync-Hub Postgres service."
    );
  }
  if (crmDatabaseUrl === syncHubDatabaseUrl) {
    throw new Error("CRM and SyncHub database URLs resolved to the same value; refusing to run.");
  }

  return { crmDatabaseUrl, syncHubDatabaseUrl };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const crmEnv = readCrmEnvFile();
  const { crmDatabaseUrl, syncHubDatabaseUrl } = resolveConnectionStrings(crmEnv);

  const crmClient = new Client({
    connectionString: crmDatabaseUrl,
    ssl: { rejectUnauthorized: false },
  });
  const syncHubClient = new Client({
    connectionString: syncHubDatabaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  await syncHubClient.connect();
  await crmClient.connect();
  try {
    const result = args.action === "refresh-values"
      ? await runPortfolioProjectValueRefresh({
        mode: args.mode,
        limit: args.limit,
        crmClient,
        syncHubClient,
      })
      : await runPortfolioProjectsSeed({
        mode: args.mode,
        limit: args.limit,
        crmClient,
        syncHubClient,
      });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await crmClient.end();
    await syncHubClient.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
