import { useMemo, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { useReportFilters } from "@/components/reports/report-filter-bar";
import { useTableSort, SortHeaderButton, type SortColumn } from "@/components/reports/sortable";
import { useCustomerConcentrationReport, type CustomerConcentrationReport } from "@/hooks/use-reports";
import { sheetsFromReport } from "@/lib/excel-export";
import { EmptyState, formatCurrency, formatDate, formatNumber, formatPercent, KpiCard, ReportPageShell } from "./analytics-page-shared";

type TopCustomerRow = CustomerConcentrationReport["topCustomers"][number];
type StaleCustomerRow = CustomerConcentrationReport["staleCustomers"][number];

type CcColumn<Row> = SortColumn<Row> & { header: string; numeric: boolean; cell: (row: Row) => ReactNode };

const CC_HEADER_CLASS = "text-[11px] font-black uppercase tracking-[0.14em] text-slate-500";

const TOP_CUSTOMER_COLUMNS: ReadonlyArray<CcColumn<TopCustomerRow>> = [
  { key: "companyName", type: "text", accessor: (r) => r.companyName, header: "Company Name", numeric: false, cell: (r) => <span className="font-semibold text-slate-900">{r.companyName}</span> },
  { key: "activeDeals", type: "number", accessor: (r) => r.activeDeals, header: "Active Deals", numeric: true, cell: (r) => formatNumber(r.activeDeals) },
  { key: "totalOpenValue", type: "number", accessor: (r) => r.totalOpenValue, header: "Total Open Value", numeric: true, cell: (r) => formatCurrency(r.totalOpenValue) },
  { key: "totalWonLifetime", type: "number", accessor: (r) => r.totalWonLifetime, header: "Total Won", numeric: true, cell: (r) => formatCurrency(r.totalWonLifetime) },
  { key: "lastActivityAt", type: "date", accessor: (r) => r.lastActivityAt, header: "Last Activity", numeric: false, cell: (r) => formatDate(r.lastActivityAt) },
  { key: "accountOwners", type: "text", accessor: (r) => r.accountOwners, header: "Owners", numeric: false, cell: (r) => r.accountOwners },
];

const STALE_CUSTOMER_COLUMNS: ReadonlyArray<CcColumn<StaleCustomerRow>> = [
  { key: "companyName", type: "text", accessor: (r) => r.companyName, header: "Company", numeric: false, cell: (r) => <span className="font-semibold text-slate-900">{r.companyName}</span> },
  { key: "ownerName", type: "text", accessor: (r) => r.ownerName, header: "Owner", numeric: false, cell: (r) => r.ownerName },
  { key: "openDeals", type: "number", accessor: (r) => r.openDeals, header: "Open Deals", numeric: true, cell: (r) => formatNumber(r.openDeals) },
  { key: "openValue", type: "number", accessor: (r) => r.openValue, header: "Open Value", numeric: true, cell: (r) => formatCurrency(r.openValue) },
  { key: "daysStale", type: "number", accessor: (r) => r.daysStale, header: "Days Stale", numeric: true, cell: (r) => formatNumber(r.daysStale) },
];

function CcSortHead<Row>({
  columns,
  toggle,
  getHeaderProps,
}: {
  columns: ReadonlyArray<CcColumn<Row>>;
  toggle: (key: string) => void;
  getHeaderProps: (key: string) => { active: boolean; dir: "asc" | "desc" | null };
}) {
  return (
    <thead className={`text-left ${CC_HEADER_CLASS}`}>
      <tr>
        {columns.map((col) => {
          const hp = getHeaderProps(col.key);
          return (
            <th key={col.key} className={col.numeric ? "py-2 text-right" : "py-2"}>
              <SortHeaderButton
                label={col.header}
                numeric={col.numeric}
                active={hp.active}
                dir={hp.dir}
                onClick={() => toggle(col.key)}
                className={CC_HEADER_CLASS}
              />
            </th>
          );
        })}
      </tr>
    </thead>
  );
}

function TopCustomersTable({ rows }: { rows: TopCustomerRow[] }) {
  // Pin the concentration flag to the DATA: the first three companies in the server-ranked array
  // are the most-concentrated. Membership-by-id, so the red flag marks the same three accounts no
  // matter how the user re-sorts the table.
  const concentratedIds = useMemo(() => new Set(rows.slice(0, 3).map((r) => r.companyId)), [rows]);
  const { sortedRows, toggle, getHeaderProps } = useTableSort(rows, TOP_CUSTOMER_COLUMNS);
  return (
    <table className="mt-4 w-full min-w-[860px] text-sm">
      <CcSortHead columns={TOP_CUSTOMER_COLUMNS} toggle={toggle} getHeaderProps={getHeaderProps} />
      <tbody className="divide-y divide-slate-100">
        {sortedRows.map((row) => (
          <tr key={row.companyId} className={concentratedIds.has(row.companyId) ? "bg-red-50/60" : undefined}>
            {TOP_CUSTOMER_COLUMNS.map((col) => (
              <td key={col.key} className={col.numeric ? "py-3 text-right tabular-nums" : "py-3"}>
                {col.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StaleCustomersTable({ rows }: { rows: StaleCustomerRow[] }) {
  const { sortedRows, toggle, getHeaderProps } = useTableSort(rows, STALE_CUSTOMER_COLUMNS);
  return (
    <table className="mt-4 w-full min-w-[720px] text-sm">
      <CcSortHead columns={STALE_CUSTOMER_COLUMNS} toggle={toggle} getHeaderProps={getHeaderProps} />
      <tbody className="divide-y divide-slate-100">
        {sortedRows.map((row) => (
          <tr key={`${row.companyName}-${row.ownerName}`}>
            {STALE_CUSTOMER_COLUMNS.map((col) => (
              <td key={col.key} className={col.numeric ? "py-3 text-right tabular-nums" : "py-3"}>
                {col.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CustomerConcentrationPage() {
  const { query } = useReportFilters({ defaultRange: "12m" });
  const { data, loading, error, refetch } = useCustomerConcentrationReport(query);
  const report = data;

  return (
    <ReportPageShell
      title="Customer Concentration"
      description="Revenue and opportunity exposure by account, including concentration risk and stale open customers."
      loading={loading}
      error={error}
      onRefresh={() => void refetch()}
      exportFilename="customer-concentration-report"
      exportSheets={sheetsFromReport("Customer Concentration", report)}
    >
      {report ? (
        <div className="space-y-6">
          <section className="grid gap-4 md:grid-cols-4">
            <KpiCard label="Active customers" value={formatNumber(report.kpis.totalActiveCustomers)} />
            <KpiCard label="Total open value" value={formatCurrency(report.kpis.totalOpenValue)} />
            <KpiCard label="Top customer share" value={formatPercent(report.kpis.topCustomerPipelinePercent)} />
            <KpiCard label="Customers above $1M" value={formatNumber(report.kpis.customersOverOneMillionOpen)} />
          </section>
          <p className="text-xs font-semibold text-slate-500">{report.scopeNote}</p>

          <Card>
            <CardContent className="overflow-x-auto p-5">
              <h2 className="text-sm font-black uppercase tracking-[0.16em] text-slate-900">Top 20 Customers</h2>
              <TopCustomersTable rows={report.topCustomers} />
              {report.topCustomers.length === 0 ? <EmptyState label="No active customer exposure for this range." /> : null}
            </CardContent>
          </Card>

          <section className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardContent className="p-5">
                <h2 className="text-sm font-black uppercase tracking-[0.16em] text-slate-900">Pareto Concentration</h2>
                {report.pareto.length ? (
                  <div className="mt-4 h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={report.pareto}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="rank" />
                        <YAxis tickFormatter={(value) => `${value}%`} />
                        <Tooltip formatter={(value) => formatPercent(Number(value))} />
                        <Line type="monotone" dataKey="cumulativePipelinePercent" name="Cumulative pipeline %" stroke="#cc0000" strokeWidth={2} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                ) : <EmptyState label="No concentration chart data." />}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-5">
                <h2 className="text-sm font-black uppercase tracking-[0.16em] text-slate-900">Revenue Distribution</h2>
                {report.distribution.length ? (
                  <div className="mt-4 h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={report.distribution}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="bucket" />
                        <YAxis allowDecimals={false} />
                        <Tooltip formatter={(value) => formatNumber(Number(value))} />
                        <Bar dataKey="customerCount" name="Customers" fill="#111827" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : <EmptyState label="No distribution data." />}
              </CardContent>
            </Card>
          </section>

          <Card>
            <CardContent className="overflow-x-auto p-5">
              <h2 className="text-sm font-black uppercase tracking-[0.16em] text-slate-900">Stale Customers</h2>
              <StaleCustomersTable rows={report.staleCustomers} />
            </CardContent>
          </Card>
        </div>
      ) : <EmptyState label="No customer concentration data for this range." />}
    </ReportPageShell>
  );
}
