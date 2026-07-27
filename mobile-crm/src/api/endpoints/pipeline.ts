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

/**
 * ALL-TIME Won and Lost, sent by EVERY pipeline read.
 *
 * Without them the server windows both terminal columns to the last 30 days
 * (resolvePipelineTerminalDateFilters — `since` defaults to now-30d unless the flag is set) and says
 * nothing about it in the response.
 *
 * Shared rather than spelled out per call, because the first version set them on the board only. The
 * drill-down then applied the 30-day default, so the board could say "Showing 15 of 40 — see all" and
 * open a list holding a fraction of that, contradicting the very count the rep had just tapped — the
 * exact silent-truncation the footer exists to expose, reintroduced one screen further in. Both routes
 * read these through the same readBoardInput, so both must send them.
 *
 * snake_case on purpose: the route tests `req.query.won_all_time === "true"` and ignores camelCase.
 */
const TERMINAL_ALL_TIME = { won_all_time: "true", lost_all_time: "true" } as const;

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
      ...TERMINAL_ALL_TIME,
    },
  });
  return {
    pipelineColumns: res.pipelineColumns ?? [],
    terminalStages: res.terminalStages ?? [],
  };
}

export type StagePagePagination = { page: number; pageSize: number; total: number; totalPages: number };

/**
 * One stage's full, paginated card list — the drill-down the board preview links to.
 *
 * THREE separate names had to be right here and two were guesses, so they are spelled out against the
 * source rather than inferred from the sibling endpoints:
 *
 *   • rows, NOT deals      — listDealStagePage returns `{ stage, scope, summary, pagination, rows }`
 *                            (service.ts:3797-3817). `deals` read as an always-empty array, so the
 *                            drill-down rendered "Nothing here" beside a non-zero header total.
 *   • pageSize, NOT limit  — both the query param (routes.ts readStageInput:627) and the pagination
 *                            field. Sending `limit` was silently ignored and every page came back at
 *                            the server default of 25.
 *   • summary.totalCount   — the full count including held cards; `summary.count` is active-only.
 *
 * "The service result IS the body" was right about the envelope and no protection at all against the
 * field names inside it — which is the failure this app keeps repeating.
 *
 * The rows carry the server verdicts (they end in attachAtRiskResult, service.ts:1592) so cards render
 * from the same authority as the board. They do NOT carry companyName: the workspace SELECT does not
 * join companies. BoardCard renders that line conditionally, so it is simply absent here rather than
 * broken — worth knowing before someone reads its absence as a bug.
 */
export async function getStagePage(
  fetcher: Fetcher,
  stageId: string,
  params: { scope: PipelineScope; page?: number; pageSize?: number },
): Promise<{ deals: DealListItem[]; pagination?: StagePagePagination; totalCount?: number }> {
  // NO envelope on this one — the service result IS the body (routes.ts:1046-1050).
  const res = await fetcher<{
    rows?: DealListItem[];
    pagination?: StagePagePagination;
    summary?: { count?: number; activeCount?: number; totalCount?: number };
  }>(`/deals/stages/${stageId}`, {
    query: {
      scope: params.scope,
      page: params.page && params.page > 0 ? params.page : undefined,
      pageSize: params.pageSize,
      // readStageInput spreads readBoardInput, so this route honours the same flags — and must be given
      // them, or the drill-down contradicts the board that linked to it.
      ...TERMINAL_ALL_TIME,
    },
  });
  return {
    deals: res.rows ?? [],
    pagination: res.pagination,
    totalCount: res.summary?.totalCount,
  };
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
  /**
   * A close target set in the SAME request as the move (YYYY-MM-DD).
   *
   * The gate considers it a pending value and revalidates against it (routes.ts:3525-3543), so an advance
   * blocked only by a missing expectedCloseDate completes in one action instead of requiring a separate
   * edit — which this app has no screen for.
   */
  expectedCloseDate?: string;
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
/**
 * Slugs the STAGE-CHANGE ROUTE treats as a Lost outcome — the only ones for which it requires a reason
 * id and non-blank notes, and the only ones for which it stores them.
 *
 * Mirrors `isLostOutcomeStage` (server/src/modules/deals/stage-change.ts:74-80) resolved through
 * `toCanonicalTerminalOutcomeSlug` (:44-70). Deliberately NARROWER than LOST_DEAL_STAGE_SLUGS in
 * shared/src/types/workflow.ts, which is the REPORTING classification set and includes the legacy
 * `deal_canceled` so historical HubSpot rows still tally as losses. Only one of those two is a request
 * contract; this is it.
 *
 * EXPORTED so the move screen and its tests read the same set. They previously each carried their own
 * copy, which made the tests tautological — they asserted a local literal against itself and would have
 * stayed green through any drift in the one that ships.
 *
 * Getting this mirror right took three attempts, each failing differently, which is why it now lives in
 * exactly one place:
 *   1. All four legacy aliases, omitting the canonical "lost" — so the screen stayed silent on the slug
 *      current pipelines actually use, and the server rejected the move naming fields the rep never saw.
 *   2. Anchored to the reporting set above, so it prompted on `deal_canceled` and collected a reason and
 *      notes the stage-change route then discarded.
 *   3. Correct, but duplicated between the screen and its tests — see the export note.
 *
 * `deal_canceled` is absent ON PURPOSE. It is seeded by no migration and belongs to no live pipeline; it
 * exists so historical rows read correctly. The web dialog does prompt on it and loses the details just
 * the same — a pre-existing server-side gap, and closing it would make the route start rejecting moves
 * that succeed today, so it is not something to fix from a mobile client.
 */
export const LOST_OUTCOME_STAGE_SLUGS: ReadonlySet<string> = new Set([
  "lost",
  "production_lost",
  "service_lost",
  "closed_lost",
]);

export function isLostOutcomeStageSlug(slug: string | null | undefined): boolean {
  return typeof slug === "string" && LOST_OUTCOME_STAGE_SLUGS.has(slug);
}

/**
 * Reasons the STAGE-CHANGE route refuses outright, regardless of who is asking.
 *
 * These are checked before ownership because they are properties of the DEAL, not the user: no rep,
 * admin or director can move a change order, and preflight does not apply the lock — so a green
 * "Ready to move" followed by a 409 is the alternative to checking here.
 */
export function stageMoveLock(deal: {
  isChangeOrder?: boolean | null;
}): { locked: true; title: string; body: string } | { locked: false } {
  if (deal.isChangeOrder === true) {
    return {
      locked: true,
      title: "A change order can't change stage",
      body:
        "Change orders are Won child deals — moving one off Won would drop its value out of every Won " +
        "report. Edit it through its parent deal instead.",
    };
  }
  return { locked: false };
}

export function canMoveStage(
  deal: { assignedRepId?: string | null },
  currentUserId: string | undefined,
): boolean {
  return Boolean(currentUserId && deal.assignedRepId === currentUserId);
}
