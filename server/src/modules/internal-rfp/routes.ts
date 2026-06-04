import crypto from "node:crypto";
import express, { Router } from "express";
import { getHoldStateAtStageEntry, WORKFLOW_ROUTES } from "@trock-crm/shared/types";
import { pool } from "../../db.js";
import { buildAuditActorFromSystem } from "../audit/audit-logger.js";
import { logActivityWithPgClient } from "../audit/pg-activity-logger.js";
import { INTERNAL_RFP_RECEIVER } from "../audit/system-processes.js";
import { applyRfpDeclineToDeal } from "../deals/rfp-decline-service.js";

export const internalRfpRoutes = Router();

const EDITABLE_DEAL_FIELDS = new Set([
  "name",
  "projectNumber",
  "projectType",
  "amount",
  "estimator",
  "description",
  "dueDate",
  "workflowRoute",
  "address.street",
  "address.city",
  "address.state",
  "address.zip",
  "address.country",
]);
const EDITABLE_COMPANY_FIELDS = new Set(["companyName"]);
const EDITABLE_CONTACT_FIELDS = new Set(["contactName", "clientEmail", "clientPhone"]);

function verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  const secret = process.env.SYNCHUB_SHARED_SECRET;
  if (!secret || !signatureHeader) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = signatureHeader.replace(/^sha256=/, "");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
  } catch {
    return false;
  }
}

function parseBody(rawBody: Buffer): any {
  return JSON.parse(rawBody.toString("utf8"));
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function listTenantSchemas() {
  const result = await pool.query(
    `SELECT nspname
       FROM pg_namespace
      WHERE nspname LIKE 'office\_%' ESCAPE '\'
      ORDER BY nspname ASC`
  );
  return result.rows
    .map((row) => row.nspname)
    .filter((schemaName): schemaName is string => /^[a-z][a-z0-9_]*$/.test(schemaName));
}

async function findDeal(sourceDealId: string) {
  for (const schemaName of await listTenantSchemas()) {
    const result = await pool.query(
      `SELECT d.id,
              d.name,
              d.deal_number,
              d.project_number,
              d.project_type,
              d.bid_estimate,
              d.estimator,
              d.description,
              d.bid_due_date,
              d.property_address,
              d.property_city,
              d.property_state,
              d.property_zip,
              d.property_country,
              d.stage_id,
              d.company_id,
              d.primary_contact_id,
              d.procore_bid_id,
              d.procore_company_id,
              d.is_bid_board_owned,
              d.rfp_approval_status,
              d.rfp_declined_reason,
              d.rfp_declined_at,
              d.rfp_override_state,
              d.rfp_override_error,
              d.rfp_override_decision,
              d.rfp_override_reviewed_at,
              d.bid_board_linked_at,
              d.assigned_rep_id,
              d.rfp_approval_requested_by,
              d.rfp_approval_request_id,
              d.workflow_route,
              d.stage_entered_at,
              d.on_hold,
              d.on_hold_started_at,
              d.on_hold_accumulated_seconds,
              d.on_hold_accumulated_seconds_at_stage_entry,
              s.slug AS stage_slug,
              s.display_order AS stage_display_order,
              s.is_terminal AS stage_is_terminal
         FROM ${quoteIdent(schemaName)}.deals d
         LEFT JOIN public.pipeline_stage_config s ON s.id = d.stage_id
        WHERE d.id = $1
          AND d.is_active = true
        LIMIT 1`,
      [sourceDealId]
    );
    if (result.rows.length > 0) {
      return { schemaName, deal: result.rows[0] };
    }
  }
  return null;
}

function flattenEditedFields(fields: Record<string, unknown>) {
  const flattened = new Map<string, unknown>();
  for (const [key, value] of Object.entries(fields)) {
    if (key === "address" && value && typeof value === "object" && !Array.isArray(value)) {
      for (const [addressKey, addressValue] of Object.entries(value as Record<string, unknown>)) {
        flattened.set(`address.${addressKey}`, addressValue);
      }
      continue;
    }
    flattened.set(key, value);
  }
  return flattened;
}

function asStringOrNull(value: unknown) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function asNumberStringOrNull(value: unknown) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : null;
}

