#!/usr/bin/env node

/*
 * One-off production operation for approved Bid Board rows that were excluded by
 * the junk/test heuristic. The approved row data is read from a private JSON
 * file so client export data is not committed to the repository.
 *
 * Required env:
 *   ENV_PATH=/Users/adnaaniqbal/Developer/trockcrm/.env
 *   APPROVED_ROWS_JSON=/private/tmp/bidboard-approved-excluded-rows.json
 *   FALLBACK_OWNER_EMAIL=<approved fallback owner email>
 * Optional env:
 *   HUBSPOT_CSV=/Users/adnaaniqbal/Developer/trockcrm/hubspot-crm-exports-all-deals-2026-05-22.csv
 *
 * Usage:
 *   node scripts/create-bidboard-excluded-real-projects.js --dry-run
 *   node scripts/create-bidboard-excluded-real-projects.js --commit
 */

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const APPROVED_PROJECT_NUMBERS = new Set(["1-PTW.1-101025", "DFW-6-06426-zz"]);
const ASSIGNMENT_REVIEW_REASON = "bid_board_import_assignment_review";
const SOURCE = "bid_board_import";
const SCHEMA = "office_dallas";

function loadEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  const contents = fs.readFileSync(filePath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function normalizeProjectNumber(value) {
  return String(value ?? "").trim().toLowerCase();
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`Missing required ${label}`);
  return text;
}

function moneyText(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) throw new Error(`Invalid numeric value: ${value}`);
  return num.toFixed(2);
}

