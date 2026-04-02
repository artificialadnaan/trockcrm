import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { fullName } from "@/lib/contact-utils";

interface DedupSuggestion {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  companyName: string | null;
  matchReason: string;
}

interface DedupWarningProps {
  suggestions: DedupSuggestion[];
  onUseExisting: (contactId: string) => void;
  onCreateAnyway: () => void;
  onCancel: () => void;
}

export function DedupWarning({ suggestions, onUseExisting, onCreateAnyway, onCancel }: DedupWarningProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 bg-amber-50 text-amber-800 p-4 rounded-lg">
        <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
        <div>
          <p className="font-medium">Possible duplicate contacts found</p>
          <p className="text-sm mt-1">
            The contact you are creating may already exist. Please review the matches below.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {suggestions.map((suggestion) => (
          <Card key={suggestion.id} className="p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium">{fullName(suggestion)}</p>
                <div className="text-xs text-muted-foreground space-y-0.5">
                  {suggestion.email && <p>{suggestion.email}</p>}
                  {suggestion.companyName && <p>{suggestion.companyName}</p>}
                  <p className="text-amber-600 font-medium">{suggestion.matchReason}</p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onUseExisting(suggestion.id)}
              >
                Use This Contact
              </Button>
            </div>
          </Card>
        ))}
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
