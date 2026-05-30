// server/src/modules/procore/synchub-routes.ts
// POST /api/integrations/synchub/opportunities — one-way push from SyncHub.
// Authenticated by shared secret header (X-SyncHub-Secret), not JWT.

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { PoolClient } from "pg";
import { pool } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import {
  buildBidBoardMirrorUpdate,
  normalizeBidBoardStageSlug,
} from "./bidboard-mirror-service.js";
import {
  buildProjectNumber,
  generateJulianDate,
  getNextSuffix,
  parseProjectNumberSuffix,
  resolveOfficeCode,
  resolveProjectTypeCode,
} from "../../services/projectNumber.js";
import { buildAuditActorFromSystem } from "../audit/audit-logger.js";
import { logActivityWithPgClient } from "../audit/pg-activity-logger.js";
import { PROCORE_SYNCHUB_WEBHOOK } from "../audit/system-processes.js";

const router = Router();
type WorkflowRoute = "normal" | "service";
const COALESCE_PROTECTED_WEBHOOK_FIELDS = new Set<string>([
  "ddEstimate",
  "bidEstimate",
  "awardedAmount",
  "proposalNotes",
  "proposalStatus",
]);

const SHARED_CANONICAL_DEAL_STAGE_SLUGS = [
  // opportunity is a CRM-only stage seeded as standard_deal family but applies
  // to both normal and service routes; service deals legitimately enter
  // Opportunity for RFP approval.
  "opportunity",
  "estimate_under_review",
  "estimate_sent_to_client",
  "contract",
  "won",
  "lost",
] as const;

/**
 * Defense-in-depth validator for schema names used in dynamic SQL.
 * This is a second guard after the office_slug regex check — it ensures
 * any schema name interpolated into SQL is strictly in the expected format.
 */
function validateSchemaName(name: string): string {
  if (!/^office_[a-z][a-z0-9_]*$/.test(name)) {
    throw new AppError(400, "Invalid schema name");
  }
  return name;
}

function workflowFamilyForRoute(workflowRoute: WorkflowRoute) {
  return workflowRoute === "service" ? "service_deal" : "standard_deal";
}

function targetWorkflowFamilyForStage(stageSlug: string, workflowRoute: WorkflowRoute) {
  if (stageSlug === "service_estimating") return "service_deal";
  return workflowFamilyForRoute(workflowRoute);
}

