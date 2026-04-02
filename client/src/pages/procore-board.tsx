// client/src/pages/procore-board.tsx
// Personal project board — rep's active deals linked to Procore projects.

import { useEffect, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

interface ProjectBoardDeal {
  id: string;
  deal_number: string;
  name: string;
  procore_project_id: number;
  procore_last_synced_at: string | null;
  change_order_total: string;
  stage_name: string;
  stage_color: string;
}

export function ProcoreBoardPage() {
  const [deals, setDeals] = useState<ProjectBoardDeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/procore/my-projects", { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => setDeals(data.deals ?? []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading)
    return (
      <div className="p-6 text-sm text-muted-foreground">Loading your Procore projects...</div>
    );
  if (error)
    return <div className="p-6 text-sm text-destructive">Error: {error}</div>;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">My Procore Projects</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Active deals linked to Procore projects
        </p>
      </div>

      {deals.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No deals are currently linked to Procore projects.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {deals.map((deal) => (
            <Card key={deal.id}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base font-semibold leading-tight">
                    {deal.name}
                  </CardTitle>
                  <Badge
                    style={{ backgroundColor: deal.stage_color ?? undefined }}
                    className="shrink-0 text-white"
                  >
                    {deal.stage_name}
                  </Badge>
                </div>
                <p className="font-mono text-xs text-muted-foreground">{deal.deal_number}</p>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Procore Project</span>
                  <a
                    href={`https://app.procore.com/projects/${deal.procore_project_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-blue-600 underline hover:text-blue-800"
                  >
                    #{deal.procore_project_id}
                  </a>
                </div>
                {Number(deal.change_order_total) !== 0 && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">CO Total</span>
                    <span className="font-medium">
                      ${Number(deal.change_order_total).toLocaleString()}
                    </span>
                  </div>
                )}
                {deal.procore_last_synced_at && (
                  <p className="text-xs text-muted-foreground">
                    Synced: {new Date(deal.procore_last_synced_at).toLocaleString()}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
