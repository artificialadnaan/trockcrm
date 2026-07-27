import type {
  LeadDetail,
  LeadListItem,
  LeadRawRow,
  LeadStage,
  LeadTransitionRefusal,
  LeadTransitionResult,
} from "../types";
import { DECORATED_LEAD_FIELDS } from "../types";

export type { LeadRawRow, LeadTransitionRefusal, LeadTransitionResult } from "../types";
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
        /**
         * THREE FLAT ARRAYS — not the preflight's checklist.
         *
         * These are two different functions returning two different shapes under one field name.
         * The PREFLIGHT gate returns `missingRequirements.effectiveChecklist.fields`, each entry a
         * `{ key, label, satisfied }` object (leads/stage-gate.ts:307-317). The TRANSITION error
         * returns `missingRequirements.{prerequisiteFields, qualificationFields, projectTypeQuestionIds}`,
         * three arrays of bare strings (stage-transition-service.ts:34-38, routes.ts:541-549).
         *
         * Reading the preflight's shape here resolved to undefined on every real refusal, so the
         * itemised list this whole branch exists to surface was silently dropped — the adapter caught
         * the 409 and then discarded exactly the payload that made catching it worthwhile. The web
         * flattens the same three arrays (client/src/hooks/use-leads.ts:657-661).
         */
        const requirements = nested.missingRequirements as
          | {
              prerequisiteFields?: string[];
              qualificationFields?: string[];
              projectTypeQuestionIds?: string[];
            }
          | undefined;
        const requirementKeys = [
          ...(requirements?.prerequisiteFields ?? []),
          ...(requirements?.qualificationFields ?? []),
          ...(requirements?.projectTypeQuestionIds ?? []),
        ];
        return {
          ok: false,
          reason: "missing_requirements",
          code: nested.code,
          targetStageId: input.targetStageId,
          resolution: "detail",
          /**
           * The key IS the label, exactly as the web does it.
           *
           * The server's readable labels come from questionnaireFieldLabel, which lives on the server
           * and is not exported to any client. Mirroring it here would be the fourth hand-copied table
           * in this app and would go stale the first time a question is added; humanising the key
           * instead would mangle `projectTypeQuestionIds`, which are ids rather than field paths.
           * The refusal box already directs the rep to the full record, where the fields are named.
           */
          missing: requirementKeys.map((key) => ({ key, label: key, resolution: "detail" as const })),
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

/**
 * Is this lead an ARCHIVE TOMBSTONE — hidden, but never converted or disqualified?
 *
 * Archiving sets `is_active = false` and deliberately LEAVES `status` at "open" (leads/service.ts:2202-
 * 2210), so these rows are simultaneously "not open" by isLeadOpen and "open" by their own status
 * field. Interpolating that status into a message produced the flatly self-contradictory "This lead is
 * open. Its stage can no longer be changed." The two axes need naming separately or the copy cannot be
 * written correctly.
 */
export function isLeadArchived(lead: { status?: string | null; isActive?: boolean | null }): boolean {
  return lead.isActive === false && (lead.status ?? "open") === "open";
}

/**
 * Fold a WRITE response into the cached DETAIL entry.
 *
 * The transition returns updateLead's raw row, which carries every column and none of the decoration —
 * and one of its columns shares a name with a decorated field while holding a different type. Spreading
 * it wholesale replaced the `{ id, name }` projectType object with the legacy TEXT column, so "Project
 * type" went blank the instant a stage moved, and stayed blank if the follow-up refetch failed. The
 * type system could not catch it: the response was modelled as a decorated LeadDetail.
 *
 * So the decorated fields are dropped from the response before merging — columns from the server,
 * decoration from the cache — rather than the merge being ordered to hope no key collides.
 */
export function mergeLeadDetail(previous: LeadDetail | undefined, updated: LeadRawRow): LeadDetail {
  const columns = { ...(updated as Record<string, unknown>) };
  for (const field of DECORATED_LEAD_FIELDS) delete columns[field];
  return { ...(previous ?? {}), ...columns } as LeadDetail;
}

/**
 * Every CLOSED lead, as TWO requests rather than one inactive filter.
 *
 * `isActive: "false"` looks like the closed set and is not: archive tombstones are inactive with an
 * "open" status, so they come back mixed in with the genuinely converted and disqualified. Filtering
 * them out AFTER the response cannot fix it, because the server orders by updatedAt and applies its
 * 100-row cap FIRST (leads/service.ts:1492-1512) — a busy week of archiving fills the whole page, and
 * the tab renders empty while the records it exists to show sit just past the cut.
 *
 * The route's `status` filter is a single equality (service.ts:1469), so "converted OR disqualified"
 * is not expressible in one call. Two calls, each capped independently, then merged on the same
 * updatedAt axis the server sorts by. Tombstones are excluded by construction rather than by cleanup.
 *
 * Promise.all, so a half-failure is a FAILURE. If the disqualified request fails and the converted one
 * succeeds, rendering the successful half shows a complete-looking list that is quietly missing a whole
 * category — the rep concludes there are no disqualified leads. The screen already has an honest
 * "couldn't load" state with a retry; a silent half-answer has none.
 *
 * Still capped, and the cap is still a cap: 100 converted plus 100 disqualified merge down to the 100
 * most recent overall, so a very long tail is reachable only by search. That is the same limit the Open
 * tab has and the same one the endpoint imposes — it is not made worse by splitting the request.
 */
export async function listClosedLeads(
  fetcher: Fetcher,
  params: Omit<ListLeadsParams, "status" | "isActive"> = {},
): Promise<LeadListItem[]> {
  const [converted, disqualified] = await Promise.all([
    listLeads(fetcher, { ...params, status: "converted", isActive: "all" }),
    listLeads(fetcher, { ...params, status: "disqualified", isActive: "all" }),
  ]);
  return [...converted, ...disqualified]
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, LEADS_PAGE_LIMIT);
}
