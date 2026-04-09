// server/src/modules/procore/synchub-routes.ts
// POST /api/integrations/synchub/opportunities — one-way push from SyncHub.
// Authenticated by shared secret header (X-SyncHub-Secret), not JWT.

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { pool } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";

const router = Router();

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
      property_address,
      property_city,
      property_state,
      property_zip,
      dd_estimate,
      source = "bid_board",
      assigned_rep_email,
    } = req.body;

    if (!office_slug || !bid_board_id || !name || !stage_slug) {
      throw new AppError(400, "office_slug, bid_board_id, name, and stage_slug are required");
    }

    // Validate office slug format (prevent injection)
    const slugRegex = /^[a-z][a-z0-9_]*$/;
    if (!slugRegex.test(office_slug)) {
      throw new AppError(400, "Invalid office_slug format");
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

    // Resolve stage
    const stageResult = await client.query(
      "SELECT id FROM public.pipeline_stage_config WHERE slug = $1 LIMIT 1",
      [stage_slug]
    );
    if (stageResult.rows.length === 0) {
      throw new AppError(400, `Unknown stage slug: ${stage_slug}`);
    }
    const stageId: string = stageResult.rows[0].id;

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

    // Fallback dedup: match by source + exact name (catches replays without procore_bid_id)
    if (!existingDealId) {
      const nameMatchResult = await client.query(
        `SELECT id FROM ${schemaName}.deals
         WHERE source = $1 AND LOWER(TRIM(name)) = LOWER(TRIM($2))
         LIMIT 1`,
        [source, name]
      );
      existingDealId = nameMatchResult.rows[0]?.id ?? null;
    }

    if (existingDealId) {
      // Fetch current deal state for stage comparison
      const currentDealResult = await client.query(
        `SELECT stage_id, stage_entered_at FROM ${schemaName}.deals WHERE id = $1`,
        [existingDealId]
      );
      const currentStageId: string = currentDealResult.rows[0].stage_id;
      const stageEnteredAt: Date | null = currentDealResult.rows[0].stage_entered_at;

      const stageChanged = currentStageId !== stageId;

      if (stageChanged) {
        // Lookup display_order for both stages to detect backward moves
        const stageOrderResult = await client.query(
          `SELECT id, display_order FROM public.pipeline_stage_config WHERE id IN ($1, $2)`,
          [currentStageId, stageId]
        );
        const orderMap = new Map<string, number>();
        for (const row of stageOrderResult.rows) {
          orderMap.set(row.id, row.display_order);
        }
        const currentOrder = orderMap.get(currentStageId) ?? 0;
        const targetOrder = orderMap.get(stageId) ?? 0;
        const isBackwardMove = targetOrder < currentOrder;

        if (isBackwardMove) {
          console.warn(
            `[SyncHub] Backward stage move for deal ${existingDealId}: ` +
            `stage ${currentStageId} (order ${currentOrder}) -> ${stageId} (order ${targetOrder}). ` +
            `Allowing — Procore is system of record.`
          );
        }

        // Validate stage gate — log conflicts but always allow (SyncHub is authoritative)
        // Gate check uses raw SQL against the same tables validateStageGate() would use
        const gateFieldsResult = await client.query(
          `SELECT required_fields, required_documents, required_approvals
           FROM public.pipeline_stage_config WHERE id = $1`,
          [stageId]
        );
        if (gateFieldsResult.rows.length > 0) {
          const { required_fields, required_documents, required_approvals } = gateFieldsResult.rows[0];
          const hasGates =
            (Array.isArray(required_fields) && required_fields.length > 0) ||
            (Array.isArray(required_documents) && required_documents.length > 0) ||
            (Array.isArray(required_approvals) && required_approvals.length > 0);
          if (hasGates) {
            console.warn(
              `[SyncHub] Stage gate bypass for deal ${existingDealId}: ` +
              `target stage ${stage_slug} has gate requirements ` +
              `(fields: ${JSON.stringify(required_fields)}, ` +
              `docs: ${JSON.stringify(required_documents)}, ` +
              `approvals: ${JSON.stringify(required_approvals)}). ` +
              `Bypassing — SyncHub integration is authoritative for stage changes.`
            );
          }
        }

        // Calculate duration in previous stage
        const durationSql = stageEnteredAt
          ? `(NOW() - $1::timestamptz)`
          : null;

        // Resolve a system user for changed_by (reuse the assignedRepId fallback)
        const systemUserResult = await client.query(
          `SELECT id FROM public.users
           WHERE office_id = $1 AND is_active = true AND role IN ('admin', 'director')
           ORDER BY created_at ASC LIMIT 1`,
          [officeId]
        );
        const changedByUserId: string = systemUserResult.rows[0]?.id ?? assignedRepId;

        // Insert stage history audit record
        if (durationSql) {
          await client.query(
            `INSERT INTO ${schemaName}.deal_stage_history
             (deal_id, from_stage_id, to_stage_id, changed_by, is_backward_move,
              is_director_override, override_reason, duration_in_previous_stage)
             VALUES ($1, $2, $3, $4, $5, false, $6, (NOW() - $7::timestamptz))`,
            [
              existingDealId,
              currentStageId,
              stageId,
              changedByUserId,
              isBackwardMove,
              "Procore/SyncHub integration sync",
              stageEnteredAt,
            ]
          );
        } else {
          await client.query(
            `INSERT INTO ${schemaName}.deal_stage_history
             (deal_id, from_stage_id, to_stage_id, changed_by, is_backward_move,
              is_director_override, override_reason)
             VALUES ($1, $2, $3, $4, $5, false, $6)`,
            [
              existingDealId,
              currentStageId,
              stageId,
              changedByUserId,
              isBackwardMove,
              "Procore/SyncHub integration sync",
            ]
          );
        }

        // Emit domain event via job_queue (outbox pattern)
        await client.query(
          `INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
           VALUES ('domain_event', $1::jsonb, $2::uuid, 'pending', NOW())`,
          [
            JSON.stringify({
              eventName: "deal.stage.changed",
              dealId: existingDealId,
              fromStageId: currentStageId,
              toStageId: stageId,
              isBackwardMove,
              changedBy: "synchub_integration",
              officeId,
            }),
            officeId,
          ]
        );
      }

      // Update deal: always sync procore_bid_id; update stage + stage_entered_at only if changed
      if (stageChanged) {
        await client.query(
          `UPDATE ${schemaName}.deals
           SET stage_id = $1,
               stage_entered_at = NOW(),
               procore_bid_id = COALESCE($2, procore_bid_id),
               updated_at = NOW()
           WHERE id = $3`,
          [stageId, procore_bid_id ?? null, existingDealId]
        );
      } else {
        await client.query(
          `UPDATE ${schemaName}.deals
           SET procore_bid_id = COALESCE($1, procore_bid_id),
               updated_at = NOW()
           WHERE id = $2`,
          [procore_bid_id ?? null, existingDealId]
        );
      }

      await client.query("COMMIT");
      console.log(
        `[SyncHub] Updated existing deal ${existingDealId} from Bid Board push` +
        (stageChanged ? ` (stage changed to ${stage_slug})` : "")
      );
      res.json({ status: "updated", deal_id: existingDealId, stage_changed: stageChanged });
      return;
    }

    // Generate deal number: TR-{YYYY}-{NNNN}
    const year = new Date().getFullYear();
    const prefix = `TR-${year}-`;
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [prefix]);
    const maxResult = await client.query(
      `SELECT deal_number FROM ${schemaName}.deals
       WHERE deal_number LIKE $1 ORDER BY deal_number DESC LIMIT 1 FOR UPDATE`,
      [`${prefix}%`]
    );
    let nextSeq = 1;
    if (maxResult.rows.length > 0) {
      const parsed = parseInt(maxResult.rows[0].deal_number.replace(prefix, ""), 10);
      if (!isNaN(parsed)) nextSeq = parsed + 1;
    }
    const dealNumber = `${prefix}${String(nextSeq).padStart(4, "0")}`;

    // Insert new deal
    const insertResult = await client.query(
      `INSERT INTO ${schemaName}.deals
       (deal_number, name, stage_id, assigned_rep_id, procore_bid_id,
        property_address, property_city, property_state, property_zip,
        dd_estimate, source, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, NOW(), NOW())
       RETURNING id`,
      [
        dealNumber,
        name,
        stageId,
        assignedRepId,
        procore_bid_id ?? null,
        property_address ?? null,
        property_city ?? null,
        property_state ?? null,
        property_zip ?? null,
        dd_estimate ?? null,
        source,
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