function buildMirrorDealUpdateQuery(args: {
  schemaName: string;
  includeHoldColumns: boolean;
  updates: {
    stageId: unknown;
    stageEnteredAt: unknown;
    bidBoardStageSlug: unknown;
    bidBoardStageFamily: unknown;
    bidBoardStageStatus: unknown;
    bidBoardStageEnteredAt: unknown;
    bidBoardStageExitedAt: unknown;
    bidBoardLossOutcome: unknown;
    bidBoardMirrorSourceEnteredAt: unknown;
    bidBoardMirrorSourceExitedAt: unknown;
    ddEstimate: unknown;
    bidEstimate: unknown;
    awardedAmount: unknown;
    proposalNotes: unknown;
    estimatingSubstage: unknown;
    proposalStatus: unknown;
    actualCloseDate: unknown;
    wonClosedDate: unknown;
    lostReasonId: unknown;
    lostNotes: unknown;
    lostCompetitor: unknown;
    lostAt: unknown;
    procoreBidId: unknown;
    readOnlySyncedAt: unknown;
    updatedAt: unknown;
    onHoldStartedAt?: unknown;
    onHoldAccumulatedSeconds?: unknown;
    onHoldAccumulatedSecondsAtStageEntry?: unknown;
    dealId: unknown;
    workflowRoute: unknown;
  };
}) {
  const params: unknown[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const setClauses = [
    `stage_id = ${bind(args.updates.stageId)}`,
    `stage_entered_at = ${bind(args.updates.stageEnteredAt)}`,
  ];

  if (args.includeHoldColumns) {
    setClauses.push(
      `on_hold_started_at = ${bind(args.updates.onHoldStartedAt ?? null)}`,
      `on_hold_accumulated_seconds = ${bind(args.updates.onHoldAccumulatedSeconds ?? null)}`,
      `on_hold_accumulated_seconds_at_stage_entry = ${bind(args.updates.onHoldAccumulatedSecondsAtStageEntry ?? null)}`
    );
  }

  setClauses.push(
    "is_bid_board_owned = true",
    `bid_board_stage_slug = ${bind(args.updates.bidBoardStageSlug)}`,
    `bid_board_stage_family = ${bind(args.updates.bidBoardStageFamily)}`,
    `bid_board_stage_status = ${bind(args.updates.bidBoardStageStatus)}`,
    `bid_board_stage_entered_at = ${bind(args.updates.bidBoardStageEnteredAt)}`,
    `bid_board_stage_exited_at = ${bind(args.updates.bidBoardStageExitedAt)}`,
    `bid_board_stage_duration = CASE
               WHEN ${bind(args.updates.bidBoardStageEnteredAt)}::timestamptz IS NOT NULL AND ${bind(args.updates.bidBoardStageExitedAt)}::timestamptz IS NOT NULL THEN ${bind(args.updates.bidBoardStageExitedAt)}::timestamptz - ${bind(args.updates.bidBoardStageEnteredAt)}::timestamptz
               ELSE NULL
             END`,
    `bid_board_loss_outcome = ${bind(args.updates.bidBoardLossOutcome)}`,
    `bid_board_mirror_source_entered_at = ${bind(args.updates.bidBoardMirrorSourceEnteredAt)}`,
    `bid_board_mirror_source_exited_at = ${bind(args.updates.bidBoardMirrorSourceExitedAt)}`,
    `dd_estimate = COALESCE(${bind(args.updates.ddEstimate)}, dd_estimate)`,
    `bid_estimate = COALESCE(${bind(args.updates.bidEstimate)}, bid_estimate)`,
    `awarded_amount = COALESCE(${bind(args.updates.awardedAmount)}, awarded_amount)`,
    `proposal_notes = COALESCE(${bind(args.updates.proposalNotes)}, proposal_notes)`,
    `estimating_substage = ${bind(args.updates.estimatingSubstage)}`,
    `proposal_status = COALESCE(${bind(args.updates.proposalStatus)}, proposal_status)`,
    `actual_close_date = ${bind(args.updates.actualCloseDate)}`,
    `won_closed_date = ${bind(args.updates.wonClosedDate)}`,
    `lost_reason_id = ${bind(args.updates.lostReasonId)}`,
    `lost_notes = ${bind(args.updates.lostNotes)}`,
    `lost_competitor = ${bind(args.updates.lostCompetitor)}`,
    `lost_at = ${bind(args.updates.lostAt)}`,
    `procore_bid_id = COALESCE(${bind(args.updates.procoreBidId)}, procore_bid_id)`,
    `read_only_synced_at = ${bind(args.updates.readOnlySyncedAt)}`,
    `updated_at = ${bind(args.updates.updatedAt)}`,
    `workflow_route = ${bind(args.updates.workflowRoute)}`,
    `pipeline_type_snapshot = CASE WHEN ${bind(args.updates.workflowRoute)} = 'service' THEN 'service' ELSE 'normal' END`
  );

  const dealIdPlaceholder = bind(args.updates.dealId);
  return {
    sql: `UPDATE ${args.schemaName}.deals
         SET ${setClauses.join(",\n             ")}
         WHERE id = ${dealIdPlaceholder}`,
    params,
  };
}

async function reserveDealNumberSuffix(
  client: PoolClient,
  schemaName: string,
  julianDate: string
): Promise<string> {
  const existingResult = await client.query<{ deal_number: string | null }>(
    `SELECT deal_number
       FROM ${schemaName}.deals
      WHERE deal_number LIKE $1
      ORDER BY deal_number DESC`,
    [`%-%-${julianDate}-%`]
  );
  const fallbackHighestSuffix =
    existingResult.rows
      .map((row) => parseProjectNumberSuffix(row.deal_number, julianDate))
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => right.localeCompare(left))[0] ?? null;

  await client.query(
    `INSERT INTO public.deal_number_daily_sequences (day_key, last_suffix)
     VALUES ($1, $2)
     ON CONFLICT (day_key) DO NOTHING`,
    [julianDate, fallbackHighestSuffix ?? ""]
  );
  const sequenceResult = await client.query<{ last_suffix: string }>(
    `SELECT last_suffix
       FROM public.deal_number_daily_sequences
      WHERE day_key = $1
      FOR UPDATE`,
    [julianDate]
  );
  const suffix = getNextSuffix(sequenceResult.rows[0]?.last_suffix || fallbackHighestSuffix);
  await client.query(
    `UPDATE public.deal_number_daily_sequences
        SET last_suffix = $2,
            updated_at = NOW()
      WHERE day_key = $1`,
    [julianDate, suffix]
  );
  return suffix;
}

