import { Link } from "react-router-dom";
import { Activity, BadgeAlert, CheckCircle2, RefreshCcw, ShieldAlert, Users } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAdminDataScrub } from "@/hooks/use-admin-data-scrub";

function formatDate(value: string | null) {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return date.toLocaleString();
}

function SummaryCard({
  title,
  value,
  description,
  icon,
  tone,
}: {
  title: string;
  value: number;
  description: string;
  icon: React.ReactNode;
  tone: "red" | "green" | "amber" | "slate";
}) {
  const toneStyles: Record<"red" | "green" | "amber" | "slate", string> = {
    red: "border-red-200 bg-red-50 text-red-700",
    green: "border-emerald-200 bg-emerald-50 text-emerald-700",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    slate: "border-slate-200 bg-white text-slate-700",
  };

  return (
    <Card className={`shadow-sm ${toneStyles[tone]}`}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          {icon}
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-4xl font-black text-slate-900">{value.toLocaleString()}</div>
      </CardContent>
    </Card>
  );
}

export function AdminDataScrubPage() {
  const { data, loading, error, refetch } = useAdminDataScrub();

  return (
    <div className="p-6 space-y-6 bg-gray-50 min-h-screen">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black tracking-tighter uppercase text-gray-900">
            Admin Data Scrub
          </h1>
          <p className="text-[11px] uppercase tracking-widest text-gray-400 mt-1">
            Cleanup backlog, ownership gaps, and recent admin corrections
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/admin/audit" className={buttonVariants({ variant: "outline" })}>
            Audit Log
          </Link>
          <Link to="/admin/merge-queue" className={buttonVariants({ variant: "outline" })}>
            Merge Queue
          </Link>
          <Button variant="outline" onClick={() => void refetch()} disabled={loading}>
            <RefreshCcw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <SummaryCard
          title="Open Duplicate Contacts"
          value={data?.summary.openDuplicateContacts ?? 0}
          description="Contacts still waiting on merge resolution"
          icon={<BadgeAlert className="h-4 w-4" />}
          tone="red"
        />
        <SummaryCard
          title="Resolved Duplicates (7d)"
          value={data?.summary.resolvedDuplicateContacts7d ?? 0}
          description="Recent duplicate cleanup completions"
          icon={<CheckCircle2 className="h-4 w-4" />}
          tone="green"
        />
        <SummaryCard
          title="Open Ownership Gaps"
          value={data?.summary.openOwnershipGaps ?? 0}
          description="Records missing clear ownership"
          icon={<ShieldAlert className="h-4 w-4" />}
          tone="amber"
        />
        <SummaryCard
          title="Scrub Actions (7d)"
          value={data?.summary.recentScrubActions7d ?? 0}
          description="Recent admin cleanup activity"
          icon={<Activity className="h-4 w-4" />}
          tone="slate"
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Backlog Buckets</CardTitle>
            <CardDescription>Queue slices that can be opened directly from the scrub view</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Bucket</TableHead>
                    <TableHead className="text-right">Count</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data?.backlogBuckets ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                        {loading ? "Loading backlog buckets..." : "No backlog buckets found."}
                      </TableCell>
                    </TableRow>
                  ) : (
                    (data?.backlogBuckets ?? []).map((bucket) => (
                      <TableRow key={bucket.bucketKey}>
                        <TableCell>
                          <div className="space-y-1">
                            <div className="font-medium">{bucket.label}</div>
                            <div className="text-xs text-muted-foreground">{bucket.bucketKey}</div>
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-medium">{bucket.count.toLocaleString()}</TableCell>
                        <TableCell className="text-right">
                          <Link to={bucket.linkPath} className={buttonVariants({ variant: "outline", size: "sm" })}>
                            Open
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Ownership Coverage</CardTitle>
            <CardDescription>Where records still lack a clean owner or assignment signal</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Gap</TableHead>
                    <TableHead className="text-right">Count</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data?.ownershipCoverage ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={2} className="py-8 text-center text-muted-foreground">
                        {loading ? "Loading ownership coverage..." : "No ownership gaps found."}
                      </TableCell>
                    </TableRow>
                  ) : (
                    (data?.ownershipCoverage ?? []).map((gap) => (
                      <TableRow key={gap.gapKey}>
                        <TableCell>
                          <div className="space-y-1">
                            <div className="font-medium">{gap.label}</div>
                            <div className="text-xs text-muted-foreground">{gap.gapKey}</div>
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-medium">{gap.count.toLocaleString()}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            Scrub Activity by User
          </CardTitle>
          <CardDescription>Who cleaned what, and when they last touched the queue</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                  <TableHead className="text-right">Ownership Edits</TableHead>
                  <TableHead>Last Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.scrubActivityByUser ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                      {loading ? "Loading scrub activity..." : "No scrub activity yet."}
                    </TableCell>
                  </TableRow>
                ) : (
                  (data?.scrubActivityByUser ?? []).map((row, index) => (
                    <TableRow key={row.userId ?? `anonymous-${row.userName}-${index}`}>
                      <TableCell>
                        <div className="space-y-1">
                          <div className="font-medium">{row.userName}</div>
                          {row.userId && (
                            <div className="text-xs text-muted-foreground">{row.userId}</div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-medium">{row.actionCount.toLocaleString()}</TableCell>
                      <TableCell className="text-right font-medium">{row.ownershipEditCount.toLocaleString()}</TableCell>
                      <TableCell>{formatDate(row.lastActionAt)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
