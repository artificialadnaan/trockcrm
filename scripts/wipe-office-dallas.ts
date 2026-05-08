import "dotenv/config";

import pg from "pg";
import { printDbTarget } from "./lib/db-safety.js";

const TABLES = [
  "activities",
  "deal_stage_history",
  "lead_stage_history",
  "deal_history",
  "contact_deal_associations",
  "deal_team_members",
  "deal_forecast_milestones",
  "deal_signed_commissions",
  "deal_payment_events",
  "lead_question_answers",
  "lead_question_answer_history",
  "lead_qualification",
  "lead_scoping_intake",
  "lead_due_diligence_approvals",
  "deal_scoping_intake",
  "deal_approvals",
  "deal_department_handoffs",
  "deals",
  "leads",
  "contacts",
  "properties",
  "companies",
  "cleanup_skips",
  "cleanup_assignments",
  "emails",
] as const;

const USER_RELATED_PUBLIC_TABLES = [
  "user_external_identities",
  "hubspot_owner_mappings",
  "user_office_access",
  "user_commission_settings",
  "user_local_auth",
  "user_local_auth_events",
  "user_graph_tokens",
  "notification_recipient_groups",
  "saved_reports",
] as const;

async function tableExists(client: pg.Client, schema: string, table: string) {
  const result = await client.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`${schema}.${table}`],
  );
  return result.rows[0]?.exists === true;
}

async function tableCount(client: pg.Client, schema: string, table: string) {
  if (!(await tableExists(client, schema, table))) return null;
  const result = await client.query<{ count: string }>(`SELECT count(*)::int AS count FROM ${schema}.${table}`);
  return Number(result.rows[0]?.count ?? 0);
}

async function collectCounts(client: pg.Client) {
  const officeDallas: Record<string, number | null> = {};
  for (const table of TABLES) officeDallas[table] = await tableCount(client, "office_dallas", table);
  const publicCounts: Record<string, number | null> = {
    users: await tableCount(client, "public", "users"),
  };
  for (const table of USER_RELATED_PUBLIC_TABLES) publicCounts[table] = await tableCount(client, "public", table);
  return { officeDallas, public: publicCounts };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  printDbTarget(databaseUrl, "wipe-office-dallas");

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const before = await collectCounts(client);
    await client.query("BEGIN");

    const officeTables = [];
    for (const table of TABLES) {
      if (await tableExists(client, "office_dallas", table)) officeTables.push(`office_dallas.${table}`);
    }
    if (officeTables.length > 0) {
      await client.query(`TRUNCATE TABLE ${officeTables.join(", ")} RESTART IDENTITY CASCADE`);
    }

    const publicTables = [];
    for (const table of USER_RELATED_PUBLIC_TABLES) {
      if (await tableExists(client, "public", table)) publicTables.push(`public.${table}`);
    }
    if (await tableExists(client, "public", "users")) publicTables.push("public.users");
    if (publicTables.length > 0) {
      await client.query(`TRUNCATE TABLE ${publicTables.join(", ")} RESTART IDENTITY CASCADE`);
    }

    const after = await collectCounts(client);
    await client.query("COMMIT");

    console.log(JSON.stringify({ before, after }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
