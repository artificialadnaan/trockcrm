import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@trock-crm/shared/schema";
import { companies, contacts, deals, leads } from "@trock-crm/shared/schema";
import { offices } from "../shared/src/schema/public/offices.js";
import {
  refreshEntityEmailStats,
  type EmailStatsEntityType,
} from "../server/src/modules/email/stats-service.js";

export interface RecomputeArgs {
  office: string;
  entityType: EmailStatsEntityType | null;
  entityId: string | null;
  all: boolean;
}

export interface RecomputeReport {
  office: string;
  entityType: EmailStatsEntityType | "all";
  processedEntities: number;
}

type DefaultDb = ReturnType<typeof drizzle<typeof schema>>;

type Connections = {
  publicDb: DefaultDb;
  tenantDb: DefaultDb;
  close: () => Promise<void>;
};

type RecomputeDeps = {
  createConnections: (officeSchema: string) => Promise<Connections>;
  validateOffice: (
    publicDb: DefaultDb,
    officeSchema: string
  ) => Promise<{ schemaName: string; officeSlug: string; officeId: string }>;
  listEntityIds: (tenantDb: DefaultDb, entityType: EmailStatsEntityType) => Promise<string[]>;
  entityExists: (
    tenantDb: DefaultDb,
    entityType: EmailStatsEntityType,
    entityId: string
  ) => Promise<boolean>;
  refreshEntityEmailStats: typeof refreshEntityEmailStats;
};

export function parseRecomputeEmailStatsArgs(argv: string[]): RecomputeArgs {
  let office: string | null = null;
  let entityType: EmailStatsEntityType | null = null;
  let entityId: string | null = null;
  let all = false;

  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--office=")) office = arg.slice("--office=".length);
    else if (arg.startsWith("--entity-type=")) entityType = arg.slice("--entity-type=".length) as EmailStatsEntityType;
    else if (arg.startsWith("--entity-id=")) entityId = arg.slice("--entity-id=".length);
    else if (arg === "--all") all = true;
  }

  if (!office) throw new Error("--office is required");
  if (all && (entityType || entityId)) {
    throw new Error("--all cannot be combined with --entity-type or --entity-id");
  }
  if (!all && (!entityType || !entityId)) {
    throw new Error("Provide either --all or both --entity-type and --entity-id");
  }
  if (
    entityType &&
    entityType !== "deal" &&
    entityType !== "company" &&
    entityType !== "contact" &&
    entityType !== "lead"
  ) {
    throw new Error(`Invalid --entity-type value: ${entityType}`);
  }

  return { office, entityType, entityId, all };
}

async function defaultCreateConnections(officeSchema: string): Promise<Connections> {
  const connectionString = process.env.DATABASE_URL ?? process.env.DATABASE_PUBLIC_URL;
  if (!connectionString) throw new Error("DATABASE_URL or DATABASE_PUBLIC_URL is required");
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query("SELECT set_config('search_path', $1, false)", [`${officeSchema},public`]);
  const db = drizzle(client, { schema });
  return {
    publicDb: db,
    tenantDb: db,
    close: async () => {
      await client.end();
    },
  };
}

async function defaultValidateOffice(publicDb: DefaultDb, officeSchema: string) {
  if (!/^office_[a-z][a-z0-9_]*$/.test(officeSchema)) throw new Error(`Invalid office schema: ${officeSchema}`);
  const officeSlug = officeSchema.slice("office_".length);
  const rows = await publicDb
    .select({ id: offices.id, slug: offices.slug })
    .from(offices)
    .where(and(eq(offices.slug, officeSlug), eq(offices.isActive, true)))
    .limit(1);
  if (!rows[0]) throw new Error(`Unknown or inactive office schema: ${officeSchema}`);
  return { schemaName: officeSchema, officeSlug, officeId: rows[0].id };
}

async function defaultListEntityIds(tenantDb: DefaultDb, entityType: EmailStatsEntityType) {
  if (entityType === "deal") {
    return (await tenantDb.select({ id: deals.id }).from(deals)).map((row) => row.id);
  }
  if (entityType === "company") {
    return (await tenantDb.select({ id: companies.id }).from(companies)).map((row) => row.id);
  }
  if (entityType === "contact") {
    return (await tenantDb.select({ id: contacts.id }).from(contacts)).map((row) => row.id);
  }
  return (await tenantDb.select({ id: leads.id }).from(leads)).map((row) => row.id);
}

async function defaultEntityExists(
  tenantDb: DefaultDb,
  entityType: EmailStatsEntityType,
  entityId: string
) {
  if (entityType === "deal") {
    return (
      (
        await tenantDb.select({ id: deals.id }).from(deals).where(eq(deals.id, entityId)).limit(1)
      ).length > 0
    );
  }
  if (entityType === "company") {
    return (
      (
        await tenantDb.select({ id: companies.id }).from(companies).where(eq(companies.id, entityId)).limit(1)
      ).length > 0
    );
  }
  if (entityType === "contact") {
    return (
      (
        await tenantDb.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, entityId)).limit(1)
      ).length > 0
    );
  }
  return (
    (
      await tenantDb.select({ id: leads.id }).from(leads).where(eq(leads.id, entityId)).limit(1)
    ).length > 0
  );
}

const defaultDeps: RecomputeDeps = {
  createConnections: defaultCreateConnections,
  validateOffice: defaultValidateOffice,
  listEntityIds: defaultListEntityIds,
  entityExists: defaultEntityExists,
  refreshEntityEmailStats,
};

export async function runRecomputeEmailStats(
  args: RecomputeArgs,
  deps: RecomputeDeps = defaultDeps
): Promise<RecomputeReport> {
  const connections = await deps.createConnections(args.office);
  try {
    await deps.validateOffice(connections.publicDb, args.office);

    if (args.all) {
      let processedEntities = 0;
      for (const entityType of ["deal", "company", "contact", "lead"] as const) {
        const entityIds = await deps.listEntityIds(connections.tenantDb, entityType);
        for (const entityId of entityIds) {
          await deps.refreshEntityEmailStats(connections.tenantDb, entityType, entityId);
        }
        processedEntities += entityIds.length;
      }
      return {
        office: args.office,
        entityType: "all",
        processedEntities,
      };
    }

    const exists = await deps.entityExists(connections.tenantDb, args.entityType!, args.entityId!);
    if (!exists) {
      throw new Error(`${args.entityType} ${args.entityId} was not found in ${args.office}`);
    }

    await deps.refreshEntityEmailStats(connections.tenantDb, args.entityType!, args.entityId!);
    return {
      office: args.office,
      entityType: args.entityType!,
      processedEntities: 1,
    };
  } finally {
    await connections.close();
  }
}

if (process.argv[1]?.endsWith("recompute-email-stats.ts") && !process.env.VITEST) {
  runRecomputeEmailStats(parseRecomputeEmailStatsArgs(process.argv))
    .then((report) => {
      console.log(
        `Recomputed email stats for ${report.processedEntities} ${report.entityType} ${
          report.processedEntities === 1 ? "entity" : "entities"
        } in ${report.office}`
      );
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
