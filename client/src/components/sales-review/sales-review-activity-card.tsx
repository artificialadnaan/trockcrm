import type { SalesReviewActivityCadenceRow } from "@/hooks/use-sales-review";
import { Card, CardContent } from "@/components/ui/card";

export function SalesReviewActivityCard({ rows }: { rows: SalesReviewActivityCadenceRow[] }) {
  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div>
          <p className="text-sm font-medium">Activity Cadence</p>
          <p className="text-xs text-muted-foreground">Trailing 7/14/30 day selling motion by rep.</p>
        </div>
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.repId} className="rounded-md border p-3">
              <div className="font-medium">{row.repName}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Calls {row.calls7d}/{row.calls14d}/{row.calls30d} • Emails {row.emails7d}/{row.emails14d}/{row.emails30d} • Meetings {row.meetings7d}/{row.meetings14d}/{row.meetings30d}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                Lunches {row.lunches7d}/{row.lunches14d}/{row.lunches30d} • Site Visits {row.siteVisits7d}/{row.siteVisits14d}/{row.siteVisits30d} • Proposals {row.proposalsSent7d}/{row.proposalsSent14d}/{row.proposalsSent30d}
              </div>
            </div>
          ))}
          {rows.length === 0 ? <p className="text-sm text-muted-foreground">No activity cadence data in the selected window.</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}
