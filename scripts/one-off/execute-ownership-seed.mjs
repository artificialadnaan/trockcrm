#!/usr/bin/env node
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const APPROVED_PLAN =
  "/Users/adnaaniqbal/Developer/trockcrm/.worktrees/disco-ownership-seed-dryrun/.reviews/ownership-seed-dryrun/plan.md";
const ENV_PATH = "/Users/adnaaniqbal/Developer/trockcrm/.env";
const EXPECTED_COMPANIES = 366;
const EXPECTED_CONTACTS = 1529;

const mode = process.argv.includes("--commit") ? "commit" : "dry-run";

function readDatabaseUrl() {
  const env = fs.readFileSync(ENV_PATH, "utf8");
  const line = env.split(/\r?\n/).find((entry) => /^DATABASE_PUBLIC_URL\s*=/.test(entry));
  if (!line) throw new Error("DATABASE_PUBLIC_URL missing from .env");
  let value = line.slice(line.indexOf("=") + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value;
}

function qident(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function qname(schema, table) {
  return `${qident(schema)}.${qident(table)}`;
}

function extractSection(markdown, startHeading, endHeading) {
  const start = markdown.indexOf(startHeading);
  if (start === -1) throw new Error(`Missing section ${startHeading}`);
  const end = markdown.indexOf(endHeading, start);
  if (end === -1) throw new Error(`Missing end section ${endHeading}`);
  return markdown.slice(start, end);
}

function parsePlanRows(section, entityType) {
  const rows = [];
  for (const line of section.split(/\r?\n/)) {
    if (!line.startsWith("| `")) continue;
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length !== 6) continue;

    const entityMatch = cells[0].match(/^`([0-9a-f-]{36})`\s+(.+)$/i);
    const schemaMatch = cells[1].match(/^`([^`]+)`$/);
    const ownerMatch = cells[3].match(/^(.+)\s+<([^<>@\s]+@[^<>@\s]+)>$/);
    const csvRowCount = Number(cells[5]);
    if (!entityMatch || !schemaMatch || !ownerMatch || !Number.isInteger(csvRowCount)) {
      throw new Error(`Unable to parse ${entityType} plan row: ${line}`);
    }

    rows.push({
      entityType,
      id: entityMatch[1],
      label: entityMatch[2],
      schema: schemaMatch[1],
      matchMethod: cells[2],
      ownerDisplayName: ownerMatch[1],
      ownerEmail: ownerMatch[2].toLowerCase(),
      currentOwnerStatusFromPlan: cells[4],
      csvRowCount,
    });
  }
  return rows;
}

function parseApprovedPlan() {
  if (!fs.existsSync(APPROVED_PLAN)) {
    throw new Error(`Approved plan missing: ${APPROVED_PLAN}`);
  }
  const markdown = fs.readFileSync(APPROVED_PLAN, "utf8");
  const companySummary = markdown.match(/^\| Companies \| 661 \| 366 \| 366 \|/m);
  const contactSummary = markdown.match(/^\| Contacts \| 2126 \| 1529 \| 1529 \|/m);
  if (!companySummary || !contactSummary) {
    throw new Error("Approved plan summary does not match expected 366 companies / 1529 contacts safe set");
  }

  const companies = parsePlanRows(
    extractSection(markdown, "## B. Company Seed Plan", "## C. Contact Seed Plan"),
    "company"
  );
  const contacts = parsePlanRows(
    extractSection(markdown, "## C. Contact Seed Plan", "## D. Skipped"),
    "contact"
  );

  if (companies.length !== EXPECTED_COMPANIES) {
    throw new Error(`Expected ${EXPECTED_COMPANIES} company plan rows, parsed ${companies.length}`);
  }
  if (contacts.length !== EXPECTED_CONTACTS) {
    throw new Error(`Expected ${EXPECTED_CONTACTS} contact plan rows, parsed ${contacts.length}`);
  }

  assertUniqueTargets(companies, "company");
  assertUniqueTargets(contacts, "contact");
  return { companies, contacts };
}

function assertUniqueTargets(rows, entityType) {
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.schema}:${row.id}`;
    if (seen.has(key)) throw new Error(`Duplicate ${entityType} target in approved plan: ${key}`);
    seen.add(key);
  }
}

async function validateOwnerColumns(client, rows) {
  const schemas = [...new Set(rows.map((row) => row.schema))];
  const result = await client.query(
    `
      SELECT table_schema, table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = ANY($1::text[])
        AND table_name IN ('companies', 'contacts')
        AND column_name = 'owner_id'
    `,
    [schemas]
  );
  const found = new Set(result.rows.map((row) => `${row.table_schema}.${row.table_name}.${row.column_name}`));
  for (const schema of schemas) {
    if (!found.has(`${schema}.companies.owner_id`)) throw new Error(`${schema}.companies.owner_id missing`);
    if (!found.has(`${schema}.contacts.owner_id`)) throw new Error(`${schema}.contacts.owner_id missing`);
  }
}

