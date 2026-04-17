import { Link } from "react-router-dom";

import type { InterventionAnalyticsDashboard, InterventionAnalyticsHotspotRow } from "@/hooks/use-ai-ops";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function HotspotTable(props: {
  title: string;
  description: string;
  rows: InterventionAnalyticsHotspotRow[];
}) {
  return (
    <Card className="bg-white">
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
        <CardDescription>{props.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{props.title}</TableHead>
              <TableHead className="text-right">Open</TableHead>
              <TableHead className="text-right">Overdue</TableHead>
              <TableHead className="text-right">Repeat</TableHead>
              <TableHead className="text-right">Queue</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-sm text-slate-400">
                  No hotspot rows are active for this dimension.
                </TableCell>
              </TableRow>
            ) : (
              props.rows.map((row) => (
                <TableRow key={`${row.entityType}-${row.key}`}>
                  <TableCell className="font-medium text-slate-900">{row.label}</TableCell>
                  <TableCell className="text-right">{row.openCases}</TableCell>
                  <TableCell className="text-right">{row.overdueCases}</TableCell>
                  <TableCell className="text-right">{row.repeatOpenCases}</TableCell>
                  <TableCell className="text-right">
                    {row.queueLink ? (
                      <Link to={row.queueLink} className="text-xs font-semibold uppercase tracking-[0.14em] text-[#CC0000]">
                        Open Queue
                      </Link>
                    ) : (
                      <span className="text-xs uppercase tracking-[0.14em] text-slate-400">N/A</span>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function InterventionAnalyticsHotspots(props: {
  hotspots: InterventionAnalyticsDashboard["hotspots"];
}) {
  const { hotspots } = props;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xl font-black tracking-tight text-slate-900">Hotspots</h2>
        <p className="mt-1 text-sm text-slate-500">
          Ranked operational concentrations by owner, issue type, and source dimension.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <HotspotTable title="Assignees" description="Owners carrying the heaviest overdue load." rows={hotspots.assignees} />
        <HotspotTable title="Disconnect Types" description="Issue patterns generating the most open work." rows={hotspots.disconnectTypes} />
        <HotspotTable title="Reps" description="Linked deal reps associated with current intervention pressure." rows={hotspots.reps} />
        <HotspotTable title="Companies" description="Customer accounts producing repeated intervention load." rows={hotspots.companies} />
        <HotspotTable title="Stages" description="Pipeline stages where cases are clustering right now." rows={hotspots.stages} />
      </div>
    </section>
  );
}
