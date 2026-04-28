import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  dismissDirectoryQueueEntry,
  mergeDirectoryQueueEntry,
  useDirectoryMergeQueue,
  type DirectoryMergeQueueEntry,
} from "@/hooks/use-directory-merge-queue";
import { GitMerge, X } from "lucide-react";

function entityLabel(entry: DirectoryMergeQueueEntry, side: "entityA" | "entityB") {
  const entity = entry[side];
  if (!entity) return "Missing record";
  if (entry.entityType === "company") return String(entity.name ?? "Unnamed company");
  return [entity.firstName, entity.lastName].filter(Boolean).join(" ") || String(entity.email ?? "Unnamed contact");
}

function entitySubLabel(entry: DirectoryMergeQueueEntry, side: "entityA" | "entityB") {
  const entity = entry[side];
  if (!entity) return "";
  if (entry.entityType === "company") {
    return [entity.city, entity.state, entity.zip].filter(Boolean).join(", ");
  }
  return [entity.email, entity.companyName].filter(Boolean).join(" | ");
}

export function DirectoryMergeQueuePage() {
  const { entries, loading, error, refetch } = useDirectoryMergeQueue("pending");

  const handleMerge = async (entry: DirectoryMergeQueueEntry, winnerId: string) => {
    await mergeDirectoryQueueEntry(entry.id, winnerId);
    await refetch();
  };

  const handleDismiss = async (entryId: string) => {
    await dismissDirectoryQueueEntry(entryId);
    await refetch();
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold">Directory Merge Queue</h2>
        <p className="text-sm text-muted-foreground">
          {entries.length} Procore and HubSpot directory match{entries.length === 1 ? "" : "es"} awaiting review
        </p>
      </div>

      {error && <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</div>}
      {loading && <div className="h-28 animate-pulse rounded-lg bg-muted" />}

      {!loading && entries.length === 0 && (
        <div className="py-12 text-center text-muted-foreground">No directory matches awaiting review.</div>
      )}

      <div className="space-y-3">
        {entries.map((entry) => (
          <Card key={entry.id} className="p-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{entry.entityType}</Badge>
                  <span className="text-sm font-medium">{entry.confidenceScore}</span>
                  {entry.matchReasons.map((reason) => (
                    <Badge key={reason} variant="secondary">{reason}</Badge>
                  ))}
                </div>
                <div className="grid gap-3 text-sm md:grid-cols-2">
                  <div>
                    <p className="font-medium">{entityLabel(entry, "entityA")}</p>
                    <p className="text-muted-foreground">{entitySubLabel(entry, "entityA")}</p>
                  </div>
                  <div>
                    <p className="font-medium">{entityLabel(entry, "entityB")}</p>
                    <p className="text-muted-foreground">{entitySubLabel(entry, "entityB")}</p>
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => handleMerge(entry, entry.entityAId)}>
                  <GitMerge className="mr-1 h-4 w-4" />
                  Keep left
                </Button>
                <Button size="sm" variant="outline" onClick={() => handleMerge(entry, entry.entityBId)}>
                  <GitMerge className="mr-1 h-4 w-4" />
                  Keep right
                </Button>
                <Button size="sm" variant="ghost" onClick={() => handleDismiss(entry.id)}>
                  <X className="mr-1 h-4 w-4" />
                  Dismiss
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
