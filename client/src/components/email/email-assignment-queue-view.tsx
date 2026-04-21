import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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

export interface EmailAssignmentTarget {
  assignedEntityType: "deal" | "lead" | "property" | "company" | "contact";
  assignedEntityId: string;
  assignedDealId: string | null;
}

type ManualSearchType = EmailAssignmentTarget["assignedEntityType"];

type ManualSearchResult = {
  id: string;
  title: string;
  subtitle: string | null;
  target: EmailAssignmentTarget;
};

interface EmailAssignmentQueueViewProps {
  items: EmailAssignmentQueueItem[];
  onAssign: (emailId: string, target: EmailAssignmentTarget) => Promise<void>;
}

type ContactSearchRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  companyName: string | null;
  category: string;
};

type DealSearchRow = {
  id: string;
  dealNumber: string;
  name: string;
  propertyAddress: string | null;
  propertyCity: string | null;
  propertyState: string | null;
};

type LeadSearchRow = {
  id: string;
  name: string;
  companyName: string | null;
  convertedDealNumber: string | null;
  property: {
    address: string | null;
    city: string | null;
    state: string | null;
  } | null;
};

type CompanySearchRow = {
  id: string;
  name: string;
  category: string | null;
};

type PropertySearchRow = {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  companyName: string | null;
};

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function buildSafeAssignmentOptions(item: EmailAssignmentQueueItem): Array<{ label: string; value: EmailAssignmentTarget }> {
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

function formatLocation(parts: Array<string | null | undefined>) {
  return parts.filter(Boolean).join(" · ") || null;
}

async function searchManualTargets(type: ManualSearchType, query: string): Promise<ManualSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  if (type === "contact") {
    const data = await api<{ contacts: ContactSearchRow[] }>(`/contacts/search?q=${encodeURIComponent(trimmed)}&limit=10`);
    return data.contacts.map((contact) => ({
      id: contact.id,
      title: [contact.firstName, contact.lastName].filter(Boolean).join(" ") || "Unknown Contact",
      subtitle: formatLocation([contact.email, contact.companyName, contact.category]),
      target: {
        assignedEntityType: "contact",
        assignedEntityId: contact.id,
        assignedDealId: null,
      },
    }));
  }

  if (type === "company") {
    const data = await api<{ companies: CompanySearchRow[]; total: number; page: number; limit: number }>(
      `/companies?search=${encodeURIComponent(trimmed)}&limit=10`
    );
    return data.companies.map((company) => ({
      id: company.id,
      title: company.name,
      subtitle: company.category ?? null,
      target: {
        assignedEntityType: "company",
        assignedEntityId: company.id,
        assignedDealId: null,
      },
    }));
  }

  if (type === "property") {
    const data = await api<{ properties: PropertySearchRow[]; total: number; page: number; limit: number }>(
      `/properties?search=${encodeURIComponent(trimmed)}&limit=10`
    );
    return data.properties.map((property) => ({
      id: property.id,
      title: property.name,
      subtitle: formatLocation([property.companyName, property.address, [property.city, property.state].filter(Boolean).join(", ")]),
      target: {
        assignedEntityType: "property",
        assignedEntityId: property.id,
        assignedDealId: null,
      },
    }));
  }

  if (type === "lead") {
    const data = await api<{ leads: LeadSearchRow[] }>(
      `/leads?search=${encodeURIComponent(trimmed)}&isActive=all`
    );
    return data.leads.slice(0, 10).map((lead) => ({
      id: lead.id,
      title: lead.name,
      subtitle: formatLocation([
        lead.companyName,
        lead.convertedDealNumber,
        lead.property?.address,
        [lead.property?.city, lead.property?.state].filter(Boolean).join(", "),
      ]),
      target: {
        assignedEntityType: "lead",
        assignedEntityId: lead.id,
        assignedDealId: null,
      },
    }));
  }

  const data = await api<{ deals: DealSearchRow[]; pagination?: unknown }>(
    `/deals?search=${encodeURIComponent(trimmed)}&limit=10`
  );
  return data.deals.map((deal) => ({
    id: deal.id,
    title: `${deal.dealNumber} · ${deal.name}`,
    subtitle: formatLocation([deal.propertyAddress, [deal.propertyCity, deal.propertyState].filter(Boolean).join(", ")]),
    target: {
      assignedEntityType: "deal",
      assignedEntityId: deal.id,
      assignedDealId: deal.id,
    },
  }));
}

