import { useEffect, useState } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { associateEmailToDeal } from "@/hooks/use-emails";
import { Button } from "@/components/ui/button";
import {
  EmailAssignmentQueueView,
  type EmailAssignmentQueueItem,
} from "./email-assignment-queue-view";

interface AssignmentQueueResponse {
  items: EmailAssignmentQueueItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export function EmailAssignmentQueue() {
  const [items, setItems] = useState<EmailAssignmentQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<AssignmentQueueResponse["pagination"]>({
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 0,
  });

  const fetchQueue = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<AssignmentQueueResponse>(`/email/assignment-queue?page=${page}&limit=10`);
      setItems(data.items);
      setPagination(data.pagination);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load assignment queue");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchQueue();
  }, [page]);

  const handleAssign = async (emailId: string, dealId: string) => {
    await associateEmailToDeal(emailId, dealId);
    await fetchQueue();
  };

  return (
    <section className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Assignment Queue</h3>
          <p className="text-xs text-muted-foreground">
            Review unresolved emails and assign them to the correct deal.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void fetchQueue()} disabled={loading}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-24 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : (
        <>
          <EmailAssignmentQueueView items={items} onAssign={handleAssign} />
          {pagination.totalPages > 1 && (
            <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
              <span>
                Page {pagination.page} of {pagination.totalPages} ({pagination.total} items)
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={pagination.page <= 1} onClick={() => setPage(page - 1)}>
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pagination.page >= pagination.totalPages}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export type { EmailAssignmentQueueItem } from "./email-assignment-queue-view";
export { EmailAssignmentQueueView } from "./email-assignment-queue-view";
