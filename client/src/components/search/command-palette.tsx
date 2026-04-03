import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Search, FileText, User, Building2, Clock, X } from "lucide-react";
import { useSearch, useRecentSearches, type SearchResult } from "@/hooks/use-search";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

const ENTITY_ICONS = {
  deal: Building2,
  contact: User,
  file: FileText,
} as const;

const ENTITY_LABELS = {
  deal: "Deal",
  contact: "Contact",
  file: "File",
} as const;

const ENTITY_BADGE_COLORS = {
  deal: "bg-blue-100 text-blue-800",
  contact: "bg-green-100 text-green-800",
  file: "bg-red-100 text-red-800",
} as const;

function ResultItem({
  result,
  onSelect,
}: {
  result: SearchResult;
  onSelect: (link: string) => void;
}) {
  const Icon = ENTITY_ICONS[result.entityType];
  return (
    <button
      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 text-left transition-colors"
      onClick={() => onSelect(result.deepLink)}
    >
      <Icon className="h-4 w-4 text-gray-400 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm text-gray-900 truncate">
          {result.primaryLabel}
        </div>
        {result.secondaryLabel && (
          <div className="text-xs text-gray-500 truncate">
            {result.secondaryLabel}
            {result.tertiaryLabel && ` \u00B7 ${result.tertiaryLabel}`}
          </div>
        )}
      </div>
      <span
        className={`text-xs px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${ENTITY_BADGE_COLORS[result.entityType]}`}
      >
        {ENTITY_LABELS[result.entityType]}
      </span>
    </button>
  );
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const { query, setQuery, results, loading } = useSearch();
  const { recent, addRecent } = useRecentSearches();

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery("");
    }
  }, [open, setQuery]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (open) document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const allResults = [
    ...(results?.deals ?? []),
    ...(results?.contacts ?? []),
    ...(results?.files ?? []),
  ].sort((a, b) => b.rank - a.rank);

  const handleSelect = (link: string) => {
    if (query.trim().length >= 2) addRecent(query.trim());
    navigate(link);
    onClose();
  };

  const handleRecentSelect = (q: string) => {
    setQuery(q);
    inputRef.current?.focus();
  };

  const handleViewAll = () => {
    if (query.trim().length >= 2) {
      addRecent(query.trim());
      navigate(`/search?q=${encodeURIComponent(query.trim())}`);
      onClose();
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Palette */}
      <div className="fixed left-1/2 top-[15vh] z-50 w-full max-w-xl mx-4 sm:mx-0 -translate-x-1/2 rounded-xl border border-gray-200 bg-white shadow-2xl overflow-hidden">
        {/* Search input */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100">
          <Search className="h-4 w-4 text-gray-400 flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search deals, contacts, files..."
            className="flex-1 text-sm outline-none text-gray-900 placeholder:text-gray-400"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="text-gray-400 hover:text-gray-600 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          <kbd className="hidden sm:inline-flex h-5 items-center gap-1 rounded border border-gray-200 bg-gray-50 px-1.5 text-xs text-gray-500">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[400px] overflow-y-auto">
          {loading && (
            <div className="px-4 py-6 text-center text-sm text-gray-400">Searching...</div>
          )}

          {!loading && query.length >= 2 && allResults.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-gray-400">
              No results for &ldquo;{query}&rdquo;
            </div>
          )}

          {!loading && allResults.length > 0 && (
            <div>
              {allResults.map((result) => (
                <ResultItem key={`${result.entityType}-${result.id}`} result={result} onSelect={handleSelect} />
              ))}
              {results && results.total >= 5 && (
                <button
                  className="w-full px-4 py-2.5 text-sm text-blue-600 hover:bg-blue-50 border-t border-gray-100 font-medium text-left transition-colors"
                  onClick={handleViewAll}
                >
                  View all results for &ldquo;{query}&rdquo;
                </button>
              )}
            </div>
          )}

          {/* Recent searches when no query */}
          {query.length < 2 && recent.length > 0 && (
            <div>
              <div className="px-4 py-2 text-xs font-medium text-gray-400 uppercase tracking-wide">
                Recent searches
              </div>
              {recent.map((q) => (
                <button
                  key={q}
                  className="w-full flex items-center gap-3 px-4 py-2 hover:bg-gray-50 text-left transition-colors"
                  onClick={() => handleRecentSelect(q)}
                >
                  <Clock className="h-4 w-4 text-gray-300 flex-shrink-0" />
                  <span className="text-sm text-gray-600">{q}</span>
                </button>
              ))}
            </div>
          )}

          {query.length < 2 && recent.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-gray-400">
              Type at least 2 characters to search
            </div>
          )}
        </div>
      </div>
    </>
  );
}