async function resolveOwners(client, rows) {
  const emails = [...new Set(rows.map((row) => row.ownerEmail))];
  const result = await client.query(
    `
      SELECT id::text, email, display_name, is_active
      FROM public.users
      WHERE lower(email) = ANY($1::text[])
    `,
    [emails]
  );
  const byEmail = new Map();
  for (const user of result.rows) {
    const key = user.email.toLowerCase();
    if (!byEmail.has(key)) byEmail.set(key, []);
    byEmail.get(key).push(user);
  }

  for (const email of emails) {
    const matches = byEmail.get(email) ?? [];
    const active = matches.filter((user) => user.is_active === true);
    if (active.length !== 1) {
      throw new Error(`Plan owner email ${email} resolved to ${active.length} active CRM users`);
    }
  }

  for (const row of rows) {
    row.ownerId = byEmail.get(row.ownerEmail).find((user) => user.is_active === true).id;
  }
}

async function currentState(client, rows, table) {
  const state = {
    totalPlanRows: rows.length,
    missing: [],
    nullOwner: [],
    alreadySame: [],
    alreadyDifferent: [],
  };

  for (const row of rows) {
    const result = await client.query(
      `
        SELECT id::text, owner_id::text
        FROM ${qname(row.schema, table)}
        WHERE id = $1
      `,
      [row.id]
    );
    if (result.rowCount !== 1) {
      state.missing.push(row);
      continue;
    }

    const ownerId = result.rows[0].owner_id;
    if (ownerId === null) state.nullOwner.push(row);
    else if (ownerId === row.ownerId) state.alreadySame.push(row);
    else state.alreadyDifferent.push({ ...row, existingOwnerId: ownerId });
  }

  return state;
}

async function updateRowsSequentially(client, rows, table) {
  let updated = 0;
  for (const row of rows) {
    const result = await client.query(
      `
        UPDATE ${qname(row.schema, table)}
        SET owner_id = $1
        WHERE id = $2
          AND owner_id IS NULL
      `,
      [row.ownerId, row.id]
    );
    updated += result.rowCount;
  }
  return updated;
}

function summarizeState(state) {
  return {
    planRows: state.totalPlanRows,
    wouldUpdateNullOwner: state.nullOwner.length,
    alreadyOwnedSameOwner: state.alreadySame.length,
    alreadyOwnedDifferentOwner: state.alreadyDifferent.length,
    missing: state.missing.length,
  };
}

function assertStateIsSafe(state, entityType) {
  const accounted =
    state.nullOwner.length + state.alreadySame.length + state.alreadyDifferent.length + state.missing.length;
  if (accounted !== state.totalPlanRows) {
    throw new Error(`${entityType} accounting mismatch: ${accounted} accounted for ${state.totalPlanRows} plan rows`);
  }
  if (state.missing.length > 0) {
    throw new Error(`${entityType} target rows missing from database: ${state.missing.map((row) => row.id).join(", ")}`);
  }
}

async function main() {
  const { companies, contacts } = parseApprovedPlan();
  const allRows = [...companies, ...contacts];
  const client = new Client({ connectionString: readDatabaseUrl(), ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    const ping = await client.query("SELECT 1 AS ok");
    if (ping.rows[0]?.ok !== 1) throw new Error("SELECT 1 failed");

    await validateOwnerColumns(client, allRows);
    await resolveOwners(client, allRows);

    await client.query("BEGIN");
    try {
      const companyStateBefore = await currentState(client, companies, "companies");
      const contactStateBefore = await currentState(client, contacts, "contacts");
      assertStateIsSafe(companyStateBefore, "company");
      assertStateIsSafe(contactStateBefore, "contact");

      const companiesUpdated = await updateRowsSequentially(client, companyStateBefore.nullOwner, "companies");
      const contactsUpdated = await updateRowsSequentially(client, contactStateBefore.nullOwner, "contacts");

      if (companiesUpdated !== companyStateBefore.nullOwner.length) {
        throw new Error(
          `Company update count mismatch: expected ${companyStateBefore.nullOwner.length}, got ${companiesUpdated}`
        );
      }
      if (contactsUpdated !== contactStateBefore.nullOwner.length) {
        throw new Error(
          `Contact update count mismatch: expected ${contactStateBefore.nullOwner.length}, got ${contactsUpdated}`
        );
      }

      const result = {
        mode,
        approvedPlan: {
          companies: companies.length,
          contacts: contacts.length,
        },
        before: {
          companies: summarizeState(companyStateBefore),
          contacts: summarizeState(contactStateBefore),
        },
        updatesAttempted: {
          companies: companyStateBefore.nullOwner.length,
          contacts: contactStateBefore.nullOwner.length,
        },
        updatesApplied: {
          companies: companiesUpdated,
          contacts: contactsUpdated,
        },
      };

      if (mode === "commit") {
        await client.query("COMMIT");
        result.transaction = "committed";
      } else {
        await client.query("ROLLBACK");
        result.transaction = "rolled_back";
      }

      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
