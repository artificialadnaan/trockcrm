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

/**
 * NO "watched". `readListScope` (leads/routes.ts:165-167) coerces anything that is not mine/team/all to
 * "mine" — silently, with a 200 — so a Watched pill would have shown the rep their own leads under
 * someone else's label. Deals genuinely supports the scope; leads does not, and copying the deals
 * scope list across was the mistake. Adding it means a server-side subscription predicate first.
 */
export type LeadScope = "mine" | "team" | "all";
export type LeadStatus = "open" | "converted" | "disqualified";

export type ListLeadsParams = {
  scope?: LeadScope;
  search?: string;
  status?: LeadStatus;
  stageIds?: string[];
  limit?: number;
  /**
   * Lifecycle visibility. The route defaults to `true` (leads/routes.ts:205-209), and BOTH conversion
   * and disqualification set `is_active = false` — so the default silently excludes every terminal
   * lead. Without "all", a `status: "converted"` filter returns nothing, and the converted/disqualified
   * badges and the converted-deal link have no row that can reach them.
   */
  isActive?: "all" | "true" | "false";
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
      /**
       * ACTIVE by default; terminal records only when explicitly asked for.
       *
       * The first version defaulted to "all" so the converted/disqualified badges and the
       * converted-deal link were reachable. That fixed one problem and created a worse one: the route
       * caps at 100 rows ordered by updatedAt, and a terminal lead is updated at the moment it is
       * converted — so a busy week of conversions can fill the entire response and push older OPEN
       * leads out of it. This screen has no pagination, so those leads become unreachable, and the
       * unreachable ones would be the actionable ones.
       *
       * Terminal leads stay reachable through the explicit Closed filter instead, which is a smaller
       * loss than an actionable lead the rep cannot get to at all.
       */
      isActive: params.isActive ?? "true",
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

/**
 * The preflight verdict — a GATE result, and NOT the transition result.
 *
 * These are different shapes from different functions: preflight returns `allowed` / `currentStage` /
 * `targetStage` / `missingRequirements`, while the transition returns `{ ok }` plus a lead or a
 * refusal. Typing preflight as the transition result made `ok` read as `undefined` for every caller —
 * an always-falsy check that looks like a refusal and is actually a type error.
 */
export type LeadStageGateResult = {
  allowed: boolean;
  currentStage?: { id: string; name: string; slug: string } | null;
  targetStage?: { id: string; name: string; slug: string } | null;
  blockReason?: string | null;
  missingRequirements?: {
    effectiveChecklist?: { fields?: Array<{ key: string; label: string; satisfied: boolean }> };
    fields?: string[];
  };
};

/** POST /leads/:id/stage/preflight — what a transition would require, without performing it. */
export async function preflightLeadStage(
  fetcher: Fetcher,
  leadId: string,
  targetStageId: string,
): Promise<LeadStageGateResult> {
  return fetcher<LeadStageGateResult>(`/leads/${leadId}/stage/preflight`, {
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
      /**
       * THE SERVER'S OWN REFUSAL, in either of the two shapes it sends.
       *
       *   1. the transition RESULT itself — `{ ok:false, …, missing }` — when preflight refuses; and
       *   2. a nested error envelope `{ error: { code: LEAD_STAGE_REQUIREMENTS_UNMET,
       *      missingRequirements, currentStage, targetStage } }`, which is what comes back when the
       *      initial preflight passed and updateLead then rejected the move.
       *
       * The second is reachable and was being re-thrown, so the detail screen showed a bare message and
       * discarded the itemised remediation — the same "refusal view that can never receive data" this
       * adapter was rewritten to fix, just via the other branch. The web normalises both
       * (client/src/hooks/use-leads.ts:642-673).
       */
      const body = err.body as
        | (LeadTransitionRefusal & { error?: { code?: string; missingRequirements?: unknown } })
        | undefined;

      if (body && body.ok === false) return body;

      const nested = body?.error;
      if (nested?.code === "LEAD_STAGE_REQUIREMENTS_UNMET") {
        const missing = (nested.missingRequirements as
          | { effectiveChecklist?: { fields?: Array<{ key: string; label: string; satisfied?: boolean }> } }
          | undefined)?.effectiveChecklist?.fields;
        return {
          ok: false,
          reason: "missing_requirements",
          code: nested.code,
          targetStageId: input.targetStageId,
          resolution: "detail",
          missing: (missing ?? [])
            .filter((field) => field.satisfied === false)
            .map((field) => ({ key: field.key, label: field.label, resolution: "detail" as const })),
        };
      }

      /**
       * EVERYTHING ELSE RE-THROWS, coded or not.
       *
       * updateLead rejects a stale submission with UNCODED 409s — "Converted leads only allow
       * questionnaire answer updates", "Hidden lead records are read-only". The previous fallback
       * fabricated a missing-requirements result for those, which routed them through onSuccess,
       * skipped the refresh onError performs, and told the rep to complete fields that do not exist
       * while leaving the stale control live. A 409 is only normalised when its payload positively
       * identifies a requirements refusal.
       */
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
  /**
   * `name`, NOT `dealName`. The conversion service reads `input.name` to override the successor deal's
   * name (conversion-service.ts:316) and never looks at `dealName`. The route forwards unknown body
   * properties untranslated, so the wrong key produced a SUCCESSFUL conversion whose deal silently kept
   * the lead's name — the failure mode with no error to notice.
   */
  input: { name?: string } = {},
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
 * The ONE stage a lead may move into next.
 *
 * `assertCanonicalLeadProgression` (leads/service.ts:524-529) rejects any forward move of more than one
 * canonical stage with a 409 LEAD_STAGE_PROGRESSION_GAP, so a picker of "every stage except the current
 * one" offers mostly actions that cannot succeed — from New Lead, Sales Validation is a guaranteed
 * failure sitting next to the one legal target. The web solves it the same way, with
 * isImmediateNextStageMove (client/src/pages/leads/lead-list-page.tsx:71-73).
 *
 * Backward moves are omitted too. That rule does not reject them, but the canonical lead flow is
 * forward-only and the web offers no backward control; adding one on mobile would be inventing a
 * workflow rather than mirroring it.
 *
 * Ordered by displayOrder over ACTIVE stages only — a retired stage sitting mid-pipeline would
 * otherwise become the "next" one and every move would fail against the write guard.
 */
export function nextLeadStage<T extends { id: string; displayOrder: number; isActivePipeline?: boolean }>(
  stages: readonly T[],
  currentStageId: string | null | undefined,
): T | null {
  if (!currentStageId) return null;
  const ordered = [...stages]
    .filter((stage) => stage.isActivePipeline !== false)
    .sort((a, b) => a.displayOrder - b.displayOrder);
  const index = ordered.findIndex((stage) => stage.id === currentStageId);
  if (index < 0) return null;
  return ordered[index + 1] ?? null;
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
