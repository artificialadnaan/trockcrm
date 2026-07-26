import type {
  Activity,
  DealDetail,
  DealListResponse,
  DealScope,
  PipelineStage,
  StageGateResult,
} from "../types";
import type { Fetcher } from "./auth";

export type ListDealsParams = {
  scope?: DealScope;
  stageId?: string;
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
  const { scope, stageId, search, page, limit } = params;
  return fetcher<DealListResponse>("/deals", {
    query: {
      scope,
      stageId,
      search: search?.trim() || undefined,
      page: page && page > 0 ? page : undefined,
      limit,
    },
  });
}

/** The detail read: the deal plus resolved company, primary contact and watch state. */
export async function getDealDetail(fetcher: Fetcher, dealId: string): Promise<DealDetail> {
  return fetcher<DealDetail>(`/deals/${dealId}/detail`);
}

/** Pipeline stage config — for the stage picker and for mapping stageId to a name on list rows. */
export async function listStages(fetcher: Fetcher): Promise<PipelineStage[]> {
  return fetcher<PipelineStage[]>("/deals/stages");
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
  return fetcher<StageGateResult>(`/deals/${dealId}/stage/preflight`, {
    method: "POST",
    body: { stageId: targetStageId },
  });
}

/**
 * Commit a stage change. OWNER-ONLY on the server — there is no admin or director bypass on this route,
 * so a director looking at someone else's deal will get a 403 here even though they can read it.
 */
export async function moveStage(
  fetcher: Fetcher,
  dealId: string,
  input: { stageId: string; lostReasonId?: string; lostNotes?: string },
): Promise<unknown> {
  return fetcher(`/deals/${dealId}/stage`, { method: "POST", body: input });
}

export async function watchDeal(fetcher: Fetcher, dealId: string): Promise<unknown> {
  return fetcher(`/deals/${dealId}/watch`, { method: "POST" });
}

export async function unwatchDeal(fetcher: Fetcher, dealId: string): Promise<unknown> {
  return fetcher(`/deals/${dealId}/watch`, { method: "DELETE" });
}

/** A deal's timeline. Passing dealId scopes it to that deal rather than the caller's own activity feed. */
export async function listActivities(fetcher: Fetcher, dealId: string): Promise<Activity[]> {
  const res = await fetcher<Activity[] | { activities: Activity[] }>("/activities", { query: { dealId } });
  // Tolerate either envelope. The auth routes proved this codebase is not uniform about it, and guessing
  // wrong here renders an empty timeline rather than throwing — the silent kind of wrong.
  return Array.isArray(res) ? res : (res.activities ?? []);
}

/**
 * Log a note against a deal. This is the 15-second interaction the whole app is justified by — a rep
 * standing on a roof recording what just happened before they forget it.
 */
export async function createActivity(
  fetcher: Fetcher,
  input: { dealId: string; activityType: string; subject?: string; notes: string },
): Promise<Activity> {
  return fetcher<Activity>("/activities", { method: "POST", body: input });
}
