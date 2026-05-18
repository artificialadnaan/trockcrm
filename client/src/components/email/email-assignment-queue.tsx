import { useEffect, useState } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  EmailAssignmentQueueView,
  type EmailAssignmentTarget,
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

export function useEmailAssignmentQueue() {
  const [items, setItems] = useState<EmailAssignmentQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<"unassigned" | "ignored">("unassigned");
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
      const data = await api<AssignmentQueueResponse>(
        `/email/assignment-queue?page=${page}&limit=10&status=${status}`
      );
      setItems(data.items);
      setPagination(data.pagination);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load parking-lot intake");
    } finally {
      setLoading(false);
    }
  };

  const handleUnignore = async (emailId: string) => {
    try {
      await api<{ email: unknown }>(`/email/${emailId}/un-ignore`, {
        method: "POST",
      });
      await fetchQueue();
      toast.success("Email returned to parking lot");
      return { ok: true as const };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to restore email";
      toast.error(message);
      return { ok: false as const, message };
    }
  };

  useEffect(() => {
    void fetchQueue();
  }, [page, status]);

  const handleAssign = async (emailId: string, target: EmailAssignmentTarget) => {
    try {
      await api<{ success: boolean }>(`/email/${emailId}/associate`, {
        method: "POST",
        json: target,
      });
      await fetchQueue();
      toast.success("Email assignment saved");
      return { ok: true as const };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to save email assignment";
      toast.error(message);
      return { ok: false as const, message };
    }
  };

  const handleIgnore = async (emailId: string) => {
    try {
      await api<{ email: unknown }>(`/email/${emailId}/ignore`, {
        method: "POST",
      });
      await fetchQueue();
      toast.success("Email marked as irrelevant");
      return { ok: true as const };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to mark email as irrelevant";
      toast.error(message);
      return { ok: false as const, message };
    }
  };

  return {
    items,
    loading,
    error,
    page,
    pagination,
    setPage,
    status,
    setStatus,
    refresh: fetchQueue,
    assign: handleAssign,
    ignore: handleIgnore,
    unignore: handleUnignore,
  };
}

export type EmailAssignmentQueueState = ReturnType<typeof useEmailAssignmentQueue>;

export function EmailAssignmentQueuePanel({
  queue,
  embedded = false,
}: {
  queue: EmailAssignmentQueueState;
  embedded?: boolean;
}) {
  const { items, loading, error, page, pagination, setPage, status, setStatus, refresh, assign, ignore, unignore } = queue;

  return (
    <section className={embedded ? "p-5" : "rounded-lg border bg-card p-4"}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-black uppercase tracking-[0.16em] text-slate-950">Parking Lot Intake</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Review unresolved CRM email intake and attach it to the right company, property, lead, or deal.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant={status === "unassigned" ? "default" : "outline"}
          onClick={() => {
            setPage(1);
            setStatus("unassigned");
          }}
        >
          Parking Lot
        </Button>
        <Button
          type="button"
          size="sm"
          variant={status === "ignored" ? "default" : "outline"}
          onClick={() => {
            setPage(1);
            setStatus("ignored");
          }}
        >
          Ignored
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
          <EmailAssignmentQueueView
            items={items}
            onAssign={assign}
            onIgnore={ignore}
            onUnignore={unignore}
            status={status}
          />
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

export function EmailAssignmentQueue() {
  const queue = useEmailAssignmentQueue();
  return <EmailAssignmentQueuePanel queue={queue} />;
}

export type { EmailAssignmentQueueItem } from "./email-assignment-queue-view";
export { EmailAssignmentQueueView } from "./email-assignment-queue-view";
