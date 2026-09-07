import { useState } from "react";
import { Link } from "react-router-dom";
import { useServiceRfpReport } from "@/hooks/use-reports";
import { useReportFilters } from "@/components/reports/report-filter-bar";
import { useDealHref } from "@/hooks/use-office-scope";
import { Button } from "@/components/ui/button";
import { DataTable, KpiCard, KpiStrip, Panel, ReportShell, sheetsFromReport, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./sales-report-ui";

export function ServiceRfpPage() {
  const { query } = useReportFilters({ dateTimezone: "America/Chicago" });
  const { data, loading, error, refetch } = useServiceRfpReport(query);
  const dealHref = useDealHref();
  const [showMissing, setShowMissing] = useState(false);
  const [page, setPage] = useState(0);
  const evidence = (showMissing ? data?.missingEvidence : data?.deals) ?? [];
  const currentPage = Math.min(page, Math.max(0, Math.ceil(evidence.length / 50) - 1));
  return (
    <ReportShell eyebrow="Sales Reports" title="Service RFPs by Sales Rep"
      description="Service opportunities supplied to estimating, counted once per deal at the first recorded RFP submission."
      loading={loading} error={error} hasData={Boolean(data)} emptyText="No service opportunities found."
      filterBarProps={{ showOffice: false, dateTimezone: "America/Chicago", ownerLabel: "Attributed sales rep" }}
      onRefresh={() => void refetch()} exportFilename="service-rfp-contributions"
      exportSheets={sheetsFromReport("Service RFPs", data ? { ...data, reps: data.reps.map(({ weekly, ...rep }) => ({ ...rep, ...weekly })) } : null)}>
      {data && <div className="space-y-6">
        <p role="note" className="text-sm text-muted-foreground">
          Totals cover {data.dateFrom} through {data.dateTo}. Weeks start Monday in America/Chicago; first and last weeks may be partial.
          New submissions retain the assigned salesperson at submission, independent of later reassignment or retries.
          Historical rows use the earliest retained RFP evidence and current owner (or owner when captured); earlier submissions and original attribution may be unavailable.
          Deleted or inactive salespeople remain represented when they have evidence.
        </p>
        <KpiStrip>
          <KpiCard label="Service RFPs supplied" value={String(data.total)} helper="Distinct deals in selected range" />
          <KpiCard label="Historical evidence" value={String(data.historicalCount)} helper="Included; attribution not proven at submission" />
          <KpiCard label="Without RFP evidence" value={String(data.missingEvidenceCount)} helper="All dates; excluded from totals. May never have been submitted." />
        </KpiStrip>
        <Panel title="Weekly contributions" description="Includes eligible sales reps with zero submissions and historical contributors outside the active roster.">
          <div className="overflow-x-auto">
            <DataTable>
              <TableHeader><TableRow><TableHead>Sales rep</TableHead><TableHead>Total</TableHead>{data.weeks.map((week) => <TableHead key={week} className="whitespace-nowrap">{week}</TableHead>)}</TableRow></TableHeader>
              <TableBody>{data.reps.map((rep) => <TableRow key={rep.repId ?? "unattributed"}>
                <TableCell>{rep.repName}</TableCell><TableCell>{rep.total}</TableCell>
                {data.weeks.map((week) => <TableCell key={week}>{rep.weekly[week] ?? 0}</TableCell>)}
              </TableRow>)}</TableBody>
            </DataTable>
          </div>
        </Panel>
        <Panel title="Contribution evidence" description="The records behind the count. RFP delivery retries do not create additional contributions.">
          <div className="mb-4 flex gap-2">
            <Button variant={showMissing ? "outline" : "default"} onClick={() => { setShowMissing(false); setPage(0); }}>Submitted RFPs ({data.total})</Button>
            <Button variant={showMissing ? "default" : "outline"} onClick={() => { setShowMissing(true); setPage(0); }}>Without evidence ({data.missingEvidenceCount})</Button>
          </div>
          <DataTable>
            <TableHeader><TableRow><TableHead>Opportunity</TableHead><TableHead>Sales rep</TableHead><TableHead>Week of</TableHead><TableHead>Evidence</TableHead></TableRow></TableHeader>
            <TableBody>{evidence.slice(currentPage * 50, (currentPage + 1) * 50).map((deal) => <TableRow key={deal.dealId}>
              <TableCell>{deal.isActive === false ? <span>{deal.dealName} (archived)</span> : <Link className="text-brand-red underline" to={dealHref(deal.dealId)}>{deal.dealName}</Link>}</TableCell>
              <TableCell>{deal.repName}</TableCell><TableCell>{deal.week ?? "—"}</TableCell>
              <TableCell>{deal.basis === "first_submission" ? "First submission; captured rep" : deal.basis === "historical" ? "Retained history; owner attribution" : "No retained submission"}</TableCell>
            </TableRow>)}</TableBody>
          </DataTable>
          {evidence.length === 0 && <p className="py-4 text-sm text-muted-foreground">No matching records.</p>}
          {evidence.length > 50 && <div className="mt-4 flex items-center gap-3">
            <Button variant="outline" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</Button>
            <span>Page {currentPage + 1} of {Math.ceil(evidence.length / 50)}</span>
            <Button variant="outline" disabled={(currentPage + 1) * 50 >= evidence.length} onClick={() => setPage(currentPage + 1)}>Next</Button>
          </div>}
        </Panel>
      </div>}
    </ReportShell>
  );
}
