// scripts/migration-extract.ts
// Run via: railway run npx tsx scripts/migration-extract.ts
// Or locally: HUBSPOT_PRIVATE_APP_TOKEN=... npx tsx scripts/migration-extract.ts

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq } from "drizzle-orm";
import {
  stagedDeals,
  stagedContacts,
  stagedActivities,
  importRuns,
} from "../shared/src/schema/migration/index.js";
import { users } from "../shared/src/schema/public/users.js";
import {
  fetchAllDeals,
  fetchAllContacts,
  fetchAllActivities,
  fetchAllOwners,
} from "../server/src/modules/migration/hubspot-client.js";
import {
  buildOwnerEmailMap,
  mapDeal,
  mapContact,
  mapActivity,
} from "../server/src/modules/migration/field-mapper.js";

// ---------------------------------------------------------------------------
// Database connection
// ---------------------------------------------------------------------------

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getRunByUserId(): Promise<string> {
  const adminRows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "admin"))
    .limit(1);
  if (adminRows[0]) return adminRows[0].id;

  const anyUser = await db.select({ id: users.id }).from(users).limit(1);
  if (anyUser[0]) return anyUser[0].id;

  throw new Error("No users found in database — run Plan 1 first");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("[migration:extract] Starting HubSpot extraction...");

  const runByUserId = await getRunByUserId();

  // Create import run record
  const [runRow] = await db
    .insert(importRuns)
    .values({
      type: "extract",
      status: "running",
      stats: { total: 0, deals: 0, contacts: 0, activities: 0 },
      runBy: runByUserId,
      startedAt: new Date(),
    })
    .returning({ id: importRuns.id });

  const runId = runRow.id;
  console.log(`[migration:extract] Import run ID: ${runId}`);

  try {
    // 1. Fetch owners (needed for rep email resolution)
    console.log("[migration:extract] Fetching HubSpot owners...");
    const owners = await fetchAllOwners();
    const ownerEmailMap = buildOwnerEmailMap(owners);
    console.log(`[migration:extract] ${owners.length} owners loaded`);

    // 2. Extract and load deals
    console.log("[migration:extract] Fetching deals from HubSpot...");
    const hsDealsList = await fetchAllDeals();
    console.log(`[migration:extract] ${hsDealsList.length} deals fetched`);

    let dealCount = 0;
    const BATCH = 50;
    for (let i = 0; i < hsDealsList.length; i += BATCH) {
      const batch = hsDealsList.slice(i, i + BATCH);
      const mapped = batch.map((d) => mapDeal(d, ownerEmailMap));

      await db
        .insert(stagedDeals)
        .values(
          mapped.map((d) => ({
            hubspotDealId: d.hubspotDealId,
            rawData: d.rawData,
            mappedName: d.mappedName,
            mappedStage: d.mappedStage,
            mappedRepEmail: d.mappedRepEmail,
            mappedAmount: d.mappedAmount != null ? String(d.mappedAmount) : null,
            mappedCloseDate: d.mappedCloseDate ? d.mappedCloseDate : null,
            mappedSource: d.mappedSource,
            validationStatus: "pending",
            validationErrors: [],
            validationWarnings: [],
          }))
        )
        .onConflictDoNothing();

      dealCount += batch.length;
      process.stdout.write(`\r  Deals: ${dealCount}/${hsDealsList.length}`);
    }
    console.log(`\n[migration:extract] ${dealCount} deals staged`);

    // 3. Extract and load contacts
    console.log("[migration:extract] Fetching contacts from HubSpot...");
    const hsContacts = await fetchAllContacts();
    console.log(`[migration:extract] ${hsContacts.length} contacts fetched`);

    let contactCount = 0;
    for (let i = 0; i < hsContacts.length; i += BATCH) {
      const batch = hsContacts.slice(i, i + BATCH);
      const mapped = batch.map(mapContact);

      await db
        .insert(stagedContacts)
        .values(
          mapped.map((c) => ({
            hubspotContactId: c.hubspotContactId,
            rawData: c.rawData,
            mappedFirstName: c.mappedFirstName,
            mappedLastName: c.mappedLastName,
            mappedEmail: c.mappedEmail,
            mappedPhone: c.mappedPhone,
            mappedCompany: c.mappedCompany,
            mappedCategory: c.mappedCategory,
            validationStatus: "pending",
            validationErrors: [],
            validationWarnings: [],
          }))
        )
        .onConflictDoNothing();

      contactCount += batch.length;
      process.stdout.write(`\r  Contacts: ${contactCount}/${hsContacts.length}`);
    }
    console.log(`\n[migration:extract] ${contactCount} contacts staged`);

    // 4. Extract and load activities
    console.log("[migration:extract] Fetching activities from HubSpot...");
    const hsActivities = await fetchAllActivities();
    console.log(`[migration:extract] ${hsActivities.length} activities fetched`);

    let activityCount = 0;
    for (let i = 0; i < hsActivities.length; i += BATCH) {
      const batch = hsActivities.slice(i, i + BATCH);
      const mapped = batch.map(mapActivity);

      await db
        .insert(stagedActivities)
        .values(
          mapped.map((a) => ({
            hubspotActivityId: a.hubspotActivityId,
            hubspotDealId: a.hubspotDealId,
            hubspotContactId: a.hubspotContactId,
            rawData: a.rawData,
            mappedType: a.mappedType,
            mappedSubject: a.mappedSubject,
            mappedBody: a.mappedBody,
            mappedOccurredAt: a.mappedOccurredAt ? new Date(a.mappedOccurredAt) : null,
            validationStatus: "pending",
            validationErrors: [],
          }))
        )
        .onConflictDoNothing();

      activityCount += batch.length;
      process.stdout.write(`\r  Activities: ${activityCount}/${hsActivities.length}`);
    }
    console.log(`\n[migration:extract] ${activityCount} activities staged`);

    // Update import run as completed
    const total = dealCount + contactCount + activityCount;
    await db
      .update(importRuns)
      .set({
        status: "completed",
        stats: { total, deals: dealCount, contacts: contactCount, activities: activityCount },
        completedAt: new Date(),
      })
      .where(eq(importRuns.id, runId));

    console.log(`\n[migration:extract] Done. ${total} records staged (run ${runId})`);
  } catch (err) {
    console.error("\n[migration:extract] FAILED:", err);
    await db
      .update(importRuns)
      .set({
        status: "failed",
        errorLog: String(err),
        completedAt: new Date(),
      })
      .where(eq(importRuns.id, runId));
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