function nullableText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function isoTimestamp(value) {
  const text = nullableText(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${value}`);
  return date.toISOString();
}

function dateOnly(value) {
  const text = nullableText(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date.toISOString().slice(0, 10);
}

function statusToStageSlug(status) {
  const normalized = String(status ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");

  if (normalized === "service estimating") return "service_estimating";
  if (normalized === "lost") return "lost";
  throw new Error(`This operation only approves Service - Estimating or Lost; got ${status}`);
}

function stageFamilyForSlug(slug) {
  switch (slug) {
    case "service_estimating":
      return "estimating";
    case "lost":
      return "terminal_loss";
    default:
      return "downstream";
  }
}

function workflowRouteForStage(slug) {
  return slug === "service_estimating" ? "service" : "normal";
}

function parseCsv(content) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const next = content[i + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function loadHubSpotOwners(csvPath) {
  if (!csvPath || !fs.existsSync(csvPath)) return new Map();
  const parsed = parseCsv(fs.readFileSync(csvPath, "utf8"));
  if (parsed.length === 0) return new Map();
  const header = parsed[0];
  const projectIndex = header.indexOf("Project Number");
  const ownerIndex = header.indexOf("Deal owner");
  if (projectIndex === -1 || ownerIndex === -1) return new Map();

  const owners = new Map();
  for (const row of parsed.slice(1)) {
    const key = normalizeProjectNumber(row[projectIndex]);
    const owner = nullableText(row[ownerIndex]);
    if (!key || !owner) continue;
    const existing = owners.get(key);
    if (!existing) owners.set(key, new Set([owner]));
    else existing.add(owner);
  }
  return owners;
}

function ownerCandidateEmails(ownerNameOrEmail) {
  const text = nullableText(ownerNameOrEmail);
  if (!text) return [];
  if (text.includes("@")) return [text.toLowerCase()];
  return [];
}

function validateRows(rows) {
  if (!Array.isArray(rows)) throw new Error("Approved rows JSON must be an array");
  if (rows.length !== 2) throw new Error(`Expected exactly 2 approved rows, got ${rows.length}`);

  const seen = new Set();
  for (const row of rows) {
    const projectNumber = requiredText(row.projectNumber, "projectNumber");
    if (!APPROVED_PROJECT_NUMBERS.has(projectNumber)) {
      throw new Error(`Unapproved project number in input: ${projectNumber}`);
    }
    if (seen.has(projectNumber)) throw new Error(`Duplicate approved project number: ${projectNumber}`);
    seen.add(projectNumber);
    requiredText(row.name, "name");
    requiredText(row.status, "status");
    requiredText(row.estimator, "estimator");
    moneyText(row.totalSales);
    statusToStageSlug(row.status);
  }

  for (const expected of APPROVED_PROJECT_NUMBERS) {
    if (!seen.has(expected)) throw new Error(`Approved input missing ${expected}`);
  }
}

async function queryOne(client, sql, params, label) {
  const result = await client.query(sql, params);
  if (result.rows.length !== 1) throw new Error(`${label}: expected 1 row, got ${result.rows.length}`);
  return result.rows[0];
}

async function ensureNoExistingMatch(client, projectNumber) {
  const result = await client.query(
    `
      SELECT d.id, d.name, d.deal_number, d.project_number, d.bid_board_project_number, psc.slug AS stage_slug
        FROM office_dallas.deals d
        LEFT JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
       WHERE d.is_active = true
         AND (
           LOWER(TRIM(d.project_number)) = $1 OR
           LOWER(TRIM(d.deal_number)) = $1 OR
           LOWER(TRIM(d.bid_board_project_number)) = $1
         )
       ORDER BY d.name, d.id
    `,
    [normalizeProjectNumber(projectNumber)]
  );
  if (result.rows.length > 0) {
    throw new Error(`Refusing to create ${projectNumber}; existing active CRM match found`);
  }
}

async function buildCreatePlan(client, rows, hubSpotOwners, fallbackOwnerEmail) {
  const fallbackOwner = await queryOne(
    client,
    `SELECT id, email FROM public.users WHERE lower(email) = lower($1) AND is_active = true LIMIT 1`,
    [fallbackOwnerEmail],
    "fallback owner"
  );

  const usersByEmail = new Map();
  const users = await client.query(`SELECT id, lower(email) AS email FROM public.users WHERE is_active = true`);
  for (const user of users.rows) usersByEmail.set(user.email, user.id);

  const plans = [];
  for (const row of rows) {
    const projectNumber = requiredText(row.projectNumber, "projectNumber");
    await ensureNoExistingMatch(client, projectNumber);

    const stageSlug = statusToStageSlug(row.status);
    const stage = await queryOne(
      client,
      `SELECT id, slug FROM public.pipeline_stage_config WHERE slug = $1 AND is_active_pipeline = true LIMIT 1`,
      [stageSlug],
      `stage ${stageSlug}`
    );

    const ownerSet = hubSpotOwners.get(normalizeProjectNumber(projectNumber));
    let assignedRepId = fallbackOwner.id;
    let assignmentReason = ASSIGNMENT_REVIEW_REASON;
    let ownerSource = "fallback_assignment_review";

    if (ownerSet && ownerSet.size === 1) {
      const [ownerValue] = [...ownerSet];
      for (const email of ownerCandidateEmails(ownerValue)) {
          const userId = usersByEmail.get(email);
          if (userId) {
            assignedRepId = userId;
            assignmentReason = null;
            ownerSource = "hubspot_project_number";
          }
      }
    }

    plans.push({
      row,
      projectNumber,
      stageId: stage.id,
      stageSlug,
      stageFamily: stageFamilyForSlug(stageSlug),
      workflowRoute: workflowRouteForStage(stageSlug),
      assignedRepId,
      assignmentReason,
      ownerSource,
    });
  }
  return plans;
}

async function writeBackupSnapshot(client, plans) {
  const backupDir = path.resolve(".reviews/bidboard-excluded-rows");
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = [];
  for (const plan of plans) {
    const result = await client.query(
      `
        SELECT d.id,
               d.deal_number,
               d.project_number,
               d.bid_board_project_number,
               d.source,
               d.is_active,
               d.on_hold,
               d.stage_id,
               d.created_at,
               d.updated_at
          FROM office_dallas.deals d
         WHERE LOWER(TRIM(d.project_number)) = $1
            OR LOWER(TRIM(d.deal_number)) = $1
            OR LOWER(TRIM(d.bid_board_project_number)) = $1
         ORDER BY d.created_at DESC
      `,
      [normalizeProjectNumber(plan.projectNumber)]
    );
    backup.push({
      projectNumber: plan.projectNumber,
      existingRowsFound: result.rows.length,
      existingRows: result.rows,
    });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `prechange-backup-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), backup }, null, 2));
  return backupPath;
}

