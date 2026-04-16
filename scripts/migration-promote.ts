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
  stagedCompanies,
  stagedProperties,
  stagedLeads,
  importRuns,
} from "../shared/src/schema/migration/index.js";
import { companies } from "../shared/src/schema/index.js";
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

function normalizeTextKey(input: string | null | undefined): string {
  return input?.trim().toLowerCase() ?? "";
}

function slugifyCompanyName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
}

function buildPropertyKey(input: {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}): string {
  return [input.address, input.city, input.state, input.zip]
    .map((part) => normalizeTextKey(part))
    .join("|");
}

async function main() {
  console.log(`[migration:promote] Promoting to office schema: ${OFFICE_SLUG}`);
  const schema = `office_${OFFICE_SLUG}`;
  const runByUserId = await getRunByUserId();

  const client = await pool.connect();
  // Bind a Drizzle instance to the transaction client so ALL operations
  // (staging updates AND tenant inserts) use the same connection/transaction.
  const txDb = drizzle(client);

  const [runRow] = await txDb
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

  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path = '${schema}', 'public'`);

    // -----------------------------------------------------------------------
    // 1. Load reference maps
    // -----------------------------------------------------------------------

    const stages = await txDb
      .select({ id: pipelineStageConfig.id, slug: pipelineStageConfig.slug })
      .from(pipelineStageConfig);
    const stageBySlug = new Map(stages.map((s) => [s.slug, s.id]));

    const repUsers = await txDb
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.isActive, true));
    const repByEmail = new Map(repUsers.map((u) => [u.email.toLowerCase(), u.id]));

    // -----------------------------------------------------------------------
    // 2. Promote companies first so contacts and deals can reference them.
    // -----------------------------------------------------------------------

    const approvedCompanies = await txDb
      .select()
      .from(stagedCompanies)
      .where(eq(stagedCompanies.validationStatus, "approved"));

    console.log(`[migration:promote] Promoting ${approvedCompanies.length} companies...`);

    const companyIdByName = new Map<string, string>();
    let promotedCompanyCount = 0;

    for (const company of approvedCompanies) {
      if (company.promotedCompanyId) {
        companyIdByName.set(normalizeTextKey(company.mappedName), company.promotedCompanyId);
        continue;
      }

      if (!company.mappedName?.trim()) continue;
      const slugBase = slugifyCompanyName(company.mappedName) || "company";
      const slug = `${slugBase}-${company.hubspotCompanyId.slice(-8)}`.slice(0, 100);
      const insertResult = await client.query(
        `INSERT INTO companies (
          name, slug, category, address, city, state, zip, phone, website, notes, is_active, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,NOW(),NOW())
        ON CONFLICT (slug) DO UPDATE SET
          name = EXCLUDED.name,
          category = EXCLUDED.category,
          address = EXCLUDED.address,
          city = EXCLUDED.city,
          state = EXCLUDED.state,
          zip = EXCLUDED.zip,
          phone = EXCLUDED.phone,
          website = EXCLUDED.website,
          notes = EXCLUDED.notes,
          updated_at = NOW()
        RETURNING id`,
        [
          company.mappedName,
          slug,
          "other",
          null,
          null,
          null,
          null,
          company.mappedPhone ?? null,
          company.mappedDomain ?? null,
          company.mappedLeadHint ?? null,
        ]
      );

      const newCompanyId = insertResult.rows[0]?.id;
      if (newCompanyId) {
        companyIdByName.set(normalizeTextKey(company.mappedName), newCompanyId);
        promotedCompanyCount++;
        await txDb
          .update(stagedCompanies)
          .set({ promotedAt: new Date(), promotedCompanyId: newCompanyId })
          .where(eq(stagedCompanies.id, company.id));
      }
    }

    console.log(`[migration:promote] ${promotedCompanyCount} companies promoted`);

    // -----------------------------------------------------------------------
    // 3. Promote contacts next (they may attach to promoted companies).
    // -----------------------------------------------------------------------

    const approvedContacts = await txDb
      .select()
      .from(stagedContacts)
      .where(eq(stagedContacts.validationStatus, "approved"));

    console.log(`[migration:promote] Promoting ${approvedContacts.length} contacts...`);

    const contactIdMap = new Map<string, string>(); // hubspot_contact_id -> new CRM contact_id
    const contactCompanyByHubspotId = new Map<string, string | null>();

    for (const c of approvedContacts) {
      if (c.promotedContactId) {
        contactIdMap.set(c.hubspotContactId, c.promotedContactId);
        contactCompanyByHubspotId.set(c.hubspotContactId, c.mappedCompany ?? null);
        continue;
      }

      const companyId = c.mappedCompany ? companyIdByName.get(normalizeTextKey(c.mappedCompany)) ?? null : null;
      const insertResult = await client.query(
        `INSERT INTO contacts (
          first_name, last_name, email, phone, company_name, company_id,
          category, hubspot_contact_id, is_active, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,NOW(),NOW())
        ON CONFLICT (email) WHERE email IS NOT NULL DO UPDATE SET
          hubspot_contact_id = EXCLUDED.hubspot_contact_id,
          company_id = COALESCE(EXCLUDED.company_id, contacts.company_id),
          company_name = COALESCE(EXCLUDED.company_name, contacts.company_name),
          updated_at = NOW()
        RETURNING id`,
        [
          c.mappedFirstName ?? "",
          c.mappedLastName ?? "",
          c.mappedEmail ?? null,
          c.mappedPhone ?? null,
          c.mappedCompany ?? null,
          companyId ?? null,
          c.mappedCategory ?? "other",
          c.hubspotContactId,
        ]
      );

      const newContactId = insertResult.rows[0]?.id;
      if (newContactId) {
        contactIdMap.set(c.hubspotContactId, newContactId);
        contactCompanyByHubspotId.set(c.hubspotContactId, c.mappedCompany ?? null);
        await txDb
          .update(stagedContacts)
          .set({ promotedAt: new Date(), promotedContactId: newContactId })
          .where(eq(stagedContacts.id, c.id));
      }
    }

    console.log(`[migration:promote] ${contactIdMap.size} contacts promoted`);

    // -----------------------------------------------------------------------
    // 4. Promote staged leads into actual deal rows in the lead stage.
    // -----------------------------------------------------------------------

    const approvedLeads = await txDb
      .select()
      .from(stagedLeads)
      .where(eq(stagedLeads.validationStatus, "approved"));

    console.log(`[migration:promote] Promoting ${approvedLeads.length} leads...`);

    const approvedProperties = await txDb
      .select()
      .from(stagedProperties)
      .where(eq(stagedProperties.validationStatus, "approved"));

    const dealIdMap = new Map<string, string>(); // hubspot deal id -> new CRM deal id
    const propertyPromotionMap = new Map<string, string>(); // property key -> deal id
    let promotedLeadCount = 0;
    let promotedDealCount = 0;

    const countResult = await client.query(
      `SELECT COALESCE(MAX(REGEXP_REPLACE(deal_number, '[^0-9]', '', 'g')::int), 0) AS max_num FROM deals`
    );
    let dealCounter = Number(countResult.rows[0]?.max_num ?? 0);
    const year = new Date().getFullYear();
    const ddStageId = stageBySlug.get("dd");
    if (!ddStageId) {
      throw new Error("Missing dd stage configuration");
    }

    for (const lead of approvedLeads) {
      if (lead.promotedLeadId) {
        dealIdMap.set(lead.hubspotLeadId, lead.promotedLeadId);
        continue;
      }

      const repId = lead.mappedOwnerEmail ? repByEmail.get(lead.mappedOwnerEmail.toLowerCase()) : null;
      if (!repId) {
        console.warn(
          `[migration:promote] Skipping lead ${lead.hubspotLeadId} — missing rep (rep: ${lead.mappedOwnerEmail})`
        );
        continue;
      }

      dealCounter++;
      const dealNumber = `TR-${year}-${String(dealCounter).padStart(4, "0")}`;
      const raw = lead.rawData as any;
      const properties = raw?.properties ?? {};
      const propertyKey = buildPropertyKey({
        address: properties.address ?? null,
        city: properties.city ?? null,
        state: properties.state ?? null,
        zip: properties.zip ?? null,
      });
      const companyId = lead.mappedCompanyName ? companyIdByName.get(normalizeTextKey(lead.mappedCompanyName)) ?? null : null;

      const insertResult = await client.query(
        `INSERT INTO deals (
          deal_number, name, stage_id, assigned_rep_id, company_id,
          dd_estimate, awarded_amount, expected_close_date, source,
          hubspot_deal_id, property_address, property_city, property_state, property_zip,
          is_active, stage_entered_at, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,NOW(),NOW(),NOW())
        ON CONFLICT (hubspot_deal_id) WHERE hubspot_deal_id IS NOT NULL DO UPDATE SET
          updated_at = NOW()
        RETURNING id`,
        [
          dealNumber,
          lead.mappedName ?? "Unnamed Lead",
          ddStageId,
          repId,
          companyId,
          lead.mappedAmount ?? null,
          null,
          lead.mappedCloseDate ?? null,
          lead.mappedSourceStage ?? "HubSpot",
          lead.hubspotLeadId,
          properties.address ?? null,
          properties.city ?? null,
          properties.state ?? null,
          properties.zip ?? null,
        ]
      );

      const newDealId = insertResult.rows[0]?.id;
      if (newDealId) {
        dealIdMap.set(lead.hubspotLeadId, newDealId);
        propertyPromotionMap.set(propertyKey, newDealId);
        promotedLeadCount++;
        await txDb
          .update(stagedLeads)
          .set({ promotedAt: new Date(), promotedLeadId: newDealId })
          .where(eq(stagedLeads.id, lead.id));
      }
    }

    // -----------------------------------------------------------------------
    // 5. Promote post-RFP deals.
    // -----------------------------------------------------------------------

    const approvedDeals = await txDb
      .select()
      .from(stagedDeals)
      .where(eq(stagedDeals.validationStatus, "approved"));

    console.log(`[migration:promote] Promoting ${approvedDeals.length} deals...`);

    for (const d of approvedDeals) {
      if (d.promotedDealId) {
        dealIdMap.set(d.hubspotDealId, d.promotedDealId);
        continue;
      }

      const stageId = d.mappedStage ? stageBySlug.get(d.mappedStage) : null;
      const repId = d.mappedRepEmail ? repByEmail.get(d.mappedRepEmail.toLowerCase()) : null;
      const raw = d.rawData as any;
      const properties = raw?.properties ?? {};
      const contactAssociations: string[] = (raw?.associations?.contacts?.results ?? []).map(
        (c: any) => c.id
      );
      const primaryContactCompany =
        contactAssociations
          .map((hsContactId) => contactCompanyByHubspotId.get(hsContactId))
          .find((company) => Boolean(company?.trim())) ?? null;
      const companyId = primaryContactCompany
        ? companyIdByName.get(normalizeTextKey(primaryContactCompany))
          ?? null
        : null;

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
          deal_number, name, stage_id, assigned_rep_id, company_id,
          bid_estimate, awarded_amount, expected_close_date, source,
          hubspot_deal_id, property_address, property_city, property_state, property_zip,
          is_active, stage_entered_at, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,NOW(),NOW(),NOW())
        ON CONFLICT (hubspot_deal_id) WHERE hubspot_deal_id IS NOT NULL DO UPDATE SET
          updated_at = NOW()
        RETURNING id`,
        [
          dealNumber,
          d.mappedName ?? "Unnamed Deal",
          stageId,
          repId,
          companyId,
          d.mappedAmount ?? null,
          null,
          d.mappedCloseDate ?? null,
          d.mappedSource ?? "HubSpot",
          d.hubspotDealId,
          properties.address ?? null,
          properties.city ?? null,
          properties.state ?? null,
          properties.zip ?? null,
        ]
      );

      const newDealId = insertResult.rows[0]?.id;
      if (newDealId) {
        dealIdMap.set(d.hubspotDealId, newDealId);
        const propertyKey = buildPropertyKey({
          address: properties.address ?? null,
          city: properties.city ?? null,
          state: properties.state ?? null,
          zip: properties.zip ?? null,
        });
        propertyPromotionMap.set(propertyKey, newDealId);
        promotedDealCount++;
        await txDb
          .update(stagedDeals)
          .set({ promotedAt: new Date(), promotedDealId: newDealId })
          .where(eq(stagedDeals.id, d.id));
      }
    }

    console.log(`[migration:promote] ${promotedLeadCount + promotedDealCount} deals promoted`);

    // -----------------------------------------------------------------------
    // 6. Link approved properties to the promoted deal snapshots.
    // -----------------------------------------------------------------------

    let promotedPropertyCount = 0;
    for (const property of approvedProperties) {
      if (property.promotedAt) continue;
      const propertyKey = buildPropertyKey({
        address: property.mappedAddress,
        city: property.mappedCity,
        state: property.mappedState,
        zip: property.mappedZip,
      });
      const promotedDealId = propertyPromotionMap.get(propertyKey);
      if (!promotedDealId) continue;
      await txDb
        .update(stagedProperties)
        .set({ promotedAt: new Date(), promotedPropertyId: promotedDealId })
        .where(eq(stagedProperties.id, property.id));
      promotedPropertyCount++;
    }

    // -----------------------------------------------------------------------
    // 7. Create contact_deal_associations
    // -----------------------------------------------------------------------

    for (const d of [...approvedLeads, ...approvedDeals]) {
      const sourceHubspotId = (d as any).hubspotLeadId ?? (d as any).hubspotDealId;
      const promotedDealId =
        (d as any).promotedLeadId ?? (d as any).promotedDealId ?? dealIdMap.get(sourceHubspotId);
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
    // 8. Promote activities
    // -----------------------------------------------------------------------

    const approvedActivities = await txDb
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

      await txDb
        .update(stagedActivities)
        .set({ promotedAt: new Date() })
        .where(eq(stagedActivities.id, a.id));

      activityCount++;
    }

    console.log(`[migration:promote] ${activityCount} activities promoted`);

    await client.query("COMMIT");

    const stats = {
      contacts: contactIdMap.size,
      companies: promotedCompanyCount,
      leads: promotedLeadCount,
      properties: promotedPropertyCount,
      deals: promotedLeadCount + promotedDealCount,
      activities: activityCount,
    };

    await txDb
      .update(importRuns)
      .set({ status: "completed", stats, completedAt: new Date() })
      .where(eq(importRuns.id, runId));

    console.log(`\n[migration:promote] Promotion complete:`, stats);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("\n[migration:promote] ROLLBACK — promotion failed:", err);
    // After rollback, update import run status (outside transaction, still on same client)
    await txDb
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
