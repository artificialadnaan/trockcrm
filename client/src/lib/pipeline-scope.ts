import { useSearchParams } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { normalizeStagePageQuery } from "./pipeline-stage-page";

export type PipelineScope = "mine" | "team" | "all";
export type PipelineEntity = "leads" | "deals";
export type PipelineRole = "rep" | "director" | "admin";

const ROLE_DEFAULT_SCOPE: Record<PipelineRole, PipelineScope> = {
  rep: "mine",
  director: "team",
  admin: "all",
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
  const allowedScope = ROLE_DEFAULT_SCOPE[input.role];

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
  const normalized = useNormalizedPipelineRoute(entity);
  const [searchParams, setSearchParams] = useSearchParams();
  const nextParams = new URLSearchParams(searchParams);
  nextParams.set("scope", normalized.allowedScope);

  return {
    stageId,
    needsRedirect: normalized.needsRedirect,
    redirectTo: `/${entity}/stages/${stageId}?${nextParams.toString()}`,
    backTo: `/${entity}?scope=${normalized.allowedScope}`,
    query: {
      ...normalizeStagePageQuery(Object.fromEntries(searchParams.entries())),
      scope: normalized.allowedScope,
    },
    onPageChange: (page: number) => {
      const params = new URLSearchParams(searchParams);
      params.set("scope", normalized.allowedScope);
      params.set("page", String(page));
      setSearchParams(params);
    },
  };
}