async function insertDeal(client, plan, operationTimestamp) {
  const row = plan.row;
  const totalSales = moneyText(row.totalSales);
  const projectCost = moneyText(row.projectCost);
  const profitMargin = row.profitMargin == null || row.profitMargin === "" ? null : String(Number(row.profitMargin));
  const lostAt = plan.stageSlug === "lost" ? operationTimestamp : null;

  const result = await client.query(
    `
      INSERT INTO office_dallas.deals (
        deal_number, project_number, bid_board_project_number,
        name, stage_id, assigned_rep_id, created_by_user_id,
        bid_estimate, awarded_amount, dd_estimate,
        source, is_active, workflow_route, pipeline_type_snapshot, pipeline_disposition,
        is_bid_board_owned, is_read_only_mirror, is_read_only_sync_dirty,
        bid_board_stage_slug, bid_board_stage_family, bid_board_stage_status,
        bid_board_stage_entered_at, bid_board_stage_exited_at, bid_board_stage_duration,
        bid_board_loss_outcome, bid_board_mirror_source_entered_at, bid_board_mirror_source_exited_at,
        bid_board_estimator, estimator, bid_board_office, bid_board_status,
        bid_board_sales_price_per_area, bid_board_project_cost, bid_board_profit_margin_pct,
        bid_board_total_sales, bid_board_created_at, bid_board_due_date,
        bid_board_customer_name, bid_board_customer_contact_raw,
        bid_board_linked_at, bid_board_last_updated_at, read_only_synced_at,
        stage_entered_at, lost_at, unassigned_reason_code, office_code,
        on_hold, on_hold_accumulated_seconds, on_hold_accumulated_seconds_at_stage_entry,
        created_at, updated_at
      )
      VALUES (
        $1::varchar, $1::text, $1::text,
        $2, $3, $4, $5,
        $6, NULL, NULL,
        $7, true, $8, $9, 'deals',
        true, true, false,
        $10, $11, $12::varchar,
        NULL, NULL, NULL,
        NULL, NULL, NULL,
        $13, $13, $14, $12::text,
        $15, $16, $17,
        $6, $18::timestamptz, $19::date,
        $20, $21,
        $22::timestamptz, $22::timestamptz, $22::timestamptz,
        $22::timestamptz, $23::timestamptz, $24, 'dfw',
        false, 0, 0,
        $22::timestamptz, $22::timestamptz
      )
      RETURNING id, name, deal_number, project_number, bid_board_project_number
    `,
    [
      plan.projectNumber,
      row.name,
      plan.stageId,
      plan.assignedRepId,
      plan.assignedRepId,
      totalSales,
      SOURCE,
      plan.workflowRoute,
      plan.workflowRoute === "service" ? "service" : "normal",
      plan.stageSlug,
      plan.stageFamily,
      row.status,
      row.estimator,
      nullableText(row.office),
      nullableText(row.salesPricePerArea),
      projectCost,
      profitMargin,
      isoTimestamp(row.createdDate),
      dateOnly(row.dueDate),
      nullableText(row.customerName),
      nullableText(row.customerContact),
      operationTimestamp,
      lostAt,
      plan.assignmentReason,
    ]
  );

  return result.rows[0];
}

async function main() {
  const mode = process.argv.includes("--commit") ? "commit" : process.argv.includes("--dry-run") ? "dry-run" : null;
  if (!mode) throw new Error("Pass --dry-run or --commit");

  loadEnvFile(process.env.ENV_PATH);
  const connectionString = process.env.DATABASE_PUBLIC_URL;
  if (!connectionString) throw new Error("DATABASE_PUBLIC_URL is required");

  const rowsPath = process.env.APPROVED_ROWS_JSON;
  if (!rowsPath || !fs.existsSync(rowsPath)) throw new Error("APPROVED_ROWS_JSON file is required");
  const rows = JSON.parse(fs.readFileSync(rowsPath, "utf8"));
  validateRows(rows);
  const fallbackOwnerEmail = requiredText(process.env.FALLBACK_OWNER_EMAIL, "FALLBACK_OWNER_EMAIL");

  const hubSpotOwners = loadHubSpotOwners(process.env.HUBSPOT_CSV);
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    const plans = await buildCreatePlan(client, rows, hubSpotOwners, fallbackOwnerEmail);
    const backupPath = mode === "commit" ? await writeBackupSnapshot(client, plans) : null;
    const operationTimestamp = new Date().toISOString();

    await client.query("BEGIN");
    await client.query("SELECT set_config('app.skip_project_number_email', 'true', true)");
    const created = [];
    for (const plan of plans) {
      created.push(await insertDeal(client, plan, operationTimestamp));
    }

    if (created.length !== rows.length) {
      throw new Error(`Created count ${created.length} did not equal approved row count ${rows.length}`);
    }

    if (mode === "dry-run") {
      await client.query("ROLLBACK");
      console.log(JSON.stringify({
        mode,
        wouldCreate: created.length,
        expected: rows.length,
        created: created.map((row) => ({
          id: row.id,
          name: row.name,
          projectNumber: row.project_number,
        })),
      }, null, 2));
    } else {
      await client.query("COMMIT");
      console.log(JSON.stringify({
        mode,
        committedCreateCount: created.length,
        backupPath,
        created: created.map((row) => ({
          id: row.id,
          name: row.name,
          projectNumber: row.project_number,
        })),
        ownerAssignments: plans.map((plan) => ({
          projectNumber: plan.projectNumber,
          ownerSource: plan.ownerSource,
          reviewReason: plan.assignmentReason,
        })),
      }, null, 2));
    }
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // Ignore rollback errors; surface the original failure.
    }
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
