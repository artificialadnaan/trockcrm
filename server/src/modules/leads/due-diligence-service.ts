import crypto from "crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  companies,
  contacts,
  leadDueDiligenceApprovals,
  leads,
  notificationRecipientAssignments,
  notificationRecipientGroups,
  projectTypeConfig,
  properties,
  users,
} from "@trock-crm/shared/schema";
import * as schema from "@trock-crm/shared/schema";
import { pool, releasePooledClient } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import { sendSystemEmailWithMetadata } from "../../lib/resend-client.js";
import { getStageBySlug } from "../pipeline/service.js";
import { transitionLeadStage } from "./service.js";
import { buildAuditActorFromSystem } from "../audit/audit-logger.js";
import { DUE_DILIGENCE_WORKER } from "../audit/system-processes.js";
import type {
  ExistingCustomerSignal,
  LeadDueDiligenceDetectionSignal,
} from "@trock-crm/shared/types";

type TenantDb = NodePgDatabase<typeof schema>;

export type DueDiligenceStatus = "pending" | "approved" | "rejected" | "superseded";

const GROUP_KEY = "lead_due_diligence";

const POC_ROLE_LABELS: Record<string, string> = {
  property_manager: "Property Manager",
  construction_manager: "Construction Manager",
  director: "Director",
  regional_manager: "Regional Manager",
  regional_vp: "Regional VP",
  vp: "VP",
  asset_manager: "Asset Manager",
  facilities_manager: "Facilities Manager",
  project_manager: "Project Manager",
  other: "Other",
};

const BUDGET_STATUS_LABELS: Record<string, string> = {
  budgeted_q1: "Budgeted Q1",
  budgeted_q2: "Budgeted Q2",
  budgeted_q3: "Budgeted Q3",
  budgeted_q4: "Budgeted Q4",
  not_budgeted: "Not Budgeted",
};

function generateApprovalToken() {
  return crypto.randomBytes(32).toString("hex");
}

export function assertSafeTenantSchema(name: string): asserts name is string {
  if (!/^office_[a-z0-9_]+$/.test(name)) {
    throw new AppError(500, "Invalid tenant schema name");
  }
}

export function assertSafeOfficeSlug(slug: string): asserts slug is string {
  if (!/^[a-z0-9_]+$/.test(slug)) {
    throw new AppError(500, "Invalid office slug");
  }
}

function tenantSchemaIdentifier(name: string) {
  assertSafeTenantSchema(name);
  return `"${name}"`;
}

function formatDate(value: string | Date | null | undefined) {
  if (!value) return "Not provided";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function baseApiUrl() {
  return (process.env.API_BASE_URL ?? process.env.FRONTEND_URL ?? "http://localhost:3001").replace(/\/$/, "");
}

export function buildLeadDueDiligenceReviewUrl(token: string) {
  return `${baseApiUrl()}/api/public/lead-due-diligence/${encodeURIComponent(token)}`;
}

export async function getLeadDueDiligenceRecipients(tenantDb: TenantDb, key = GROUP_KEY) {
  const rows = await tenantDb
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
    })
    .from(notificationRecipientGroups)
    .innerJoin(notificationRecipientAssignments, eq(notificationRecipientAssignments.groupId, notificationRecipientGroups.id))
    .innerJoin(users, eq(users.id, notificationRecipientAssignments.userId))
    .where(and(eq(notificationRecipientGroups.key, key), eq(users.isActive, true)));

  if (rows.length > 0 || key !== GROUP_KEY) {
    return rows;
  }

  return tenantDb
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
    })
    .from(users)
    .where(and(inArray(users.role, ["admin", "director"]), eq(users.isActive, true)));
}

