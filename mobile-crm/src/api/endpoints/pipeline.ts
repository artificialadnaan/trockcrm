import type { DealListItem, PipelineStage } from "../types";
import type { Fetcher } from "./auth";

/**
 * The kanban board and the stage-move flow.
 *
 * Contracts here were read off the server rather than inferred, because two of them are actively
 * misleading:
 *
 *   - The OpenAPI spec documents GET /api/deals/pipeline as an object keyed by stage id. It is not.
 *     The route returns `{ pipelineColumns, terminalStages }` (deals/routes.ts:1019-1030). Following
 *     the spec would produce a client that renders nothing on a perfectly good response.
 *
 *   - The web client calls the cards `column.cards`. That is a CLIENT-SIDE rename in
 *     normalizeDealBoardResponse; the wire field is `column.deals`. Copying the web type would give an
 *     empty board with no error.
 */

/** A column of the board. `deals` — never `cards`. */
export type PipelineColumn = {
  stage: PipelineStage;
  deals: DealListItem[];
  totalValue: number;
  /** Active (non-held) card count — what the column header should show. */
  activeCount: number;
  /** Including held cards. Differs from activeCount whenever anything is parked. */
  totalCount: number;
  count: number;
};

/**
 * Won/Lost summaries. These carry NO `deals` array — the web type declares one as optional, which
 * reads as "might be there". It never is; terminal cards live inside pipelineColumns.
 */
export type TerminalStageSummary = {
  stage: PipelineStage;
  totalValue: number;
  count: number;
};

export type PipelineResponse = {
  pipelineColumns: PipelineColumn[];
  terminalStages: TerminalStageSummary[];
};

/** The scopes the server actually understands. */
export type PipelineScope = "mine" | "team" | "all" | "watched" | "on_hold";

/**
 * How many cards to pull per column.
 *
 * The server default is 100 PER COLUMN across ~8-10 columns, and every card is the full ~120-column
 * deals row — multiple megabytes on cellular, for a board that shows a handful of cards per column at a
 * time. A phone wants a preview and a drill-down, not the whole pipeline.
 */
const BOARD_PREVIEW_LIMIT = 15;

export async function getPipeline(
  fetcher: Fetcher,
  params: { scope: PipelineScope; previewLimit?: number },
): Promise<PipelineResponse> {
  const res = await fetcher<PipelineResponse>("/deals/pipeline", {
    query: {
      // ALWAYS explicit. `normalizeCollaborativeScope` is literally `requested ?? "mine"` and does not
      // validate — an unrecognised string falls through every branch and yields an UNSCOPED,
      // office-wide board. Omitting it is merely owner-scoped; misspelling it leaks the whole office.
      scope: params.scope,
      previewLimit: params.previewLimit ?? BOARD_PREVIEW_LIMIT,
    },
  });
  return {
    pipelineColumns: res.pipelineColumns ?? [],
    terminalStages: res.terminalStages ?? [],
  };
}

/** One stage's full, paginated card list — the drill-down the board preview links to. */
export async function getStagePage(
  fetcher: Fetcher,
  stageId: string,
  params: { scope: PipelineScope; page?: number; limit?: number } ,
): Promise<{ deals: DealListItem[]; pagination?: { page: number; limit: number; total: number; totalPages: number } }> {
  // NO envelope on this one — the service result IS the body (routes.ts:1052).
  const res = await fetcher<{
    deals?: DealListItem[];
    pagination?: { page: number; limit: number; total: number; totalPages: number };
  }>(`/deals/stages/${stageId}`, {
    query: {
      scope: params.scope,
      page: params.page && params.page > 0 ? params.page : undefined,
      limit: params.limit,
    },
  });
  return { deals: res.deals ?? [], pagination: res.pagination };
}

/** One requirement the gate checks. */
export type ChecklistEntry = { key: string; label: string; satisfied: boolean };

/**
 * The preflight verdict.
 *
 * IMPORTANT: preflight has NO ownership check on the server, while the COMMIT route is strictly
 * owner-only with no admin or director bypass. So `allowed: true` here does NOT mean this user may
 * move the deal — a director can preflight any deal in their office, get a green light, and then take
 * a hard 403 on commit. Gate the affordance on ownership; use this only for "what is missing".
 */
export type StagePreflight = {
  allowed: boolean;
  isBackwardMove: boolean;
  isTerminal: boolean;
  targetStage: { id: string; name: string; slug: string; isTerminal: boolean };
  currentStage?: { id: string; name: string; slug: string } | null;
  missingRequirements?: { fields: string[]; documents: string[]; approvals: string[] };
  effectiveChecklist?: {
    fields: ChecklistEntry[];
    attachments: ChecklistEntry[];
    approvals: ChecklistEntry[];
  };
  requiresOverride: boolean;
  overrideType?: string | null;
  blockReason: string | null;
  /** A Bid Board-owned deal is read-only here; the board is the system of record. */
  bidBoardLocked?: boolean;
};

export async function preflightStage(
  fetcher: Fetcher,
  dealId: string,
  targetStageId: string,
): Promise<StagePreflight> {
  // `targetStageId`, not `stageId` — the server 400s without it.
  return fetcher<StagePreflight>(`/deals/${dealId}/stage/preflight`, {
    method: "POST",
    body: { targetStageId },
  });
}

export type StageMoveInput = {
  targetStageId: string;
  /** Required by the server for a backward move and for any admin/director requirement override. */
  overrideReason?: string;
  /** Both required when moving into a Lost stage. */
  lostReasonId?: string;
  lostNotes?: string;
  lostCompetitor?: string;
};

export async function moveStage(
  fetcher: Fetcher,
  dealId: string,
  input: StageMoveInput,
): Promise<{ deal: DealListItem }> {
  const res = await fetcher<{ deal: DealListItem }>(`/deals/${dealId}/stage`, {
    method: "POST",
    body: input,
  });
  return { deal: res.deal };
}

/** A reason a deal was lost. `id` is what a Lost move sends as `lostReasonId`. */
export type LostReason = { id: string; label: string; displayOrder: number };

export async function listLostReasons(fetcher: Fetcher): Promise<LostReason[]> {
  // A DIFFERENT router mount: /api/pipeline, not /api/deals.
  const res = await fetcher<{ reasons: LostReason[] }>("/pipeline/lost-reasons");
  return res.reasons ?? [];
}

/**
 * May THIS user move THIS deal?
 *
 * The commit route calls assertDealOwnerRouteAccess with neither allowAdmin nor allowDirector
 * (deals/routes.ts:3522-3524), so `isElevatedOverride` is false for every role and a non-owner gets a
 * flat 403 — an admin included. Sibling routes DO pass those flags, so this is deliberate rather than
 * an oversight.
 *
 * The service layer looks more permissive (it only rejects `rep`s who are not the owner), which is
 * exactly why reading the service alone gives the wrong answer.
 */
export function canMoveStage(
  deal: { assignedRepId?: string | null },
  currentUserId: string | undefined,
): boolean {
  return Boolean(currentUserId && deal.assignedRepId === currentUserId);
}
