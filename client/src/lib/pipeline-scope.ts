import { useSearchParams } from "react-router-dom";
import { normalizeStagePageSort } from "@trock-crm/shared/types";
import { useAuth } from "@/lib/auth";
import { normalizeStagePageQuery } from "./pipeline-stage-page";

export type PipelineScope = "mine" | "team" | "all";
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

function coerceScope(value: string | null): PipelineScope | null {
  if (value === "mine" || value === "team" || value === "all") return value;
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
  const allowedScope = input.requestedScope && ROLE_ALLOWED_SCOPES[role].includes(input.requestedScope)
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
  const needsRedirect = searchParams.get("scope") !== allowedScope;
  const nextParams = new URLSearchParams(searchParams);
  nextParams.set("scope", allowedScope);
  const backParams = new URLSearchParams(searchParams);
  backParams.set("scope", allowedScope);
  backParams.delete("page");
  const baseQuery = normalizeStagePageQuery(Object.fromEntries(searchParams.entries()));
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
      setSearchParams(params);
    },
  };
}
