import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { CompanyDedupSuggestion } from "@/hooks/use-companies";

interface CompanyDedupWarningProps {
  suggestions: CompanyDedupSuggestion[];
  onUseExisting: (companyId: string) => void;
  onCreateAnyway: () => void;
  onCancel: () => void;
}

function locationLine(s: CompanyDedupSuggestion): string | null {
  const parts = [s.address, [s.city, s.state].filter(Boolean).join(", "), s.zip]
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function CompanyDedupWarning({ suggestions, onUseExisting, onCreateAnyway, onCancel }: CompanyDedupWarningProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 bg-amber-50 text-amber-800 p-4 rounded-lg">
        <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
        <div>
          <p className="font-medium">Possible duplicate company found</p>
          <p className="text-sm mt-1">
            A company with this name already exists. Use the existing one so deals and contacts
            stay together, or create a new company anyway.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {suggestions.map((suggestion) => {
          const location = locationLine(suggestion);
          return (
            <Card key={suggestion.id} className="p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium truncate">{suggestion.name}</p>
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    {location && <p className="truncate">{location}</p>}
                    <p>
                      {suggestion.dealCount} {suggestion.dealCount === 1 ? "deal" : "deals"}
                    </p>
                    <p className="text-amber-600 font-medium">{suggestion.matchReason}</p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onUseExisting(suggestion.id)}
                >
                  Use This Company
                </Button>
              </div>
            </Card>
          );
        })}
      </div>

      <div className="flex gap-3 justify-end">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="outline" onClick={onCreateAnyway}>
          Create Anyway
        </Button>
      </div>
    </div>
  );
}
