import type { Request } from "express";
import { eq, and } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { fieldScorecards } from "@trock-crm/shared/schema";
import {
  isCorrectiveActionApprover,
  resolveCorrectiveActionApprovers,
} from "@trock-crm/shared/lib/correctiveActionApprovers";
import { AppError } from "../../middleware/error-handler.js";
import {
  approveCorrectiveActionItems,
  rejectCorrectiveActionItem,
  type ApprovalActor,
  type ApprovalOutcome,
} from "./corrective-action-approval.js";

type TenantDb = NodePgDatabase<typeof schema>;

/**
 * Authorization for the corrective-action APPROVAL verbs.
 *
 * Gated on the `QC_APPROVER_EMAILS` allowlist alone — deliberately not a role. The allowlist grants the
 * verb; the caller still needs ordinary CRM access to the deal, which the route's own
 * assertDealRouteAccess provides before this runs.
 *
 * FAILS CLOSED. An unset or empty list authorizes nobody, and must never degrade to a role check: that
 * would silently grant exactly the authority the allowlist exists to withhold. The 403 is logged with the
 * reason so a misconfiguration is diagnosable rather than mysterious.
 */
export function assertCorrectiveActionApprover(
  req: Request,
  env: NodeJS.ProcessEnv = process.env,
): ApprovalActor {
  const approvers = resolveCorrectiveActionApprovers(env);
  const user = req.user;
  if (!user?.id) throw new AppError(401, "Not authenticated");

  if (approvers.length === 0) {
    console.warn(
      "[CorrectiveActionApproval] QC_APPROVER_EMAILS is not configured - nobody can approve. Set it (comma-separated) to enable the approval gate.",
      { userId: user.id },
    );
    throw new AppError(403, "Corrective-action approval is not configured.", "QC_APPROVER_NOT_CONFIGURED");
  }
  if (!isCorrectiveActionApprover(user.email, approvers)) {
    throw new AppError(
      403,
      "You are not authorized to approve or reject corrective actions.",
      "NOT_A_QC_APPROVER",
    );
  }

  return {
    userId: user.id,
    name: user.displayName ?? null,
    email: user.email ?? null,
  };
}

/** Whether the signed-in user may see the approve/reject controls. Server stays authoritative regardless. */
export function canApproveCorrectiveActions(
  req: Request,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const approvers = resolveCorrectiveActionApprovers(env);
  return approvers.length > 0 && isCorrectiveActionApprover(req.user?.email, approvers);
}

/**
 * The scorecard must belong to the deal in the URL, and still be active. Without this an approver could act
 * on any scorecard id by pairing it with a deal they can access.
 */
export async function assertScorecardBelongsToDeal(
  db: TenantDb,
  dealId: string,
  scorecardId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: fieldScorecards.id })
    .from(fieldScorecards)
    .where(
      and(
        eq(fieldScorecards.id, scorecardId),
        eq(fieldScorecards.dealId, dealId),
        eq(fieldScorecards.isActive, true),
      ),
    )
    .limit(1);
  if (!row) throw new AppError(404, "Scorecard not found");
}

/** Parse + validate the optional explicit item-id list on an approve request. */
export function parseApproveItemIds(body: unknown): string[] | undefined {
  const raw = (body as { itemIds?: unknown } | null | undefined)?.itemIds;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new AppError(400, "itemIds must be an array of corrective-action item ids.");
  const ids = [...new Set(raw.filter((id): id is string => typeof id === "string" && id.trim().length > 0))];
  if (ids.length === 0) throw new AppError(400, "itemIds must contain at least one item id.");
  return ids;
}

/** Parse + validate a rejection comment. Required and bounded — it is the whole content of a rejection. */
export const MAX_REJECTION_COMMENT_LENGTH = 5000;
export function parseRejectionComment(body: unknown): string {
  const raw = (body as { comment?: unknown } | null | undefined)?.comment;
  const comment = typeof raw === "string" ? raw.trim() : "";
  if (!comment) {
    throw new AppError(400, "A rejection needs a comment explaining what still has to be fixed.");
  }
  if (comment.length > MAX_REJECTION_COMMENT_LENGTH) {
    throw new AppError(400, `A rejection comment cannot exceed ${MAX_REJECTION_COMMENT_LENGTH} characters.`);
  }
  return comment;
}

export type { ApprovalOutcome };
export { approveCorrectiveActionItems, rejectCorrectiveActionItem };
