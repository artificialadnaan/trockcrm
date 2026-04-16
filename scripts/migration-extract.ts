// scripts/migration-extract.ts
// Run via: railway run npx tsx scripts/migration-extract.ts
// Or locally: HUBSPOT_PRIVATE_APP_TOKEN=... npx tsx scripts/migration-extract.ts

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq } from "drizzle-orm";
import {
  stagedCompanies,
  stagedProperties,
  stagedLeads,
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

function normalizeTextKey(input: string | null | undefined): string {
  return input?.trim().toLowerCase() ?? "";
}

function deriveEmailDomain(email: string | null | undefined): string | null {
  if (!email?.includes("@")) return null;
  return email.split("@").pop()?.toLowerCase().trim() ?? null;
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
    const BATCH = 50;

    // 1. Fetch owners (needed for rep email resolution)
    console.log("[migration:extract] Fetching HubSpot owners...");
    const owners = await fetchAllOwners();
    const ownerEmailMap = buildOwnerEmailMap(owners);
    console.log(`[migration:extract] ${owners.length} owners loaded`);

    // 2. Extract and load contacts
    console.log("[migration:extract] Fetching contacts from HubSpot...");
    const hsContacts = await fetchAllContacts();
    console.log(`[migration:extract] ${hsContacts.length} contacts fetched`);
    const mappedContacts = hsContacts.map(mapContact);
    const contactByHubspotId = new Map(mappedContacts.map((contact) => [contact.hubspotContactId, contact]));

    let contactCount = 0;
    for (let i = 0; i < hsContacts.length; i += BATCH) {
      const batch = hsContacts.slice(i, i + BATCH);
      const mapped = mappedContacts.slice(i, i + BATCH);

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

    // 3. Derive staged companies, properties, and leads from HubSpot contact + deal data.
    const companyRows = new Map<
      string,
      {
        hubspotCompanyId: string;
        rawData: Record<string, unknown>;
        mappedName: string | null;
        mappedDomain: string | null;
        mappedPhone: string | null;
        mappedOwnerEmail: string | null;
        mappedLeadHint: string | null;
      }
    >();
    for (const contact of mappedContacts) {
      if (!contact.mappedCompany) continue;
      const companyKey = normalizeTextKey(contact.mappedCompany);
      if (!companyKey) continue;
      const companyId =
        `derived-company:${companyKey.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || contact.hubspotContactId}`;
      const existing = companyRows.get(companyKey);
      if (!existing) {
        companyRows.set(companyKey, {
          hubspotCompanyId: companyId,
          rawData: {
            source: "derived-from-contacts",
            contactIds: [contact.hubspotContactId],
            companyName: contact.mappedCompany,
          },
          mappedName: contact.mappedCompany,
          mappedDomain: deriveEmailDomain(contact.mappedEmail),
          mappedPhone: contact.mappedPhone,
          mappedOwnerEmail: null,
          mappedLeadHint: contact.mappedEmail,
        });
      } else {
        (existing.rawData as any).contactIds.push(contact.hubspotContactId);
        existing.mappedDomain = existing.mappedDomain ?? deriveEmailDomain(contact.mappedEmail);
        existing.mappedPhone = existing.mappedPhone ?? contact.mappedPhone;
      }
    }

    console.log("[migration:extract] Fetching deals from HubSpot...");
    const hsDealsList = await fetchAllDeals();
    console.log(`[migration:extract] ${hsDealsList.length} deals fetched`);
    const mappedDeals = hsDealsList.map((deal) => mapDeal(deal, ownerEmailMap));
    const dealRows: Array<Record<string, unknown>> = [];
    const leadDrafts: Array<{
      leadKey: string;
      propertyKey: string;
      row: Record<string, unknown>;
    }> = [];
    const propertyDrafts = new Map<
      string,
      {
        hubspotPropertyId: string;
        rawData: Record<string, unknown>;
        mappedName: string | null;
        mappedCompanyName: string | null;
        mappedCompanyDomain: string | null;
        mappedAddress: string | null;
        mappedCity: string | null;
        mappedState: string | null;
        mappedZip: string | null;
        candidateCompanyCount: number;
        mappedOwnerEmail: string | null;
      }
    >();
    const leadCounts = new Map<string, number>();

    for (let i = 0; i < hsDealsList.length; i++) {
      const sourceDeal = hsDealsList[i];
      const mappedDeal = mappedDeals[i];
      const associatedContacts = sourceDeal.associations?.contacts?.results ?? [];
      const companyNames = Array.from(
        new Set(
          associatedContacts
            .map((assoc) => contactByHubspotId.get(assoc.id)?.mappedCompany)
            .filter((company): company is string => Boolean(company?.trim()))
            .map((company) => normalizeTextKey(company))
        )
      );
      const primaryCompanyName =
        associatedContacts
          .map((assoc) => contactByHubspotId.get(assoc.id)?.mappedCompany)
          .find((company) => Boolean(company?.trim())) ?? null;
      const primaryCompanyEmail =
        associatedContacts
          .map((assoc) => contactByHubspotId.get(assoc.id)?.mappedEmail)
          .find((email) => Boolean(email?.trim())) ?? null;
      const propertyKey = buildPropertyKey({
        address: sourceDeal.properties.address ?? null,
        city: sourceDeal.properties.city ?? null,
        state: sourceDeal.properties.state ?? null,
        zip: sourceDeal.properties.zip ?? null,
      });

      if (propertyKey.trim()) {
        const propertyName =
          [sourceDeal.properties.address, sourceDeal.properties.city, sourceDeal.properties.state, sourceDeal.properties.zip]
            .filter(Boolean)
            .join(", ") || mappedDeal.mappedName || null;
        const propertyId =
          `derived-property:${propertyKey.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || sourceDeal.id}`;
        const existingProperty = propertyDrafts.get(propertyKey);
        if (!existingProperty) {
          propertyDrafts.set(propertyKey, {
            hubspotPropertyId: propertyId,
            rawData: {
              source: "derived-from-deals",
              dealIds: [sourceDeal.id],
              propertyKey,
            },
            mappedName: propertyName,
            mappedCompanyName: primaryCompanyName,
            mappedCompanyDomain: primaryCompanyEmail ? deriveEmailDomain(primaryCompanyEmail) : null,
            mappedAddress: sourceDeal.properties.address ?? null,
            mappedCity: sourceDeal.properties.city ?? null,
            mappedState: sourceDeal.properties.state ?? null,
            mappedZip: sourceDeal.properties.zip ?? null,
            candidateCompanyCount: companyNames.length,
            mappedOwnerEmail: mappedDeal.mappedRepEmail,
          });
        } else {
          (existingProperty.rawData as any).dealIds.push(sourceDeal.id);
          existingProperty.mappedCompanyName = existingProperty.mappedCompanyName ?? primaryCompanyName;
          existingProperty.mappedCompanyDomain =
            existingProperty.mappedCompanyDomain ??
            (primaryCompanyEmail ? deriveEmailDomain(primaryCompanyEmail) : null);
          existingProperty.candidateCompanyCount = Math.max(
            existingProperty.candidateCompanyCount,
            companyNames.length
          );
        }
      }

      const isLeadStage = mappedDeal.mappedStage === "dd";
      if (isLeadStage) {
        const leadKey = `${normalizeTextKey(primaryCompanyName)}::${propertyKey}`;
        leadCounts.set(leadKey, (leadCounts.get(leadKey) ?? 0) + 1);
        leadDrafts.push({
          leadKey,
          propertyKey,
          row: {
            hubspotLeadId: sourceDeal.id,
            rawData: sourceDeal as unknown as Record<string, unknown>,
            mappedName: mappedDeal.mappedName,
            mappedCompanyName: primaryCompanyName,
            mappedPropertyName:
              [sourceDeal.properties.address, sourceDeal.properties.city, sourceDeal.properties.state, sourceDeal.properties.zip]
                .filter(Boolean)
                .join(", ") || mappedDeal.mappedName || null,
            mappedDealName: mappedDeal.mappedName,
            candidateDealCount: 0,
            candidatePropertyCount: 0,
            mappedOwnerEmail: mappedDeal.mappedRepEmail,
            mappedSourceStage: mappedDeal.mappedStage,
            mappedAmount: mappedDeal.mappedAmount != null ? String(mappedDeal.mappedAmount) : null,
            mappedCloseDate: mappedDeal.mappedCloseDate ? mappedDeal.mappedCloseDate : null,
            validationStatus: "pending",
            validationErrors: [],
            validationWarnings: [],
          },
        });
      } else {
        dealRows.push({
          hubspotDealId: mappedDeal.hubspotDealId,
          rawData: mappedDeal.rawData,
          mappedName: mappedDeal.mappedName,
          mappedStage: mappedDeal.mappedStage,
          mappedRepEmail: mappedDeal.mappedRepEmail,
          mappedAmount: mappedDeal.mappedAmount != null ? String(mappedDeal.mappedAmount) : null,
          mappedCloseDate: mappedDeal.mappedCloseDate ? mappedDeal.mappedCloseDate : null,
          mappedSource: mappedDeal.mappedSource,
          validationStatus: "pending",
          validationErrors: [],
          validationWarnings: [],
        });
      }
    }

    for (const lead of leadDrafts) {
      lead.row.candidateDealCount = leadCounts.get(lead.leadKey) ?? 0;
      lead.row.candidatePropertyCount = propertyDrafts.has(lead.propertyKey) ? 1 : 0;
    }

    let companyCount = 0;
    const companyList = Array.from(companyRows.values());
    for (let i = 0; i < companyList.length; i += BATCH) {
      const batch = companyList.slice(i, i + BATCH);
      await db
        .insert(stagedCompanies)
        .values(
          batch.map((company) => ({
            hubspotCompanyId: company.hubspotCompanyId,
            rawData: company.rawData,
            mappedName: company.mappedName,
            mappedDomain: company.mappedDomain,
            mappedPhone: company.mappedPhone,
            mappedOwnerEmail: company.mappedOwnerEmail,
            mappedLeadHint: company.mappedLeadHint,
            validationStatus: "pending",
            validationErrors: [],
            validationWarnings: [],
          }))
        )
        .onConflictDoNothing();

      companyCount += batch.length;
      process.stdout.write(`\r  Companies: ${companyCount}/${companyList.length}`);
    }
    if (companyList.length > 0) console.log(`\n[migration:extract] ${companyCount} companies staged`);

    let propertyCount = 0;
    const propertyList = Array.from(propertyDrafts.values());
    for (let i = 0; i < propertyList.length; i += BATCH) {
      const batch = propertyList.slice(i, i + BATCH);
      await db
        .insert(stagedProperties)
        .values(
          batch.map((property) => ({
            hubspotPropertyId: property.hubspotPropertyId,
            rawData: property.rawData,
            mappedName: property.mappedName,
            mappedCompanyName: property.mappedCompanyName,
            mappedCompanyDomain: property.mappedCompanyDomain,
            mappedAddress: property.mappedAddress,
            mappedCity: property.mappedCity,
            mappedState: property.mappedState,
            mappedZip: property.mappedZip,
            candidateCompanyCount: property.candidateCompanyCount,
            mappedOwnerEmail: property.mappedOwnerEmail,
            validationStatus: "pending",
            validationErrors: [],
            validationWarnings: [],
          }))
        )
        .onConflictDoNothing();

      propertyCount += batch.length;
      process.stdout.write(`\r  Properties: ${propertyCount}/${propertyList.length}`);
    }
    if (propertyList.length > 0) console.log(`\n[migration:extract] ${propertyCount} properties staged`);

    let leadCount = 0;
    const leadList = leadDrafts.map((lead) => lead.row);
    for (let i = 0; i < leadList.length; i += BATCH) {
      const batch = leadList.slice(i, i + BATCH);
      await db
        .insert(stagedLeads)
        .values(
          batch.map((lead) => ({
            hubspotLeadId: lead.hubspotLeadId as string,
            rawData: lead.rawData,
            mappedName: lead.mappedName,
            mappedCompanyName: lead.mappedCompanyName,
            mappedPropertyName: lead.mappedPropertyName,
            mappedDealName: lead.mappedDealName,
            candidateDealCount: lead.candidateDealCount,
            candidatePropertyCount: lead.candidatePropertyCount,
            mappedOwnerEmail: lead.mappedOwnerEmail,
            mappedSourceStage: lead.mappedSourceStage,
            mappedAmount: lead.mappedAmount != null ? String(lead.mappedAmount) : null,
            mappedCloseDate: lead.mappedCloseDate,
            validationStatus: "pending",
            validationErrors: [],
            validationWarnings: [],
          }))
        )
        .onConflictDoNothing();

      leadCount += batch.length;
      process.stdout.write(`\r  Leads: ${leadCount}/${leadList.length}`);
    }
    if (leadList.length > 0) console.log(`\n[migration:extract] ${leadCount} leads staged`);

    // 4. Extract and load post-RFP deals
    console.log("[migration:extract] Staging post-RFP deals...");
    let dealCount = 0;
    for (let i = 0; i < dealRows.length; i += BATCH) {
      const batch = dealRows.slice(i, i + BATCH);

      await db
        .insert(stagedDeals)
        .values(batch as any)
        .onConflictDoNothing();

      dealCount += batch.length;
      process.stdout.write(`\r  Deals: ${dealCount}/${dealRows.length}`);
    }
    if (dealRows.length > 0) console.log(`\n[migration:extract] ${dealCount} deals staged`);

    // 5. Extract and load activities
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
    const total = companyCount + propertyCount + leadCount + dealCount + contactCount + activityCount;
    await db
      .update(importRuns)
      .set({
        status: "completed",
        stats: {
          total,
          companies: companyCount,
          properties: propertyCount,
          leads: leadCount,
          deals: dealCount,
          contacts: contactCount,
          activities: activityCount,
        },
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
