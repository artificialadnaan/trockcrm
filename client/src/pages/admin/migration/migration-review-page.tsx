import { useMemo, useState } from "react";
import { CheckCircle2, XCircle, ArrowRightLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  useStagedCompanies,
  useStagedProperties,
  useStagedLeads,
  type StagedCompany,
  type StagedProperty,
  type StagedLead,
} from "@/hooks/use-migration";

type ReviewTab = "companies" | "properties" | "leads";

const TAB_LABELS: Record<ReviewTab, string> = {
  companies: "Companies",
  properties: "Properties",
  leads: "Leads",
};

const STATUS_BADGE: Record<string, string> = {
  valid: "bg-green-100 text-green-800",
  approved: "bg-blue-100 text-blue-800",
  needs_review: "bg-amber-100 text-amber-800",
  invalid: "bg-red-100 text-red-800",
  pending: "bg-gray-100 text-gray-600",
  rejected: "bg-gray-100 text-gray-500",
  promoted: "bg-emerald-100 text-emerald-800",
};

function QueueBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-xs text-gray-400">—</span>;
  return <Badge className={`text-xs ${STATUS_BADGE[value] ?? "bg-gray-100"}`}>{value.replace(/_/g, " ")}</Badge>;
}

function EntityReason({
  item,
}: {
  item: {
    exceptionBucket: string | null;
    exceptionReason: string | null;
    validationWarnings: Array<{ warning: string }>;
    validationErrors: Array<{ error: string }>;
  };
}) {
  return (
    <div className="space-y-1">
      <QueueBadge value={item.exceptionBucket} />
      {item.exceptionReason && <div className="text-xs text-gray-600">{item.exceptionReason}</div>}
      {item.validationErrors.map((error, index) => (
        <div key={index} className="text-xs text-red-700">
          {error.error}
        </div>
      ))}
      {item.validationWarnings.map((warning, index) => (
        <div key={index} className="text-xs text-amber-700">
          {warning.warning}
        </div>
      ))}
    </div>
  );
}

export function MigrationReviewPage() {
  const [tab, setTab] = useState<ReviewTab>("companies");

  const companies = useStagedCompanies("unresolved");
  const properties = useStagedProperties("unresolved");
  const leads = useStagedLeads("unresolved");

  const current = useMemo(() => {
    if (tab === "properties") return properties;
    if (tab === "leads") return leads;
    return companies;
  }, [tab, companies, properties, leads]);

  const totalPages = Math.max(1, Math.ceil(current.total / 50));
  const start = current.total === 0 ? 0 : (current.page - 1) * 50 + 1;
  const end = Math.min(current.page * 50, current.total);

  const handleReject = async (id: string) => {
    const notes = window.prompt("Reject notes (optional)");
    await current.reject(id, notes ?? undefined);
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Migration Review Queue</h1>
          <p className="text-sm text-gray-500 mt-1">
            Resolve staged companies, properties, and leads before promotion.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {(["companies", "properties", "leads"] as ReviewTab[]).map((nextTab) => (
            <Button
              key={nextTab}
              variant={tab === nextTab ? "default" : "outline"}
              size="sm"
              onClick={() => setTab(nextTab)}
            >
              {TAB_LABELS[nextTab]}
            </Button>
          ))}
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium uppercase tracking-wide text-gray-500">
            {TAB_LABELS[tab]} queue
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[260px]">Record</TableHead>
                <TableHead>Mapping</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="w-[160px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {current.loading ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-gray-400">
                    Loading...
                  </TableCell>
                </TableRow>
              ) : current.rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-gray-400">
                    No unresolved staged {tab} rows.
                  </TableCell>
                </TableRow>
              ) : (
                current.rows.map((row: StagedCompany | StagedProperty | StagedLead) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium text-gray-900">
                      {"mappedName" in row && row.mappedName ? row.mappedName : null}
                      {"mappedName" in row && !row.mappedName ? (
                        <span className="text-gray-400">Unnamed record</span>
                      ) : null}
                      {"mappedDomain" in row && row.mappedDomain ? (
                        <div className="text-xs text-gray-500">{row.mappedDomain}</div>
                      ) : null}
                      {"mappedCompanyName" in row && row.mappedCompanyName ? (
                        <div className="text-xs text-gray-500">{row.mappedCompanyName}</div>
                      ) : null}
                      {"mappedDealName" in row && row.mappedDealName ? (
                        <div className="text-xs text-gray-500">{row.mappedDealName}</div>
                      ) : null}
                      <div className="text-xs text-gray-400">{row.id.slice(0, 8)}...</div>
                    </TableCell>
                    <TableCell className="text-sm text-gray-600">
                      {"mappedOwnerEmail" in row && row.mappedOwnerEmail ? (
                        <div>{row.mappedOwnerEmail}</div>
                      ) : null}
                      {"mappedLeadHint" in row && row.mappedLeadHint ? (
                        <div>{row.mappedLeadHint}</div>
                      ) : null}
                      {"mappedAddress" in row && row.mappedAddress ? (
                        <div>
                          {row.mappedAddress}
                          {row.mappedCity || row.mappedState || row.mappedZip
                            ? `, ${[row.mappedCity, row.mappedState, row.mappedZip].filter(Boolean).join(" ")}`
                            : ""}
                        </div>
                      ) : null}
                      {"mappedPropertyName" in row && row.mappedPropertyName ? (
                        <div>{row.mappedPropertyName}</div>
                      ) : null}
                      {"candidateCompanyCount" in row ? (
                        <div className="text-xs text-gray-400">
                          {row.candidateCompanyCount} candidate companies
                        </div>
                      ) : null}
                      {"candidateDealCount" in row ? (
                        <div className="text-xs text-gray-400">
                          {row.candidateDealCount} candidate deals
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge className={`text-xs ${STATUS_BADGE[row.validationStatus] ?? "bg-gray-100"}`}>
                        {row.validationStatus.replace(/_/g, " ")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <EntityReason item={row as any} />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-green-700 hover:bg-green-50"
                          onClick={() => current.approve(row.id)}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-red-700 hover:bg-red-50"
                          onClick={() => handleReject(row.id)}
                        >
                          <XCircle className="h-3.5 w-3.5 mr-1" />
                          Reject
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-3 text-sm text-gray-500">
        <span>
          {current.total.toLocaleString()} staged {tab}
          {current.total > 0 ? ` • showing ${start.toLocaleString()}-${end.toLocaleString()}` : ""}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => current.setPage(Math.max(1, current.page - 1))}
            disabled={current.loading || current.page <= 1}
          >
            Prev
          </Button>
          <span className="text-xs text-gray-500">
            Page {current.page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => current.setPage(Math.min(totalPages, current.page + 1))}
            disabled={current.loading || current.page >= totalPages}
          >
            Next
          </Button>
          <Button variant="outline" size="sm" onClick={current.refetch} disabled={current.loading}>
            <ArrowRightLeft className="h-4 w-4 mr-1" />
            Refresh
          </Button>
        </div>
      </div>
    </div>
  );
}