// SyncHub shared-secret auth middleware
function requireSyncHubSecret(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const secret = process.env.SYNCHUB_INTEGRATION_SECRET;
  if (!secret) {
    res.status(500).json({ error: "SYNCHUB_INTEGRATION_SECRET not configured" });
    return;
  }
  if (req.headers["x-synchub-secret"] !== secret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

/**
 * POST /api/integrations/synchub/opportunities
 *
 * Payload shape (sent by SyncHub):
 * {
 *   office_slug: string;           // e.g. "dallas"
 *   bid_board_id: string;          // SyncHub internal ID for dedup
 *   procore_bid_id?: number;       // Procore bid ID (if available)
 *   name: string;                  // Project name
 *   stage_slug: string;            // CRM stage slug (e.g. "dd", "estimating")
 *   property_address?: string;
 *   property_city?: string;
 *   property_state?: string;
 *   property_zip?: string;
 *   dd_estimate?: string;          // Numeric string
 *   source?: string;               // "bid_board"
 *   assigned_rep_email?: string;   // Rep to assign (matched by email)
 * }
 */
router.post("/opportunities", requireSyncHubSecret, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const {
      office_slug,
      bid_board_id,
      procore_bid_id,
      name,
      stage_slug,
      stage_label,
      stage_name,
      stage_status,
      stage_family,
      estimating_substage,
      proposal_status,
      stage_entered_at,
      stage_exited_at,
      mirror_source_entered_at,
      mirror_source_exited_at,
      property_address,
      property_city,
      property_state,
      property_zip,
      dd_estimate,
      bid_estimate,
      awarded_amount,
      proposal_notes,
      lost_reason_id,
      lost_notes,
      lost_competitor,
      loss_outcome,
      source = "bid_board",
      assigned_rep_email,
      workflow_route = "normal",
    } = req.body;

    const rawStageInput = stage_slug ?? stage_label ?? stage_name;
    if (!office_slug || !bid_board_id || !name || !rawStageInput) {
      throw new AppError(400, "office_slug, bid_board_id, name, and stage_slug are required");
    }

    // Validate office slug format (prevent injection)
    const slugRegex = /^[a-z][a-z0-9_]*$/;
    if (!slugRegex.test(office_slug)) {
      throw new AppError(400, "Invalid office_slug format");
    }
    if (workflow_route !== "normal" && workflow_route !== "service") {
      throw new AppError(400, "workflow_route must be 'normal' or 'service'");
    }
    // Resolve office
    const officeResult = await client.query(
      "SELECT id FROM public.offices WHERE slug = $1 AND is_active = true LIMIT 1",
      [office_slug]
    );
    if (officeResult.rows.length === 0) {
      throw new AppError(404, `Office not found: ${office_slug}`);
    }
    const officeId: string = officeResult.rows[0].id;
    const schemaName = validateSchemaName(`office_${office_slug}`);

    // Resolve assigned rep (optional — fallback to a system/admin user)
    let assignedRepId: string | null = null;
    if (assigned_rep_email) {
      const repResult = await client.query(
        "SELECT id FROM public.users WHERE email = $1 AND is_active = true LIMIT 1",
        [assigned_rep_email.toLowerCase()]
      );
      assignedRepId = repResult.rows[0]?.id ?? null;
    }
    if (!assignedRepId) {
      // Fallback: pick any active admin/director in this office
      const fallbackResult = await client.query(
        `SELECT id FROM public.users
         WHERE office_id = $1 AND is_active = true AND role IN ('admin', 'director')
         ORDER BY created_at ASC LIMIT 1`,
        [officeId]
      );
      if (fallbackResult.rows.length === 0) {
        throw new AppError(500, "No admin/director found to assign opportunity to");
      }
      assignedRepId = fallbackResult.rows[0].id;
    }

    await client.query("BEGIN");

    // Idempotency: match by procore_bid_id first (most reliable), then by
    // source + name as fallback to catch replays where bid_id wasn't set.
    let existingDealId: string | null = null;
    if (procore_bid_id != null) {
      const existingResult = await client.query(
        `SELECT id FROM ${schemaName}.deals WHERE procore_bid_id = $1 LIMIT 1`,
        [procore_bid_id]
      );
      existingDealId = existingResult.rows[0]?.id ?? null;
    }

    // Fallback dedup: keep service/normal routes isolated even when names match.
    if (!existingDealId) {
      const nameMatchResult = await client.query(
        `SELECT id FROM ${schemaName}.deals
         WHERE source = $1
           AND LOWER(TRIM(name)) = LOWER(TRIM($2))
           AND workflow_route = $3
         LIMIT 1`,
        [source, name, workflow_route]
      );
      existingDealId = nameMatchResult.rows[0]?.id ?? null;
    }

    if (existingDealId) {
      // Mirror (update) path writes deal_stage_history explicitly below, so suppress the
      // backstop trigger (migration 0143) for this branch to avoid double-recording.
      // Scoped to the mirror branch only -- the create branch relies on the trigger for its
      // "Created in" row. Transaction-local; clears at COMMIT/ROLLBACK.
      await client.query("SELECT set_config('app.skip_stage_history_trigger', '1', true)");
      // Fetch current deal state for stage comparison and mirror updates
      const currentDealResult = await client.query(
        `SELECT id, name, deal_number, project_number,
                stage_id, stage_entered_at, on_hold, on_hold_started_at,
                on_hold_accumulated_seconds, on_hold_accumulated_seconds_at_stage_entry,
                workflow_route, is_bid_board_owned,
                proposal_status, estimating_substage, actual_close_date, won_closed_date,
                dd_estimate, bid_estimate, awarded_amount, proposal_notes,
                bid_board_stage_slug, bid_board_stage_family, bid_board_stage_status,
                lost_reason_id, lost_notes, lost_competitor, lost_at
           FROM ${schemaName}.deals
          WHERE id = $1`,
        [existingDealId]
      );
      const currentDeal = currentDealResult.rows[0];
      const effectiveWorkflowRoute: WorkflowRoute =
        currentDeal.workflow_route === "service" ? "service" : "normal";
      const normalizedRequestStageSlug = normalizeBidBoardStageSlug(
        String(rawStageInput),
        effectiveWorkflowRoute
      );
      if (!normalizedRequestStageSlug) {
        throw new AppError(400, `Unknown Bid Board stage: ${rawStageInput}`);
      }
      const targetLookupWorkflowFamily = targetWorkflowFamilyForStage(
        normalizedRequestStageSlug,
        effectiveWorkflowRoute
      );
      const currentStageResult = await client.query(
        `SELECT id, slug, display_order, workflow_family
           FROM public.pipeline_stage_config
          WHERE id = $1
          LIMIT 1`,
        [currentDeal.stage_id]
      );
      const targetStageResult = await client.query(
        `SELECT id, slug, name, display_order, is_terminal, workflow_family,
                required_fields, required_documents, required_approvals
           FROM public.pipeline_stage_config
          WHERE slug = $1
            AND (
              workflow_family = $2
              OR (
                $2 = 'service_deal'
                AND workflow_family = 'standard_deal'
                AND slug = ANY($3::text[])
              )
            )
          ORDER BY CASE WHEN workflow_family = $2 THEN 0 ELSE 1 END
          LIMIT 1`,
        [normalizedRequestStageSlug, targetLookupWorkflowFamily, SHARED_CANONICAL_DEAL_STAGE_SLUGS]
      );

      if (targetStageResult.rows.length === 0) {
        throw new AppError(400, `Unknown stage slug for ${targetLookupWorkflowFamily}: ${normalizedRequestStageSlug}`);
      }

      const targetStage = targetStageResult.rows[0];
      const suppressOpportunityRfpEvent =
        targetStage.slug === "opportunity" || normalizedRequestStageSlug === "opportunity";
      if (suppressOpportunityRfpEvent) {
        // Bid Board mirror updates are not CRM-authored stage changes. PR 4
        // intentionally suppresses deal.opportunity.entered here even if a
        // payload carries the Opportunity slug during cutover or replay.
        console.info("[SyncHub] Suppressed deal.opportunity.entered for Bid Board mirror update");
      }
      const currentStage = currentStageResult.rows[0] ?? null;
      const mirrorResult = buildBidBoardMirrorUpdate({
        now: new Date(),
        deal: {
          id: currentDeal.id,
          stageId: currentDeal.stage_id,
          stageEnteredAt: currentDeal.stage_entered_at,
          onHold: currentDeal.on_hold,
          onHoldStartedAt: currentDeal.on_hold_started_at,
          onHoldAccumulatedSeconds: currentDeal.on_hold_accumulated_seconds,
          onHoldAccumulatedSecondsAtStageEntry:
            currentDeal.on_hold_accumulated_seconds_at_stage_entry,
          workflowRoute: effectiveWorkflowRoute,
          isBidBoardOwned: currentDeal.is_bid_board_owned,
          proposalStatus: currentDeal.proposal_status,
          estimatingSubstage: currentDeal.estimating_substage,
          actualCloseDate: currentDeal.actual_close_date,
          wonClosedDate: currentDeal.won_closed_date ?? null,
          lostReasonId: currentDeal.lost_reason_id,
          lostNotes: currentDeal.lost_notes,
          lostCompetitor: currentDeal.lost_competitor,
          lostAt: currentDeal.lost_at,
        },
        currentStage: currentStage
          ? {
              id: currentStage.id,
              slug: currentStage.slug,
              displayOrder: currentStage.display_order,
            }
          : null,
        targetStage: {
          id: targetStage.id,
          slug: targetStage.slug,
          name: targetStage.name,
          displayOrder: targetStage.display_order,
          isTerminal: targetStage.is_terminal,
          workflowFamily: targetStage.workflow_family,
        },
        payload: {
          stageSlug: normalizedRequestStageSlug,
          stageStatus: stage_status,
          stageFamily: stage_family,
          estimatingSubstage: estimating_substage,
          ...(proposal_status !== undefined ? { proposalStatus: proposal_status } : {}),
          stageEnteredAt: stage_entered_at,
          stageExitedAt: stage_exited_at,
          mirrorSourceEnteredAt: mirror_source_entered_at,
          mirrorSourceExitedAt: mirror_source_exited_at,
          ddEstimate: dd_estimate,
          bidEstimate: bid_estimate,
          awardedAmount: awarded_amount,
          proposalNotes: proposal_notes,
          lostReasonId: lost_reason_id,
          lostNotes: lost_notes,
          lostCompetitor: lost_competitor,
          lossOutcome: loss_outcome,
        },
      });
      const hasProposalStatusUpdate = Object.prototype.hasOwnProperty.call(
        mirrorResult.updates,
        "proposalStatus"
      );
      const proposalStatusForUpdate = hasProposalStatusUpdate
        ? (mirrorResult.updates.proposalStatus ?? null)
        : null;

      if (mirrorResult.history?.isBackwardMove) {
        console.warn(
          `[SyncHub] Backward mirrored move for deal ${existingDealId}: ` +
          `${currentDeal.stage_id} -> ${targetStage.id}. Allowing — Bid Board is the source of truth.`
        );
      }

      const hasGates =
        (Array.isArray(targetStage.required_fields) && targetStage.required_fields.length > 0) ||
        (Array.isArray(targetStage.required_documents) && targetStage.required_documents.length > 0) ||
        (Array.isArray(targetStage.required_approvals) && targetStage.required_approvals.length > 0);
      if (hasGates) {
        console.warn(
          `[SyncHub] Stage gate bypass for deal ${existingDealId}: ` +
          `target stage ${stage_slug} has gate requirements. ` +
          `Bypassing — Bid Board integration is authoritative for mirrored downstream state.`
        );
      }

      const systemUserResult = await client.query(
        `SELECT id FROM public.users
         WHERE office_id = $1 AND is_active = true AND role IN ('admin', 'director')
         ORDER BY created_at ASC LIMIT 1`,
        [officeId]
      );
      const changedByUserId: string = systemUserResult.rows[0]?.id ?? assignedRepId;

      if (mirrorResult.history) {
        await client.query(
          `INSERT INTO ${schemaName}.deal_stage_history
           (deal_id, from_stage_id, to_stage_id, changed_by, is_backward_move,
            is_director_override, override_reason, duration_in_previous_stage)
           VALUES ($1, $2, $3, $4, $5, false, $6, $7::interval)`,
          [
            existingDealId,
            mirrorResult.history.fromStageId,
            mirrorResult.history.toStageId,
            changedByUserId,
            mirrorResult.history.isBackwardMove,
            mirrorResult.history.overrideReason,
            mirrorResult.history.durationInPreviousStage,
          ]
        );

        await client.query(
          `INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
           VALUES ('domain_event', $1::jsonb, $2::uuid, 'pending', NOW())`,
          [
            JSON.stringify({
              eventName: "deal.stage.changed",
              dealId: existingDealId,
              fromStageId: mirrorResult.history.fromStageId,
              toStageId: mirrorResult.history.toStageId,
              isBackwardMove: mirrorResult.history.isBackwardMove,
              changedBy: "synchub_integration",
              officeId,
            }),
            officeId,
          ]
        );
      }

      const mirrorDealUpdate = buildMirrorDealUpdateQuery({
        schemaName,
        includeHoldColumns: mirrorResult.stageChanged,
        updates: {
          stageId: mirrorResult.updates.stageId,
          stageEnteredAt: mirrorResult.updates.stageEnteredAt,
          bidBoardStageSlug: mirrorResult.updates.bidBoardStageSlug,
          bidBoardStageFamily: mirrorResult.updates.bidBoardStageFamily,
          bidBoardStageStatus: mirrorResult.updates.bidBoardStageStatus,
          bidBoardStageEnteredAt: mirrorResult.updates.bidBoardStageEnteredAt,
          bidBoardStageExitedAt: mirrorResult.updates.bidBoardStageExitedAt,
          bidBoardLossOutcome: mirrorResult.updates.bidBoardLossOutcome,
          bidBoardMirrorSourceEnteredAt: mirrorResult.updates.bidBoardMirrorSourceEnteredAt,
          bidBoardMirrorSourceExitedAt: mirrorResult.updates.bidBoardMirrorSourceExitedAt,
          ddEstimate: mirrorResult.updates.ddEstimate ?? null,
          bidEstimate: mirrorResult.updates.bidEstimate ?? null,
          awardedAmount: mirrorResult.updates.awardedAmount ?? null,
          proposalNotes: mirrorResult.updates.proposalNotes ?? null,
          estimatingSubstage: mirrorResult.updates.estimatingSubstage ?? null,
          proposalStatus: proposalStatusForUpdate,
          actualCloseDate: mirrorResult.updates.actualCloseDate ?? null,
          wonClosedDate: mirrorResult.updates.wonClosedDate ?? null,
          lostReasonId: mirrorResult.updates.lostReasonId ?? null,
          lostNotes: mirrorResult.updates.lostNotes ?? null,
          lostCompetitor: mirrorResult.updates.lostCompetitor ?? null,
          lostAt: mirrorResult.updates.lostAt ?? null,
          procoreBidId: procore_bid_id ?? null,
          readOnlySyncedAt: mirrorResult.updates.readOnlySyncedAt,
          updatedAt: mirrorResult.updates.updatedAt,
          onHoldStartedAt: mirrorResult.updates.onHoldStartedAt ?? null,
          onHoldAccumulatedSeconds: mirrorResult.updates.onHoldAccumulatedSeconds ?? null,
          onHoldAccumulatedSecondsAtStageEntry:
            mirrorResult.updates.onHoldAccumulatedSecondsAtStageEntry ?? null,
          dealId: existingDealId,
          workflowRoute: effectiveWorkflowRoute,
        },
      });
      await client.query(mirrorDealUpdate.sql, mirrorDealUpdate.params);

      const webhookFieldChanges: Record<string, { from: unknown; to: unknown }> = {
        stageId: { from: currentDeal.stage_id, to: mirrorResult.updates.stageId },
        bidBoardStageSlug: { from: currentDeal.bid_board_stage_slug ?? null, to: mirrorResult.updates.bidBoardStageSlug },
        bidBoardStageFamily: { from: currentDeal.bid_board_stage_family ?? null, to: mirrorResult.updates.bidBoardStageFamily },
        bidBoardStageStatus: { from: currentDeal.bid_board_stage_status ?? null, to: mirrorResult.updates.bidBoardStageStatus },
        readOnlySyncedAt: { from: null, to: mirrorResult.updates.readOnlySyncedAt },
      };
      const optionalWebhookFields = [
        { key: "ddEstimate", column: "dd_estimate", value: mirrorResult.updates.ddEstimate },
        { key: "bidEstimate", column: "bid_estimate", value: mirrorResult.updates.bidEstimate },
        { key: "awardedAmount", column: "awarded_amount", value: mirrorResult.updates.awardedAmount },
        { key: "proposalNotes", column: "proposal_notes", value: mirrorResult.updates.proposalNotes },
        { key: "estimatingSubstage", column: "estimating_substage", value: mirrorResult.updates.estimatingSubstage },
        { key: "proposalStatus", column: "proposal_status", value: mirrorResult.updates.proposalStatus },
        { key: "actualCloseDate", column: "actual_close_date", value: mirrorResult.updates.actualCloseDate },
        { key: "wonClosedDate", column: "won_closed_date", value: mirrorResult.updates.wonClosedDate },
      ] as const;
      for (const { key, column, value } of optionalWebhookFields) {
        if (value === undefined) continue;
        const normalizedOld = currentDeal[column] ?? null;
        const normalizedNew = value ?? null;
        if (COALESCE_PROTECTED_WEBHOOK_FIELDS.has(key) && normalizedNew === null) continue;
        if (normalizedOld !== normalizedNew) {
          webhookFieldChanges[key] = { from: normalizedOld, to: normalizedNew };
        }
      }
      await logActivityWithPgClient({
        client,
        schemaName,
        actor: buildAuditActorFromSystem({ systemProcess: PROCORE_SYNCHUB_WEBHOOK }),
        action: "update",
        entity: {
          tableName: "deals",
          entityType: "deal",
          recordId: existingDealId,
          nameSnapshot: currentDeal.name ?? name,
          secondaryIdSnapshot: currentDeal.project_number ?? currentDeal.deal_number ?? null,
        },
        fieldChanges: webhookFieldChanges,
        metadata: { procoreBidId: procore_bid_id ?? null, bidBoardId: bid_board_id },
      });

      await client.query("COMMIT");
      console.log(
        `[SyncHub] Updated existing deal ${existingDealId} from Bid Board push` +
        (mirrorResult.stageChanged ? ` (stage changed to ${normalizedRequestStageSlug})` : "")
      );
      res.json({ status: "updated", deal_id: existingDealId, stage_changed: mirrorResult.stageChanged });
      return;
    }

    const normalizedRequestStageSlug = normalizeBidBoardStageSlug(String(rawStageInput), workflow_route);
    if (!normalizedRequestStageSlug) {
      throw new AppError(400, `Unknown Bid Board stage: ${rawStageInput}`);
    }
    const targetWorkflowFamily = targetWorkflowFamilyForStage(normalizedRequestStageSlug, workflow_route);

    const stageResult = await client.query(
      `SELECT id, slug, name, display_order, is_terminal, workflow_family
         FROM public.pipeline_stage_config
        WHERE slug = $1
          AND (
            workflow_family = $2
            OR (
              $2 = 'service_deal'
              AND workflow_family = 'standard_deal'
              AND slug = ANY($3::text[])
            )
          )
        ORDER BY CASE WHEN workflow_family = $2 THEN 0 ELSE 1 END
        LIMIT 1`,
      [normalizedRequestStageSlug, targetWorkflowFamily, SHARED_CANONICAL_DEAL_STAGE_SLUGS]
    );
    if (stageResult.rows.length === 0) {
      throw new AppError(400, `Unknown stage slug for ${targetWorkflowFamily}: ${normalizedRequestStageSlug}`);
    }
    const targetStage = stageResult.rows[0];
    const mirrorResult = buildBidBoardMirrorUpdate({
      now: new Date(),
      deal: {
        id: "new",
        stageId: targetStage.id,
        // Carry the Procore-reported stage-entry date so an INSERT of an
        // already-Won deal derives won_closed_date (and stage_entered_at) from the
        // real source date, not processing-time now. On insert stageChanged is
        // structurally false (deal.stageId === targetStage.id), so the mirror's
        // stageEnteredAt resolver reads input.deal.stageEnteredAt; null falls back
        // to now (no regression when SyncHub omits the field).
        stageEnteredAt: stage_entered_at ?? null,
        workflowRoute: workflow_route,
        isBidBoardOwned: false,
        proposalStatus: null,
        estimatingSubstage: null,
        actualCloseDate: null,
        wonClosedDate: null,
        lostReasonId: null,
        lostNotes: null,
        lostCompetitor: null,
        lostAt: null,
      },
      targetStage: {
        id: targetStage.id,
        slug: targetStage.slug,
        name: targetStage.name,
        displayOrder: targetStage.display_order,
        isTerminal: targetStage.is_terminal,
        workflowFamily: targetStage.workflow_family,
      },
      payload: {
        stageSlug: normalizedRequestStageSlug,
        stageStatus: stage_status,
        stageFamily: stage_family,
        estimatingSubstage: estimating_substage,
        proposalStatus: proposal_status,
        stageEnteredAt: stage_entered_at,
        stageExitedAt: stage_exited_at,
        mirrorSourceEnteredAt: mirror_source_entered_at,
        mirrorSourceExitedAt: mirror_source_exited_at,
        ddEstimate: dd_estimate,
        bidEstimate: bid_estimate,
        awardedAmount: awarded_amount,
        proposalNotes: proposal_notes,
        lostReasonId: lost_reason_id,
        lostNotes: lost_notes,
        lostCompetitor: lost_competitor,
        lossOutcome: loss_outcome,
      },
    });

    const officeCode = resolveOfficeCode(office_slug);
    const createdAt = new Date();
    const julianDate = generateJulianDate(createdAt);
    const dealNumber = buildProjectNumber({
      officeCode,
      projectTypeCode: resolveProjectTypeCode({ workflowRoute: workflow_route }),
      createdAt,
      suffix: await reserveDealNumberSuffix(client, schemaName, julianDate),
    });

    // Insert new deal
    const insertResult = await client.query(
      `INSERT INTO ${schemaName}.deals
       (deal_number, name, stage_id, assigned_rep_id, procore_bid_id,
        property_address, property_city, property_state, property_zip, office_code,
        dd_estimate, bid_estimate, awarded_amount, source, is_active,
        workflow_route, pipeline_type_snapshot, is_bid_board_owned,
       bid_board_stage_slug, bid_board_stage_family, bid_board_stage_status,
        bid_board_stage_entered_at, bid_board_stage_exited_at, bid_board_stage_duration,
        bid_board_loss_outcome, bid_board_mirror_source_entered_at, bid_board_mirror_source_exited_at,
        read_only_synced_at, stage_entered_at, estimating_substage, proposal_status, proposal_notes,
        actual_close_date, lost_reason_id, lost_notes, lost_competitor, lost_at,
        created_at, updated_at, won_closed_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, true, $15,
               CASE WHEN $15 = 'service' THEN 'service' ELSE 'normal' END,
               true, $16, $17, $18, $19, $20,
               CASE
                 WHEN $19::timestamptz IS NOT NULL AND $20::timestamptz IS NOT NULL THEN $20::timestamptz - $19::timestamptz
                 ELSE NULL
               END,
               $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33,
               $34, $35, $36)
       RETURNING id, name, deal_number, project_number`,
      [
        dealNumber,
        name,
        mirrorResult.updates.stageId,
        assignedRepId,
        procore_bid_id ?? null,
        property_address ?? null,
        property_city ?? null,
        property_state ?? null,
        property_zip ?? null,
        officeCode,
        mirrorResult.updates.ddEstimate ?? null,
        mirrorResult.updates.bidEstimate ?? null,
        mirrorResult.updates.awardedAmount ?? null,
        source,
        workflow_route,
        mirrorResult.updates.bidBoardStageSlug,
        mirrorResult.updates.bidBoardStageFamily,
        mirrorResult.updates.bidBoardStageStatus,
        mirrorResult.updates.bidBoardStageEnteredAt,
        mirrorResult.updates.bidBoardStageExitedAt,
        mirrorResult.updates.bidBoardLossOutcome,
        mirrorResult.updates.bidBoardMirrorSourceEnteredAt,
        mirrorResult.updates.bidBoardMirrorSourceExitedAt,
        mirrorResult.updates.readOnlySyncedAt,
        mirrorResult.updates.stageEnteredAt,
        mirrorResult.updates.estimatingSubstage ?? null,
        mirrorResult.updates.proposalStatus ?? null,
        mirrorResult.updates.proposalNotes ?? null,
        mirrorResult.updates.actualCloseDate ?? null,
        mirrorResult.updates.lostReasonId ?? null,
        mirrorResult.updates.lostNotes ?? null,
        mirrorResult.updates.lostCompetitor ?? null,
        mirrorResult.updates.lostAt ?? null,
        createdAt,
        createdAt,
        mirrorResult.updates.wonClosedDate ?? null,
      ]
    );

    const insertedDeal = insertResult.rows[0];
    const newDealId: string = insertedDeal.id;

    await logActivityWithPgClient({
      client,
      schemaName,
      actor: buildAuditActorFromSystem({ systemProcess: PROCORE_SYNCHUB_WEBHOOK }),
      action: "insert",
      entity: {
        tableName: "deals",
        entityType: "deal",
        recordId: newDealId,
        nameSnapshot: insertedDeal.name ?? name,
        secondaryIdSnapshot: insertedDeal.project_number ?? insertedDeal.deal_number ?? dealNumber,
      },
      fieldChanges: {
        name: { from: null, to: name },
        stageId: { from: null, to: mirrorResult.updates.stageId },
        assignedRepId: { from: null, to: assignedRepId },
        bidEstimate: { from: null, to: mirrorResult.updates.bidEstimate ?? null },
        ddEstimate: { from: null, to: mirrorResult.updates.ddEstimate ?? null },
        awardedAmount: { from: null, to: mirrorResult.updates.awardedAmount ?? null },
        workflowRoute: { from: null, to: workflow_route },
        bidBoardStageSlug: { from: null, to: mirrorResult.updates.bidBoardStageSlug },
        readOnlySyncedAt: { from: null, to: mirrorResult.updates.readOnlySyncedAt },
      },
      metadata: { procoreBidId: procore_bid_id ?? null, bidBoardId: bid_board_id },
    });

    // Write to job_queue so worker can fire deal.created notification
    await client.query(
      `INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
       VALUES ('domain_event', $1::jsonb, $2, 'pending', NOW())`,
      [
        JSON.stringify({
          eventName: "deal.created",
          dealId: newDealId,
          source: "synchub_bid_board",
          officeId,
        }),
        officeId,
      ]
    );

    await client.query("COMMIT");

    console.log(`[SyncHub] Created deal ${dealNumber} (${newDealId}) from Bid Board push`);
    res.status(201).json({ status: "created", deal_id: newDealId, deal_number: dealNumber });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

export const syncHubRoutes = router;