function asDateOrNull(value: unknown) {
  if (value == null || value === "") return null;
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function normalizeOptionalString(value: unknown): { valid: true; value: string | null } | { valid: false } {
  if (value == null) return { valid: true, value: null };
  if (typeof value !== "string") return { valid: false };
  const text = value.trim();
  return { valid: true, value: text.length > 0 ? text : null };
}

function isUuid(value: string | null): boolean {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

function auditFieldKeyForInternalRfpColumn(column: string): string {
  if (column === "deal_number") return "projectNumber";
  if (column === "project_type") return "projectType";
  if (column === "bid_estimate") return "bidEstimate";
  if (column === "bid_due_date") return "bidDueDate";
  if (column === "property_address") return "propertyAddress";
  if (column === "property_city") return "propertyCity";
  if (column === "property_state") return "propertyState";
  if (column === "property_zip") return "propertyZip";
  if (column === "property_country") return "propertyCountry";
  if (column === "workflow_route") return "workflowRoute";
  return column;
}

function isWorkflowRoute(value: string | null): value is (typeof WORKFLOW_ROUTES)[number] {
  return value != null && (WORKFLOW_ROUTES as readonly string[]).includes(value);
}

function bidBoardCreatedTargetStageSlug(workflowRoute: unknown) {
  return workflowRoute === "service" ? "service_estimating" : "estimating";
}

function numericStageOrder(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldApplyBidBoardCreatedStage(currentDeal: any, targetStage: any): boolean {
  if (!targetStage?.id || currentDeal.stage_id === targetStage.id) return false;
  if (currentDeal.stage_is_terminal === true) return false;
  const currentOrder = numericStageOrder(currentDeal.stage_display_order);
  const targetOrder = numericStageOrder(targetStage.display_order);
  return currentOrder == null || targetOrder == null || targetOrder >= currentOrder;
}

function isPendingRfpApprovalStatus(value: unknown): boolean {
  return value === "pending_outbox" || value === "pending";
}

function isDealNumberUniqueViolation(error: unknown): boolean {
  const pgError = error as { code?: string; constraint?: string; detail?: string };
  if (pgError?.code !== "23505") return false;
  const constraint = String(pgError.constraint ?? "").toLowerCase();
  const detail = String(pgError.detail ?? "").toLowerCase();
  return constraint.includes("deal_number") || detail.includes("(deal_number)=");
}

function rejectField(applied: string[], rejected: string[], field: string) {
  const index = applied.indexOf(field);
  if (index >= 0) applied.splice(index, 1);
  if (!rejected.includes(field)) rejected.push(field);
}

function splitName(value: unknown) {
  const text = asStringOrNull(value);
  if (!text) return { firstName: "", lastName: "" };
  const [firstName, ...rest] = text.split(/\s+/);
  return { firstName, lastName: rest.join(" ") || "" };
}

internalRfpRoutes.post(
  "/rfp-edits",
  express.raw({ type: "application/json", limit: "1mb" }),
  async (req, res, next) => {
    try {
      const rawBody = req.body as Buffer;
      const signature = req.headers["x-rfp-request-signature"] as string | undefined;
      if (!verifySignature(rawBody, signature)) {
        res.status(401).json({ success: false, error: "invalid_signature" });
        return;
      }

      let payload: any;
      try {
        payload = parseBody(rawBody);
      } catch {
        res.status(400).json({ success: false, error: "invalid_json" });
        return;
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        res.status(422).json({ success: false, error: "invalid_payload" });
        return;
      }

      const sourceDealId = asStringOrNull(payload.sourceDealId);
      if (
        !sourceDealId ||
        typeof payload.rfpApprovalRequestId !== "number" ||
        !payload.editedFields ||
        typeof payload.editedFields !== "object"
      ) {
        res.status(422).json({ success: false, error: "invalid_payload" });
        return;
      }

      const found = await findDeal(sourceDealId);
      if (!found) {
        res.status(404).json({ success: false, error: "deal_not_found" });
        return;
      }

      const currentRequestId = Number(found.deal.rfp_approval_request_id);
      if (!Number.isFinite(currentRequestId) || payload.rfpApprovalRequestId !== currentRequestId) {
        console.warn(
          `[RFP edits] stale callback ignored for sourceDealId=${sourceDealId}; incoming rfpApprovalRequestId=${payload.rfpApprovalRequestId}; current rfpApprovalRequestId=${found.deal.rfp_approval_request_id ?? "null"}`
        );
        res.json({
          success: true,
          idempotent: true,
          applied: [],
          rejected: [],
          reason: "stale_callback_ignored",
        });
        return;
      }

      const flattened = flattenEditedFields(payload.editedFields);
      const dealUpdates: Record<string, unknown> = {};
      const applied: string[] = [];
      const rejected: string[] = [];

      for (const [field, value] of flattened.entries()) {
        if (EDITABLE_DEAL_FIELDS.has(field)) {
          if (field === "workflowRoute") {
            const workflowRoute = asStringOrNull(value);
            if (!isWorkflowRoute(workflowRoute)) {
              rejected.push(field);
              console.warn(
                `[RFP edits] Rejected invalid workflowRoute '${workflowRoute ?? ""}' for deal ${sourceDealId} request ${payload.rfpApprovalRequestId ?? "unknown"}`
              );
              continue;
            }
            applied.push(field);
            dealUpdates.workflow_route = workflowRoute;
            continue;
          }
          applied.push(field);
          if (field === "name") dealUpdates.name = asStringOrNull(value);
          if (field === "projectNumber") dealUpdates.deal_number = asStringOrNull(value);
          if (field === "projectType") dealUpdates.project_type = asStringOrNull(value);
          if (field === "amount") dealUpdates.bid_estimate = asNumberStringOrNull(value);
          if (field === "estimator") dealUpdates.estimator = asStringOrNull(value);
          if (field === "description") dealUpdates.description = asStringOrNull(value);
          if (field === "dueDate") dealUpdates.bid_due_date = asDateOrNull(value);
          if (field === "address.street") dealUpdates.property_address = asStringOrNull(value);
          if (field === "address.city") dealUpdates.property_city = asStringOrNull(value);
          if (field === "address.state") dealUpdates.property_state = asStringOrNull(value);
          if (field === "address.zip") dealUpdates.property_zip = asStringOrNull(value);
          if (field === "address.country") dealUpdates.property_country = asStringOrNull(value);
          continue;
        }
        if (EDITABLE_COMPANY_FIELDS.has(field) || EDITABLE_CONTACT_FIELDS.has(field)) {
          applied.push(field);
          continue;
        }
        rejected.push(field);
        console.warn(`[RFP edits] Rejected unapproved field '${field}' for deal ${sourceDealId}`);
      }

      if (Object.keys(dealUpdates).length > 0) {
        const runDealUpdate = async () => {
          const assignments = Object.keys(dealUpdates).map((column, index) => `${quoteIdent(column)} = $${index + 1}`);
          return pool.query(
            `UPDATE ${quoteIdent(found.schemaName)}.deals
                SET ${assignments.join(", ")},
                    updated_at = NOW()
              WHERE id = $${assignments.length + 1}
              RETURNING id, name, deal_number, project_number`,
            [...Object.values(dealUpdates), sourceDealId]
          );
        };

        let updatedDeal: Record<string, unknown> | null = null;
        try {
          updatedDeal = (await runDealUpdate()).rows[0] ?? null;
        } catch (err) {
          if (!isDealNumberUniqueViolation(err) || !Object.prototype.hasOwnProperty.call(dealUpdates, "deal_number")) {
            throw err;
          }

          console.warn(
            `[RFP edits] Rejected projectNumber deal_number collision '${dealUpdates.deal_number ?? ""}' for deal ${sourceDealId} request ${payload.rfpApprovalRequestId ?? "unknown"}`
          );
          delete dealUpdates.deal_number;
          rejectField(applied, rejected, "projectNumber");
          if (Object.keys(dealUpdates).length > 0) {
            updatedDeal = (await runDealUpdate()).rows[0] ?? null;
          }
        }
        if (updatedDeal && Object.keys(dealUpdates).length > 0) {
          const fieldChanges = Object.fromEntries(
            Object.entries(dealUpdates).map(([column, to]) => [
              auditFieldKeyForInternalRfpColumn(column),
              { from: found.deal[column], to },
            ])
          );
          await logActivityWithPgClient({
            client: pool,
            schemaName: found.schemaName,
            actor: buildAuditActorFromSystem({ systemProcess: INTERNAL_RFP_RECEIVER }),
            action: "update",
            entity: {
              tableName: "deals",
              entityType: "deal",
              recordId: String(updatedDeal.id ?? sourceDealId),
              nameSnapshot: String(updatedDeal.name ?? found.deal.name ?? "Deal"),
              secondaryIdSnapshot: (updatedDeal.project_number ?? updatedDeal.deal_number ?? found.deal.project_number ?? found.deal.deal_number ?? null) as string | null,
            },
            fieldChanges,
            metadata: { rfpApprovalRequestId: payload.rfpApprovalRequestId },
          });
        }
      }

      if (flattened.has("companyName") && found.deal.company_id) {
        await pool.query(
          `UPDATE ${quoteIdent(found.schemaName)}.companies SET name = $1, updated_at = NOW() WHERE id = $2`,
          [asStringOrNull(flattened.get("companyName")), found.deal.company_id]
        );
      }

      if (found.deal.primary_contact_id) {
        const contactAssignments: string[] = [];
        const contactValues: unknown[] = [];
        if (flattened.has("contactName")) {
          const { firstName, lastName } = splitName(flattened.get("contactName"));
          contactAssignments.push(`first_name = $${contactValues.length + 1}`);
          contactValues.push(firstName);
          contactAssignments.push(`last_name = $${contactValues.length + 1}`);
          contactValues.push(lastName);
        }
        if (flattened.has("clientEmail")) {
          contactAssignments.push(`email = $${contactValues.length + 1}`);
          contactValues.push(asStringOrNull(flattened.get("clientEmail")));
        }
        if (flattened.has("clientPhone")) {
          contactAssignments.push(`phone = $${contactValues.length + 1}`);
          contactValues.push(asStringOrNull(flattened.get("clientPhone")));
        }
        if (contactAssignments.length > 0) {
          await pool.query(
            `UPDATE ${quoteIdent(found.schemaName)}.contacts
                SET ${contactAssignments.join(", ")},
                    updated_at = NOW()
              WHERE id = $${contactValues.length + 1}`,
            [...contactValues, found.deal.primary_contact_id]
          );
        }
      }

      res.json({ success: true, applied, rejected });
    } catch (err) {
      next(err);
    }
  }
);

internalRfpRoutes.post(
  "/deals/eligibility-check",
  express.raw({ type: "application/json", limit: "128kb" }),
  async (req, res, next) => {
    try {
      const rawBody = req.body as Buffer;
      const signature = req.headers["x-rfp-request-signature"] as string | undefined;
      if (!verifySignature(rawBody, signature)) {
        res.status(401).json({ success: false, error: "invalid_signature" });
        return;
      }

      let payload: any;
      try {
        payload = parseBody(rawBody);
      } catch {
        res.status(400).json({ success: false, error: "invalid_json" });
        return;
      }

      const sourceDealId = asStringOrNull(payload.sourceDealId);
      if (!sourceDealId) {
        res.status(422).json({ success: false, error: "invalid_payload" });
        return;
      }

      const found = await findDeal(sourceDealId);
      if (!found) {
        res.status(404).json({ exists: false });
        return;
      }

      res.json({
        exists: true,
        stage: found.deal.stage_slug ?? null,
        dealId: found.deal.id,
      });
    } catch (err) {
      next(err);
    }
  }
);

internalRfpRoutes.post(
  "/rfp-declined",
  express.raw({ type: "application/json", limit: "128kb" }),
  async (req, res, next) => {
    try {
      const rawBody = req.body;
      if (!Buffer.isBuffer(rawBody)) {
        res.status(422).json({ success: false, error: "invalid_payload" });
        return;
      }
      const signature = req.headers["x-rfp-request-signature"] as string | undefined;
      if (!verifySignature(rawBody, signature)) {
        res.status(401).json({ success: false, error: "invalid_signature" });
        return;
      }

      let payload: any;
      try {
        payload = parseBody(rawBody);
      } catch {
        res.status(400).json({ success: false, error: "invalid_json" });
        return;
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        res.status(422).json({ success: false, error: "invalid_payload" });
        return;
      }

      const sourceDealId = asStringOrNull(payload.sourceDealId);
      const denialReasonInput = normalizeOptionalString(payload.denialReason);
      const fallbackReasonInput = normalizeOptionalString(payload.reason);
      const declinedAt = payload.declinedAt == null ? new Date().toISOString() : asDateOrNull(payload.declinedAt);
      if (
        !sourceDealId ||
        !isUuid(sourceDealId) ||
        typeof payload.rfpApprovalRequestId !== "number" ||
        !Number.isFinite(payload.rfpApprovalRequestId) ||
        !Number.isInteger(payload.rfpApprovalRequestId) ||
        !denialReasonInput.valid ||
        !fallbackReasonInput.valid ||
        !declinedAt
      ) {
        res.status(422).json({ success: false, error: "invalid_payload" });
        return;
      }
      const denialReason = denialReasonInput.value ?? fallbackReasonInput.value;

      const found = await findDeal(sourceDealId);
      if (!found) {
        res.status(404).json({ success: false, error: "deal_not_found" });
        return;
      }

      const currentRequestId =
        found.deal.rfp_approval_request_id == null ? null : Number(found.deal.rfp_approval_request_id);
      if ((currentRequestId == null || !Number.isFinite(currentRequestId)) && found.deal.rfp_approval_status !== "declined") {
        res.status(409).json({
          success: false,
          error: "rfp_decline_invalid_state",
          reason: "no_pending_rfp",
        });
        return;
      }

      if (currentRequestId == null || !Number.isFinite(currentRequestId) || payload.rfpApprovalRequestId !== currentRequestId) {
        console.warn(
          `[RFP declined callback] stale callback ignored for sourceDealId=${sourceDealId}; incoming rfpApprovalRequestId=${payload.rfpApprovalRequestId}; current rfpApprovalRequestId=${found.deal.rfp_approval_request_id ?? "null"}`
        );
        res.json({ success: true, idempotent: true, reason: "stale_callback_ignored" });
        return;
      }

      if (found.deal.rfp_approval_status === "declined") {
        res.json({
          success: true,
          idempotent: true,
          dealId: sourceDealId,
          status: "declined",
          pending: false,
        });
        return;
      }

      if (!isPendingRfpApprovalStatus(found.deal.rfp_approval_status)) {
        res.status(409).json({
          success: false,
          error: "rfp_decline_invalid_state",
          reason: "no_pending_rfp",
        });
        return;
      }

      const changedByUserId = found.deal.rfp_approval_requested_by ?? found.deal.assigned_rep_id ?? null;
      if (!changedByUserId) {
        res.status(409).json({
          success: false,
          error: "rfp_decline_invalid_state",
          reason: "missing_audit_actor",
        });
        return;
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const declineResult = await applyRfpDeclineToDeal({
          client,
          schemaName: found.schemaName,
          deal: found.deal,
          sourceDealId,
          rfpApprovalRequestId: payload.rfpApprovalRequestId,
          denialReason,
          declinedAt,
          changedByUserId,
        });

        if (!declineResult.applied) {
          const refreshed = await findDeal(sourceDealId);
          if (
            refreshed?.deal.rfp_approval_status === "declined" &&
            Number(refreshed.deal.rfp_approval_request_id) === payload.rfpApprovalRequestId
          ) {
            await client.query("ROLLBACK");
            res.json({
              success: true,
              idempotent: true,
              dealId: sourceDealId,
              status: "declined",
              pending: false,
            });
            return;
          }

          await client.query("ROLLBACK");
          res.status(409).json({
            success: false,
            error: "rfp_decline_invalid_state",
            reason: "state_changed_during_callback",
          });
          return;
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      res.json({
        success: true,
        dealId: sourceDealId,
        status: "declined",
        pending: false,
      });
    } catch (err) {
      next(err);
    }
  }
);

internalRfpRoutes.post(
  "/bid-board-created",
  express.raw({ type: "application/json", limit: "128kb" }),
  async (req, res, next) => {
    try {
      const rawBody = req.body as Buffer;
      const signature = req.headers["x-rfp-request-signature"] as string | undefined;
      if (!verifySignature(rawBody, signature)) {
        res.status(401).json({ success: false, error: "invalid_signature" });
        return;
      }

      let payload: any;
      try {
        payload = parseBody(rawBody);
      } catch {
        res.status(400).json({ success: false, error: "invalid_json" });
        return;
      }

      const sourceDealId = asStringOrNull(payload.sourceDealId);
      // Absent `status` defaults to 'created' for backward-compatibility with pre-override callbacks.
      const callbackStatus = asStringOrNull(payload.status) ?? "created";
      if (callbackStatus !== "created" && callbackStatus !== "failed") {
        res.status(422).json({ success: false, error: "invalid_payload" });
        return;
      }
      if (!sourceDealId || typeof payload.rfpApprovalRequestId !== "number") {
        res.status(422).json({ success: false, error: "invalid_payload" });
        return;
      }

      const found = await findDeal(sourceDealId);
      if (!found) {
        res.status(404).json({ success: false, error: "deal_not_found" });
        return;
      }

      // Stale-callback guard (both statuses): the callback must reference the deal's current RFP cycle. The
      // callback is at-least-once, so a duplicate (same request id, same resulting state) is a safe no-op below.
      const currentRequestId = Number(found.deal.rfp_approval_request_id);
      if (!Number.isFinite(currentRequestId) || payload.rfpApprovalRequestId !== currentRequestId) {
        console.warn(
          `[RFP callback] stale callback ignored for sourceDealId=${sourceDealId}; incoming rfpApprovalRequestId=${payload.rfpApprovalRequestId}; current rfpApprovalRequestId=${found.deal.rfp_approval_request_id ?? "null"}`
        );
        res.json({ success: true, idempotent: true, reason: "stale_callback_ignored" });
        return;
      }

      // Failure callback: the Playwright Bid Board creation failed. Mark the override retryable and leave the
      // deal declined. The declined-only + value-distinct guards make it idempotent and order-safe — a stale
      // 'failed' arriving after a 'created' finds an already-approved deal and is a no-op.
      if (callbackStatus === "failed") {
        // Cap the free-text reason so an oversized SyncHub error can't bloat the column / audit log.
        const overrideError = (asStringOrNull(payload.error) ?? "Bid Board project creation failed").slice(0, 2000);
        // The callback's createdAt is required for the freshness guard below (it's compared against the current
        // attempt's start, rfp_override_reviewed_at). Reject a missing/unparseable timestamp rather than defaulting
        // to NOW() — a NOW() default would always look "fresh" and let a stale failed clobber a fresh retry.
        const callbackCreatedAt = asDateOrNull(payload.createdAt);
        if (!callbackCreatedAt) {
          res.status(422).json({ success: false, error: "invalid_payload" });
          return;
        }
        let failedApplied = false;
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const failedUpdate = await client.query(
            `UPDATE ${quoteIdent(found.schemaName)}.deals
                SET rfp_override_state = 'failed',
                    rfp_override_error = $1,
                    updated_at = NOW()
              WHERE id = $2
                AND rfp_approval_status = 'declined'
                AND rfp_approval_request_id = $3
                -- never resurrect 'failed' onto a deal the reviewers have terminally re-confirmed (a late
                -- at-least-once retry of an old failed callback must not regress the review state)
                AND rfp_override_decision IS DISTINCT FROM 'denial_reconfirmed'
                -- freshness: ignore a stale failed callback from a PRIOR attempt (same request id) so a
                -- duplicate of the old failure can't flip a fresh retry (a newer 'approving') back to failed.
                AND COALESCE($4::timestamptz, NOW()) >= rfp_override_reviewed_at
                AND (rfp_override_state IS DISTINCT FROM 'failed' OR rfp_override_error IS DISTINCT FROM $1)`,
            [overrideError, sourceDealId, currentRequestId, callbackCreatedAt]
          );
          failedApplied = (failedUpdate.rowCount ?? 0) > 0;
          if (failedApplied) {
            console.warn(`[RFP callback] override approval FAILED for deal ${sourceDealId}: ${overrideError}`);
            await logActivityWithPgClient({
              client,
              schemaName: found.schemaName,
              actor: buildAuditActorFromSystem({ systemProcess: INTERNAL_RFP_RECEIVER }),
              action: "update",
              entity: {
                tableName: "deals",
                entityType: "deal",
                recordId: sourceDealId,
                nameSnapshot: String(found.deal.name ?? "Deal"),
                secondaryIdSnapshot: (found.deal.project_number ?? found.deal.deal_number ?? null) as string | null,
              },
              fieldChanges: {
                rfpOverrideState: { from: found.deal.rfp_override_state ?? null, to: "failed" },
                rfpOverrideError: { from: found.deal.rfp_override_error ?? null, to: overrideError },
              },
              metadata: { rfpApprovalRequestId: currentRequestId },
            });
          }
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
        res.json({ success: true, status: "failed", dealId: sourceDealId, applied: failedApplied });
        return;
      }

      // Success callback ('created'): validate the project linkage fields, then link + advance to estimating.
      const bidboardProjectId = asStringOrNull(payload.bidboardProjectId);
      const procoreCompanyId = asStringOrNull(payload.procoreCompanyId);
      if (!bidboardProjectId || !/^\d+$/.test(bidboardProjectId) || !procoreCompanyId) {
        res.status(422).json({ success: false, error: "invalid_payload" });
        return;
      }
      // Freshness for the OVERRIDE flow only: if an override attempt is in flight, ignore a stale 'created' from
      // a prior attempt (createdAt older than the current attempt's rfp_override_reviewed_at) so it can't link the
      // old attempt's project / clear the fresh 'approving' state. The original (non-override) RFP-approval flow has
      // rfp_override_reviewed_at IS NULL, so this never gates it.
      const createdCallbackAt = asDateOrNull(payload.createdAt);

      // For the OVERRIDE flow (rfp_override_reviewed_at set), a 'created' callback MUST carry a parseable createdAt:
      // the freshness guard below needs it, so a timestamp-less success would silently no-op the linkage while this
      // handler still returns 200. SyncHub treats a 200 as delivered and stops retrying — leaving the deal stuck
      // declined/'approving' even though a Procore project may already exist. Reject it as 422 (like the failed path)
      // so SyncHub retries with a well-formed callback. The original (non-override) flow has reviewed_at NULL and is
      // exempt (its pre-override callbacks legitimately carry no createdAt and link via the IS NULL escape).
      if (found.deal.rfp_override_reviewed_at != null && !createdCallbackAt) {
        console.warn(
          `[RFP callback] override 'created' for deal ${sourceDealId} (request ${currentRequestId}) is missing a parseable createdAt; returning 422 so SyncHub retries instead of silently dropping it`
        );
        res.status(422).json({ success: false, error: "invalid_payload" });
        return;
      }

      const existingBidId = found.deal.procore_bid_id == null ? null : String(found.deal.procore_bid_id);
      if (existingBidId && existingBidId !== bidboardProjectId) {
        console.warn(
          `[RFP callback] Deal ${sourceDealId} already had procore_bid_id=${existingBidId}; updating to ${bidboardProjectId}`
        );
      }

      const targetStageSlug = bidBoardCreatedTargetStageSlug(found.deal.workflow_route);
      const targetStageResult = await pool.query(
        `SELECT id, display_order, is_terminal FROM public.pipeline_stage_config WHERE slug = $1 LIMIT 1`,
        [targetStageSlug]
      );
      const targetStage = targetStageResult.rows[0] ?? null;
      if (!targetStage?.id) {
        console.warn(
          `[RFP callback] Could not find target stage '${targetStageSlug}' for deal ${sourceDealId}; linkage will be applied without a stage transition`
        );
      }
      const applyStage = shouldApplyBidBoardCreatedStage(found.deal, targetStage);
      if (targetStage?.id && found.deal.stage_id !== targetStage.id && !applyStage) {
        console.warn(
          `[RFP callback] Skipping unsafe stage transition for deal ${sourceDealId}: ${found.deal.stage_slug ?? found.deal.stage_id} -> ${targetStageSlug}`
        );
      }

      const changedByUserId = found.deal.rfp_approval_requested_by ?? found.deal.assigned_rep_id ?? null;
      const canApplyStage = applyStage && Boolean(changedByUserId);
      if (applyStage && !changedByUserId) {
        console.warn(`[RFP callback] Skipping stage transition for deal ${sourceDealId}: no changed_by user available`);
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // This callback writes deal_stage_history explicitly on the stage move (below), so
        // suppress the deal_stage_history backstop trigger (migration 0143) for this
        // transaction to avoid double-recording. Transaction-local; clears at COMMIT/ROLLBACK.
        await client.query("SELECT set_config('app.skip_stage_history_trigger', '1', true)");
        const linkageUpdate = await client.query(
          `UPDATE ${quoteIdent(found.schemaName)}.deals
              SET procore_bid_id = $1::bigint,
                  procore_company_id = $2,
                  is_bid_board_owned = true,
                  rfp_approval_status = 'approved',
                  bid_board_linked_at = NOW(),
                  rfp_override_state = NULL,
                  rfp_override_error = NULL,
                  updated_at = NOW()
            WHERE id = $3
              -- a re-confirmed denial is terminal; never let a (delayed) success callback override it
              AND rfp_override_decision IS DISTINCT FROM 'denial_reconfirmed'
              -- override-flow freshness: a stale 'created' from a prior attempt can't link/approve a fresh retry.
              -- Require a REAL createdAt for the override flow (no NOW() substitution): a created with no parseable
              -- timestamp is treated as not-fresh and ignored, never as current. The original (non-override) flow
              -- has rfp_override_reviewed_at IS NULL and is unaffected.
              AND (rfp_override_reviewed_at IS NULL OR ($4::timestamptz IS NOT NULL AND $4::timestamptz >= rfp_override_reviewed_at))
              AND (
                procore_bid_id IS DISTINCT FROM $1::bigint OR
                procore_company_id IS DISTINCT FROM $2 OR
                is_bid_board_owned IS DISTINCT FROM true OR
                rfp_approval_status IS DISTINCT FROM 'approved' OR
                bid_board_linked_at IS NULL OR
                rfp_override_state IS NOT NULL OR
                rfp_override_error IS NOT NULL
              )
            RETURNING id, name, deal_number, project_number, bid_board_linked_at`,
          [bidboardProjectId, procoreCompanyId, sourceDealId, createdCallbackAt]
        );
        if ((linkageUpdate.rowCount ?? 0) > 0) {
          const linkedDeal = linkageUpdate.rows[0] ?? found.deal;
          await logActivityWithPgClient({
            client,
            schemaName: found.schemaName,
            actor: buildAuditActorFromSystem({ systemProcess: INTERNAL_RFP_RECEIVER }),
            action: "update",
            entity: {
              tableName: "deals",
              entityType: "deal",
              recordId: sourceDealId,
              nameSnapshot: String(linkedDeal.name ?? found.deal.name ?? "Deal"),
              secondaryIdSnapshot: (linkedDeal.project_number ?? linkedDeal.deal_number ?? found.deal.project_number ?? found.deal.deal_number ?? null) as string | null,
            },
            fieldChanges: {
              procoreBidId: { from: found.deal.procore_bid_id ?? null, to: bidboardProjectId },
              procoreCompanyId: { from: found.deal.procore_company_id ?? null, to: procoreCompanyId },
              isBidBoardOwned: { from: found.deal.is_bid_board_owned ?? null, to: true },
              rfpApprovalStatus: { from: found.deal.rfp_approval_status ?? null, to: "approved" },
              bidBoardLinkedAt: { from: found.deal.bid_board_linked_at ?? null, to: linkedDeal.bid_board_linked_at ?? "now" },
            },
            metadata: { rfpApprovalRequestId: payload.rfpApprovalRequestId, bidboardProjectId },
          });
        }

        if (canApplyStage) {
          const stageChangedAt = new Date();
          const stageEntryHoldState = getHoldStateAtStageEntry(
            {
              onHold: Boolean(found.deal.on_hold),
              onHoldStartedAt: found.deal.on_hold_started_at,
              onHoldAccumulatedSeconds: Number(found.deal.on_hold_accumulated_seconds ?? 0),
            },
            stageChangedAt
          );
          const stageUpdate = await client.query(
            `UPDATE ${quoteIdent(found.schemaName)}.deals
                SET stage_id = $1::uuid,
                    stage_entered_at = $2::timestamptz,
                    on_hold_started_at = $3::timestamptz,
                    on_hold_accumulated_seconds = $4::bigint,
                    on_hold_accumulated_seconds_at_stage_entry = $5::bigint,
                    updated_at = NOW()
              WHERE id = $6
                AND stage_id = $7::uuid
                -- same guards as the linkage update: a re-confirmed denial (or a stale prior-attempt 'created')
                -- must not advance the stage
                AND rfp_override_decision IS DISTINCT FROM 'denial_reconfirmed'
                AND (rfp_override_reviewed_at IS NULL OR ($8::timestamptz IS NOT NULL AND $8::timestamptz >= rfp_override_reviewed_at))
              RETURNING id`,
            [
              targetStage.id,
              stageChangedAt,
              stageEntryHoldState.onHoldStartedAt,
              stageEntryHoldState.onHoldAccumulatedSeconds,
              stageEntryHoldState.onHoldAccumulatedSecondsAtStageEntry,
              sourceDealId,
              found.deal.stage_id,
              createdCallbackAt,
            ]
          );

          if ((stageUpdate.rowCount ?? 0) > 0) {
            await client.query(
              `INSERT INTO ${quoteIdent(found.schemaName)}.deal_stage_history
                 (deal_id, from_stage_id, to_stage_id, changed_by, is_backward_move,
                  is_director_override, override_reason, duration_in_previous_stage)
               VALUES ($1, $2, $3, $4, false, false, $5,
                 CASE WHEN $6::timestamptz IS NULL THEN NULL ELSE NOW() - $6::timestamptz END)`,
              [
                sourceDealId,
                found.deal.stage_id,
                targetStage.id,
                changedByUserId,
                `Bid Board created callback - Stage ${targetStageSlug}`,
                found.deal.stage_entered_at,
              ]
            );
            await logActivityWithPgClient({
              client,
              schemaName: found.schemaName,
              actor: buildAuditActorFromSystem({ systemProcess: INTERNAL_RFP_RECEIVER }),
              action: "update",
              entity: {
                tableName: "deals",
                entityType: "deal",
                recordId: sourceDealId,
                nameSnapshot: String(found.deal.name ?? "Deal"),
                secondaryIdSnapshot: (found.deal.project_number ?? found.deal.deal_number ?? null) as string | null,
              },
              fieldChanges: {
                stageId: { from: found.deal.stage_id, to: targetStage.id },
              },
              metadata: { rfpApprovalRequestId: payload.rfpApprovalRequestId, bidboardProjectId, targetStageSlug },
            });
          } else {
            console.warn(`[RFP callback] Skipped stage transition for deal ${sourceDealId}: stage changed during callback`);
          }
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      res.json({ success: true, dealId: sourceDealId, bidboardProjectId });
    } catch (err) {
      next(err);
    }
  }
);
