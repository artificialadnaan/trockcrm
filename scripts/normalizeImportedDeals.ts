import pg from "pg";
import dotenv from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { diffDealShapeFields } from "../server/src/services/dealShapeNormalization.js";

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

const DATABASE_URL = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required to diff and normalize imported deals.");
  process.exit(1);
}

const TENANT_SCHEMA = process.env.TENANT_SCHEMA ?? "office_dallas";
const dryRun = process.env.DRY_RUN !== "false";

const SELECT_FIELDS = `
  id,
  deal_number AS "dealNumber",
  name,
  stage_id AS "stageId",
  assigned_rep_id AS "assignedRepId",
  primary_contact_id AS "primaryContactId",
  company_id AS "companyId",
  property_id AS "propertyId",
  source_lead_id AS "sourceLeadId",
  dd_estimate AS "ddEstimate",
  bid_estimate AS "bidEstimate",
  awarded_amount AS "awardedAmount",
  change_order_total AS "changeOrderTotal",
  description,
  property_address AS "propertyAddress",
  property_city AS "propertyCity",
  property_state AS "propertyState",
  property_zip AS "propertyZip",
  project_type_id AS "projectTypeId",
  region_id AS "regionId",
  source,
  win_probability AS "winProbability",
  expected_close_date AS "expectedCloseDate",
  workflow_route AS "workflowRoute",
  pipeline_disposition AS "pipelineDisposition",
  is_bid_board_owned AS "isBidBoardOwned",
  is_read_only_mirror AS "isReadOnlyMirror",
  is_read_only_sync_dirty AS "isReadOnlySyncDirty",
  hubspot_deal_id AS "hubspotDealId",
  proposal_status AS "proposalStatus",
  proposal_revision_count AS "proposalRevisionCount",
  stage_entered_at AS "stageEnteredAt",
  is_active AS "isActive",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('search_path', $1, true)", [`${TENANT_SCHEMA},public`]);

    const newDeals = await client.query(`
      SELECT ${SELECT_FIELDS}
      FROM deals
      WHERE hubspot_deal_id IS NULL
      ORDER BY created_at DESC
      LIMIT 5
    `);
    const importedDeals = await client.query(`
      SELECT ${SELECT_FIELDS}
      FROM deals
      WHERE hubspot_deal_id IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 5
    `);

    if (newDeals.rows.length === 0 || importedDeals.rows.length === 0) {
      throw new Error(`Need at least one new CRM deal and one imported deal in ${TENANT_SCHEMA}`);
    }

    const diffRows = diffDealShapeFields(newDeals.rows[0], importedDeals.rows[0]);
    console.log("Field-level shape diff for sampled new CRM deal vs imported deal:");
    console.table(diffRows);

    const update = await client.query(`
      UPDATE deals
      SET
        workflow_route = COALESCE(workflow_route, 'normal'),
        pipeline_disposition = COALESCE(pipeline_disposition, 'deals'),
        change_order_total = COALESCE(change_order_total, 0),
        source = COALESCE(NULLIF(source, ''), 'HubSpot'),
        is_bid_board_owned = COALESCE(is_bid_board_owned, false),
        is_read_only_mirror = COALESCE(is_read_only_mirror, false),
        is_read_only_sync_dirty = COALESCE(is_read_only_sync_dirty, false),
        proposal_status = COALESCE(proposal_status, 'not_started'),
        proposal_revision_count = COALESCE(proposal_revision_count, 0),
        stage_entered_at = COALESCE(stage_entered_at, created_at, NOW()),
        is_active = COALESCE(is_active, true),
        updated_at = NOW()
      WHERE hubspot_deal_id IS NOT NULL
      RETURNING id, deal_number, hubspot_deal_id
    `);

    console.log(`${dryRun ? "Would normalize" : "Normalized"} ${update.rowCount ?? 0} imported deal rows.`);
    if (dryRun) {
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