function AssignmentTargetDialog({
  item,
  safeOptions,
  onAssign,
  open,
  onOpenChange,
}: {
  item: EmailAssignmentQueueItem;
  safeOptions: Array<{ label: string; value: EmailAssignmentTarget }>;
  onAssign: (emailId: string, target: EmailAssignmentTarget) => Promise<void>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [searchType, setSearchType] = useState<ManualSearchType>("deal");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ManualSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setSearchError(null);
      setSearching(false);
      setResolvingKey(null);
      return;
    }

    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setSearchError(null);
      setSearching(false);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setSearching(true);
      setSearchError(null);
      searchManualTargets(searchType, trimmed)
        .then((nextResults) => {
          setResults(nextResults);
        })
        .catch((error: unknown) => {
          setSearchError(error instanceof Error ? error.message : "Search failed");
          setResults([]);
        })
        .finally(() => {
          setSearching(false);
        });
    }, 250);

    return () => window.clearTimeout(timeoutId);
  }, [open, query, searchType]);

  const typeLabels: Array<{ type: ManualSearchType; label: string }> = useMemo(
    () => [
      { type: "deal", label: "Deals" },
      { type: "lead", label: "Leads" },
      { type: "contact", label: "Contacts" },
      { type: "company", label: "Companies" },
      { type: "property", label: "Properties" },
    ],
    []
  );

  async function handleAssignTarget(target: EmailAssignmentTarget) {
    const key = `${target.assignedEntityType}:${target.assignedEntityId}`;
    setResolvingKey(key);
    try {
      await onAssign(item.email.id, target);
      onOpenChange(false);
    } finally {
      setResolvingKey(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Assign intake manually</DialogTitle>
          <DialogDescription>
            No safe match found. Search the CRM and attach this email to any deal, lead, contact, company, or property.
          </DialogDescription>
        </DialogHeader>

        {safeOptions.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Suggested targets</p>
            <div className="grid gap-2">
              {safeOptions.map((option) => {
                const key = `${option.value.assignedEntityType}:${option.value.assignedEntityId}`;
                return (
                  <div key={key} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                    <div className="min-w-0 text-sm">{option.label}</div>
                    <Button
                      size="sm"
                      onClick={() => void handleAssignTarget(option.value)}
                      disabled={resolvingKey !== null}
                    >
                      {resolvingKey === key ? "Assigning..." : "Assign"}
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Search anywhere in CRM</p>
          <div className="flex flex-wrap gap-2">
            {typeLabels.map((entry) => (
              <Button
                key={entry.type}
                type="button"
                size="sm"
                variant={searchType === entry.type ? "default" : "outline"}
                onClick={() => setSearchType(entry.type)}
              >
                {entry.label}
              </Button>
            ))}
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${searchType}s...`}
              className="pl-9"
            />
          </div>

          {searchError && <p className="text-sm text-red-700">{searchError}</p>}

          {query.trim().length < 2 ? (
            <p className="text-sm text-muted-foreground">Type at least 2 characters to search across {searchType}s.</p>
          ) : searching ? (
            <p className="text-sm text-muted-foreground">Searching {searchType}s...</p>
          ) : results.length === 0 ? (
            <p className="text-sm text-muted-foreground">No {searchType} results matched this search.</p>
          ) : (
            <div className="grid max-h-72 gap-2 overflow-y-auto">
              {results.map((result) => {
                const key = `${result.target.assignedEntityType}:${result.target.assignedEntityId}`;
                return (
                  <div key={result.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{result.title}</p>
                      {result.subtitle && <p className="truncate text-xs text-muted-foreground">{result.subtitle}</p>}
                    </div>
                    <Button
                      size="sm"
                      onClick={() => void handleAssignTarget(result.target)}
                      disabled={resolvingKey !== null}
                    >
                      {resolvingKey === key ? "Assigning..." : "Assign"}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

function AssignmentQueueCard({
  item,
  onAssign,
}: {
  item: EmailAssignmentQueueItem;
  onAssign: (emailId: string, target: EmailAssignmentTarget) => Promise<void>;
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

      <AssignmentTargetDialog
        item={item}
        safeOptions={safeOptions}
        onAssign={onAssign}
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
