// client/src/components/procore/procore-sync-status.tsx
// Admin-only Procore sync status dashboard.

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

interface SyncSummary {
  synced: number;
  conflict: number;
  error: number;
  pending: number;
}

interface SyncConflict {
  id: string;
  entity_type: string;
  procore_id: number;
  crm_entity_id: string;
  conflict_data: Record<string, unknown>;
  updated_at: string;
}

interface SyncStatus {
  summary: SyncSummary;
  conflicts: SyncConflict[];
  circuit_breaker: { state: string; failures: number; openedAt: number | null };
}

export function ProcoreSyncStatus() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/procore/sync-status", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading Procore sync status...</div>;
  if (error) return <div className="p-6 text-sm text-destructive">Error: {error}</div>;
  if (!status) return null;

  const cbState = status.circuit_breaker.state;
  const cbBadgeVariant =
    cbState === "closed" ? "default" : cbState === "half_open" ? "secondary" : "destructive";

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Procore Sync Status</h2>
        <Button variant="outline" size="sm" onClick={load}>Refresh</Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {(["synced", "pending", "conflict", "error"] as const).map((key) => (
          <Card key={key}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium capitalize text-muted-foreground">
                {key}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <span className="text-2xl font-bold">{status.summary[key]}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Circuit breaker */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">Procore API Circuit Breaker:</span>
        <Badge variant={cbBadgeVariant as any} className="capitalize">
          {cbState.replace("_", " ")}
        </Badge>
        {status.circuit_breaker.failures > 0 && (
          <span className="text-sm text-muted-foreground">
            ({status.circuit_breaker.failures} consecutive failures)
          </span>
        )}
      </div>

      {/* Conflicts table */}
      {status.conflicts.length > 0 && (
        <div>
          <h3 className="mb-3 text-base font-semibold">Conflicts Requiring Review</h3>
          <div className="rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-2 text-left font-medium">Entity</th>
                  <th className="px-4 py-2 text-left font-medium">Procore ID</th>
                  <th className="px-4 py-2 text-left font-medium">Conflict Data</th>
                  <th className="px-4 py-2 text-left font-medium">Detected</th>
                  <th className="px-4 py-2 text-left font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {status.conflicts.map((c, i) => (
                  <tr
                    key={c.id}
                    className={i % 2 === 0 ? "bg-background" : "bg-muted/30"}
                  >
                    <td className="px-4 py-2 capitalize">{c.entity_type}</td>
                    <td className="px-4 py-2 font-mono">{c.procore_id}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {JSON.stringify(c.conflict_data)}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {new Date(c.updated_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          await fetch(`/api/procore/sync-conflicts/${c.id}/resolve`, {
                            method: "POST",
                            credentials: "include",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ resolution: "accept_crm" }),
                          });
                          load();
                        }}
                      >
                        Accept CRM
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
