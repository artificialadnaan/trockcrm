import type { LeadDetail, LeadListItem, LeadStage, LeadTransitionRefusal, LeadTransitionResult } from "../types";

export type { LeadTransitionRefusal, LeadTransitionResult } from "../types";
import { ApiError } from "../client";
import type { Fetcher } from "./auth";

/**
 * The leads surface.
 *
 * Its envelopes are the least uniform in the CRM API, so every one is named against its route line
 * rather than inferred from a sibling — this app has already shipped three separate defects from
 * assuming one endpoint's shape matched the next.
 */

export type LeadScope = "mine" | "team" | "all" | "watched";
export type LeadStatus = "open" | "converted" | "disqualified";

export type ListLeadsParams = {
  scope?: LeadScope;
  search?: string;
  status?: LeadStatus;
  stageIds?: string[];
  limit?: number;
};

/**
 * THE ROW CAP, and why this list does not paginate.
 *
 * GET /leads takes no page or offset at all — it has one opt-in `limit`, clamped server-side to
 * [1, LEADS_LIST_MAX_ROWS = 100] (service.ts:1509-1512). Deals and contacts both paginate, so the
 * reflex is to reach for useInfiniteQuery here; that would send a `page` the route never reads and
 * silently re-request the same first rows forever.
 *
 * Omitting the limit is worse than capping it: with no limit the route returns the FULL set, because
 * aggregate callers (dashboard metrics, director totals, company portfolio) depend on that. A phone
 * asking an unbounded question of a table this wide is how a list screen becomes a timeout.
 */
const LEADS_PAGE_LIMIT = 100;

/** GET /leads → `{ leads }`. */
export async function listLeads(fetcher: Fetcher, params: ListLeadsParams = {}): Promise<LeadListItem[]> {
  const res = await fetcher<{ leads: LeadListItem[] }>("/leads", {
    query: {
      scope: params.scope,
      search: params.search?.trim() || undefined,
      status: params.status,
      // Comma-joined — the route does `(req.query.stageIds as string).split(",")` (routes.ts:189).
      stageIds: params.stageIds && params.stageIds.length > 0 ? params.stageIds.join(",") : undefined,
      limit: params.limit ?? LEADS_PAGE_LIMIT,
    },
  });
  return res.leads ?? [];
}

/**
 * GET /leads/:id → `{ lead }`.
 *
 * One envelope, two payloads: `leadQuestionnaire` is attached only when the server's lead-edit-v2 flag
 * is on (routes.ts:289-305). Same key either way, so this reads the envelope and lets the optional
 * field be optional rather than branching on a flag the client cannot see.
 */
export async function getLead(fetcher: Fetcher, leadId: string): Promise<LeadDetail> {
  const res = await fetcher<{ lead: LeadDetail }>(`/leads/${leadId}`);
  return res.lead;
}

/**
 * GET /leads/stages → `{ stages }`.
 *
 * A DIFFERENT endpoint from /deals/stages, not a filtered view of it: the route calls
 * getAllStages("lead") (routes.ts:235), and the deal route asks for the two deal families. Reusing the
 * deal stage list here offers stages a lead can never enter.
 */
export async function listLeadStages(fetcher: Fetcher): Promise<LeadStage[]> {
  const res = await fetcher<{ stages: LeadStage[] }>("/leads/stages");
  return res.stages ?? [];
}

/** POST /leads/:id/stage/preflight — what a transition would require, without performing it. */
export async function preflightLeadStage(
  fetcher: Fetcher,
  leadId: string,
  targetStageId: string,
): Promise<LeadTransitionResult> {
  return fetcher<LeadTransitionResult>(`/leads/${leadId}/stage/preflight`, {
    method: "POST",
    body: { targetStageId },
  });
}

/**
 * POST /leads/:id/stage-transition.
 *
 * TWO things are unusual and both bite:
 *
 *   1. NO ENVELOPE — the service result IS the body (`res.status(...).json(result)`, routes.ts:539).
 *   2. A REFUSAL IS A 409 carrying that same body. apiFetch throws on any non-2xx, so the refusal —
 *      which is the useful case, the one holding the list of what is missing — would surface as a
 *      generic ApiError and the caller would never see `missing` at all.
 *
 * So the 409 is caught and returned as a VALUE. It is not an error: the server is answering the
 * question, and "here is what this lead still needs" is the answer worth rendering. Every other status
 * still throws.
 */
export async function transitionLeadStage(
  fetcher: Fetcher,
  leadId: string,
  input: { targetStageId: string; reason?: string },
): Promise<LeadTransitionResult> {
  try {
    return await fetcher<LeadTransitionResult>(`/leads/${leadId}/stage-transition`, {
      method: "POST",
      body: input,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      // The body is not surfaced through ApiError, so reconstruct the refusal from what it does carry.
      // Callers branch on `ok`, and a refusal with no detail is still a refusal — never a success.
      return {
        ok: false,
        reason: "missing_requirements",
        code: err.code ?? null,
        targetStageId: input.targetStageId,
        resolution: "detail",
        missing: [],
      };
    }
    throw err;
  }
}

/**
 * POST /leads/:id/convert → 201 with `{ lead, deal }` at the TOP LEVEL — two records, no envelope
 * around either (routes.ts:679).
 */
export async function convertLead(
  fetcher: Fetcher,
  leadId: string,
  input: { dealName?: string } = {},
): Promise<{ lead: LeadDetail; deal: { id: string; dealNumber?: string | null } }> {
  return fetcher<{ lead: LeadDetail; deal: { id: string; dealNumber?: string | null } }>(
    `/leads/${leadId}/convert`,
    { method: "POST", body: input },
  );
}

/** POST/DELETE /leads/:id/watch — the watch toggle behind the "Watched" scope. */
export async function watchLead(fetcher: Fetcher, leadId: string, watching: boolean): Promise<void> {
  await fetcher(`/leads/${leadId}/watch`, { method: watching ? "POST" : "DELETE" });
}

/**
 * Is this lead still open?
 *
 * `status` and `isActive` are separate axes and a converted lead keeps a name, a stage and a rep — so
 * "has a stage" is not "can be worked". Converted and disqualified leads stay readable (they are how a
 * rep finds the deal a lead became) but must not be offered a stage move.
 */
export function isLeadOpen(lead: { status?: string | null; isActive?: boolean | null }): boolean {
  return lead.isActive !== false && (lead.status ?? "open") === "open";
}
