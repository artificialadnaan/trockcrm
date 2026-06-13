import { useSearchParams } from "react-router-dom";
import { normalizeStagePageSort } from "@trock-crm/shared/types";
import { useAuth } from "@/lib/auth";
import { normalizeStagePageQuery } from "./pipeline-stage-page";

export type PipelineScope = "mine" | "team" | "all" | "watched";
export type PipelineEntity = "leads" | "deals";
export type PipelineRole = "rep" | "director" | "admin";

const ROLE_DEFAULT_SCOPE: Record<PipelineRole, PipelineScope> = {
  rep: "mine",
  director: "mine",
  admin: "mine",
};

// Team scope is parked (PR #512) and not configured anywhere, so it is not an allowed scope
// -- a stage-route bookmark like /deals/stages/X?scope=team coerces to the role default
// (mine) and redirects, matching the list/board pages that dropped the Team pill (D-12b).
// PipelineScope keeps "team" in the union for coercion inputs; do not change the type.
const ROLE_ALLOWED_SCOPES: Record<PipelineRole, readonly PipelineScope[]> = {
  rep: ["mine", "all"],
  director: ["mine", "all"],
  admin: ["mine", "all"],
};

export function coerceScope(value: string | null): PipelineScope | null {
  if (value === "mine" || value === "team" || value === "all" || value === "watched") return value;
  return null;
}

function normalizeLeadStageRouteSort(value?: string) {
  return value === "name_asc" || value === "age_desc" ? value : "age_desc";
}

export function normalizePipelineScope(input: {
  role: PipelineRole;
  requestedScope: PipelineScope | null;
  entity: PipelineEntity;
}) {
  const role = input.role in ROLE_DEFAULT_SCOPE ? input.role : "rep";
  // "watched" is a DEALS-ONLY scope (the deal_subscriptions watch relation has no leads-list filter
  // wired in v1), so it is allowed only for the deals entity; on leads it coerces to the role default.
  const isAllowed = (scope: PipelineScope) =>
    ROLE_ALLOWED_SCOPES[role].includes(scope) || (scope === "watched" && input.entity === "deals");
  const allowedScope = input.requestedScope && isAllowed(input.requestedScope)
    ? input.requestedScope
    : ROLE_DEFAULT_SCOPE[role];

  return {
    allowedScope,
    redirectTo: `/${input.entity}?scope=${allowedScope}`,
  };
}

export function useNormalizedPipelineRoute(entity: PipelineEntity) {
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const normalized = normalizePipelineScope({
    role: (user?.role ?? "director") as PipelineRole,
    requestedScope: coerceScope(searchParams.get("scope")),
    entity,
  });

  return {
    ...normalized,
    needsRedirect: searchParams.get("scope") !== normalized.allowedScope,
  };
}

export function useNormalizedStageRoute(entity: PipelineEntity, stageId: string) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const role = (user?.role ?? "director") as PipelineRole;
  const normalized = normalizePipelineScope({
    role,
    requestedScope: coerceScope(searchParams.get("scope")),
    entity,
  });
  const allowedScope = normalized.allowedScope;
  const requestedRawScope = searchParams.get("scope");
  const needsRedirect = requestedRawScope !== allowedScope;
  // A parked ?scope=team stage bookmark is coerced to mine; also drop any stale owner filter
  // so the coerced Mine view (and its redirect/back links) is not intersected with another
  // rep's deals into an empty result -- parity with the list pages (D-12b).
  const cleanedParams = new URLSearchParams(searchParams);
  if (requestedRawScope === "team" && allowedScope !== "team") {
    cleanedParams.delete("assignedRepId");
  }
  const nextParams = new URLSearchParams(cleanedParams);
  nextParams.set("scope", allowedScope);
  const backParams = new URLSearchParams(cleanedParams);
  backParams.set("scope", allowedScope);
  backParams.delete("page");
  const baseQuery = normalizeStagePageQuery(Object.fromEntries(cleanedParams.entries()));
  const sort = entity === "deals"
    ? normalizeStagePageSort(baseQuery.sort)
    : normalizeLeadStageRouteSort(baseQuery.sort);

  return {
    stageId,
    needsRedirect,
    redirectTo: `/${entity}/stages/${stageId}?${nextParams.toString()}`,
    backTo: `/${entity}?${backParams.toString()}`,
    query: {
      ...baseQuery,
      sort,
      scope: allowedScope,
    },
    onPageChange: (page: number) => {
      const params = new URLSearchParams(searchParams);
      params.set("scope", allowedScope);
      params.set("page", String(page));
      // Paging is intra-cohort state, not a drill-down step: REPLACE in place so it never adds a history
      // entry. Otherwise the history-aware header "Back" (navigate(-1)) would step back to the previous
      // PAGE of this same cohort instead of up to the rep/dashboard the user drilled in from.
      setSearchParams(params, { replace: true });
    },
  };
}