async function getLeadSummary(tenantDb: TenantDb, leadId: string) {
  const [row] = await tenantDb
    .select({
      leadId: leads.id,
      leadName: leads.name,
      bidDueDate: leads.bidDueDate,
      budgetStatus: leads.budgetStatus,
      primaryContactRole: leads.primaryContactRole,
      primaryContactRoleOtherLabel: leads.primaryContactRoleOtherLabel,
      companyName: companies.name,
      companyVerificationStatus: companies.companyVerificationStatus,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
      propertyName: properties.name,
      propertyAddress: properties.address,
      propertyCity: properties.city,
      propertyState: properties.state,
      propertyZip: properties.zip,
      propertyUnitCount: properties.unitCount,
      propertyBuildYear: properties.buildYear,
      projectTypeName: projectTypeConfig.name,
    })
    .from(leads)
    .innerJoin(companies, eq(companies.id, leads.companyId))
    .innerJoin(properties, eq(properties.id, leads.propertyId))
    .leftJoin(contacts, eq(contacts.id, leads.primaryContactId))
    .leftJoin(projectTypeConfig, eq(projectTypeConfig.id, leads.projectTypeId))
    .where(eq(leads.id, leadId))
    .limit(1);

  if (!row) {
    throw new AppError(404, "Lead not found");
  }

  return row;
}

function formatAddress(summary: Awaited<ReturnType<typeof getLeadSummary>>) {
  return [
    summary.propertyAddress,
    summary.propertyCity,
    summary.propertyState,
    summary.propertyZip,
  ].filter(Boolean).join(", ");
}

function formatContact(summary: Awaited<ReturnType<typeof getLeadSummary>>) {
  const name = [summary.contactFirstName, summary.contactLastName].filter(Boolean).join(" ");
  return name || "Not provided";
}

function formatPocRole(summary: Awaited<ReturnType<typeof getLeadSummary>>) {
  if (summary.primaryContactRole === "other") {
    return summary.primaryContactRoleOtherLabel ?? "Other";
  }
  return summary.primaryContactRole
    ? POC_ROLE_LABELS[summary.primaryContactRole] ?? summary.primaryContactRole
    : "Not provided";
}

function formatPocRoleValue(role: string | null | undefined, otherLabel?: string | null) {
  if (role === "other") {
    return otherLabel ?? "Other";
  }
  return role ? POC_ROLE_LABELS[role] ?? role : "Not provided";
}

function formatBudgetStatus(summary: Awaited<ReturnType<typeof getLeadSummary>>) {
  return summary.budgetStatus
    ? BUDGET_STATUS_LABELS[summary.budgetStatus] ?? summary.budgetStatus
    : "Not provided";
}

function formatBudgetStatusValue(status: string | null | undefined) {
  return status ? BUDGET_STATUS_LABELS[status] ?? status : "Not provided";
}

function detectionExplanation(signal: ExistingCustomerSignal | null) {
  if (!signal) {
    return "No activity found on company, contact, or property in the last 12 months.";
  }
  return `${signal.detail} on ${formatDate(signal.occurredAt)}.`;
}

