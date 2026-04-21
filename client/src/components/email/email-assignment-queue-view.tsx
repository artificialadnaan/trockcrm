import { useState } from "react";
import { Button } from "@/components/ui/button";
import { EmailManualAssignmentDialog, type EmailAssociationTarget } from "./email-manual-assignment-dialog";

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

export interface EmailAssignmentQueueCompanyCandidate {
  id: string;
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
  companyId: string | null;
  contactName: string | null;
  companyName: string | null;
  candidateDeals: EmailAssignmentQueueDealCandidate[];
  candidateLeads: EmailAssignmentQueueLeadCandidate[];
  candidateProperties: EmailAssignmentQueuePropertyCandidate[];
  candidateCompanies?: EmailAssignmentQueueCompanyCandidate[];
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

export type EmailAssignmentTarget = EmailAssociationTarget;

interface EmailAssignmentQueueViewProps {
  items: EmailAssignmentQueueItem[];
  onAssign: (
    emailId: string,
    target: EmailAssociationTarget
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function buildSafeAssignmentOptions(item: EmailAssignmentQueueItem): Array<{ label: string; value: EmailAssociationTarget }> {
  const options: Array<{ label: string; value: EmailAssociationTarget }> = [];

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

  for (const lead of item.candidateLeads) {
    options.push({
      label: `Lead · ${lead.leadNumber} · ${lead.name}`,
      value: {
        assignedEntityType: "lead",
        assignedEntityId: lead.id,
        assignedDealId: null,
      },
    });
  }

  for (const property of item.candidateProperties) {
    options.push({
      label: `Property · ${property.name}`,
      value: {
        assignedEntityType: "property",
        assignedEntityId: property.id,
        assignedDealId: null,
      },
    });
  }

  for (const company of item.candidateCompanies ?? []) {
    options.push({
      label: `Company · ${company.name}`,
      value: {
        assignedEntityType: "company",
        assignedEntityId: company.id,
        assignedDealId: null,
      },
    });
  }

  if (options.length === 0) {
    const companyId = item.companyId ?? item.suggestedAssignment.assignedEntityId;
    const companyName = item.companyName;
    if (companyId && companyName) {
      options.push({
        label: `Company · ${companyName}`,
        value: {
          assignedEntityType: "company",
          assignedEntityId: companyId,
          assignedDealId: null,
        },
      });
    }
  }

  return options;
}

function AssignmentQueueCard({
  item,
  onAssign,
}: {
  item: EmailAssignmentQueueItem;
  onAssign: (
    emailId: string,
    target: EmailAssociationTarget
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
}) {
  const safeOptions = buildSafeAssignmentOptions(item);
  const [dialogOpen, setDialogOpen] = useState(false);

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
          <p className="mt-1 text-xs text-muted-foreground">Parking lot intake</p>
        </div>
        <span className="shrink-0 rounded-full border px-2 py-1 text-xs">
          {item.suggestedAssignment.confidence} confidence
        </span>
      </div>

      <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
        {item.email.bodyPreview ?? ""}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">
          {safeOptions.length > 0
            ? `${safeOptions.length} safe ${safeOptions.length === 1 ? "suggestion" : "suggestions"} available`
            : "No safe match found"}
        </p>
        <Button type="button" variant="outline" onClick={() => setDialogOpen(true)}>
          Assign manually
        </Button>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        {safeOptions.length > 0
          ? "Open manual assignment to use a suggestion or search anywhere in the CRM."
          : "This email can still be reviewed and manually assigned anywhere in the CRM."}
      </p>

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <span className="rounded-full border px-2 py-1">Matched by {item.suggestedAssignment.matchedBy}</span>
        {item.suggestedAssignment.ambiguityReason && (
          <span className="rounded-full border px-2 py-1 text-amber-700">
            {item.suggestedAssignment.ambiguityReason}
          </span>
        )}
      </div>

      <p className="mt-2 text-xs text-muted-foreground">{formatDateTime(item.email.sentAt)}</p>

      <EmailManualAssignmentDialog
        safeOptions={safeOptions}
        onAssign={async (target) => {
          const result = await onAssign(item.email.id, target);
          if (!result.ok) {
            throw new Error(result.message);
          }
        }}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </div>
  );
}

export function EmailAssignmentQueueView({ items, onAssign }: EmailAssignmentQueueViewProps) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
        No unresolved parking-lot email intake.
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
