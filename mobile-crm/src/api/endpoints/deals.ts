import type {
  Activity,
  ActivityListResponse,
  DealDetail,
  DealListResponse,
  DealScope,
  PipelineStage,
  StageGateResult,
} from "../types";
import type { Fetcher } from "./auth";

export type ListDealsParams = {
  scope?: DealScope;
  /**
   * Plural, and an array, because that is the server's contract: GET /api/deals reads a COMMA-SEPARATED
   * `stageIds` (deals/routes.ts:895) and does not look at `stageId` at all. Sending the singular name
   * filtered nothing and quietly returned every stage — a filter that appears applied and is not.
   */
  stageIds?: string[];
  search?: string;
  page?: number;
  limit?: number;
};

/**
 * The deals list.
 *
 * Uses the LIST endpoint, never /:id/detail per row — tenant.deals carries ~153 columns and the detail
 * read additionally resolves company/contact joins, so a list built from it would be brutal on a phone.
 *
 * `page` is guarded to >= 1: apiFetch's query builder drops undefined/null/"" but KEEPS 0, and page=0 is
 * not a valid page on the server.
 */
export async function listDeals(fetcher: Fetcher, params: ListDealsParams = {}): Promise<DealListResponse> {
  const { scope, stageIds, search, page, limit } = params;
  return fetcher<DealListResponse>("/deals", {
    query: {
      scope,
      // Comma-joined, per the route's `(req.query.stageIds as string).split(",")`.
      stageIds: stageIds && stageIds.length > 0 ? stageIds.join(",") : undefined,
      search: search?.trim() || undefined,
      page: page && page > 0 ? page : undefined,
      limit,
    },
  });
}

/** GET /deals/:id/detail → { deal }. Returning the envelope leaves every field undefined. */
export async function getDealDetail(fetcher: Fetcher, dealId: string): Promise<DealDetail> {
  const res = await fetcher<{ deal: DealDetail }>(`/deals/${dealId}/detail`);
  return res.deal;
}

/** GET /deals/stages → { stages }. Iterating the envelope as an array THROWS and crashes the list. */
export async function listStages(fetcher: Fetcher): Promise<PipelineStage[]> {
  const res = await fetcher<{ stages: PipelineStage[] }>("/deals/stages");
  return res.stages ?? [];
}

/**
 * Ask whether a stage move is allowed WITHOUT committing it.
 *
 * This is the reason the app can tell a rep what is missing instead of handing them an opaque 400 after
 * the fact. Always call this and show the result before offering to commit.
 */
export async function preflightStage(
  fetcher: Fetcher,
  dealId: string,
  targetStageId: string,
): Promise<StageGateResult> {
  // The server requires `targetStageId` and 400s without it — `stageId` is silently not the contract.
  return fetcher<StageGateResult>(`/deals/${dealId}/stage/preflight`, {
    method: "POST",
    body: { targetStageId },
  });
}

/**
 * Commit a stage change. OWNER-ONLY on the server — there is no admin or director bypass on this route,
 * so a director looking at someone else's deal will get a 403 here even though they can read it.
 */
export async function moveStage(
  fetcher: Fetcher,
  dealId: string,
  input: { targetStageId: string; overrideReason?: string; lostReasonId?: string; lostNotes?: string },
): Promise<unknown> {
  return fetcher(`/deals/${dealId}/stage`, { method: "POST", body: input });
}

export async function watchDeal(fetcher: Fetcher, dealId: string): Promise<unknown> {
  return fetcher(`/deals/${dealId}/watch`, { method: "POST" });
}

export async function unwatchDeal(fetcher: Fetcher, dealId: string): Promise<unknown> {
  return fetcher(`/deals/${dealId}/watch`, { method: "DELETE" });
}

/**
 * GET /activities → { activities, pagination }. Scoped to one deal by the dealId param.
 *
 * Returns the WHOLE response, pagination included. The server defaults to 50 rows per page
 * (activities/service.ts:129), so discarding the envelope made every activity beyond the 50th
 * permanently unreachable while the timeline looked complete — a deal's history silently truncated at a
 * boundary nothing on screen mentions.
 */
export async function listActivities(
  fetcher: Fetcher,
  dealId: string,
  params: { page?: number; limit?: number } = {},
): Promise<ActivityListResponse> {
  const res = await fetcher<ActivityListResponse>("/activities", {
    query: {
      dealId,
      page: params.page && params.page > 0 ? params.page : undefined,
      limit: params.limit,
    },
  });
  return { activities: res.activities ?? [], pagination: res.pagination };
}

/**
 * Log a note against a deal. This is the 15-second interaction the whole app is justified by — a rep
 * standing on a roof recording what just happened before they forget it.
 */
export async function createActivity(
  fetcher: Fetcher,
  input: { dealId: string; type: string; subject?: string; body: string },
): Promise<Activity> {
  // The server reads `type` and `body` and 400s when `type` is absent. Sending activityType/notes made
  // every note submission fail — the headline interaction of the whole app, silently broken.
  const res = await fetcher<{ activity: Activity }>("/activities", {
    method: "POST",
    body: { type: input.type, subject: input.subject, body: input.body, dealId: input.dealId },
  });
  return res.activity;
}
