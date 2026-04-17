import { useMemo, useState } from "react";
import DOMPurify from "dompurify";
import { ArrowLeft, ArrowDownLeft, ArrowUpRight, Link2, Loader2, RefreshCw, Unlink2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDeals } from "@/hooks/use-deals";
import {
  assignEmailThread,
  detachEmailThread,
  reassignEmailThread,
  useEmailThread,
  type EmailThread,
} from "@/hooks/use-emails";

interface EmailThreadViewProps {
  conversationId: string;
  onBack: () => void;
}

type AssignmentMode = "assign" | "reassign";

function formatReason(reason: string | null | undefined): string {
  if (!reason) return "manual_thread_assignment";
  return reason.replace(/_/g, " ");
}

function ThreadAssignmentDialog({
  open,
  mode,
  currentDealId,
  onOpenChange,
  onConfirm,
  loading,
}: {
  open: boolean;
  mode: AssignmentMode;
  currentDealId: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (dealId: string) => Promise<void>;
  loading: boolean;
}) {
  const [search, setSearch] = useState("");
  const [selectedDealId, setSelectedDealId] = useState(currentDealId ?? "");
  const { deals, loading: dealsLoading } = useDeals({
    search: search.trim().length >= 2 ? search.trim() : undefined,
    limit: 25,
  });

  const selectedDeal = deals.find((deal) => deal.id === selectedDealId) ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{mode === "assign" ? "Assign Thread to Deal" : "Reassign Thread"}</DialogTitle>
          <DialogDescription>
            This binds the whole conversation thread, including historical messages and future replies, to the selected deal.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="thread-deal-search">Find deal</Label>
            <Input
              id="thread-deal-search"
              placeholder="Search by deal number or name"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>

          <div className="max-h-72 space-y-2 overflow-y-auto rounded-lg border p-2">
            {dealsLoading ? (
              <div className="flex items-center gap-2 px-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading deals...
              </div>
            ) : deals.length === 0 ? (
              <p className="px-2 py-6 text-sm text-muted-foreground">
                No deals found. Try a broader search.
              </p>
            ) : (
              deals.map((deal) => {
                const isSelected = deal.id === selectedDealId;
                return (
                  <button
                    key={deal.id}
                    type="button"
                    className={`flex w-full items-start justify-between rounded-md border px-3 py-2 text-left transition-colors ${
                      isSelected ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                    }`}
                    onClick={() => setSelectedDealId(deal.id)}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{deal.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {deal.dealNumber}
                        {deal.propertyAddress ? ` · ${deal.propertyAddress}` : ""}
                      </p>
                    </div>
                    {isSelected ? (
                      <Badge variant="outline" className="ml-3 shrink-0 border-primary text-primary">
                        Selected
                      </Badge>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>

          {selectedDeal ? (
            <div className="rounded-lg border bg-muted/30 p-3 text-sm">
              <p className="font-medium">Selected deal</p>
              <p>{selectedDeal.name}</p>
              <p className="text-muted-foreground">
                {selectedDeal.dealNumber}
                {selectedDeal.propertyAddress ? ` · ${selectedDeal.propertyAddress}` : ""}
              </p>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button
            onClick={() => selectedDealId && onConfirm(selectedDealId)}
            disabled={!selectedDealId || loading}
          >
            {loading ? "Saving..." : mode === "assign" ? "Assign Thread" : "Reassign Thread"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ThreadAssignmentCard({
  thread,
  onAssign,
  onReassign,
  onDetach,
  saving,
}: {
  thread: EmailThread;
  onAssign: () => void;
  onReassign: () => void;
  onDetach: () => Promise<void>;
  saving: boolean;
}) {
  const binding = thread.binding;
  const affectedCount = thread.emails.length;

  if (!binding?.dealId) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-amber-900">Thread is not assigned to a deal</p>
            <p className="mt-1 text-sm text-amber-800">
              Bind this conversation once and the system will use it for historical messages and future replies.
            </p>
          </div>
          <Button onClick={onAssign} disabled={saving}>
            <Link2 className="mr-2 h-4 w-4" />
            Assign to Deal
          </Button>
        </div>
        <p className="mt-3 text-xs text-amber-800">
          {affectedCount} message{affectedCount !== 1 ? "s" : ""} in this thread
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-muted/30 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-primary/40 text-primary">
              Bound to deal
            </Badge>
            <Badge variant="outline">{binding.confidence} confidence</Badge>
          </div>
          <div>
            <p className="text-sm font-semibold">{binding.dealName ?? "Assigned deal"}</p>
            <p className="text-xs text-muted-foreground">
              Reason: {formatReason(binding.assignmentReason)}
            </p>
            <p className="text-xs text-muted-foreground">
              {affectedCount} message{affectedCount !== 1 ? "s" : ""} will follow this binding
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onReassign} disabled={saving}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Reassign
          </Button>
          <Button variant="outline" onClick={() => void onDetach()} disabled={saving}>
            <Unlink2 className="mr-2 h-4 w-4" />
            Detach
          </Button>
        </div>
      </div>
    </div>
  );
}

export function EmailThreadView({ conversationId, onBack }: EmailThreadViewProps) {
  const { thread, loading, error, setThread } = useEmailThread(conversationId);
  const [dialogMode, setDialogMode] = useState<AssignmentMode | null>(null);
  const [saving, setSaving] = useState(false);

  const subject = thread.emails[0]?.subject ?? "(No Subject)";
  const binding = thread.binding;
  const canDetach = Boolean(binding?.dealId);

  const handleAssignLikeAction = async (dealId: string) => {
    setSaving(true);
    try {
      const result =
        dialogMode === "reassign"
          ? await reassignEmailThread(conversationId, dealId)
          : await assignEmailThread(conversationId, dealId);
      setThread(result.thread);
      setDialogMode(null);
      toast.success(dialogMode === "reassign" ? "Thread reassigned" : "Thread assigned to deal");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to save thread assignment");
    } finally {
      setSaving(false);
    }
  };

  const handleDetach = async () => {
    setSaving(true);
    try {
      const result = await detachEmailThread(conversationId);
      setThread(result.thread);
      toast.success("Thread detached");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to detach thread");
    } finally {
      setSaving(false);
    }
  };

  const headerMeta = useMemo(() => {
    if (!binding) return null;
    return [binding.contactName, binding.companyName].filter(Boolean).join(" · ");
  }, [binding]);

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="h-8 w-32 animate-pulse rounded bg-muted" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          Back
        </Button>
        <p className="mt-2 text-sm text-red-600">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          Back
        </Button>
        <div className="min-w-0">
          <h3 className="truncate font-medium">{subject}</h3>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
              {thread.emails.length} message{thread.emails.length !== 1 ? "s" : ""}
            </span>
            {headerMeta ? <span>{headerMeta}</span> : null}
          </div>
        </div>
      </div>

      <ThreadAssignmentCard
        thread={thread}
        onAssign={() => setDialogMode("assign")}
        onReassign={() => setDialogMode("reassign")}
        onDetach={handleDetach}
        saving={saving}
      />

      <div className="space-y-3">
        {thread.emails.map((email) => {
          const isInbound = email.direction === "inbound";
          return (
            <div
              key={email.id}
              className={`rounded-lg border p-4 ${
                isInbound ? "border-l-4 border-l-blue-400" : "border-l-4 border-l-green-400"
              }`}
            >
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {isInbound ? (
                    <ArrowDownLeft className="h-4 w-4 text-blue-500" />
                  ) : (
                    <ArrowUpRight className="h-4 w-4 text-green-500" />
                  )}
                  <span className="text-sm font-medium">
                    {isInbound ? email.fromAddress : `To: ${email.toAddresses.join(", ")}`}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {new Date(email.sentAt).toLocaleString()}
                </span>
              </div>
              <div
                className="prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{
                  __html: DOMPurify.sanitize(email.bodyHtml ?? email.bodyPreview ?? ""),
                }}
              />
            </div>
          );
        })}
      </div>

      <ThreadAssignmentDialog
        open={dialogMode !== null}
        mode={dialogMode ?? "assign"}
        currentDealId={binding?.dealId ?? null}
        onOpenChange={(open) => {
          if (!open) setDialogMode(null);
        }}
        onConfirm={handleAssignLikeAction}
        loading={saving}
      />

      {!canDetach && dialogMode === "reassign" ? null : null}
    </div>
  );
}
