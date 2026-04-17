import { AlertTriangle, ArrowUpRight, Clock3, ShieldAlert } from "lucide-react";
import { Link } from "react-router-dom";
import type { InterventionQueueItem } from "@/hooks/use-admin-interventions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const severityClassNames: Record<string, string> = {
  critical: "border-red-200 bg-red-50 text-red-700",
  high: "border-orange-200 bg-orange-50 text-orange-700",
  medium: "border-amber-200 bg-amber-50 text-amber-700",
  low: "border-slate-200 bg-slate-50 text-slate-700",
};

function formatAge(days: number) {
  if (days <= 0) return "Today";
  if (days === 1) return "1 day";
  return `${days} days`;
}

export function InterventionQueueTable(props: {
  items: InterventionQueueItem[];
  selectedIds: string[];
  onToggleSelected: (caseId: string, checked: boolean) => void;
  onToggleAllVisible: (checked: boolean) => void;
  onOpenDetail: (caseId: string) => void;
}) {
  const allVisibleSelected = props.items.length > 0 && props.items.every((item) => props.selectedIds.includes(item.id));

  return (
    <div className="rounded-xl border border-border/80 bg-white overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">
              <Checkbox checked={allVisibleSelected} onCheckedChange={props.onToggleAllVisible} />
            </TableHead>
            <TableHead>Disconnect case</TableHead>
            <TableHead>Owner</TableHead>
            <TableHead>Generated task</TableHead>
            <TableHead>Last intervention</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                No intervention cases match the current filter.
              </TableCell>
            </TableRow>
          ) : (
            props.items.map((item) => (
              <TableRow key={item.id}>
                <TableCell>
                  <Checkbox
                    checked={props.selectedIds.includes(item.id)}
                    onCheckedChange={(checked) => props.onToggleSelected(item.id, checked)}
                  />
                </TableCell>
                <TableCell className="align-top">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className={severityClassNames[item.severity] ?? severityClassNames.low}>
                        {item.severity}
                      </Badge>
                      <Badge variant="outline">{item.disconnectType}</Badge>
                      {item.status === "snoozed" && (
                        <Badge variant="outline" className="border-blue-200 bg-blue-50 text-blue-700">
                          <Clock3 className="h-3 w-3 mr-1" />
                          Snoozed
                        </Badge>
                      )}
                      {item.escalated && (
                        <Badge variant="outline" className="border-red-200 bg-red-50 text-red-700">
                          <ShieldAlert className="h-3 w-3 mr-1" />
                          Escalated
                        </Badge>
                      )}
                    </div>
                    <div>
                      {item.deal ? (
                        <Link to={`/deals/${item.deal.id}`} className="text-sm font-semibold text-brand-red hover:underline">
                          {item.deal.dealNumber} {item.deal.name}
                        </Link>
                      ) : (
                        <div className="text-sm font-semibold">Unlinked disconnect case</div>
                      )}
                      {item.company && (
                        <div className="text-xs text-muted-foreground mt-1">{item.company.name}</div>
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground leading-6">
                      {item.evidenceSummary ?? "No evidence summary available."}
                    </div>
                    <div className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <AlertTriangle className="h-3 w-3" />
                      Open for {formatAge(item.ageDays)}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="align-top">
                  <div className="text-sm font-medium">{item.assignedToName ?? item.assignedTo ?? "Unassigned"}</div>
                  {item.clusterKey && <div className="text-xs text-muted-foreground mt-1">{item.clusterKey}</div>}
                </TableCell>
                <TableCell className="align-top">
                  {item.generatedTask ? (
                    <div className="space-y-1">
                      <div className="text-sm font-medium">{item.generatedTask.title}</div>
                      <div className="text-xs text-muted-foreground">{item.generatedTask.status}</div>
                      <div className="text-xs text-muted-foreground">
                        {item.generatedTask.assignedToName ?? item.generatedTask.assignedTo ?? "No task assignee"}
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">No generated task</div>
                  )}
                </TableCell>
                <TableCell className="align-top">
                  {item.lastIntervention ? (
                    <div className="space-y-1">
                      <div className="text-sm font-medium">{item.lastIntervention.actionType}</div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(item.lastIntervention.actedAt).toLocaleString()}
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">No intervention yet</div>
                  )}
                </TableCell>
                <TableCell className="text-right align-top">
                  <Button variant="outline" size="sm" onClick={() => props.onOpenDetail(item.id)}>
                    Open case
                    <ArrowUpRight className="h-4 w-4 ml-2" />
                  </Button>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
