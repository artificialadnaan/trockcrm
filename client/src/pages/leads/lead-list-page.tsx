import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LeadKanbanBoard } from "@/components/leads/lead-kanban-board";
import { useLeads } from "@/hooks/use-leads";
import { usePipelineStages } from "@/hooks/use-pipeline-config";

export function LeadListPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const { leads, loading, error } = useLeads();
  const { stages } = usePipelineStages();
  const leadStages = useMemo(
    () =>
      stages
        .filter((stage) => stage.workflowFamily === "lead")
        .sort((a, b) => a.displayOrder - b.displayOrder),
    [stages]
  );

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return leads;
    return leads.filter((lead) => {
      const haystack = [
        lead.name,
        lead.companyName,
        lead.source,
        lead.property?.name,
        lead.property?.address,
        lead.property?.city,
        lead.property?.state,
        lead.property?.zip,
        lead.convertedDealNumber,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [leads, search]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Building2 className="h-4 w-4 text-brand-red" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-brand-red">
              Lead Pipeline
            </span>
          </div>
          <h1 className="text-3xl font-black tracking-tight text-foreground">Leads</h1>
          <p className="text-sm text-muted-foreground">
            {filtered.length} pre-RFP lead{filtered.length !== 1 ? "s" : ""}
          </p>
        </div>
        <Button onClick={() => navigate("/deals/new")}>
          <Plus className="h-4 w-4 mr-2" />
          New Lead
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
            placeholder="Search leads, companies, or properties..."
            className="pl-9"
          />
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="h-20 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed p-12 text-center text-muted-foreground">
          <Building2 className="mx-auto mb-3 h-10 w-10 opacity-30" />
          <p className="text-lg font-medium">No leads found</p>
          <p className="text-sm mt-1">Try a different search or start a new lead.</p>
        </div>
      ) : (
        <LeadKanbanBoard
          leads={filtered}
          stages={leadStages}
          onOpenLead={(leadId) => navigate(`/leads/${leadId}`)}
        />
      )}
    </div>
  );
}
