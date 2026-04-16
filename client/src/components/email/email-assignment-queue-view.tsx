import { useState } from "react";

export interface EmailAssignmentQueueDealCandidate {
  id: string;
  dealNumber: string;
  name: string;
}

export interface EmailAssignmentQueueLeadCandidate {
  id: string;
  leadNumber: string;
  name: string;
  relatedDealId: string | null;
}

export interface EmailAssignmentQueuePropertyCandidate {
  id: string;
  name: string;
  relatedDealIds: string[];
}

export interface EmailAssignmentQueueItem {
  email: {
    id: string;
    subject: string | null;
    bodyPreview: string | null;
    fromAddress: string;
    sentAt: string;
  };
  companyId: string | null;
  contactName: string | null;
  companyName: string | null;
  candidateDeals: EmailAssignmentQueueDealCandidate[];
  candidateLeads: EmailAssignmentQueueLeadCandidate[];
  candidateProperties: EmailAssignmentQueuePropertyCandidate[];
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

export interface EmailAssignmentTarget {
  assignedEntityType: "deal";
  assignedEntityId: string;
  assignedDealId: string;
}

interface EmailAssignmentQueueViewProps {
  items: EmailAssignmentQueueItem[];
  onAssign: (emailId: string, target: EmailAssignmentTarget) => Promise<void>;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function encodeTarget(target: EmailAssignmentTarget) {
  return JSON.stringify(target);
}

function decodeTarget(value: string): EmailAssignmentTarget | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as EmailAssignmentTarget;
  } catch {
    return null;
  }
}

function buildAssignmentOptions(item: EmailAssignmentQueueItem): Array<{ label: string; value: EmailAssignmentTarget }> {
  const options: Array<{ label: string; value: EmailAssignmentTarget }> = [];

  for (const deal of item.candidateDeals) {
    options.push({
      label: `Deal · ${deal.dealNumber} · ${deal.name}`,
      value: {
        assignedEntityType: "deal",
        assignedEntityId: deal.id,
        assignedDealId: deal.id,
      },
    });
  }

  return options;
}

function AssignmentQueueCard({
  item,
  onAssign,
}: {
  item: EmailAssignmentQueueItem;
  onAssign: (emailId: string, target: EmailAssignmentTarget) => Promise<void>;
}) {
  const assignmentOptions = buildAssignmentOptions(item);
  const [selectedTarget, setSelectedTarget] = useState(
    assignmentOptions.length === 1 ? encodeTarget(assignmentOptions[0]!.value) : ""
  );
  const [saving, setSaving] = useState(false);

  const parsedTarget = decodeTarget(selectedTarget);

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
          className="min-w-[300px] rounded-md border bg-background px-3 py-2 text-sm"
          value={selectedTarget}
          onChange={(event) => setSelectedTarget(event.target.value)}
        >
          {assignmentOptions.length === 0 ? (
            <option value="">No safe assignment targets</option>
          ) : (
            <>
              <option value="">Select a target...</option>
              {assignmentOptions.map((option) => (
                <option key={encodeTarget(option.value)} value={encodeTarget(option.value)}>
                  {option.label}
                </option>
              ))}
            </>
          )}
        </select>
        <button
          type="button"
          className="rounded-md border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!parsedTarget || saving}
          onClick={async () => {
            if (!parsedTarget) return;
            setSaving(true);
            try {
              await onAssign(item.email.id, parsedTarget);
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Assigning..." : "Resolve"}
        </button>
      </div>

      {assignmentOptions.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          This email can be reviewed, but it does not have a safe deal target yet.
        </p>
      )}

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
