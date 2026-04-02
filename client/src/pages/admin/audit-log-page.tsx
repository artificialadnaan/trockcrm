import { useState } from "react";
import { useAuditLog } from "@/hooks/use-audit-log";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export function AuditLogPage() {
  const [tableName, setTableName] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const { entries, loading, refetch } = useAuditLog({ tableName, dateFrom, dateTo });

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold">Audit Log</h2>
      <div className="flex gap-3 flex-wrap">
        <Input placeholder="Filter by table" value={tableName} onChange={e => setTableName(e.target.value)} className="w-48" />
        <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="w-40" />
        <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="w-40" />
        <Button onClick={refetch}>Search</Button>
      </div>
      {loading ? <p className="text-muted-foreground">Loading...</p> : entries.length === 0 ? <p className="text-muted-foreground">No audit entries found.</p> : (
        <div className="space-y-2">
          {entries.map((e: any) => (
            <Card key={e.id}>
              <CardContent className="p-3 flex items-center justify-between">
                <div>
                  <Badge variant="secondary">{e.action}</Badge>
                  <span className="ml-2 font-medium">{e.tableName}</span>
                  <span className="ml-2 text-sm text-muted-foreground">{e.recordId}</span>
                </div>
                <div className="text-sm text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
