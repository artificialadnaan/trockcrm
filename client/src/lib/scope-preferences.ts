import type { PipelineScope } from "@/lib/pipeline-scope";

const STORAGE_PREFIX = "pipeline-scope-preference";

function isScope(value: string | null | undefined): value is PipelineScope {
  return value === "mine" || value === "team" || value === "all" || value === "watched";
}

function storageKey(userId: string) {
  return `${STORAGE_PREFIX}:${userId}`;
}

export function readStoredScopePreference(userId: string | null | undefined): PipelineScope | null {
  if (!userId || typeof window === "undefined") return null;
  const value = window.localStorage.getItem(storageKey(userId));
  return isScope(value) ? value : null;
}

export function writeStoredScopePreference(userId: string | null | undefined, scope: PipelineScope) {
  if (!userId || typeof window === "undefined") return;
  window.localStorage.setItem(storageKey(userId), scope);
}

export function resolvePreferredScope(input: {
  requestedScope: string | null;
  userId?: string | null;
  fallback?: PipelineScope;
}): PipelineScope {
  if (isScope(input.requestedScope)) {
    return input.requestedScope;
  }

  const stored = readStoredScopePreference(input.userId);
  if (stored) {
    return stored;
  }

  return input.fallback ?? "mine";
}
