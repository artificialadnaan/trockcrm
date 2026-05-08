import "dotenv/config";

import pg from "pg";
import { assertWriteAllowed } from "./lib/db-safety.js";

const ADMIN_USER_ID = "1cc88c3f-a5f9-5f97-857c-73d97ac0762e";

function assertTenantSchema(value: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe tenant schema: ${value}`);
  return value;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  assertWriteAllowed(databaseUrl, process.argv, "cleanup:assignments");

  const tenantArg = process.argv.find((arg) => arg.startsWith("--tenant="));
  const tenant = assertTenantSchema(tenantArg?.split("=")[1] ?? "office_dallas");
  const client = new pg.Client({ connectionString: databaseUrl });

  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM ${tenant}.cleanup_assignments`);

    const inserts: Record<string, string> = {
      deals: `
        INSERT INTO ${tenant}.cleanup_assignments (
          record_type, record_id, assigned_to, assignment_reason, source_hubspot_owner_id, source_hubspot_owner_email
        )
        SELECT
          'deal',
          id,
          COALESCE(assigned_rep_id, $1::uuid),
          CASE WHEN assigned_rep_id IS NULL THEN 'admin_queue_unassigned_owner' ELSE 'deal_owner' END,
          hubspot_owner_id,
          hubspot_owner_email
        FROM ${tenant}.deals
        ON CONFLICT (record_type, record_id) DO UPDATE SET
          assigned_to = EXCLUDED.assigned_to,
          assignment_reason = EXCLUDED.assignment_reason,
          source_hubspot_owner_id = EXCLUDED.source_hubspot_owner_id,
          source_hubspot_owner_email = EXCLUDED.source_hubspot_owner_email,
          updated_at = now()
      `,
      leads: `
        INSERT INTO ${tenant}.cleanup_assignments (
          record_type, record_id, assigned_to, assignment_reason, source_hubspot_owner_id, source_hubspot_owner_email
        )
        SELECT
          'lead',
          id,
          COALESCE(assigned_rep_id, $1::uuid),
          CASE WHEN assigned_rep_id IS NULL THEN 'admin_queue_unassigned_owner' ELSE 'lead_owner' END,
          hubspot_owner_id,
          hubspot_owner_email
        FROM ${tenant}.leads
        ON CONFLICT (record_type, record_id) DO UPDATE SET
          assigned_to = EXCLUDED.assigned_to,
          assignment_reason = EXCLUDED.assignment_reason,
          source_hubspot_owner_id = EXCLUDED.source_hubspot_owner_id,
          source_hubspot_owner_email = EXCLUDED.source_hubspot_owner_email,
          updated_at = now()
      `,
      contacts: `
        WITH ranked AS (
          SELECT
            c.id AS record_id,
            COALESCE(d.assigned_rep_id, l.assigned_rep_id, $1::uuid) AS assigned_to,
            COALESCE(d.hubspot_owner_id, l.hubspot_owner_id) AS source_hubspot_owner_id,
            COALESCE(d.hubspot_owner_email, l.hubspot_owner_email) AS source_hubspot_owner_email,
            CASE
              WHEN d.assigned_rep_id IS NOT NULL THEN 'inherited_from_deal'
              WHEN l.assigned_rep_id IS NOT NULL THEN 'inherited_from_lead'
              ELSE 'admin_queue_orphan_contact'
            END AS assignment_reason,
            row_number() OVER (
              PARTITION BY c.id
              ORDER BY
                CASE WHEN d.assigned_rep_id IS NOT NULL THEN 0 WHEN l.assigned_rep_id IS NOT NULL THEN 1 ELSE 2 END,
                COALESCE(d.updated_at, l.updated_at, c.updated_at, c.created_at) DESC NULLS LAST
            ) AS rank
          FROM ${tenant}.contacts c
          LEFT JOIN ${tenant}.deals d ON d.primary_contact_id = c.id
          LEFT JOIN ${tenant}.leads l ON l.primary_contact_id = c.id
        )
        INSERT INTO ${tenant}.cleanup_assignments (
          record_type, record_id, assigned_to, assignment_reason, source_hubspot_owner_id, source_hubspot_owner_email
        )
        SELECT 'contact', record_id, assigned_to, assignment_reason, source_hubspot_owner_id, source_hubspot_owner_email
        FROM ranked
        WHERE rank = 1
        ON CONFLICT (record_type, record_id) DO UPDATE SET
          assigned_to = EXCLUDED.assigned_to,
          assignment_reason = EXCLUDED.assignment_reason,
          source_hubspot_owner_id = EXCLUDED.source_hubspot_owner_id,
          source_hubspot_owner_email = EXCLUDED.source_hubspot_owner_email,
          updated_at = now()
      `,
      companies: `
        WITH ranked AS (
          SELECT
            c.id AS record_id,
            COALESCE(d.assigned_rep_id, l.assigned_rep_id, $1::uuid) AS assigned_to,
            COALESCE(d.hubspot_owner_id, l.hubspot_owner_id) AS source_hubspot_owner_id,
            COALESCE(d.hubspot_owner_email, l.hubspot_owner_email) AS source_hubspot_owner_email,
            CASE
              WHEN d.assigned_rep_id IS NOT NULL THEN 'inherited_from_deal'
              WHEN l.assigned_rep_id IS NOT NULL THEN 'inherited_from_lead'
              ELSE 'admin_queue_orphan_company'
            END AS assignment_reason,
            row_number() OVER (
              PARTITION BY c.id
              ORDER BY
                CASE WHEN d.assigned_rep_id IS NOT NULL THEN 0 WHEN l.assigned_rep_id IS NOT NULL THEN 1 ELSE 2 END,
                COALESCE(d.updated_at, l.updated_at, c.updated_at, c.created_at) DESC NULLS LAST
            ) AS rank
          FROM ${tenant}.companies c
          LEFT JOIN ${tenant}.deals d ON d.company_id = c.id
          LEFT JOIN ${tenant}.leads l ON l.company_id = c.id
        )
        INSERT INTO ${tenant}.cleanup_assignments (
          record_type, record_id, assigned_to, assignment_reason, source_hubspot_owner_id, source_hubspot_owner_email
        )
        SELECT 'company', record_id, assigned_to, assignment_reason, source_hubspot_owner_id, source_hubspot_owner_email
        FROM ranked
        WHERE rank = 1
        ON CONFLICT (record_type, record_id) DO UPDATE SET
          assigned_to = EXCLUDED.assigned_to,
          assignment_reason = EXCLUDED.assignment_reason,
          source_hubspot_owner_id = EXCLUDED.source_hubspot_owner_id,
          source_hubspot_owner_email = EXCLUDED.source_hubspot_owner_email,
          updated_at = now()
      `,
    };

    const results: Record<string, number> = {};
    for (const [name, sql] of Object.entries(inserts)) {
      const result = await client.query(sql, [ADMIN_USER_ID]);
      results[name] = result.rowCount ?? 0;
    }

    await client.query("COMMIT");
    console.log(JSON.stringify({ tenant, inserted: results }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
