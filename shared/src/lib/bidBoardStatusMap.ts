export type BidBoardExportStageSlug =
  | "estimating"
  | "estimate_under_review"
  | "estimate_sent_to_client"
  | "contract"
  | "won"
  | "lost";

export const BID_BOARD_STATUS_TO_CRM_STAGE: Record<string, BidBoardExportStageSlug> = {
  "estimate in progress": "estimating",
  "service estimating": "estimating",
  "estimate under review": "estimate_under_review",
  "estimate sent to client": "estimate_sent_to_client",
  contract: "contract",
  won: "won",
  lost: "lost",
};

const SKIPPED_BID_BOARD_STATUSES = new Set(["templates"]);

export function normalizeBidBoardStatus(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

export function isSkippedBidBoardStatus(value: string | null | undefined): boolean {
  const normalized = normalizeBidBoardStatus(value);
  return normalized != null && SKIPPED_BID_BOARD_STATUSES.has(normalized);
}

export function bidBoardStatusToCrmStage(
  value: string | null | undefined
): BidBoardExportStageSlug | null {
  const normalized = normalizeBidBoardStatus(value);
  if (!normalized || SKIPPED_BID_BOARD_STATUSES.has(normalized)) return null;
  return BID_BOARD_STATUS_TO_CRM_STAGE[normalized] ?? null;
}
