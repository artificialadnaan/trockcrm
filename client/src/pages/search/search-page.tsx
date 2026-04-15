import { useEffect } from "react";
import { useSearchParams, Link, useNavigate } from "react-router-dom";
import { Search, Building2, User, FileText, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import {
  executeAiSearchWorkflowAction,
  trackAiSearchInteraction,
  useAiSearch,
  useSearch,
  useRecentSearches,
  type AiSearchRecommendedAction,
  type SearchResult,
} from "@/hooks/use-search";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const ENTITY_ICONS = { deal: Building2, contact: User, file: FileText } as const;
const ENTITY_COLORS = {
  deal: "bg-blue-100 text-blue-800",
  contact: "bg-green-100 text-green-800",
  file: "bg-red-100 text-red-800",
} as const;

function PopularityBadge({ score }: { score?: number }) {
  if (!score || score < 1) return null;
  return (
    <Badge variant="outline" className="text-[10px] uppercase tracking-[0.16em]">
      Frequently used
    </Badge>
  );
}

function ResultCard({ result }: { result: SearchResult }) {
  const Icon = ENTITY_ICONS[result.entityType];
  return (
    <Link
      to={result.deepLink}
      className="flex items-center gap-3 p-4 rounded-lg border bg-white hover:shadow-md transition-shadow"
    >
      <Icon className="h-5 w-5 text-gray-400 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-gray-900 truncate">{result.primaryLabel}</div>
        {result.secondaryLabel && (
          <div className="text-sm text-gray-500 truncate">
            {result.secondaryLabel}
            {result.tertiaryLabel && ` \u00B7 ${result.tertiaryLabel}`}
          </div>
        )}
      </div>
      <Badge className={`text-xs ${ENTITY_COLORS[result.entityType]}`}>
        {result.entityType}
      </Badge>
    </Link>
  );
}

export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const initialQ = searchParams.get("q") ?? "";
  const { query, setQuery, results, loading } = useSearch();
  const { setQuery: setAiQuery, results: aiResults, loading: aiLoading } = useAiSearch();
  const { addRecent } = useRecentSearches();

  useEffect(() => {
    if (initialQ) {
      setQuery(initialQ);
      setAiQuery(initialQ);
      addRecent(initialQ);
    }
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQ]);

  const handleQueryChange = (q: string) => {
    setQuery(q);
    setAiQuery(q);
    setSearchParams(q.trim().length >= 2 ? { q: q.trim() } : {}, { replace: true });
  };

  const sections: Array<{ key: "deals" | "contacts" | "files"; label: string }> = [
    { key: "deals", label: "Deals" },
    { key: "contacts", label: "Contacts" },
    { key: "files", label: "Files" },
  ];
  const intentLabel = aiResults?.intent ? aiResults.intent.replace(/_/g, " ") : null;

  const trackInteraction = (interactionType: "recommended_action_click" | "top_entity_click" | "evidence_click", targetValue: string, deepLink: string) => {
    if (!aiResults?.queryId) return;
    void trackAiSearchInteraction({
      queryId: aiResults.queryId,
      interactionType,
      targetValue,
      deepLink,
    }).catch(() => {});
  };

  const handleRecommendedAction = async (action: AiSearchRecommendedAction) => {
    trackInteraction("recommended_action_click", action.actionType, action.deepLink);

    if (action.executionMode === "navigate") {
      navigate(action.deepLink);
      return;
    }

    try {
      await executeAiSearchWorkflowAction(action);
      if (action.successMessage) {
        toast.success(action.successMessage);
      }
      navigate(action.deepLink);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to run AI workflow action");
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Search className="h-6 w-6 text-gray-400" />
        <Input
          autoFocus
          placeholder="Search deals, contacts, files..."
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          className="text-base"
        />
      </div>

      {loading && (
        <div className="text-center text-gray-400 py-12">Searching...</div>
      )}

      {aiResults?.summary && query.length >= 2 && (
        <Card className="border-border/80">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              AI Search Summary
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {intentLabel && intentLabel !== "general search" && (
              <Badge variant="outline">{intentLabel}</Badge>
            )}
            <p className="text-sm leading-6">{aiResults.summary}</p>
            {aiLoading && <p className="text-sm text-muted-foreground">Refreshing AI evidence...</p>}
            {(aiResults.recommendedActions ?? []).length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Recommended Next Steps
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {aiResults.recommendedActions.map((action) => (
                    <button
                      key={`${action.actionType}:${action.deepLink}`}
                      type="button"
                      className="rounded-lg border bg-white px-3 py-3 hover:bg-gray-50 text-left"
                      onClick={() => void handleRecommendedAction(action)}
                    >
                      <div className="space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-sm font-medium text-foreground">{action.label}</div>
                          <PopularityBadge score={action.interactionScore} />
                        </div>
                        <div className="text-xs text-muted-foreground leading-5">{action.rationale}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {(aiResults.topEntities ?? []).length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Top Entity Matches
                </p>
                <div className="flex flex-wrap gap-2">
                  {aiResults.topEntities.map((entity) => (
                    <Link
                      key={`${entity.entityType}:${entity.id}`}
                      to={entity.deepLink}
                      onClick={() => trackInteraction("top_entity_click", `${entity.entityType}:${entity.id}`, entity.deepLink)}
                    >
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="hover:bg-secondary/80">
                          {entity.entityType}: {entity.label}
                        </Badge>
                        <PopularityBadge score={entity.interactionScore} />
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}
            {(aiResults.evidence ?? []).length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Supporting Evidence
                </p>
                <div className="space-y-2">
                  {aiResults.evidence.map((item) => (
                    <Link
                      key={item.id}
                      to={item.deepLink}
                      className="block rounded-lg border bg-white px-3 py-3 hover:bg-gray-50"
                      onClick={() => trackInteraction("evidence_click", `${item.sourceType}:${item.sourceId}`, item.deepLink)}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="flex items-center gap-2">
                            <div className="text-sm font-medium text-foreground">{item.title}</div>
                            <PopularityBadge score={item.interactionScore} />
                          </div>
                          <div className="text-sm text-muted-foreground line-clamp-2">{item.snippet}</div>
                          {item.entityLabel && (
                            <div className="text-xs text-muted-foreground">
                              Linked {item.entityType}: {item.entityLabel}
                            </div>
                          )}
                        </div>
                        <Badge variant="outline">{item.sourceType}</Badge>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {!loading && results && results.total === 0 && query.length >= 2 && (
        <div className="text-center text-gray-400 py-12">
          No results found for &ldquo;{query}&rdquo;
        </div>
      )}

      {!loading && results && results.total > 0 && (
        <div className="space-y-6">
          {sections.map(({ key, label }) => {
            const items = results[key] as SearchResult[];
            if (items.length === 0) return null;
            return (
              <div key={key}>
                <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-2">
                  {label} ({items.length})
                </h2>
                <div className="space-y-2">
                  {items.map((r) => (
                    <ResultCard key={r.id} result={r} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
