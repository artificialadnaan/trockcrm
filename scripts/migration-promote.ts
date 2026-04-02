// scripts/migration-promote.ts
// Run via: OFFICE_SLUG=dallas railway run npx tsx scripts/migration-promote.ts

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
import { pipelineStageConfig } from "../shared/src/schema/public/pipeline-stage-config.js";
import { users } from "../shared/src/schema/public/users.js";

const OFFICE_SLUG = process.env.OFFICE_SLUG;
if (!OFFICE_SLUG) {
  console.error("OFFICE_SLUG env var required (e.g. OFFICE_SLUG=dallas)");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

async function getRunByUserId(): Promise<string> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "admin"))
    .limit(1);
  if (!rows[0]) throw new Error("No admin user found");
  return rows[0].id;
}

async function main() {
  console.log(`[migration:promote] Promoting to office schema: ${OFFICE_SLUG}`);
  const schema = `office_${OFFICE_SLUG}`;
  const runByUserId = await getRunByUserId();

  const [runRow] = await db
    .insert(importRuns)
    .values({
      type: "promote",
      status: "running",
      stats: {},
      runBy: runByUserId,
      startedAt: new Date(),
    })
    .returning({ id: importRuns.id });

  const runId = runRow.id;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path = '${schema}', 'public'`);

    // -----------------------------------------------------------------------
    // 1. Load reference maps
    // -----------------------------------------------------------------------

    const stages = await db
      .select({ id: pipelineStageConfig.id, slug: pipelineStageConfig.slug })
      .from(pipelineStageConfig);
    const stageBySlug = new Map(stages.map((s) => [s.slug, s.id]));

    const repUsers = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.isActive, true));
    const repByEmail = new Map(repUsers.map((u) => [u.email.toLowerCase(), u.id]));

    // -----------------------------------------------------------------------
    // 2. Promote contacts first (deals reference contacts)
    // -----------------------------------------------------------------------

    const approvedContacts = await db
      .select()
      .from(stagedContacts)
      .where(eq(stagedContacts.validationStatus, "approved"));

    console.log(`[migration:promote] Promoting ${approvedContacts.length} contacts...`);

    const contactIdMap = new Map<string, string>(); // hubspot_contact_id -> new CRM contact_id

    for (const c of approvedContacts) {
      // Check if already promoted (idempotency)
      if (c.promotedContactId) {
        contactIdMap.set(c.hubspotContactId, c.promotedContactId);
        continue;
      }

      const insertResult = await client.query(
        `INSERT INTO contacts (
          first_name, last_name, email, phone, company_name,
          category, hubspot_contact_id, is_active, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,true,NOW(),NOW())
        ON CONFLICT (email) WHERE email IS NOT NULL DO UPDATE SET
          hubspot_contact_id = EXCLUDED.hubspot_contact_id,
          updated_at = NOW()
        RETURNING id`,
        [
          c.mappedFirstName ?? "",
          c.mappedLastName ?? "",
          c.mappedEmail ?? null,
          c.mappedPhone ?? null,
          c.mappedCompany ?? null,
          c.mappedCategory ?? "other",
          c.hubspotContactId,
        ]
      );

      const newContactId = insertResult.rows[0]?.id;
      if (newContactId) {
        contactIdMap.set(c.hubspotContactId, newContactId);
        await db
          .update(stagedContacts)
          .set({ promotedAt: new Date(), promotedContactId: newContactId })
          .where(eq(stagedContacts.id, c.id));
      }
    }

    console.log(`[migration:promote] ${contactIdMap.size} contacts promoted`);

    // -----------------------------------------------------------------------
    // 3. Promote deals
    // -----------------------------------------------------------------------

    const approvedDeals = await db
      .select()
      .from(stagedDeals)
      .where(eq(stagedDeals.validationStatus, "approved"));

    console.log(`[migration:promote] Promoting ${approvedDeals.length} deals...`);

    const dealIdMap = new Map<string, string>(); // hubspot_deal_id -> new CRM deal_id

    // Generate deal numbers sequentially
    const countResult = await client.query(
      `SELECT COALESCE(MAX(REGEXP_REPLACE(deal_number, '[^0-9]', '', 'g')::int), 0) AS max_num FROM deals`
    );
    let dealCounter = Number(countResult.rows[0]?.max_num ?? 0);

    const year = new Date().getFullYear();

    for (const d of approvedDeals) {
      if (d.promotedDealId) {
        dealIdMap.set(d.hubspotDealId, d.promotedDealId);
        continue;
      }

      const stageId = d.mappedStage ? stageBySlug.get(d.mappedStage) : null;
      const repId = d.mappedRepEmail ? repByEmail.get(d.mappedRepEmail.toLowerCase()) : null;

      if (!stageId || !repId) {
        console.warn(
          `[migration:promote] Skipping deal ${d.hubspotDealId} — missing stage or rep (stage: ${d.mappedStage}, rep: ${d.mappedRepEmail})`
        );
        continue;
      }

      dealCounter++;
      const dealNumber = `TR-${year}-${String(dealCounter).padStart(4, "0")}`;

      const insertResult = await client.query(
        `INSERT INTO deals (
          deal_number, name, stage_id, assigned_rep_id,
          bid_estimate, awarded_amount, expected_close_date, source,
          hubspot_deal_id, is_active, stage_entered_at, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,NOW(),NOW(),NOW())
        ON CONFLICT (hubspot_deal_id) WHERE hubspot_deal_id IS NOT NULL DO UPDATE SET
          updated_at = NOW()
        RETURNING id`,
        [
          dealNumber,
          d.mappedName ?? "Unnamed Deal",
          stageId,
          repId,
          d.mappedAmount ?? null,
          null,
          d.mappedCloseDate ?? null,
          d.mappedSource ?? "HubSpot",
          d.hubspotDealId,
        ]
      );

      const newDealId = insertResult.rows[0]?.id;
      if (newDealId) {
        dealIdMap.set(d.hubspotDealId, newDealId);
        await db
          .update(stagedDeals)
          .set({ promotedAt: new Date(), promotedDealId: newDealId })
          .where(eq(stagedDeals.id, d.id));
      }
    }

    console.log(`[migration:promote] ${dealIdMap.size} deals promoted`);

    // -----------------------------------------------------------------------
    // 4. Create contact_deal_associations
    // -----------------------------------------------------------------------

    for (const d of approvedDeals) {
      const promotedDealId = d.promotedDealId ?? dealIdMap.get(d.hubspotDealId);
      if (!promotedDealId) continue;

      const raw = d.rawData as any;
      const contactAssocs: string[] = (raw?.associations?.contacts?.results ?? []).map(
        (c: any) => c.id
      );

      for (const hsContactId of contactAssocs) {
        const crmContactId = contactIdMap.get(hsContactId);
        if (!crmContactId) continue;

        await client.query(
          `INSERT INTO contact_deal_associations (contact_id, deal_id, is_primary, created_at)
           VALUES ($1, $2, true, NOW())
           ON CONFLICT (contact_id, deal_id) DO NOTHING`,
          [crmContactId, promotedDealId]
        );
      }
    }

    // -----------------------------------------------------------------------
    // 5. Promote activities
    // -----------------------------------------------------------------------

    const approvedActivities = await db
      .select()
      .from(stagedActivities)
      .where(eq(stagedActivities.validationStatus, "approved"));

    console.log(`[migration:promote] Promoting ${approvedActivities.length} activities...`);

    let activityCount = 0;
    for (const a of approvedActivities) {
      if (a.promotedAt) continue;

      const crmDealId = a.hubspotDealId ? dealIdMap.get(a.hubspotDealId) : null;
      const crmContactId = a.hubspotContactId ? contactIdMap.get(a.hubspotContactId) : null;

      if (!crmDealId && !crmContactId) continue; // orphan — skip

      const systemUserId = runByUserId;

      await client.query(
        `INSERT INTO activities (
          type, user_id, deal_id, contact_id, subject, body, occurred_at, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
        [
          a.mappedType ?? "note",
          systemUserId,
          crmDealId ?? null,
          crmContactId ?? null,
          a.mappedSubject ?? "",
          a.mappedBody ?? "",
          a.mappedOccurredAt ?? new Date(),
        ]
      );

      await db
        .update(stagedActivities)
        .set({ promotedAt: new Date() })
        .where(eq(stagedActivities.id, a.id));

      activityCount++;
    }

    console.log(`[migration:promote] ${activityCount} activities promoted`);

    await client.query("COMMIT");

    const stats = {
      contacts: contactIdMap.size,
      deals: dealIdMap.size,
      activities: activityCount,
    };

    await db
      .update(importRuns)
      .set({ status: "completed", stats, completedAt: new Date() })
      .where(eq(importRuns.id, runId));

    console.log(`\n[migration:promote] Promotion complete:`, stats);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("\n[migration:promote] ROLLBACK — promotion failed:", err);
    await db
      .update(importRuns)
      .set({ status: "rolled_back", errorLog: String(err), completedAt: new Date() })
      .where(eq(importRuns.id, runId));
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
