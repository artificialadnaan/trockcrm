import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "@/lib/api";

export interface SearchResult {
  entityType: "deal" | "contact" | "file";
  id: string;
  primaryLabel: string;
  secondaryLabel: string;
  tertiaryLabel?: string;
  deepLink: string;
  rank: number;
}

export interface SearchResponse {
  deals: SearchResult[];
  contacts: SearchResult[];
  files: SearchResult[];
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
  actionType: "open_best_match" | "review_deal_emails" | "open_contact" | "open_file_context" | "open_deal_context";
  label: string;
  rationale: string;
  deepLink: string;
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

  const search = useCallback(async (q: string) => {
    if (q.trim().length < 2) {
      setResults(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api<SearchResponse>(
        `/search?q=${encodeURIComponent(q.trim())}`
      );
      setResults(data);
    } catch {
      setError("Search failed");
      setResults(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      search(query);
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

  const search = useCallback(async (q: string) => {
    if (q.trim().length < 2) {
      setResults(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api<AiSearchResponse>(`/search/ai?q=${encodeURIComponent(q.trim())}`);
      setResults(data);
    } catch {
      setError("AI search failed");
      setResults(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      search(query);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, search]);

  return { query, setQuery, results, loading, error };
}

export async function trackAiSearchInteraction(input: {
  queryId: string;
  interactionType: "recommended_action_click" | "top_entity_click" | "evidence_click";
  targetValue: string;
  deepLink: string;
}) {
  return api<{ interaction: { id: string } }>("/search/ai/interaction", {
    method: "POST",
    json: input,
  });
}
