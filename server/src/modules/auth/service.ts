import jwt from "jsonwebtoken";
import crypto from "crypto";
import { eq, and, like } from "drizzle-orm";
import { pool } from "../../db.js";
import { db } from "../../db.js";
import { offices, users, userOfficeAccess } from "@trock-crm/shared/schema";
import type { JwtClaims } from "@trock-crm/shared/types";
import { getUserLocalAuthGate } from "./local-auth-service.js";

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  const nodeEnv = process.env.NODE_ENV;
  const isLocalDevEnv = nodeEnv === "development" || nodeEnv === "test";
  if (!secret && !isLocalDevEnv) {
    throw new Error("JWT_SECRET must be set outside local development/test");
  }
  return secret || "dev-secret-change-in-production";
}

const JWT_EXPIRES_IN = "24h";

export function signJwt(claims: JwtClaims): string {
  return jwt.sign(claims, getJwtSecret(), { expiresIn: JWT_EXPIRES_IN });
}

export function verifyJwt(token: string): JwtClaims {
  return jwt.verify(token, getJwtSecret()) as JwtClaims;
}

export async function getUserById(userId: string) {
  const result = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return result[0] ?? null;
}

export async function getUserByEmail(email: string) {
  const result = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return result[0] ?? null;
}

export async function buildAuthenticatedUser(userId: string) {
  const user = await getUserById(userId);
  if (!user || !user.isActive) return null;

  const localAuthGate = await getUserLocalAuthGate(user.id);

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    officeId: user.officeId,
    activeOfficeId: user.officeId,
    mustChangePassword: localAuthGate.mustChangePassword,
  };
}

export async function getUserByAzureId(azureAdId: string) {
  const result = await db
    .select()
    .from(users)
    .where(eq(users.azureAdId, azureAdId))
    .limit(1);
  return result[0] ?? null;
}

export async function getDevUsers() {
  const result = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      officeId: users.officeId,
    })
    .from(users)
    .where(and(eq(users.isActive, true), like(users.email, "%@trock.dev")));
  return result;
}

export async function getOfficeBySlug(slug: string) {
  const normalized = slug.trim().toLowerCase();
  if (!normalized) return null;

  const result = await db
    .select()
    .from(offices)
    .where(eq(offices.slug, normalized))
    .limit(1);

  return result[0] ?? null;
}

export async function ensureDevUserPrimaryOffice(userId: string, preferredOfficeSlug = "dallas") {
  const user = await getUserById(userId);
  if (!user || !user.email.endsWith("@trock.dev")) {
    return user;
  }

  const office = await getOfficeBySlug(preferredOfficeSlug);
  if (!office || !office.isActive || user.officeId === office.id) {
    return user;
  }

  const [updatedUser] = await db
    .update(users)
    .set({ officeId: office.id })
    .where(eq(users.id, userId))
    .returning();

  return updatedUser ?? user;
}

