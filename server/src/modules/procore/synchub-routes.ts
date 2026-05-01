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

const router = Router();
type WorkflowRoute = "normal" | "service";

const SHARED_CANONICAL_DEAL_STAGE_SLUGS = [
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
      // Fetch current deal state for stage comparison and mirror updates
      const currentDealResult = await client.query(
        `SELECT id, stage_id, stage_entered_at, workflow_route, is_bid_board_owned,
                proposal_status, estimating_substage, actual_close_date,
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
      const [currentStageResult, targetStageResult] = await Promise.all([
        client.query(
          `SELECT id, slug, display_order, workflow_family
             FROM public.pipeline_stage_config
            WHERE id = $1
            LIMIT 1`,
          [currentDeal.stage_id]
        ),
        client.query(
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
        ),
      ]);

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
          workflowRoute: effectiveWorkflowRoute,
          isBidBoardOwned: currentDeal.is_bid_board_owned,
          proposalStatus: currentDeal.proposal_status,
          estimatingSubstage: currentDeal.estimating_substage,
          actualCloseDate: currentDeal.actual_close_date,
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

      await client.query(
        `UPDATE ${schemaName}.deals
         SET stage_id = $1,
             stage_entered_at = $2,
             is_bid_board_owned = true,
             bid_board_stage_slug = $3,
             bid_board_stage_family = $4,
             bid_board_stage_status = $5,
             bid_board_stage_entered_at = $6,
             bid_board_stage_exited_at = $7,
             bid_board_stage_duration = CASE
               WHEN $6::timestamptz IS NOT NULL AND $7::timestamptz IS NOT NULL THEN $7::timestamptz - $6::timestamptz
               ELSE NULL
             END,
             bid_board_loss_outcome = $8,
             bid_board_mirror_source_entered_at = $9,
             bid_board_mirror_source_exited_at = $10,
             dd_estimate = COALESCE($11, dd_estimate),
             bid_estimate = COALESCE($12, bid_estimate),
             awarded_amount = COALESCE($13, awarded_amount),
             proposal_notes = COALESCE($14, proposal_notes),
             estimating_substage = $15,
             proposal_status = COALESCE($16, proposal_status),
             actual_close_date = $17,
             lost_reason_id = $18,
             lost_notes = $19,
             lost_competitor = $20,
             lost_at = $21,
             procore_bid_id = COALESCE($22, procore_bid_id),
             read_only_synced_at = $23,
             updated_at = $24,
             workflow_route = $26,
             pipeline_type_snapshot = CASE WHEN $26 = 'service' THEN 'service' ELSE 'normal' END
         WHERE id = $25`,
        [
          mirrorResult.updates.stageId,
          mirrorResult.updates.stageEnteredAt,
          mirrorResult.updates.bidBoardStageSlug,
          mirrorResult.updates.bidBoardStageFamily,
          mirrorResult.updates.bidBoardStageStatus,
          mirrorResult.updates.bidBoardStageEnteredAt,
          mirrorResult.updates.bidBoardStageExitedAt,
          mirrorResult.updates.bidBoardLossOutcome,
          mirrorResult.updates.bidBoardMirrorSourceEnteredAt,
          mirrorResult.updates.bidBoardMirrorSourceExitedAt,
          mirrorResult.updates.ddEstimate ?? null,
          mirrorResult.updates.bidEstimate ?? null,
          mirrorResult.updates.awardedAmount ?? null,
          mirrorResult.updates.proposalNotes ?? null,
          mirrorResult.updates.estimatingSubstage ?? null,
          mirrorResult.updates.proposalStatus ?? null,
          mirrorResult.updates.actualCloseDate ?? null,
          mirrorResult.updates.lostReasonId ?? null,
          mirrorResult.updates.lostNotes ?? null,
          mirrorResult.updates.lostCompetitor ?? null,
          mirrorResult.updates.lostAt ?? null,
          procore_bid_id ?? null,
          mirrorResult.updates.readOnlySyncedAt,
          mirrorResult.updates.updatedAt,
          existingDealId,
          effectiveWorkflowRoute,
        ]
      );

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
        stageEnteredAt: null,
        workflowRoute: workflow_route,
        isBidBoardOwned: false,
        proposalStatus: null,
        estimatingSubstage: null,
        actualCloseDate: null,
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
        created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, true, $15,
               CASE WHEN $15 = 'service' THEN 'service' ELSE 'normal' END,
               true, $16, $17, $18, $19, $20,
               CASE
                 WHEN $19::timestamptz IS NOT NULL AND $20::timestamptz IS NOT NULL THEN $20::timestamptz - $19::timestamptz
                 ELSE NULL
               END,
               $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33,
               $34, $35)
       RETURNING id`,
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
      ]
    );

    const newDealId: string = insertResult.rows[0].id;

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
