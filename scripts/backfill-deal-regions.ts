import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  DEAL_REGION_DEFINITIONS,
  getDealRegionSlugForState,
  type DealRegionSlug,
} from "../shared/src/types/deal-regions.js";

const LEGACY_REGION_FALLBACK: Record<string, DealRegionSlug> = {
  texas: "central",
  southeast: "east_coast",
  east_coast: "east_coast",
};

const TARGET_REGION_IDS: Record<DealRegionSlug, string> = {
  west_coast: "22222222-2222-4222-8222-222222222222",
  central: "11111111-1111-4111-8111-111111111111",
  east_coast: "33333333-3333-4333-8333-333333333333",
};

type Mode = "dry-run" | "commit";

type QueryClient = Pick<pg.Client, "query">;

export type DealRegionRow = {
  id: string;
  slug: string;
  name: string;
  isActive: boolean;
};

export type DealRegionBackfillDeal = {
  schemaName: string;
  dealId: string;
  dealNumber: string;
  dealName: string;
  currentRegionId: string | null;
  currentRegionSlug: string | null;
  currentRegionName: string | null;
  propertyState: string | null;
  dealPropertyState: string | null;
};

export type DealRegionBackfillChange = DealRegionBackfillDeal & {
  source: "state" | "legacy_fallback";
  effectiveState: string | null;
  targetRegionSlug: DealRegionSlug;
  targetRegionId: string;
  targetRegionName: string;
};

export type DealRegionBackfillPlan = {
  counts: {
    totalDeals: number;
    withUsableState: number;
    withoutUsableState: number;
    willUpdate: number;
    unchanged: number;
    leftBlankNoState: number;
    oldRegionRows: number;
    oldRegionRowsUpdatedByState: number;
    oldRegionRowsUpdatedByFallback: number;
    unmappedState: number;
    missingTargetRegion: number;
  };
  bySchema: Record<string, { totalDeals: number; willUpdate: number; leftBlankNoState: number }>;
  targetRegions: Record<DealRegionSlug, { id: string; name: string; existsInDatabase: boolean }>;
  changes: DealRegionBackfillChange[];
  unmappedStates: DealRegionBackfillDeal[];
  missingTargetRegions: Array<{ dealId: string; schemaName: string; targetRegionSlug: DealRegionSlug }>;
};

export type DealRegionBackfillReport = {
  mode: Mode;
  committed: boolean;
  plan: DealRegionBackfillPlan;
  updatedRows: number;
};

function parseArgs(argv = process.argv.slice(2)): { mode: Mode } {
  const hasDryRun = argv.includes("--dry-run");
  const hasCommit = argv.includes("--commit");
  if ([hasDryRun, hasCommit].filter(Boolean).length !== 1) {
    throw new Error("Specify exactly one of --dry-run or --commit");
  }
  return { mode: hasCommit ? "commit" : "dry-run" };
}

function findCrmEnvPath() {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../..", ".env"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function loadEnv() {
  const envPath = findCrmEnvPath();
  if (envPath) dotenv.config({ path: envPath });
  dotenv.config();
}

function resolveDatabaseUrl() {
  const url = process.env.CRM_DATABASE_URL?.trim() || process.env.DATABASE_PUBLIC_URL?.trim() || "";
  if (!url) throw new Error("Missing CRM database URL. Set CRM_DATABASE_URL or DATABASE_PUBLIC_URL.");
  return url;
}

