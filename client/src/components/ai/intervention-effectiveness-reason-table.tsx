import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type PerformanceRow = {
  key: string;
  label: string;
  volume: number;
  reopenRate: number | null;
  durableCloseRate: number | null;
  medianDaysToReopen: number | null;
  averageDaysToDurableClose: number | null;
  queueLink: string;
};

function formatPercent(value: number | null) {
  if (value === null) return "n/a";
  return `${Math.round(value * 100)}%`;
}

function formatDays(value: number | null) {
  if (value === null) return "n/a";
  return `${value}d`;
}

export function InterventionEffectivenessReasonTable(props: {
  title: string;
  rows: PerformanceRow[];
}) {
  return (
    <Card className="border-border/80 bg-white shadow-sm">
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
      </CardHeader>
      <CardContent>
        {props.rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
            No rows yet.
          </div>
        ) : (
          <div className="space-y-3">
            {props.rows.map((row) => (
              <Link
                key={row.key}
                to={row.queueLink}
                className="block rounded-lg border border-border/70 px-4 py-3 transition-colors hover:border-brand-red/40 hover:bg-muted/20"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium text-gray-900">{row.label}</div>
                    <div className="mt-1 text-xs uppercase tracking-widest text-muted-foreground">
                      {row.volume} conclusions
                    </div>
                  </div>
                  <span className="rounded-full border border-border bg-white px-2 py-1 text-[10px] font-semibold text-gray-700">
                    Open queue
                  </span>
                </div>
                <div className="mt-3 grid gap-3 text-sm md:grid-cols-4">
                  <div>
                    <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Durable close rate</div>
                    <div className="mt-1 font-semibold text-gray-900">{formatPercent(row.durableCloseRate)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Reopen rate</div>
                    <div className="mt-1 font-semibold text-gray-900">{formatPercent(row.reopenRate)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Median days to reopen</div>
                    <div className="mt-1 font-semibold text-gray-900">{formatDays(row.medianDaysToReopen)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Average days to durable closure</div>
                    <div className="mt-1 font-semibold text-gray-900">{formatDays(row.averageDaysToDurableClose)}</div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
