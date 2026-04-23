import { Link } from "react-router-dom";
import type { InterventionAnalyticsHotspotRow } from "@/hooks/use-ai-ops";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function formatPercent(value: number | null) {
  if (value == null || Number.isNaN(value)) return "N/A";
  return `${Math.round(value * 100)}%`;
}

interface HotspotTableProps {
  title: string;
  description: string;
  rows: InterventionAnalyticsHotspotRow[];
}

function HotspotTable({ title, description, rows }: HotspotTableProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead className="text-right">Open</TableHead>
              <TableHead className="text-right">Overdue</TableHead>
              <TableHead className="text-right">Repeat</TableHead>
              <TableHead className="text-right">Clearance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                  No hotspots in this dimension.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={`${row.entityType}:${row.key}`}>
                  <TableCell>
                    {row.queueLink ? (
                      <Link to={row.queueLink} className="font-medium text-brand-red hover:underline">
                        {row.label}
                      </Link>
                    ) : (
                      <span className="font-medium">{row.label}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{row.openCases}</TableCell>
                  <TableCell className="text-right">{row.overdueCases}</TableCell>
                  <TableCell className="text-right">{row.repeatOpenCases}</TableCell>
                  <TableCell className="text-right">
                    <Badge variant="outline">{formatPercent(row.clearanceRate30d)}</Badge>
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

interface InterventionAnalyticsHotspotsProps {
  hotspots: {
    assignees: InterventionAnalyticsHotspotRow[];
    disconnectTypes: InterventionAnalyticsHotspotRow[];
    reps: InterventionAnalyticsHotspotRow[];
    companies: InterventionAnalyticsHotspotRow[];
    stages: InterventionAnalyticsHotspotRow[];
  };
}

export function InterventionAnalyticsHotspots({ hotspots }: InterventionAnalyticsHotspotsProps) {
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      <HotspotTable
        title="Hotspots By Assignee"
        description="Managers can drill directly into the queue for overloaded or overdue owners."
        rows={hotspots.assignees}
      />
      <HotspotTable
        title="Hotspots By Disconnect Type"
        description="See which operational breakdowns generate the most intervention load."
        rows={hotspots.disconnectTypes}
      />
      <HotspotTable
        title="Hotspots By Rep"
        description="Identify sales-side follow-through patterns driving manager intervention."
        rows={hotspots.reps}
      />
      <HotspotTable
        title="Hotspots By Company"
        description="Spot customers and accounts with repeat intervention friction."
        rows={hotspots.companies}
      />
      <div className="xl:col-span-2">
        <HotspotTable
          title="Hotspots By Stage"
          description="Understand where in the pipeline intervention pressure is accumulating."
          rows={hotspots.stages}
        />
      </div>
    </div>
  );
}
