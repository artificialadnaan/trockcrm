import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { EmailAssociationTarget } from "@/hooks/use-emails";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type ManualSearchType = EmailAssociationTarget["assignedEntityType"];

type ManualSearchResult = {
  id: string;
  title: string;
  subtitle: string | null;
  target: EmailAssociationTarget;
};

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

function formatLocation(parts: Array<string | null | undefined>) {
  return parts.filter(Boolean).join(" · ") || null;
}

async function searchManualTargets(type: ManualSearchType, query: string): Promise<ManualSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  if (type === "contact") {
    const data = await api<{ contacts: ContactSearchRow[] }>(
      `/contacts/search?q=${encodeURIComponent(trimmed)}&limit=10`
    );
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
      subtitle: formatLocation([
        property.companyName,
        property.address,
        [property.city, property.state].filter(Boolean).join(", "),
      ]),
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
    subtitle: formatLocation([
      deal.propertyAddress,
      [deal.propertyCity, deal.propertyState].filter(Boolean).join(", "),
    ]),
    target: {
      assignedEntityType: "deal",
      assignedEntityId: deal.id,
      assignedDealId: deal.id,
    },
  }));
}

interface EmailManualAssignmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAssign: (target: EmailAssociationTarget) => Promise<void>;
  title?: string;
  description?: string;
  safeOptions?: Array<{ label: string; value: EmailAssociationTarget }>;
}

export function EmailManualAssignmentDialog({
  open,
  onOpenChange,
  onAssign,
  title = "Assign intake manually",
  description = "No safe match found. Search the CRM and attach this email to any deal, lead, contact, company, or property.",
  safeOptions = [],
}: EmailManualAssignmentDialogProps) {
  const [searchType, setSearchType] = useState<ManualSearchType>("deal");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ManualSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setSearchError(null);
      setSearching(false);
      setResolvingKey(null);
      setAssignmentError(null);
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

  async function handleAssignTarget(target: EmailAssociationTarget) {
    const key = `${target.assignedEntityType}:${target.assignedEntityId}`;
    setResolvingKey(key);
    setAssignmentError(null);
    try {
      await onAssign(target);
      onOpenChange(false);
    } catch (error: unknown) {
      setAssignmentError(error instanceof Error ? error.message : "Failed to assign email");
    } finally {
      setResolvingKey(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {safeOptions.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Suggested targets</p>
            <div className="grid gap-2">
              {safeOptions.map((option) => {
                const key = `${option.value.assignedEntityType}:${option.value.assignedEntityId}`;
                return (
                  <div key={key} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                    <div className="min-w-0 flex-1 text-sm">{option.label}</div>
                    <Button
                      size="sm"
                      className="shrink-0"
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
          {assignmentError && <p className="text-sm text-red-700">{assignmentError}</p>}

          {query.trim().length < 2 ? (
            <p className="text-sm text-muted-foreground">
              Type at least 2 characters to search across {searchType}s.
            </p>
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
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{result.title}</p>
                      {result.subtitle && (
                        <p className="truncate text-xs text-muted-foreground">{result.subtitle}</p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      className="shrink-0"
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

export type { EmailAssociationTarget } from "@/hooks/use-emails";
