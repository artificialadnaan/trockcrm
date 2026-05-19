import { useSearchParams } from "react-router-dom";
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

const ROLE_ALLOWED_SCOPES: Record<PipelineRole, readonly PipelineScope[]> = {
  rep: ["mine", "team", "all"],
  director: ["mine", "team", "all"],
  admin: ["mine", "team", "all"],
};

function coerceScope(value: string | null): PipelineScope | null {
  if (value === "mine" || value === "team" || value === "all") return value;
  return null;
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

  return {
    stageId,
    needsRedirect,
    redirectTo: `/${entity}/stages/${stageId}?${nextParams.toString()}`,
    backTo: `/${entity}?scope=${allowedScope}`,
    query: {
      ...normalizeStagePageQuery(Object.fromEntries(searchParams.entries())),
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
