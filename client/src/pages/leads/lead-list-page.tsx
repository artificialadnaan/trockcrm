import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Building2, MapPin, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { LeadStageBadge } from "@/components/leads/lead-stage-badge";
import {
  formatLeadPropertyLine,
  getLeadBoardStageLabel,
  getLeadStageMetadata,
  LEAD_BOARD_STAGE_SLUGS,
  useLeads,
} from "@/hooks/use-leads";
import { usePipelineStages } from "@/hooks/use-pipeline-config";

export function LeadListPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const { leads, loading, error } = useLeads();
  const { stages } = usePipelineStages();

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return leads.filter((lead) => {
      const stageMeta = getLeadStageMetadata(lead.stageId, stages);
      if (!stageMeta.isBoardStage) {
        return false;
      }

      if (!query) {
        return true;
      }

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
  }, [leads, search, stages]);

  const columns = useMemo(
    () =>
      LEAD_BOARD_STAGE_SLUGS.map((slug) => ({
        slug,
        name: getLeadBoardStageLabel(slug),
        leads: filtered.filter((lead) => getLeadStageMetadata(lead.stageId, stages).slug === slug),
      })),
    [filtered, stages]
  );

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
            {filtered.length} CRM-owned pre-handoff lead{filtered.length !== 1 ? "s" : ""}
          </p>
        </div>
        <Button onClick={() => navigate("/leads/new")}>
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
        <div className="grid gap-4 xl:grid-cols-3">
          {columns.map((column) => (
            <section key={column.slug} className="space-y-3 rounded-2xl border bg-muted/20 p-3">
              <div className="flex items-start justify-between gap-3 border-b pb-3">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-muted-foreground">
                    {column.name}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {column.slug === "sales_validation_stage"
                      ? "Last CRM checkpoint before Opportunity handoff."
                      : "CRM-owned lead work."}
                  </p>
                </div>
                <span className="rounded-full border bg-background px-2 py-1 text-xs font-semibold text-muted-foreground">
                  {column.leads.length}
                </span>
              </div>

              <div className="space-y-2">
                {column.leads.length === 0 ? (
                  <div className="rounded-xl border border-dashed bg-background/70 px-4 py-8 text-center text-sm text-muted-foreground">
                    No leads in this stage
                  </div>
                ) : (
                  column.leads.map((lead) => {
                    const companyName = lead.companyName ?? "Unassigned";
                    const propertyLine = formatLeadPropertyLine(lead);

                    return (
                      <Card
                        key={lead.id}
                        className="cursor-pointer p-4 transition-colors hover:bg-background"
                        onClick={() => navigate(`/leads/${lead.id}`)}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0 flex-1 space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <LeadStageBadge stageId={lead.stageId} />
                            </div>
                            <h3 className="truncate text-lg font-semibold">{lead.name}</h3>
                            <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                              <span>{companyName}</span>
                              {propertyLine && (
                                <span className="flex items-center gap-1">
                                  <MapPin className="h-3.5 w-3.5" />
                                  {propertyLine}
                                </span>
                              )}
                            </div>
                          </div>
                          <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
                        </div>
                      </Card>
                    );
                  })
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