function deterministicUuid(seed: string): string {
  const digest = crypto.createHash("sha1").update(seed).digest("hex").slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

export async function ensureDevDemoWorkspace(
  userId: string,
  preferredOfficeSlug = "dallas"
): Promise<void> {
  const user = await getUserById(userId);
  if (!user || !user.email.endsWith("@trock.dev")) {
    return;
  }

  const office = await getOfficeBySlug(preferredOfficeSlug);
  if (!office || !office.isActive) {
    return;
  }

  const repUser = await getUserByEmail("rep@trock.dev");
  const directorUser = await getUserByEmail("director@trock.dev");
  const adminUser = await getUserByEmail("admin@trock.dev");

  if (!repUser || !directorUser || !adminUser) {
    return;
  }

  const schemaName = `office_${office.slug}`;
  const client = await pool.connect();

  const companyId = deterministicUuid(`${schemaName}:demo-company`);
  const propertyId = deterministicUuid(`${schemaName}:demo-property`);
  const contactId = deterministicUuid(`${schemaName}:demo-contact`);
  const staleLeadId = deterministicUuid(`${schemaName}:demo-stale-lead`);
  const freshLeadId = deterministicUuid(`${schemaName}:demo-fresh-lead`);
  const estimatingDealId = deterministicUuid(`${schemaName}:demo-estimating-deal`);
  const productionDealId = deterministicUuid(`${schemaName}:demo-production-deal`);
  const wonDealId = deterministicUuid(`${schemaName}:demo-won-deal`);
  const lostDealId = deterministicUuid(`${schemaName}:demo-lost-deal`);

  const today = new Date();
  const todayIso = today.toISOString();
  const todayDate = today.toISOString().slice(0, 10);
  const overdueDate = new Date(today);
  overdueDate.setDate(overdueDate.getDate() - 2);
  const overdueDateStr = overdueDate.toISOString().slice(0, 10);

  const thisWeek = new Date(today);
  thisWeek.setDate(thisWeek.getDate() - 2);
  const weekIso = thisWeek.toISOString();

  const lastMonth = new Date(today);
  lastMonth.setMonth(lastMonth.getMonth() - 1);
  const lastMonthIso = lastMonth.toISOString();
  const lastMonthDate = lastMonth.toISOString().slice(0, 10);

  const staleLeadEntered = new Date(today);
  staleLeadEntered.setDate(staleLeadEntered.getDate() - 24);
  const staleLeadEnteredIso = staleLeadEntered.toISOString();

  const freshLeadEntered = new Date(today);
  freshLeadEntered.setDate(freshLeadEntered.getDate() - 3);
  const freshLeadEnteredIso = freshLeadEntered.toISOString();

  const staleDealEntered = new Date(today);
  staleDealEntered.setDate(staleDealEntered.getDate() - 18);
  const staleDealEnteredIso = staleDealEntered.toISOString();

  const activeDealEntered = new Date(today);
  activeDealEntered.setDate(activeDealEntered.getDate() - 6);
  const activeDealEnteredIso = activeDealEntered.toISOString();

  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('search_path', $1, true)", [`${schemaName},public`]);
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [adminUser.id]);

    const stageResult = await client.query(
      `
        SELECT id, slug
        FROM public.pipeline_stage_config
        WHERE slug = ANY($1)
      `,
      [["contacted", "estimating", "in_production", "closed_won", "closed_lost"]]
    );

    const stageBySlug = new Map(stageResult.rows.map((row) => [row.slug, row.id]));
    const contactedStageId = stageBySlug.get("contacted");
    const estimatingStageId = stageBySlug.get("estimating");
    const productionStageId = stageBySlug.get("in_production");
    const closedWonStageId = stageBySlug.get("closed_won");
    const closedLostStageId = stageBySlug.get("closed_lost");

    if (!contactedStageId || !estimatingStageId || !productionStageId || !closedWonStageId || !closedLostStageId) {
      await client.query("ROLLBACK");
      return;
    }

    await client.query(
      `
        INSERT INTO companies (id, name, slug, category, address, city, state, zip, phone, website, notes, is_active)
        VALUES ($1, $2, $3, 'client', $4, $5, $6, $7, $8, $9, $10, true)
        ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name,
            slug = EXCLUDED.slug,
            address = EXCLUDED.address,
            city = EXCLUDED.city,
            state = EXCLUDED.state,
            zip = EXCLUDED.zip,
            phone = EXCLUDED.phone,
            website = EXCLUDED.website,
            notes = EXCLUDED.notes,
            is_active = true,
            updated_at = NOW()
      `,
      [
        companyId,
        "Birchstone Demo Holdings",
        "birchstone-demo-holdings",
        "4800 Spring Valley Rd",
        "Dallas",
        "TX",
        "75244",
        "(972) 555-0147",
        "https://demo.birchstone.local",
        "Demo company seeded for director and rep detail walkthroughs.",
      ]
    );

    await client.query(
      `
        INSERT INTO properties (id, company_id, name, address, city, state, zip, notes, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
        ON CONFLICT (id) DO UPDATE
        SET company_id = EXCLUDED.company_id,
            name = EXCLUDED.name,
            address = EXCLUDED.address,
            city = EXCLUDED.city,
            state = EXCLUDED.state,
            zip = EXCLUDED.zip,
            notes = EXCLUDED.notes,
            is_active = true,
            updated_at = NOW()
      `,
      [
        propertyId,
        companyId,
        "Birchstone Dallas Medical Plaza",
        "4800 Spring Valley Rd",
        "Dallas",
        "TX",
        "75244",
        "Demo property used for seeded lead/deal lifecycle flows.",
      ]
    );

    await client.query(
      `
        INSERT INTO contacts (
          id, first_name, last_name, email, phone, mobile, company_name, company_id,
          job_title, category, address, city, state, zip, notes, is_active
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'client', $10, $11, $12, $13, $14, true)
        ON CONFLICT (id) DO UPDATE
        SET first_name = EXCLUDED.first_name,
            last_name = EXCLUDED.last_name,
            email = EXCLUDED.email,
            phone = EXCLUDED.phone,
            mobile = EXCLUDED.mobile,
            company_name = EXCLUDED.company_name,
            company_id = EXCLUDED.company_id,
            job_title = EXCLUDED.job_title,
            address = EXCLUDED.address,
            city = EXCLUDED.city,
            state = EXCLUDED.state,
            zip = EXCLUDED.zip,
            notes = EXCLUDED.notes,
            is_active = true,
            updated_at = NOW()
      `,
      [
        contactId,
        "Bridget",
        "Manager",
        "bridget.manager@birchstone-demo.local",
        "(972) 555-0188",
        "(214) 555-0199",
        "Birchstone Demo Holdings",
        companyId,
        "Regional Facilities Manager",
        "4800 Spring Valley Rd",
        "Dallas",
        "TX",
        "75244",
        "Primary demo contact for seeded sales activity.",
      ]
    );

    await client.query(
      `
        INSERT INTO leads (
          id, company_id, property_id, primary_contact_id, name, stage_id, assigned_rep_id, status,
          source, description, last_activity_at, stage_entered_at, is_active
        )
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10, $11, true),
          ($12, $2, $3, $4, $13, $6, $7, 'open', $14, $15, $16, $17, true)
        ON CONFLICT (id) DO UPDATE
        SET company_id = EXCLUDED.company_id,
            property_id = EXCLUDED.property_id,
            primary_contact_id = EXCLUDED.primary_contact_id,
            name = EXCLUDED.name,
            stage_id = EXCLUDED.stage_id,
            assigned_rep_id = EXCLUDED.assigned_rep_id,
            status = EXCLUDED.status,
            source = EXCLUDED.source,
            description = EXCLUDED.description,
            last_activity_at = EXCLUDED.last_activity_at,
            stage_entered_at = EXCLUDED.stage_entered_at,
            is_active = true,
            updated_at = NOW()
      `,
      [
        staleLeadId,
        companyId,
        propertyId,
        contactId,
        "Birchstone roof replacement lead",
        contactedStageId,
        repUser.id,
        "Referral",
        "Lead seeded to demonstrate stale lead watchlists and director intervention.",
        weekIso,
        staleLeadEnteredIso,
        freshLeadId,
        "Birchstone service expansion lead",
        "Trade Show",
        "Fresh lead seeded to show active lead-stage pipeline.",
        todayIso,
        freshLeadEnteredIso,
      ]
    );

    await client.query(
      `
        INSERT INTO leads (id, company_id, property_id, primary_contact_id, name, stage_id, assigned_rep_id, status, source, description, last_activity_at, stage_entered_at, is_active, converted_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'converted', $8, $9, $10, $11, false, $12)
        ON CONFLICT (id) DO UPDATE
        SET status = 'converted',
            converted_at = EXCLUDED.converted_at,
            is_active = false,
            updated_at = NOW()
      `,
      [
        deterministicUuid(`${schemaName}:demo-converted-lead`),
        companyId,
        propertyId,
        contactId,
        "Birchstone awarded project lead",
        contactedStageId,
        repUser.id,
        "Referral",
        "Converted lead backing the seeded closed won deal.",
        lastMonthIso,
        lastMonthIso,
        lastMonthIso,
      ]
    );

    const convertedLeadId = deterministicUuid(`${schemaName}:demo-converted-lead`);

    await client.query(
      `
        INSERT INTO deals (
          id, deal_number, name, stage_id, assigned_rep_id, primary_contact_id, company_id, property_id, source_lead_id,
          dd_estimate, bid_estimate, awarded_amount, description, property_address, property_city, property_state, property_zip,
          source, workflow_route, last_activity_at, stage_entered_at, is_active, expected_close_date, actual_close_date, lost_at, lost_notes
        )
        VALUES
          ($1, 'TR-DEMO-001', 'Birchstone North Tower Reroof', $2, $3, $4, $5, $6, NULL, 180000, 245000, NULL, $7, $8, $9, $10, $11, 'Referral', 'normal', $12, $13, true, $14, NULL, NULL, NULL),
          ($15, 'TR-DEMO-002', 'Birchstone Parking Garage Waterproofing', $16, $3, $4, $5, $6, NULL, 92000, 128000, NULL, $17, $8, $9, $10, $11, 'Trade Show', 'normal', $18, $19, true, $20, NULL, NULL, NULL),
          ($21, 'TR-DEMO-003', 'Birchstone Interior Water Damage Repair', $22, $3, $4, $5, $6, $23, 65000, 84000, 91000, $24, $8, $9, $10, $11, 'Referral', 'normal', $25, $26, true, $27, $28, NULL, NULL),
          ($29, 'TR-DEMO-004', 'Birchstone East Annex Coating Bid', $30, $3, $4, $5, $6, NULL, 74000, 99000, NULL, $31, $8, $9, $10, $11, 'Outbound', 'normal', $32, $33, false, $34, NULL, $35, 'Lost to incumbent vendor on price.')
        ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name,
            stage_id = EXCLUDED.stage_id,
            assigned_rep_id = EXCLUDED.assigned_rep_id,
            primary_contact_id = EXCLUDED.primary_contact_id,
            company_id = EXCLUDED.company_id,
            property_id = EXCLUDED.property_id,
            source_lead_id = EXCLUDED.source_lead_id,
            dd_estimate = EXCLUDED.dd_estimate,
            bid_estimate = EXCLUDED.bid_estimate,
            awarded_amount = EXCLUDED.awarded_amount,
            description = EXCLUDED.description,
            property_address = EXCLUDED.property_address,
            property_city = EXCLUDED.property_city,
            property_state = EXCLUDED.property_state,
            property_zip = EXCLUDED.property_zip,
            source = EXCLUDED.source,
            workflow_route = EXCLUDED.workflow_route,
            last_activity_at = EXCLUDED.last_activity_at,
            stage_entered_at = EXCLUDED.stage_entered_at,
            is_active = EXCLUDED.is_active,
            expected_close_date = EXCLUDED.expected_close_date,
            actual_close_date = EXCLUDED.actual_close_date,
            lost_at = EXCLUDED.lost_at,
            lost_notes = EXCLUDED.lost_notes,
            updated_at = NOW()
      `,
      [
        estimatingDealId,
        estimatingStageId,
        repUser.id,
        contactId,
        companyId,
        propertyId,
        "Active estimating deal seeded for director and rep detail demos.",
        "4800 Spring Valley Rd",
        "Dallas",
        "TX",
        "75244",
        todayIso,
        staleDealEnteredIso,
        new Date(today.getTime() + 1000 * 60 * 60 * 24 * 21).toISOString().slice(0, 10),
        productionDealId,
        productionStageId,
        "In production deal seeded to show active pipeline breadth.",
        weekIso,
        activeDealEnteredIso,
        new Date(today.getTime() + 1000 * 60 * 60 * 24 * 45).toISOString().slice(0, 10),
        wonDealId,
        closedWonStageId,
        convertedLeadId,
        "Recently won deal seeded for win-rate trend and close metrics.",
        lastMonthIso,
        lastMonthIso,
        lastMonthDate,
        lastMonthDate,
        lostDealId,
        closedLostStageId,
        "Recently lost deal seeded for loss reporting and trend contrast.",
        lastMonthIso,
        lastMonthIso,
        lastMonthDate,
        lastMonthIso,
      ]
    );

    await client.query(
      `
        INSERT INTO deal_stage_history (
          id, deal_id, from_stage_id, to_stage_id, changed_by, is_backward_move, is_director_override, created_at
        )
        VALUES
          ($1, $2, NULL, $3, $4, false, false, $5),
          ($6, $7, NULL, $8, $4, false, false, $9)
        ON CONFLICT (id) DO UPDATE
        SET to_stage_id = EXCLUDED.to_stage_id,
            changed_by = EXCLUDED.changed_by,
            created_at = EXCLUDED.created_at
      `,
      [
        deterministicUuid(`${schemaName}:demo-history-won`),
        wonDealId,
        closedWonStageId,
        directorUser.id,
        lastMonthIso,
        deterministicUuid(`${schemaName}:demo-history-lost`),
        lostDealId,
        closedLostStageId,
        lastMonthIso,
      ]
    );

    await client.query(
      `
        INSERT INTO lead_stage_history (id, lead_id, from_stage_id, to_stage_id, changed_by, created_at)
        VALUES
          ($1, $2, NULL, $3, $4, $5),
          ($6, $7, NULL, $3, $4, $8)
        ON CONFLICT (id) DO UPDATE
        SET to_stage_id = EXCLUDED.to_stage_id,
            changed_by = EXCLUDED.changed_by,
            created_at = EXCLUDED.created_at
      `,
      [
        deterministicUuid(`${schemaName}:demo-history-stale-lead`),
        staleLeadId,
        contactedStageId,
        directorUser.id,
        staleLeadEnteredIso,
        deterministicUuid(`${schemaName}:demo-history-fresh-lead`),
        freshLeadId,
        freshLeadEnteredIso,
      ]
    );

    await client.query(
      `
        INSERT INTO tasks (
          id, title, description, type, priority, status, assigned_to, created_by, office_id, deal_id, due_date, completed_at, created_at, updated_at
        )
        VALUES
          ($1, 'Call Bridget about revised roof scope', 'Seeded demo follow-up task due today.', 'follow_up', 'high', 'pending', $2, $3, $4, $5, $6, NULL, NOW(), NOW()),
          ($7, 'Follow up on garage waterproofing approvals', 'Seeded overdue task for dashboard urgency.', 'follow_up', 'urgent', 'pending', $2, $3, $4, $8, $9, NULL, NOW(), NOW()),
          ($10, 'Send recap after site walk', 'Completed follow-up used for compliance calculations.', 'follow_up', 'normal', 'completed', $2, $3, $4, $5, $11, NOW(), NOW(), NOW()),
          ($12, 'Closed-lost postmortem recap', 'Dismissed follow-up used for compliance calculations.', 'follow_up', 'normal', 'dismissed', $2, $3, $4, $13, $14, NULL, NOW(), NOW())
        ON CONFLICT (id) DO UPDATE
        SET title = EXCLUDED.title,
            description = EXCLUDED.description,
            status = EXCLUDED.status,
            assigned_to = EXCLUDED.assigned_to,
            created_by = EXCLUDED.created_by,
            office_id = EXCLUDED.office_id,
            deal_id = EXCLUDED.deal_id,
            due_date = EXCLUDED.due_date,
            completed_at = EXCLUDED.completed_at,
            updated_at = NOW()
      `,
      [
        deterministicUuid(`${schemaName}:demo-task-today`),
        repUser.id,
        directorUser.id,
        office.id,
        estimatingDealId,
        todayDate,
        deterministicUuid(`${schemaName}:demo-task-overdue`),
        productionDealId,
        overdueDateStr,
        deterministicUuid(`${schemaName}:demo-task-completed`),
        todayDate,
        deterministicUuid(`${schemaName}:demo-task-dismissed`),
        lostDealId,
        lastMonthDate,
      ]
    );

    await client.query(
      `
        INSERT INTO activities (
          id, type, responsible_user_id, performed_by_user_id, source_entity_type, source_entity_id,
          company_id, property_id, lead_id, deal_id, contact_id, subject, body, outcome, occurred_at
        )
        VALUES
          ($1, 'call', $2, $2, 'deal', $3, $4, $5, NULL, $3, $6, 'Scope clarification call', 'Reviewed the updated roof replacement phasing and next steps.', 'connected', $7),
          ($8, 'email', $2, $2, 'deal', $3, $4, $5, NULL, $3, $6, 'Proposal follow-up email', 'Sent the revised budget summary and requested decision timing.', NULL, $9),
          ($10, 'meeting', $2, $11, 'deal', $12, $4, $5, NULL, $12, $6, 'Site walk meeting', 'Walked the garage waterproofing conditions with the client team.', NULL, $13),
          ($14, 'note', $2, $2, 'lead', $15, $4, $5, $15, NULL, $6, 'Lead qualification note', 'Documented urgency, funding confidence, and next outreach plan.', NULL, $16)
        ON CONFLICT (id) DO UPDATE
        SET responsible_user_id = EXCLUDED.responsible_user_id,
            performed_by_user_id = EXCLUDED.performed_by_user_id,
            source_entity_type = EXCLUDED.source_entity_type,
            source_entity_id = EXCLUDED.source_entity_id,
            company_id = EXCLUDED.company_id,
            property_id = EXCLUDED.property_id,
            lead_id = EXCLUDED.lead_id,
            deal_id = EXCLUDED.deal_id,
            contact_id = EXCLUDED.contact_id,
            subject = EXCLUDED.subject,
            body = EXCLUDED.body,
            outcome = EXCLUDED.outcome,
            occurred_at = EXCLUDED.occurred_at
      `,
      [
        deterministicUuid(`${schemaName}:demo-activity-call`),
        repUser.id,
        estimatingDealId,
        companyId,
        propertyId,
        contactId,
        weekIso,
        deterministicUuid(`${schemaName}:demo-activity-email`),
        new Date(today.getTime() - 1000 * 60 * 60 * 20).toISOString(),
        deterministicUuid(`${schemaName}:demo-activity-meeting`),
        directorUser.id,
        productionDealId,
        new Date(today.getTime() - 1000 * 60 * 60 * 28).toISOString(),
        deterministicUuid(`${schemaName}:demo-activity-note`),
        staleLeadId,
        new Date(today.getTime() - 1000 * 60 * 60 * 36).toISOString(),
      ]
    );

    await client.query(
      `
        UPDATE deals
        SET last_activity_at = data.last_activity_at
        FROM (
          VALUES
            ($1::uuid, $2::timestamptz),
            ($3::uuid, $4::timestamptz)
        ) AS data(id, last_activity_at)
        WHERE deals.id = data.id
      `,
      [
        estimatingDealId,
        todayIso,
        productionDealId,
        weekIso,
      ]
    );

    await client.query(
      `
        UPDATE leads
        SET last_activity_at = data.last_activity_at
        FROM (
          VALUES
            ($1::uuid, $2::timestamptz),
            ($3::uuid, $4::timestamptz)
        ) AS data(id, last_activity_at)
        WHERE leads.id = data.id
      `,
      [
        staleLeadId,
        new Date(today.getTime() - 1000 * 60 * 60 * 36).toISOString(),
        freshLeadId,
        todayIso,
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function canAccessOffice(userId: string, officeId: string): Promise<boolean> {
  const { hasAccess } = await getOfficeAccess(userId, officeId);
  return hasAccess;
}

/**
 * Check office access AND return the role_override if one exists.
 * Primary office always has access with no override.
 */
export async function getOfficeAccess(
  userId: string,
  officeId: string,
): Promise<{ hasAccess: boolean; roleOverride?: string }> {
  const user = await getUserById(userId);
  if (!user) return { hasAccess: false };
  if (user.officeId === officeId) return { hasAccess: true }; // Primary office, no override

  // Check user_office_access for cross-office access + role override
  const rows = await db
    .select()
    .from(userOfficeAccess)
    .where(eq(userOfficeAccess.userId, userId))
    .limit(100);

  const access = rows.find((a) => a.officeId === officeId);
  if (!access) return { hasAccess: false };
  return { hasAccess: true, roleOverride: access.roleOverride || undefined };
}

export async function getAccessibleOffices(
  userId: string,
  userRole: string,
  primaryOfficeId: string
): Promise<Array<{ id: string; name: string; slug: string }>> {
  if (userRole === "admin") {
    const result = await pool.query<{ id: string; name: string; slug: string }>(
      "SELECT id, name, slug FROM public.offices WHERE is_active = true ORDER BY name"
    );
    return result.rows;
  }

  const result = await pool.query<{ id: string; name: string; slug: string }>(
    `SELECT DISTINCT o.id, o.name, o.slug
     FROM public.offices o
     WHERE o.is_active = true
       AND (
         o.id = $1
         OR o.id IN (
           SELECT office_id FROM public.user_office_access
           WHERE user_id = $2
         )
       )
     ORDER BY o.name`,
    [primaryOfficeId, userId]
  );

  return result.rows;
}