function quoteIdent(identifier: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid identifier: ${identifier}`);
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

function effectiveState(deal: DealRegionBackfillDeal) {
  return (deal.propertyState?.trim() || deal.dealPropertyState?.trim() || null)?.toUpperCase() ?? null;
}

function targetName(slug: DealRegionSlug) {
  return DEAL_REGION_DEFINITIONS.find((region) => region.slug === slug)?.name ?? slug;
}

function ensureSchemaBucket(plan: DealRegionBackfillPlan, schemaName: string) {
  plan.bySchema[schemaName] ??= { totalDeals: 0, willUpdate: 0, leftBlankNoState: 0 };
  return plan.bySchema[schemaName];
}

export function buildDealRegionBackfillPlan(input: {
  deals: DealRegionBackfillDeal[];
  regions: DealRegionRow[];
}): DealRegionBackfillPlan {
  const regionsBySlug = new Map(input.regions.map((region) => [region.slug, region]));
  const targetRegions = Object.fromEntries(
    DEAL_REGION_DEFINITIONS.map((definition) => {
      const row = regionsBySlug.get(definition.slug);
      return [
        definition.slug,
        {
          id: row?.id ?? TARGET_REGION_IDS[definition.slug],
          name: definition.name,
          existsInDatabase: Boolean(row),
        },
      ];
    })
  ) as DealRegionBackfillPlan["targetRegions"];

  const plan: DealRegionBackfillPlan = {
    counts: {
      totalDeals: 0,
      withUsableState: 0,
      withoutUsableState: 0,
      willUpdate: 0,
      unchanged: 0,
      leftBlankNoState: 0,
      oldRegionRows: 0,
      oldRegionRowsUpdatedByState: 0,
      oldRegionRowsUpdatedByFallback: 0,
      unmappedState: 0,
      missingTargetRegion: 0,
    },
    bySchema: {},
    targetRegions,
    changes: [],
    unmappedStates: [],
    missingTargetRegions: [],
  };

  for (const deal of input.deals) {
    plan.counts.totalDeals += 1;
    const bucket = ensureSchemaBucket(plan, deal.schemaName);
    bucket.totalDeals += 1;

    const currentSlug = deal.currentRegionSlug ?? null;
    const hasOldRegion = currentSlug === "texas" || currentSlug === "southeast" || currentSlug === "east_coast";
    if (hasOldRegion) plan.counts.oldRegionRows += 1;

    const state = effectiveState(deal);
    const stateRegionSlug = getDealRegionSlugForState(state);
    let targetSlug: DealRegionSlug | null = null;
    let source: DealRegionBackfillChange["source"] | null = null;

    if (state) {
      if (stateRegionSlug) {
        plan.counts.withUsableState += 1;
        targetSlug = stateRegionSlug;
        source = "state";
      } else {
        plan.counts.unmappedState += 1;
        plan.unmappedStates.push(deal);
      }
    } else {
      plan.counts.withoutUsableState += 1;
      if (currentSlug && LEGACY_REGION_FALLBACK[currentSlug]) {
        targetSlug = LEGACY_REGION_FALLBACK[currentSlug];
        source = "legacy_fallback";
      } else if (!deal.currentRegionId) {
        plan.counts.leftBlankNoState += 1;
        bucket.leftBlankNoState += 1;
      }
    }

    if (!targetSlug || !source) {
      plan.counts.unchanged += 1;
      continue;
    }

    const target = targetRegions[targetSlug];
    if (!target.existsInDatabase) {
      plan.counts.missingTargetRegion += 1;
      plan.missingTargetRegions.push({ dealId: deal.dealId, schemaName: deal.schemaName, targetRegionSlug: targetSlug });
    }

    if (deal.currentRegionId === target.id) {
      plan.counts.unchanged += 1;
      continue;
    }

    const change: DealRegionBackfillChange = {
      ...deal,
      source,
      effectiveState: state,
      targetRegionSlug: targetSlug,
      targetRegionId: target.id,
      targetRegionName: targetName(targetSlug),
    };
    plan.changes.push(change);
    plan.counts.willUpdate += 1;
    bucket.willUpdate += 1;
    if (hasOldRegion && source === "state") plan.counts.oldRegionRowsUpdatedByState += 1;
    if (hasOldRegion && source === "legacy_fallback") plan.counts.oldRegionRowsUpdatedByFallback += 1;
  }

  return plan;
}

async function fetchOfficeSchemas(client: QueryClient): Promise<string[]> {
  const result = await client.query(
    `SELECT n.nspname AS schema_name
       FROM pg_namespace n
      WHERE n.nspname LIKE 'office\\_%' ESCAPE '\\'
        AND to_regclass(format('%I.deals', n.nspname)) IS NOT NULL
      ORDER BY n.nspname ASC`
  );
  return result.rows.map((row: { schema_name: string }) => row.schema_name);
}

async function fetchRegions(client: QueryClient): Promise<DealRegionRow[]> {
  const result = await client.query(
    "SELECT id::text, slug, name, is_active FROM public.region_config ORDER BY display_order ASC, name ASC"
  );
  return result.rows as DealRegionRow[];
}

async function fetchDealsForSchema(client: QueryClient, schemaName: string): Promise<DealRegionBackfillDeal[]> {
  const schema = quoteIdent(schemaName);
  const result = await client.query(
    `SELECT
        $1::text AS "schemaName",
        d.id::text AS "dealId",
        d.deal_number AS "dealNumber",
        d.name AS "dealName",
        d.region_id::text AS "currentRegionId",
        rc.slug AS "currentRegionSlug",
        rc.name AS "currentRegionName",
        p.state AS "propertyState",
        d.property_state AS "dealPropertyState"
       FROM ${schema}.deals d
       LEFT JOIN public.region_config rc ON rc.id = d.region_id
       LEFT JOIN ${schema}.properties p ON p.id = d.property_id
      ORDER BY d.deal_number ASC, d.id ASC`,
    [schemaName]
  );
  return result.rows as DealRegionBackfillDeal[];
}

async function updateDealRegion(input: {
  client: QueryClient;
  change: DealRegionBackfillChange;
}) {
  const schema = quoteIdent(input.change.schemaName);
  const result = await input.client.query(
    `UPDATE ${schema}.deals
        SET region_id = $1::uuid,
            updated_at = NOW()
      WHERE id = $2::uuid
        AND (region_id IS DISTINCT FROM $1::uuid)`,
    [input.change.targetRegionId, input.change.dealId]
  );
  return result.rowCount ?? 0;
}

export async function runDealRegionBackfill(input: {
  client: QueryClient;
  mode: Mode;
}): Promise<DealRegionBackfillReport> {
  const regions = await fetchRegions(input.client);
  const schemas = await fetchOfficeSchemas(input.client);
  const deals: DealRegionBackfillDeal[] = [];
  for (const schemaName of schemas) {
    const schemaDeals = await fetchDealsForSchema(input.client, schemaName);
    deals.push(...schemaDeals);
  }

  const plan = buildDealRegionBackfillPlan({ deals, regions });
  let updatedRows = 0;

  if (input.mode === "commit") {
    const missingTargetSlugs = DEAL_REGION_DEFINITIONS
      .filter((definition) => !plan.targetRegions[definition.slug].existsInDatabase)
      .map((definition) => definition.slug);
    if (missingTargetSlugs.length > 0) {
      throw new Error(`Missing target region rows: ${missingTargetSlugs.join(", ")}. Run migrations before --commit.`);
    }

    await input.client.query("BEGIN");
    try {
      for (const change of plan.changes) {
        updatedRows += await updateDealRegion({ client: input.client, change });
      }
      await input.client.query("COMMIT");
    } catch (error) {
      await input.client.query("ROLLBACK");
      throw error;
    }
  }

  return {
    mode: input.mode,
    committed: input.mode === "commit",
    plan,
    updatedRows,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  loadEnv();
  const client = new pg.Client({
    connectionString: resolveDatabaseUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const result = await runDealRegionBackfill({ client, mode: args.mode });
    console.log(JSON.stringify(result, null, 2));
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
