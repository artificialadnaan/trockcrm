import { Building2, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { LeadRecord } from "@/hooks/use-leads";
import type { PipelineStage } from "@/hooks/use-pipeline-config";

export function LeadKanbanBoard({
  leads,
  stages,
  onOpenLead,
}: {
  leads: LeadRecord[];
  stages: PipelineStage[];
  onOpenLead: (leadId: string) => void;
}) {
  const leadsByStage = new Map<string, LeadRecord[]>();
  for (const stage of stages) {
    leadsByStage.set(stage.id, []);
  }

  for (const lead of leads) {
    const stageLeads = leadsByStage.get(lead.stageId);
    if (stageLeads) {
      stageLeads.push(lead);
    }
  }

  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex min-w-max gap-4">
        {stages.map((stage) => {
          const stageLeads = leadsByStage.get(stage.id) ?? [];
          return (
            <section
              key={stage.id}
              className="w-[290px] shrink-0 rounded-2xl border border-slate-200 bg-slate-50/70 p-3"
            >
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">{stage.name}</h3>
                  <p className="text-xs text-slate-500">
                    {stageLeads.length} lead{stageLeads.length === 1 ? "" : "s"}
                  </p>
                </div>
                <Badge variant="outline" className="border-slate-300 bg-white text-slate-700">
                  {stage.displayOrder}
                </Badge>
              </div>

              <div className="space-y-3">
                {stageLeads.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-200 bg-white/70 px-3 py-6 text-center text-xs text-slate-400">
                    No leads in this stage
                  </div>
                ) : (
                  stageLeads.map((lead) => {
                    const showPendingBadge =
                      stage.slug === "new_lead" && lead.verificationStatus === "pending";
                    return (
                      <Card
                        key={lead.id}
                        className="cursor-pointer border-slate-200 p-3 transition-colors hover:bg-white"
                        onClick={() => onOpenLead(lead.id)}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 space-y-2">
                            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-slate-500">
                              <Building2 className="h-3.5 w-3.5" />
                              <span>{lead.companyName ?? "Unassigned"}</span>
                            </div>
                            <h4 className="line-clamp-2 text-sm font-semibold text-slate-900">
                              {lead.name}
                            </h4>
                            {showPendingBadge ? (
                              <span
                                title="Awaiting approval from assigned approver"
                                className="inline-flex items-center rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700"
                              >
                                Pending Verification
                              </span>
                            ) : null}
                          </div>
                          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                        </div>
                      </Card>
                    );
                  })
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