export function buildLeadDueDiligenceEmail(input: {
  summary: Awaited<ReturnType<typeof getLeadSummary>>;
  token: string;
  detectionSignal: ExistingCustomerSignal | null;
}) {
  const reviewUrl = buildLeadDueDiligenceReviewUrl(input.token);
  const contactName = formatContact(input.summary);
  const role = formatPocRole(input.summary);
  const email = input.summary.contactEmail;
  const contactLine = email ? `${contactName} (${role}) · ${email}` : `${contactName} (${role})`;
  const rows = [
    ["Lead", input.summary.leadName],
    ["Company", `${input.summary.companyName} (${input.summary.companyVerificationStatus ?? "not_required"})`],
    ["Primary contact", contactLine],
    ["Property", formatAddress(input.summary)],
    ["Units", input.summary.propertyUnitCount ?? "Not provided"],
    ["Year built", input.summary.propertyBuildYear ?? "Not provided"],
    ["Project type", input.summary.projectTypeName ?? "Not provided"],
    ["Budget status", formatBudgetStatus(input.summary)],
    ["Bid due date", formatDate(input.summary.bidDueDate)],
    ["Why flagged", detectionExplanation(input.detectionSignal)],
  ];

  return {
    subject: "Due Diligence for New Lead/Company",
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#111827;line-height:1.5">
        <h1 style="font-size:20px;margin:0 0 16px">Due Diligence for New Lead/Company</h1>
        <table style="border-collapse:collapse;width:100%;max-width:720px">
          ${rows.map(([label, value]) => `
            <tr>
              <th style="text-align:left;border:1px solid #d1d5db;padding:8px;background:#f9fafb;width:180px">${escapeHtml(label)}</th>
              <td style="border:1px solid #d1d5db;padding:8px">${escapeHtml(value)}</td>
            </tr>
          `).join("")}
        </table>
        <p style="margin:20px 0 0">
          <a href="${escapeHtml(reviewUrl)}" style="display:inline-block;background:#991b1b;color:#fff;text-decoration:none;padding:10px 14px;border-radius:4px;font-weight:700">Review and decide</a>
        </p>
      </div>
    `,
  };
}

export async function createLeadDueDiligenceApproval(tenantDb: TenantDb, input: {
  leadId: string;
  requestedBy: string;
  detectionSignal: ExistingCustomerSignal | null;
  now: Date;
}) {
  const token = generateApprovalToken();
  const detectionSignal: LeadDueDiligenceDetectionSignal = input.detectionSignal ?? {
    source: "none",
    type: "no_recent_activity",
    occurredAt: null,
    detail: "No activity found on company, contact, or property in the last 12 months.",
  };
  let approval: typeof leadDueDiligenceApprovals.$inferSelect;
  try {
    [approval] = await tenantDb
      .insert(leadDueDiligenceApprovals)
      .values({
        leadId: input.leadId,
        status: "pending",
        approvalToken: token,
        requestedBy: input.requestedBy,
        requestedAt: input.now,
        detectionSignal,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning();
  } catch (err: any) {
    if (err?.code === "23505" && String(err?.constraint ?? "").includes("lead_uidx")) {
      throw new AppError(
        409,
        "A Due Diligence approval already exists for this lead. createLeadDueDiligenceApproval should only be called once per lead."
      );
    }
    throw err;
  }

  return approval;
}

export async function getLeadDueDiligenceApprovalForLead(tenantDb: TenantDb, leadId: string) {
  const [approval] = await tenantDb
    .select()
    .from(leadDueDiligenceApprovals)
    .where(eq(leadDueDiligenceApprovals.leadId, leadId))
    .orderBy(desc(leadDueDiligenceApprovals.requestedAt))
    .limit(1);
  return approval ?? null;
}

export async function dispatchPendingDueDiligenceEmail(
  tenantDb: TenantDb,
  approvalId: string,
  options: { now: Date }
): Promise<{ success: boolean; messageId: string | null }> {
  try {
    const [approval] = await tenantDb
      .select()
      .from(leadDueDiligenceApprovals)
      .where(eq(leadDueDiligenceApprovals.id, approvalId))
      .limit(1);

    if (!approval || approval.status !== "pending" || approval.emailSentAt !== null) {
      return { success: false, messageId: null };
    }

    const recipients = await getLeadDueDiligenceRecipients(tenantDb);
    if (recipients.length === 0) {
      console.warn(`[lead-dd] pending due diligence approval ${approval.id} has no configured recipients`);
      return { success: false, messageId: null };
    }

    const summary = await getLeadSummary(tenantDb, approval.leadId);
    const detectionSignal =
      approval.detectionSignal.source === "none" ? null : approval.detectionSignal;
    const email = buildLeadDueDiligenceEmail({
      summary,
      token: approval.approvalToken,
      detectionSignal,
    });
    const sent = await sendSystemEmailWithMetadata(
      recipients.map((recipient) => recipient.email),
      email.subject,
      email.html
    );

    if (!sent.success) {
      // TODO: Add a director/admin "resend DD email" action for approvals
      // left pending with email_sent_at null after a transient email failure.
      return sent;
    }

    await tenantDb
      .update(leadDueDiligenceApprovals)
      .set({
        emailSentAt: options.now,
        emailMessageId: sent.messageId,
        updatedAt: options.now,
      })
      .where(eq(leadDueDiligenceApprovals.id, approval.id));

    return sent;
  } catch (err) {
    console.error("[lead-dd] failed to dispatch due diligence email", {
      approvalId,
      err,
    });
    return { success: false, messageId: null };
  }
}

export async function listLeadDueDiligenceApprovals(tenantDb: TenantDb, status: DueDiligenceStatus = "pending") {
  const result = await tenantDb.execute(sql`
    SELECT
      a.id,
      a.lead_id,
      a.status,
      a.requested_at,
      a.decided_at,
      a.decision_reason,
      a.detection_signal,
      a.email_sent_at,
      a.email_message_id,
      l.name AS lead_name,
      l.primary_contact_role,
      l.primary_contact_role_other_label,
      l.budget_status,
      l.bid_due_date,
      c.name AS company_name,
      c.company_verification_status,
      p.address AS property_address,
      p.city AS property_city,
      p.state AS property_state,
      p.zip AS property_zip,
      p.unit_count,
      p.build_year,
      pt.name AS project_type_name,
      concat_ws(' ', ct.first_name, ct.last_name) AS primary_contact_name,
      ct.email AS primary_contact_email,
      requested_by.display_name AS requested_by_name,
      decided_by.display_name AS decided_by_name
    FROM lead_due_diligence_approvals a
    JOIN leads l ON l.id = a.lead_id
    JOIN companies c ON c.id = l.company_id
    JOIN properties p ON p.id = l.property_id
    LEFT JOIN contacts ct ON ct.id = l.primary_contact_id
    LEFT JOIN public.project_type_config pt ON pt.id = l.project_type_id
    JOIN public.users requested_by ON requested_by.id = a.requested_by
    LEFT JOIN public.users decided_by ON decided_by.id = a.decided_by
    WHERE a.status = ${status}
    ORDER BY a.requested_at DESC
  `);

  return (result as { rows: unknown[] }).rows;
}

export async function decideLeadDueDiligenceApproval(tenantDb: TenantDb, input: {
  approvalId: string;
  decision: "approve" | "reject";
  reason?: string | null;
  userId: string;
  now?: Date;
}) {
  if (input.decision === "reject" && (!input.reason || input.reason.trim().length < 10)) {
    throw new AppError(400, "Rejection reason must be at least 10 characters");
  }

  const now = input.now ?? new Date();
  const status = input.decision === "approve" ? "approved" : "rejected";
  const verificationStatus = input.decision === "approve" ? "approved" : "rejected";

  const [approval] = await tenantDb
    .update(leadDueDiligenceApprovals)
    .set({
      status,
      decidedBy: input.userId,
      decidedAt: now,
      decisionReason: input.decision === "reject" ? input.reason?.trim() ?? null : null,
      updatedAt: now,
    })
    .where(and(eq(leadDueDiligenceApprovals.id, input.approvalId), eq(leadDueDiligenceApprovals.status, "pending")))
    .returning();

  if (!approval) {
    throw new AppError(409, "Due Diligence approval is no longer pending");
  }

  // verification_status is a compat mirror; lead_due_diligence_approvals is the
  // source of truth for stage gating.
  await tenantDb
    .update(leads)
    .set({ verificationStatus, updatedAt: now })
    .where(eq(leads.id, approval.leadId));

  if (status === "approved") {
    await maybeAutoTransitionAfterDdApproval(tenantDb, {
      leadId: approval.leadId,
      actorUserId: input.userId,
    });
  }

  return approval;
}

async function fetchLeadStageId(tenantDb: TenantDb, leadId: string) {
  const [lead] = await tenantDb
    .select({ stageId: leads.stageId })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  return lead?.stageId ?? null;
}

async function maybeAutoTransitionAfterDdApproval(
  tenantDb: TenantDb,
  input: {
    leadId: string;
    actorUserId: string | null | undefined;
    currentStageId?: string | null;
  }
) {
  try {
    if (!input.actorUserId) {
      console.warn(
        `[lead-dd] auto-transition skipped for lead ${input.leadId} after approval`,
        { reason: "missing_actor_user_id" }
      );
      return;
    }

    const currentStageId = input.currentStageId ?? await fetchLeadStageId(tenantDb, input.leadId);
    if (!currentStageId) return;

    const [newLeadStage, qualifiedLeadStage] = await Promise.all([
      getStageBySlug("new_lead", "lead"),
      getStageBySlug("qualified_lead", "lead"),
    ]);

    if (!newLeadStage || !qualifiedLeadStage || currentStageId !== newLeadStage.id) {
      return;
    }

    const result = await transitionLeadStage(tenantDb, {
      leadId: input.leadId,
      targetStageId: qualifiedLeadStage.id,
      userId: input.actorUserId,
      userRole: "admin",
      auditContext: {
        actor: buildAuditActorFromSystem({
          systemProcess: DUE_DILIGENCE_WORKER,
          userId: input.actorUserId,
        }),
      },
    });

    if (!result.ok) {
      console.warn(
        `[lead-dd] auto-transition failed for lead ${input.leadId} after approval`,
        { blockReason: result.code }
      );
    }
  } catch (err) {
    console.warn(
      `[lead-dd] auto-transition errored for lead ${input.leadId}`,
      { err }
    );
  }
}

async function listTenantSchemas(client: PoolClient) {
  const result = await client.query<{ schema_name: string }>(`
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name LIKE 'office\\_%' ESCAPE '\\'
    ORDER BY schema_name
  `);
  return result.rows.map((row) => row.schema_name);
}

async function findApprovalByToken(client: PoolClient, token: string, forUpdate = false) {
  const schemas = await listTenantSchemas(client);
  for (const tenantSchema of schemas) {
    const schemaIdentifier = tenantSchemaIdentifier(tenantSchema);
    const result = await client.query(
      `
        SELECT a.*, $1::text AS tenant_schema
        FROM ${schemaIdentifier}.lead_due_diligence_approvals a
        WHERE a.approval_token = $2
        ${forUpdate ? "FOR UPDATE" : ""}
      `,
      [tenantSchema, token]
    );
    if (result.rows[0]) {
      return result.rows[0] as Record<string, any>;
    }
  }
  return null;
}

function tokenFingerprint(token: string | null | undefined) {
  if (!token) return null;
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function logPublicTokenRejected(
  reason: "missing" | "invalid_format" | "not_found" | "missing_summary" | "already_used",
  input: { token?: string | null; tenantSchema?: string | null; leadId?: string | null; status?: string | null } = {}
) {
  console.warn("[lead-dd] public due diligence token rejected", {
    reason,
    tokenFingerprint: tokenFingerprint(input.token),
    tenantSchema: input.tenantSchema ?? null,
    leadId: input.leadId ?? null,
    status: input.status ?? null,
  });
}

function assertPublicDecisionToken(token: string) {
  if (!token) {
    logPublicTokenRejected("missing");
    throw new AppError(404, "Due Diligence decision not found");
  }
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    logPublicTokenRejected("invalid_format", { token });
    throw new AppError(404, "Due Diligence decision not found");
  }
}

async function loadPublicDecisionSummary(client: PoolClient, tenantSchema: string, leadId: string) {
  const schemaIdentifier = tenantSchemaIdentifier(tenantSchema);
  const result = await client.query(
    `
      SELECT
        l.name AS lead_name,
        l.primary_contact_role,
        l.primary_contact_role_other_label,
        l.budget_status,
        l.bid_due_date,
        c.name AS company_name,
        p.address AS property_address,
        p.city AS property_city,
        p.state AS property_state,
        p.zip AS property_zip,
        p.unit_count,
        p.build_year,
        pt.name AS project_type_name,
        concat_ws(' ', ct.first_name, ct.last_name) AS primary_contact_name,
        ct.email AS primary_contact_email
      FROM ${schemaIdentifier}.leads l
      JOIN ${schemaIdentifier}.companies c ON c.id = l.company_id
      JOIN ${schemaIdentifier}.properties p ON p.id = l.property_id
      LEFT JOIN ${schemaIdentifier}.contacts ct ON ct.id = l.primary_contact_id
      LEFT JOIN public.project_type_config pt ON pt.id = l.project_type_id
      WHERE l.id = $1
    `,
    [leadId]
  );
  return result.rows[0] ?? null;
}

function renderDecisionHtml(input: {
  token: string;
  approval: Record<string, any>;
  summary: Record<string, any>;
  notice?: string | null;
  error?: string | null;
}) {
  const status = input.approval.status as DueDiligenceStatus;
  const decided = status !== "pending";
  const signal = input.approval.detection_signal;
  const contactName = input.summary.primary_contact_name || "Not provided";
  const contactRole = formatPocRoleValue(
    input.summary.primary_contact_role,
    input.summary.primary_contact_role_other_label
  );
  const contactEmail = input.summary.primary_contact_email;
  const contactLine = contactEmail ? `${contactName} (${contactRole}) · ${contactEmail}` : `${contactName} (${contactRole})`;
  const detectionDetail = signal?.detail ?? "No activity found on company, contact, or property in the last 12 months.";
  const detectionText = signal?.occurredAt || signal?.occurred_at
    ? `${detectionDetail} on ${formatDate(signal.occurredAt ?? signal.occurred_at)}.`
    : detectionDetail;
  const rows = [
    ["Lead", input.summary.lead_name],
    ["Company", input.summary.company_name],
    ["Primary contact", contactLine],
    ["Property", [input.summary.property_address, input.summary.property_city, input.summary.property_state, input.summary.property_zip].filter(Boolean).join(", ")],
    ["Project type", input.summary.project_type_name ?? "Not provided"],
    ["Units", input.summary.unit_count ?? "Not provided"],
    ["Year built", input.summary.build_year ?? "Not provided"],
    ["Budget status", formatBudgetStatusValue(input.summary.budget_status)],
    ["Bid due date", formatDate(input.summary.bid_due_date)],
    ["Detection", detectionText],
  ];

  const body = decided
    ? `<p class="notice">This decision has already been recorded as <strong>${escapeHtml(status)}</strong>${input.approval.decided_at ? ` on ${escapeHtml(formatDate(input.approval.decided_at))}` : ""}.</p>`
    : `
      <form method="post" action="/api/public/lead-due-diligence/decide" class="action-form">
        <input type="hidden" name="token" value="${escapeHtml(input.token)}" />
        <button type="submit" name="decision" value="approve">Approve</button>
      </form>
      <form method="post" action="/api/public/lead-due-diligence/decide" class="action-form">
        <input type="hidden" name="token" value="${escapeHtml(input.token)}" />
        <input type="hidden" name="decision" value="reject" />
        <button type="button" class="secondary" onclick="document.getElementById('reject-panel').hidden=false; this.hidden=true">Reject</button>
        <div id="reject-panel" hidden>
          <label for="reason">Rejection reason</label>
          <textarea id="reason" name="reason" minlength="10" required rows="4" placeholder="Enter at least 10 characters"></textarea>
          <button type="submit">Confirm Reject</button>
        </div>
      </form>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="referrer" content="no-referrer" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>T Rock Construction — Lead Due Diligence</title>
    <style>
      body{font-family:Arial,Helvetica,sans-serif;background:#f8fafc;color:#111827;margin:0;padding:24px}
      main{max-width:760px;margin:0 auto;background:white;border:1px solid #d1d5db;padding:24px}
      h1{font-size:24px;margin:0 0 16px}
      table{border-collapse:collapse;width:100%;margin-bottom:20px}
      th,td{border:1px solid #d1d5db;padding:8px;text-align:left;vertical-align:top}
      th{background:#f3f4f6;width:180px}
      button{background:#991b1b;color:white;border:0;padding:10px 14px;font-weight:700;margin-right:8px;cursor:pointer}
      button.secondary{background:#374151}
      textarea{display:block;width:100%;margin:8px 0 12px}
      .notice{border:1px solid #d1d5db;background:#f9fafb;padding:12px}
      .error{border:1px solid #fecaca;background:#fef2f2;color:#991b1b;padding:12px}
      .action-form{display:inline-block;margin:0 8px 12px 0}
      #reject-panel{margin-top:16px;min-width:min(560px,100%)}
      footer{margin-top:24px;color:#6b7280;font-size:12px}
      @media (max-width:640px){body{padding:12px}main{padding:16px}th,td{display:block;width:auto}button{width:100%;margin:0 0 8px}.action-form{display:block;margin-right:0}}
    </style>
  </head>
  <body>
    <main>
      <h1>T Rock Construction — Lead Due Diligence</h1>
      ${input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : ""}
      ${input.notice ? `<p class="notice">${escapeHtml(input.notice)}</p>` : ""}
      <table>${rows.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join("")}</table>
      ${body}
      <footer>T Rock Construction</footer>
    </main>
  </body>
</html>`;
}

export function renderDueDiligenceNotFoundPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="referrer" content="no-referrer" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>T Rock Construction — Lead Due Diligence</title>
    <style>
      body{font-family:Arial,Helvetica,sans-serif;background:#f8fafc;color:#111827;margin:0;padding:24px}
      main{max-width:680px;margin:0 auto;background:white;border:1px solid #d1d5db;padding:24px}
      h1{font-size:24px;margin:0 0 16px}
      .notice{border:1px solid #d1d5db;background:#f9fafb;padding:12px}
      footer{margin-top:24px;color:#6b7280;font-size:12px}
    </style>
  </head>
  <body>
    <main>
      <h1>T Rock Construction — Lead Due Diligence</h1>
      <p class="notice">This Due Diligence link is invalid or has expired. Contact T Rock Construction if you need a new link.</p>
      <footer>T Rock Construction</footer>
    </main>
  </body>
</html>`;
}

export async function renderDueDiligenceDecisionPage(token: string, options: {
  notice?: string | null;
  error?: string | null;
} = {}) {
  assertPublicDecisionToken(token);

  const client = await pool.connect();
  let releaseErr: unknown;
  try {
    const approval = await findApprovalByToken(client, token);
    if (!approval) {
      logPublicTokenRejected("not_found", { token });
      throw new AppError(404, "Due Diligence decision not found");
    }

    const summary = await loadPublicDecisionSummary(client, approval.tenant_schema, approval.lead_id);
    if (!summary) {
      logPublicTokenRejected("missing_summary", {
        token,
        tenantSchema: approval.tenant_schema,
        leadId: approval.lead_id,
      });
      throw new AppError(404, "Due Diligence decision not found");
    }

    return renderDecisionHtml({ token, approval, summary, notice: options.notice, error: options.error });
  } catch (err) {
    releaseErr = err;
    throw err;
  } finally {
    releasePooledClient(client, releaseErr);
  }
}

export async function decideDueDiligenceByToken(input: {
  token: string;
  decision: "approve" | "reject";
  reason?: string | null;
}) {
  assertPublicDecisionToken(input.token);
  const client = await pool.connect();
  let releaseErr: unknown;
  let transactionActive = false;
  try {
    await client.query("BEGIN");
    transactionActive = true;
    const approval = await findApprovalByToken(client, input.token, true);
    if (!approval) {
      await client.query("ROLLBACK");
      transactionActive = false;
      logPublicTokenRejected("not_found", { token: input.token });
      throw new AppError(404, "Due Diligence decision not found");
    }

    if (approval.status !== "pending") {
      await client.query("ROLLBACK");
      transactionActive = false;
      logPublicTokenRejected("already_used", {
        token: input.token,
        tenantSchema: approval.tenant_schema,
        leadId: approval.lead_id,
        status: approval.status,
      });
      throw new AppError(404, "Due Diligence decision not found");
    }

    if (input.decision === "reject" && (!input.reason || input.reason.trim().length < 10)) {
      await client.query("ROLLBACK");
      transactionActive = false;
      throw new AppError(400, "Rejection reason must be at least 10 characters");
    }

    const status = input.decision === "approve" ? "approved" : "rejected";
    const verificationStatus = input.decision === "approve" ? "approved" : "rejected";
    const reason = input.decision === "reject" ? input.reason?.trim() ?? null : null;
    const now = new Date();
    const tenantSchema = approval.tenant_schema as string;
    const schemaIdentifier = tenantSchemaIdentifier(tenantSchema);

    const update = await client.query(
      `
        UPDATE ${schemaIdentifier}.lead_due_diligence_approvals
           SET status = $1,
               decided_by = NULL,
               decided_at = $2,
               decision_reason = $3,
               updated_at = $2
         WHERE id = $4
         RETURNING *
      `,
      [status, now, reason, approval.id]
    );

    // decided_by is intentionally null for public token decisions. The
    // approval link is sent to multiple recipients; we cannot determine
    // which one clicked it from an unauthenticated request. The audit
    // trail is preserved through:
    // - approval_token (links the decision to the email send)
    // - email_message_id (links to the Resend send record)
    // - email_sent_at (when the link was dispatched)
    // - decided_at (when the decision was made)
    // Admin UI should label this as "Decided via email token" when
    // decided_by is null and decided_at is set.
    await client.query(
      `UPDATE ${schemaIdentifier}.leads SET verification_status = $1, updated_at = $2 WHERE id = $3`,
      [verificationStatus, now, approval.lead_id]
    );

    if (status === "approved") {
      const leadStageResult = await client.query(
        `SELECT stage_id FROM ${schemaIdentifier}.leads WHERE id = $1`,
        [approval.lead_id]
      );
      await client.query("SELECT set_config('search_path', $1, true)", [`${tenantSchema},public`]);
      if (approval.requested_by) {
        await client.query("SELECT set_config('app.current_user_id', $1, true)", [approval.requested_by]);
      }
      await maybeAutoTransitionAfterDdApproval(drizzle(client, { schema }), {
        leadId: approval.lead_id,
        actorUserId: approval.requested_by,
        currentStageId: leadStageResult.rows[0]?.stage_id ?? null,
      });
    }

    await client.query("COMMIT");
    transactionActive = false;
    return { ...update.rows[0], tenant_schema: tenantSchema };
  } catch (err) {
    releaseErr = err;
    if (transactionActive) {
      await client.query("ROLLBACK").catch((e) => { releaseErr = e ?? releaseErr; });
    }
    throw err;
  } finally {
    releasePooledClient(client, releaseErr);
  }
}

const WELL_KNOWN_GROUPS: Record<string, { name: string; description: string }> = {
  [GROUP_KEY]: {
    name: "Lead Due Diligence",
    description: "Recipients who receive new-customer lead due diligence approval requests.",
  },
};

async function ensureWellKnownGroup(tenantDb: TenantDb, key: string) {
  const known = WELL_KNOWN_GROUPS[key];
  if (!known) return null;
  const [row] = await tenantDb
    .insert(notificationRecipientGroups)
    .values({ key, name: known.name, description: known.description })
    .onConflictDoNothing({ target: notificationRecipientGroups.key })
    .returning();
  if (row) return row;
  const [existing] = await tenantDb
    .select()
    .from(notificationRecipientGroups)
    .where(eq(notificationRecipientGroups.key, key))
    .limit(1);
  return existing ?? null;
}

// TODO: Audit log for assignment changes. When an admin adds or removes a
// recipient, record (actor, group, before, after, timestamp) for
// compliance/security. Out of scope for initial DD rollout.
export async function getNotificationRecipientGroup(tenantDb: TenantDb, key: string) {
  const [existing] = await tenantDb
    .select()
    .from(notificationRecipientGroups)
    .where(eq(notificationRecipientGroups.key, key))
    .limit(1);
  const group = existing ?? (await ensureWellKnownGroup(tenantDb, key));
  if (!group) {
    throw new AppError(404, "Notification recipient group not found");
  }
  const recipients = await getLeadDueDiligenceRecipients(tenantDb, key);
  return { group, recipients };
}

export async function updateNotificationRecipientAssignments(tenantDb: TenantDb, key: string, userIds: string[]) {
  const [existing] = await tenantDb
    .select()
    .from(notificationRecipientGroups)
    .where(eq(notificationRecipientGroups.key, key))
    .limit(1);
  const group = existing ?? (await ensureWellKnownGroup(tenantDb, key));
  if (!group) {
    throw new AppError(404, "Notification recipient group not found");
  }

  const uniqueUserIds = [...new Set(userIds)];

  if (uniqueUserIds.length > 0) {
    const existingUsers = await tenantDb
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, uniqueUserIds));
    const existingIds = new Set(existingUsers.map((user) => user.id));
    const missingIds = uniqueUserIds.filter((userId) => !existingIds.has(userId));

    if (missingIds.length > 0) {
      throw new AppError(
        400,
        `Invalid user ID(s): ${missingIds.join(", ")}. These users do not exist in the system.`
      );
    }
  }

  await tenantDb.transaction(async (tx) => {
    await tx
      .delete(notificationRecipientAssignments)
      .where(eq(notificationRecipientAssignments.groupId, group.id));

    if (uniqueUserIds.length > 0) {
      await tx.insert(notificationRecipientAssignments).values(
        uniqueUserIds.map((userId) => ({
          groupId: group.id,
          userId,
        }))
      );
    }
  });

  return getNotificationRecipientGroup(tenantDb, key);
}
