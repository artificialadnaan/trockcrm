import { useState } from "react";

export interface EmailAssignmentQueueDealCandidate {
  id: string;
  dealNumber: string;
  name: string;
}

export interface EmailAssignmentQueueItem {
  email: {
    id: string;
    subject: string | null;
    bodyPreview: string | null;
    fromAddress: string;
    sentAt: string;
  };
  contactName: string | null;
  companyName: string | null;
  candidateDeals: EmailAssignmentQueueDealCandidate[];
  suggestedAssignment: {
    assignedEntityType: string | null;
    assignedEntityId: string | null;
    assignedDealId: string | null;
    confidence: "high" | "medium" | "low";
    ambiguityReason: string | null;
    matchedBy: string;
    requiresClassificationTask: boolean;
    candidateDealIds: string[];
  };
}

interface EmailAssignmentQueueViewProps {
  items: EmailAssignmentQueueItem[];
  onAssign: (emailId: string, dealId: string) => Promise<void>;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function AssignmentQueueCard({
  item,
  onAssign,
}: {
  item: EmailAssignmentQueueItem;
  onAssign: (emailId: string, dealId: string) => Promise<void>;
}) {
  const [selectedDealId, setSelectedDealId] = useState(item.candidateDeals[0]?.id ?? "");
  const [saving, setSaving] = useState(false);

  return (
    <div className="rounded-lg border bg-background p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            {item.contactName ?? "Unknown contact"}
            {item.companyName ? ` · ${item.companyName}` : ""}
          </p>
          <h3 className="truncate text-sm font-semibold">{item.email.subject ?? "(No Subject)"}</h3>
          <p className="text-xs text-muted-foreground">{item.email.fromAddress}</p>
        </div>
        <span className="shrink-0 rounded-full border px-2 py-1 text-xs">
          {item.suggestedAssignment.confidence} confidence
        </span>
      </div>

      <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
        {item.email.bodyPreview ?? ""}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          className="min-w-[240px] rounded-md border bg-background px-3 py-2 text-sm"
          value={selectedDealId}
          onChange={(event) => setSelectedDealId(event.target.value)}
        >
          {item.candidateDeals.length === 0 ? (
            <option value="">No candidate deals</option>
          ) : (
            item.candidateDeals.map((deal) => (
              <option key={deal.id} value={deal.id}>
                {deal.dealNumber} · {deal.name}
              </option>
            ))
          )}
        </select>
        <button
          type="button"
          className="rounded-md border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!selectedDealId || saving}
          onClick={async () => {
            if (!selectedDealId) return;
            setSaving(true);
            try {
              await onAssign(item.email.id, selectedDealId);
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Assigning..." : "Assign"}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <span className="rounded-full border px-2 py-1">Matched by {item.suggestedAssignment.matchedBy}</span>
        {item.suggestedAssignment.ambiguityReason && (
          <span className="rounded-full border px-2 py-1 text-amber-700">
            {item.suggestedAssignment.ambiguityReason}
          </span>
        )}
      </div>

      <p className="mt-2 text-xs text-muted-foreground">{formatDateTime(item.email.sentAt)}</p>
    </div>
  );
}

export function EmailAssignmentQueueView({ items, onAssign }: EmailAssignmentQueueViewProps) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
        No unresolved email assignments.
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {items.map((item) => (
        <AssignmentQueueCard key={item.email.id} item={item} onAssign={onAssign} />
      ))}
    </div>
  );
}
