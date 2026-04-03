import { useEffect } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { Search, Building2, User, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useSearch, useRecentSearches, type SearchResult } from "@/hooks/use-search";
import { Input } from "@/components/ui/input";

const ENTITY_ICONS = { deal: Building2, contact: User, file: FileText } as const;
const ENTITY_COLORS = {
  deal: "bg-blue-100 text-blue-800",
  contact: "bg-green-100 text-green-800",
  file: "bg-red-100 text-red-800",
} as const;

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
  const initialQ = searchParams.get("q") ?? "";
  const { query, setQuery, results, loading } = useSearch();
  const { addRecent } = useRecentSearches();

  useEffect(() => {
    if (initialQ) {
      setQuery(initialQ);
      addRecent(initialQ);
    }
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQ]);

  const handleQueryChange = (q: string) => {
    setQuery(q);
    setSearchParams(q.trim().length >= 2 ? { q: q.trim() } : {}, { replace: true });
  };

  const sections: Array<{ key: "deals" | "contacts" | "files"; label: string }> = [
    { key: "deals", label: "Deals" },
    { key: "contacts", label: "Contacts" },
    { key: "files", label: "Files" },
  ];

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
