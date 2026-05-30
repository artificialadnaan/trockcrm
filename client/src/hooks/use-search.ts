import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "@/lib/api";

export type SearchEntityType = "deal" | "contact" | "file" | "company" | "lead" | "property";
export type DealLifecycle = "active" | "on_hold" | "won" | "lost";

export interface SearchResult {
  entityType: SearchEntityType;
  id: string;
  primaryLabel: string;
  secondaryLabel: string;
  tertiaryLabel?: string;
  status?: DealLifecycle | null;
  deepLink: string;
  rank: number;
}

export interface SearchResponse {
  deals: SearchResult[];
  contacts: SearchResult[];
  files: SearchResult[];
  companies: SearchResult[];
  leads: SearchResult[];
  properties: SearchResult[];
  total: number;
  query: string;
}

export interface AiSearchEvidence {
  id: string;
  sourceType: string;
  sourceId: string;
  dealId: string | null;
  entityType: "deal" | "contact" | "file" | "crm_text";
  entityLabel: string | null;
  title: string;
  snippet: string;
  deepLink: string;
  interactionScore?: number;
}

export interface AiSearchEntityAnchor {
  entityType: "deal" | "contact" | "file";
  id: string;
  label: string;
  deepLink: string;
  interactionScore?: number;
}

export interface AiSearchRecommendedAction {
  actionType:
    | "open_best_match"
    | "review_deal_emails"
    | "open_contact"
    | "open_file_context"
    | "open_deal_context"
    | "open_deal_copilot"
    | "refresh_deal_copilot";
  label: string;
  rationale: string;
  deepLink: string;
  executionMode: "navigate" | "api_then_navigate";
  apiEndpoint?: string;
  apiMethod?: "POST";
  successMessage?: string;
  interactionScore?: number;
}

export interface AiSearchResponse {
  queryId: string;
  query: string;
  intent: "deal_lookup" | "contact_lookup" | "file_lookup" | "account_research" | "activity_lookup" | "general_search";
  summary: string;
  structured: SearchResponse;
  topEntities: AiSearchEntityAnchor[];
  recommendedActions: AiSearchRecommendedAction[];
  evidence: AiSearchEvidence[];
}

const RECENT_SEARCHES_KEY = "trock_crm_recent_searches";
const MAX_RECENT = 8;
const DEBOUNCE_MS = 300;

export function useRecentSearches() {
  const [recent, setRecent] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY) ?? "[]");
    } catch {
      return [];
    }
  });

  const addRecent = useCallback((query: string) => {
    if (!query.trim() || query.trim().length < 2) return;
    setRecent((prev) => {
      const next = [query, ...prev.filter((q) => q !== query)].slice(0, MAX_RECENT);
      localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const clearRecent = useCallback(() => {
    localStorage.removeItem(RECENT_SEARCHES_KEY);
    setRecent([]);
  }, []);

  return { recent, addRecent, clearRecent };
}

export function useSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last-write-wins: only the latest request may write results, so a slow earlier-keystroke
  // response can never overwrite a later one (debounce reduces but does not eliminate this).
  const requestIdRef = useRef(0);

  const search = useCallback(async (q: string, requestId: number) => {
    if (q.trim().length < 2) {
      setResults(null);
      if (requestId === requestIdRef.current) setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api<SearchResponse>(
        `/search?q=${encodeURIComponent(q.trim())}`
      );
      if (requestId !== requestIdRef.current) return; // superseded by a newer query
      setResults(data);
    } catch {
      if (requestId !== requestIdRef.current) return;
      setError("Search failed");
      setResults(null);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Advance the generation on EVERY query change (not only when the debounced fetch fires), so
    // a response for a now-stale query is rejected even if it returns inside the debounce window
    // before the next request starts.
    const requestId = ++requestIdRef.current;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      search(query, requestId);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, search]);

  return { query, setQuery, results, loading, error };
}

export function useAiSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AiSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last-write-wins (same as useSearch): generation advances on every query change so a slow
  // earlier-keystroke AI response cannot overwrite a later one.
  const requestIdRef = useRef(0);

  const search = useCallback(async (q: string, requestId: number) => {
    if (q.trim().length < 2) {
      setResults(null);
      if (requestId === requestIdRef.current) setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api<AiSearchResponse>(`/search/ai?q=${encodeURIComponent(q.trim())}`);
      if (requestId !== requestIdRef.current) return;
      setResults(data);
    } catch {
      if (requestId !== requestIdRef.current) return;
      setError("AI search failed");
      setResults(null);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      search(query, requestId);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, search]);

  return { query, setQuery, results, loading, error };
}

export async function trackAiSearchInteraction(input: {
  queryId: string;
  interactionType: "search_impression" | "recommended_action_click" | "recommended_action_executed" | "top_entity_click" | "evidence_click";
  targetValue: string;
  deepLink: string;
  executionMode?: "navigate" | "api_then_navigate";
  apiEndpoint?: string;
  queryContext?: {
    query: string;
    intent: AiSearchResponse["intent"];
    structuredTotal: number;
    topEntityTypes: string[];
    recommendedActionTypes: string[];
    hasEvidence: boolean;
  };
}) {
  return api<{ interaction: { id: string } }>("/search/ai/interaction", {
    method: "POST",
    json: input,
  });
}

export async function executeAiSearchWorkflowAction(action: AiSearchRecommendedAction) {
  if (action.executionMode !== "api_then_navigate" || !action.apiEndpoint) {
    return null;
  }

  return api(action.apiEndpoint, {
    method: action.apiMethod ?? "POST",
  });
}
