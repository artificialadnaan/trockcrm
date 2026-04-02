import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MergeDialog } from "@/components/contacts/merge-dialog";
import { useDuplicateQueue, dismissDuplicate } from "@/hooks/use-duplicate-queue";
import {
  fullName,
  confidenceLabel,
  confidenceColor,
  MATCH_TYPE_LABELS,
} from "@/lib/contact-utils";
import type { Contact } from "@/hooks/use-contacts";
import { GitMerge, X, Users } from "lucide-react";

export function MergeQueuePage() {
  const { entries, pagination, loading, error, refetch } = useDuplicateQueue("pending");
  const [mergeEntry, setMergeEntry] = useState<{
    id: string;
    contactA: Contact;
    contactB: Contact;
  } | null>(null);

  const handleDismiss = async (entryId: string) => {
    if (!window.confirm("Dismiss this duplicate? It will not appear in the queue again.")) return;
    try {
      await dismissDuplicate(entryId);
      refetch();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to dismiss");
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold">Duplicate Merge Queue</h2>
        <p className="text-sm text-muted-foreground">
          {pagination.total} pending duplicate{pagination.total !== 1 ? "s" : ""} to review
        </p>
      </div>

      {error && (
        <div className="p-4 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>
      )}

      {loading && (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />
          ))}
        </div>
      )}

      {!loading && entries.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <Users className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="text-lg font-medium">No duplicates to review</p>
          <p className="text-sm">The weekly scan will check for new potential duplicates.</p>
        </div>
      )}

      {!loading && entries.length > 0 && (
        <div className="space-y-3">
          {entries.map((entry) => {
            if (!entry.contactA || !entry.contactB) return null;

            return (
              <Card key={entry.id} className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant="outline">{MATCH_TYPE_LABELS[entry.matchType] ?? entry.matchType}</Badge>
                      <span className={`text-sm font-medium ${confidenceColor(entry.confidenceScore)}`}>
                        {confidenceLabel(entry.confidenceScore)} ({entry.confidenceScore})
                      </span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                      <div>
                        <p className="font-medium">{fullName(entry.contactA)}</p>
                        <p className="text-muted-foreground">{entry.contactA.email ?? "No email"}</p>
                        <p className="text-muted-foreground">{entry.contactA.companyName ?? "No company"}</p>
                      </div>
                      <div>
                        <p className="font-medium">{fullName(entry.contactB)}</p>
                        <p className="text-muted-foreground">{entry.contactB.email ?? "No email"}</p>
                        <p className="text-muted-foreground">{entry.contactB.companyName ?? "No company"}</p>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setMergeEntry({
                          id: entry.id,
                          contactA: entry.contactA!,
                          contactB: entry.contactB!,
                        })
                      }
                    >
                      <GitMerge className="h-4 w-4 mr-1" />
                      Merge
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDismiss(entry.id)}
                    >
                      <X className="h-4 w-4 mr-1" />
                      Dismiss
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Merge Dialog */}
      {mergeEntry && (
        <MergeDialog
          open={!!mergeEntry}
          onOpenChange={(open) => {
            if (!open) setMergeEntry(null);
          }}
          queueEntryId={mergeEntry.id}
          contactA={mergeEntry.contactA}
          contactB={mergeEntry.contactB}
          onSuccess={refetch}
        />
      )}
    </div>
  );
}
