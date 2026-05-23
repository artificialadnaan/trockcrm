import { useState, useEffect, useRef } from "react";
import { Loader2, ChevronsUpDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { OwnerLabel } from "@/components/shared/owner-label";
import { createCompany, searchCompanies } from "@/hooks/use-companies";

const COMPANY_CATEGORY_LABELS: Record<string, string> = {
  client: "Client",
  subcontractor: "Subcontractor",
  architect: "Architect",
  property_manager: "Property Manager",
  vendor: "Vendor",
  consultant: "Consultant",
  other: "Other",
};

const SEARCH_DEBOUNCE_MS = 150;

interface CompanySelectorProps {
  value: string | null;
  onChange: (companyId: string) => void;
  required?: boolean;
  officeId?: string | null;
  showOwnerLabel?: boolean;
}

interface CompanyOption {
  id: string;
  name: string;
  category: string | null;
  ownerUserId: string | null;
  ownerUserName: string | null;
}

async function submitInlineCompanyCreate(input: {
  name: string;
  category: string;
  officeId?: string | null;
  onCreated: (company: { id: string; name: string }) => void;
  onError: (message: string | null) => void;
  onCreating: (value: boolean) => void;
}) {
  if (!input.name.trim()) {
    input.onError("Name is required");
    return;
  }

  input.onCreating(true);
  input.onError(null);
  try {
    const result = await createCompany(
      {
        name: input.name.trim(),
        category: input.category || null,
      },
      { officeId: input.officeId }
    );
    input.onCreated(result.company);
  } catch (err: unknown) {
    input.onError(err instanceof Error ? err.message : "Failed to create company");
  } finally {
    input.onCreating(false);
  }
}

export function CompanySelector({ value, onChange, required, officeId, showOwnerLabel = false }: CompanySelectorProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CompanyOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [selectedOwner, setSelectedOwner] = useState<{ ownerUserId: string | null; ownerUserName: string | null } | null>(null);
  const [showInlineForm, setShowInlineForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Initialize display name from value prop
  useEffect(() => {
    let cancelled = false;
    if (!value) {
      setSelectedCompanyId(null);
      setSelectedName(null);
      setSelectedOwner(null);
      return () => {
        cancelled = true;
      };
    }
    if (value && selectedCompanyId !== value) {
      // Fetch the company name and owner for the current value
      import("@/lib/api").then(({ api }) => {
        api<{ company: { name: string; ownerUserId: string | null; ownerUserName: string | null } }>(
          `/companies/${value}`,
          officeId ? { headers: { "x-office-id": officeId } } : {}
        )
          .then((data) => {
            if (!cancelled) {
              setSelectedCompanyId(value);
              setSelectedName(data.company.name);
              setSelectedOwner({
                ownerUserId: data.company.ownerUserId ?? null,
                ownerUserName: data.company.ownerUserName ?? null,
              });
            }
          })
          .catch(() => {});
      });
    }
    return () => {
      cancelled = true;
    };
  }, [officeId, selectedCompanyId, value]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Debounced search
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const trimmedQuery = query.trim();
    if (trimmedQuery.length < 1) {
      setResults([]);
      return;
    }
    setResults([]);
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const data = await searchCompanies(trimmedQuery, { officeId });
        if (!cancelled) {
          setResults(data.companies);
        }
      } catch {
        if (!cancelled) {
          setResults([]);
        }
      } finally {
        if (!cancelled) {
          setSearching(false);
        }
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [officeId, query, open]);

  const handleSelect = (company: CompanyOption) => {
    setSelectedCompanyId(company.id);
    setSelectedName(company.name);
    setSelectedOwner({
      ownerUserId: company.ownerUserId ?? null,
      ownerUserName: company.ownerUserName ?? null,
    });
    setQuery("");
    setOpen(false);
    onChange(company.id);
  };

  const handleCreateSubmit = async () => {
    await submitInlineCompanyCreate({
      name: newName,
      category: newCategory,
      officeId,
      onError: setCreateError,
      onCreating: setCreating,
      onCreated: (company) => {
        setSelectedCompanyId(company.id);
        setSelectedName(company.name);
        setSelectedOwner(null);
        setShowInlineForm(false);
        setNewName("");
        setNewCategory("");
        setOpen(false);
        onChange(company.id);
      },
    });
  };

  const handleInlineCreateKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    if (!creating) {
      void handleCreateSubmit();
    }
  };

  return (
    <div className="relative" ref={containerRef}>
      {/* Trigger button */}
      <Button
        type="button"
        variant="outline"
        className="w-full justify-between font-normal"
        onClick={() => {
          setOpen((prev) => !prev);
          setShowInlineForm(false);
        }}
      >
        <span className={selectedName ? "flex min-w-0 items-center gap-2 text-foreground" : "text-muted-foreground"}>
          <span className="truncate">{selectedName ?? (required ? "Select company *" : "Select company")}</span>
          {showOwnerLabel && selectedName ? (
            <OwnerLabel
              ownerId={selectedOwner?.ownerUserId ?? null}
              ownerName={selectedOwner?.ownerUserName ?? null}
              className="max-w-[10rem] shrink-0"
            />
          ) : null}
        </span>
        <ChevronsUpDown className="h-4 w-4 opacity-50" />
      </Button>

      {/* Dropdown */}
      {open && !showInlineForm && (
        <div className="absolute z-50 mt-1 w-full bg-background border rounded-md shadow-md">
          <div className="p-2 border-b">
            <Input
              autoFocus
              placeholder="Search companies..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <div className="max-h-52 overflow-y-auto">
            {searching && (
              <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Searching...
              </div>
            )}
            {!searching && results.length === 0 && query.length > 0 && (
              <p className="px-3 py-2 text-sm text-muted-foreground">No companies found.</p>
            )}
            {!searching && results.map((company) => (
              <button
                key={company.id}
                type="button"
                className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors"
                onClick={() => handleSelect(company)}
              >
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="font-medium">{company.name}</span>
                  {company.category && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {COMPANY_CATEGORY_LABELS[company.category] ?? company.category}
                    </span>
                  )}
                  {showOwnerLabel ? (
                    <OwnerLabel ownerId={company.ownerUserId} ownerName={company.ownerUserName} className="max-w-[12rem]" />
                  ) : null}
                </span>
              </button>
            ))}
          </div>
          <div className="border-t">
            <button
              type="button"
              className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-muted transition-colors text-brand-red font-medium"
              onClick={() => {
                setShowInlineForm(true);
                setNewName(query);
              }}
            >
              <Plus className="h-4 w-4" />
              Add New Company
            </button>
          </div>
        </div>
      )}

      {/* Inline create form */}
      {open && showInlineForm && (
        <div className="absolute z-50 mt-1 w-full bg-background border rounded-md shadow-md p-3 space-y-3">
          <p className="text-sm font-medium">New Company</p>
          {createError && (
            <p className="text-xs text-red-600">{createError}</p>
          )}
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Name *</Label>
              <Input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={handleInlineCreateKeyDown}
                className="h-8 text-sm"
                required
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Category</Label>
              <Select
                value={newCategory || "none"}
                onValueChange={(v) => setNewCategory(v != null && v !== "none" ? v : "")}
              >
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {Object.entries(COMPANY_CATEGORY_LABELS).map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2 justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowInlineForm(false)}
              >
                Back
              </Button>
              <Button type="button" size="sm" disabled={creating} onClick={() => void handleCreateSubmit()}>
                {creating && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                Create
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
