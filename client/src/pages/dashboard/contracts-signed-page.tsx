import { useMemo } from "react";
import { Link, useNavigate, useSearchParams, Navigate } from "react-router-dom";
import { ArrowLeft, FileSignature, FilePen } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useDeals, type Deal } from "@/hooks/use-deals";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/components/charts/chart-colors";

type Period = "ytd" | "mtd";

function isPeriod(value: string | null): value is Period {
  return value === "ytd" || value === "mtd";
}

// Today / year-start / month-start in America/Chicago to match the
// dashboard service's YTD/MTD card semantics.
function getChicagoDateParts(): { today: string; yearStart: string; monthStart: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const today = fmt.format(new Date());
  const [year, month] = today.split("-");
  return {
    today,
    yearStart: `${year}-01-01`,
    monthStart: `${year}-${month}-01`,
  };
}

function formatSignedDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}

function buildPropertyLine(deal: Deal): string {
  const parts = [deal.propertyAddress, deal.propertyCity, deal.propertyState]
    .filter((part): part is string => Boolean(part && part.trim()));
  return parts.length > 0 ? parts.join(", ") : "No property address on file";
}

export function ContractsSignedPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const periodParam = searchParams.get("period");

  if (!isPeriod(periodParam)) {
    return <Navigate to="/" replace />;
  }
  const period: Period = periodParam;

  const { today, yearStart, monthStart } = useMemo(() => getChicagoDateParts(), []);
  const contractSignedFrom = period === "ytd" ? yearStart : monthStart;

  const { deals, loading, error } = useDeals({
    assignedRepId: user?.id,
    contractSignedFrom,
    contractSignedTo: today,
    sortBy: "contract_signed_date",
    sortDir: "desc",
    limit: 100,
  });

  const totalValue = useMemo(
    () => deals.reduce((sum, d) => sum + Number(d.awardedAmount ?? 0), 0),
    [deals]
  );

  const periodLabel = period === "ytd" ? "Year to Date" : "Month to Date";
  const Icon = period === "ytd" ? FileSignature : FilePen;

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to dashboard
        </Link>
      </div>

      <PageHeader
        title={`Contracts Signed — ${periodLabel}`}
        description={`Deals where contract signed date is between ${contractSignedFrom} and ${today}.`}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="border-indigo-200 bg-indigo-50/70">
          <CardContent className="flex items-center justify-between p-4">
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Period</p>
              <p className="text-2xl font-bold">{periodLabel}</p>
            </div>
            <Icon className="h-5 w-5 text-muted-foreground" />
          </CardContent>
        </Card>
        <Card className="border-indigo-200 bg-indigo-50/70">
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Contracts Signed</p>
            <p className="text-2xl font-bold">{loading ? "—" : deals.length}</p>
          </CardContent>
        </Card>
        <Card className="border-indigo-200 bg-indigo-50/70">
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Total Awarded</p>
            <p className="text-2xl font-bold">{loading ? "—" : formatCurrency(totalValue)}</p>
          </CardContent>
        </Card>
      </div>

      {error ? (
        <Card>
          <CardContent className="p-6 text-center text-red-600">{error}</CardContent>
        </Card>
      ) : loading ? (
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground">Loading...</CardContent>
        </Card>
      ) : deals.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center">
            <p className="text-base font-medium text-slate-900">
              No contracts signed in this period yet.
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Contracts you sign in this {period === "ytd" ? "year" : "month"} will appear here.
            </p>
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => navigate("/")}
            >
              Back to dashboard
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden border-slate-200">
          <div className="divide-y divide-slate-100">
            {deals.map((deal) => (
              <button
                key={deal.id}
                type="button"
                onClick={() => navigate(`/deals/${deal.id}`)}
                className="flex w-full items-start justify-between gap-4 px-6 py-4 text-left transition-colors hover:bg-slate-50"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-semibold text-slate-950">{deal.name}</p>
                    <span className="text-xs text-slate-500">{deal.dealNumber}</span>
                  </div>
                  <p className="mt-1 truncate text-sm text-slate-600">{buildPropertyLine(deal)}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    Signed {formatSignedDate(deal.contractSignedDate)}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-semibold text-slate-900">
                    {formatCurrency(Number(deal.awardedAmount ?? 0))}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">Open deal</p>
                </div>
              </button>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
