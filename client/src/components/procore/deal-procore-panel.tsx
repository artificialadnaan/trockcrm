// client/src/components/procore/deal-procore-panel.tsx
// Deal detail Procore tab — shows sync state, project link, and change orders.

import { useEffect, useState } from "react";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

interface DealProcorePanelProps {
  dealId: string;
  procoreProjectId: number | null;
  procoreLastSyncedAt: string | null;
  changeOrderTotal: string | null;
}

interface SyncStateInfo {
  sync_status: "synced" | "pending" | "conflict" | "error";
  last_synced_at: string | null;
  error_message: string | null;
}

interface ChangeOrder {
  id: string;
  co_number: number;
  title: string;
  amount: string;
  status: "pending" | "approved" | "rejected";
  procore_co_id: number | null;
}

export function DealProcorePanel({
  dealId,
  procoreProjectId,
  procoreLastSyncedAt,
  changeOrderTotal,
}: DealProcorePanelProps) {
  const [syncState, setSyncState] = useState<SyncStateInfo | null>(null);
  const [changeOrders, setChangeOrders] = useState<ChangeOrder[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [syncRes, coRes] = await Promise.all([
          fetch(`/api/procore/deals/${dealId}/sync-state`, { credentials: "include" }),
          fetch(`/api/deals/${dealId}/change-orders`, { credentials: "include" }),
        ]);
        if (syncRes.ok) setSyncState(await syncRes.json());
        if (coRes.ok) {
          const data = await coRes.json();
          setChangeOrders(data.changeOrders ?? []);
        }
      } catch {
        // Non-blocking — Procore panel failure should not break the deal detail page
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [dealId]);

  const statusVariant: Record<string, string> = {
    synced: "default",
    pending: "secondary",
    conflict: "destructive",
    error: "destructive",
  };

  const procoreUrl = procoreProjectId
    ? `https://app.procore.com/projects/${procoreProjectId}`
    : null;

  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Procore Link</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {procoreProjectId ? (
            <>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Project ID:</span>
                <span className="font-mono text-sm">{procoreProjectId}</span>
                <a
                  href={procoreUrl ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-600 underline hover:text-blue-800"
                >
                  Open in Procore
                </a>
              </div>
              {syncState && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Sync status:</span>
                  <Badge
                    variant={statusVariant[syncState.sync_status] as any}
                    className="capitalize"
                  >
                    {syncState.sync_status}
                  </Badge>
                  {syncState.error_message && (
                    <span className="text-xs text-destructive">{syncState.error_message}</span>
                  )}
                </div>
              )}
              {procoreLastSyncedAt && (
                <p className="text-xs text-muted-foreground">
                  Last synced: {new Date(procoreLastSyncedAt).toLocaleString()}
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No Procore project linked. A project will be created automatically when this
              deal is marked as Closed Won.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Change orders */}
      {changeOrders.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              Change Orders
              {changeOrderTotal != null && Number(changeOrderTotal) !== 0 && (
                <span className="ml-2 text-base font-bold">
                  Total: ${Number(changeOrderTotal).toLocaleString()}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-1 text-left font-medium text-muted-foreground">CO #</th>
                  <th className="py-1 text-left font-medium text-muted-foreground">Title</th>
                  <th className="py-1 text-right font-medium text-muted-foreground">Amount</th>
                  <th className="py-1 text-left font-medium text-muted-foreground">Status</th>
                </tr>
              </thead>
              <tbody>
                {changeOrders.map((co) => (
                  <tr key={co.id} className="border-b last:border-0">
                    <td className="py-2 font-mono">{co.co_number}</td>
                    <td className="py-2">{co.title}</td>
                    <td className="py-2 text-right">
                      ${Number(co.amount).toLocaleString()}
                    </td>
                    <td className="py-2">
                      <Badge
                        variant={
                          co.status === "approved"
                            ? "default"
                            : co.status === "rejected"
                            ? "destructive"
                            : "secondary"
                        }
                        className="capitalize"
                      >
                        {co.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {loading && (
        <p className="text-xs text-muted-foreground">Loading Procore data...</p>
      )}
    </div>
  );
}
