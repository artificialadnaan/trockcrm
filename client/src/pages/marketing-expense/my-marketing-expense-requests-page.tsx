import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileText,
  Inbox,
  Megaphone,
  Plus,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  useMyMarketingExpenseRequests,
  withdrawMarketingExpenseRequest,
} from "@/hooks/use-marketing-expense-requests";
import {
  formatDateOnly,
  formatMoney,
  type MarketingExpenseRequestSummary,
  type MarketingExpenseStatus,
} from "@trock-crm/shared/types";

/**
 * "My expense requests" — the status page the ask asked for: *they can view a page with their requests and
 * the status of their requests*.
 *
 * Modelled on pages/deals/pending-rfp-page.tsx: a local `statusMeta()` chip map (there is no shared
 * StatusBadge in this repo), stat tiles, an `role="alert"` error card, a pulse skeleton with an sr-only
 * "Loading…", and a centred empty state.
 *
 * DRAFTS ARE LISTED. A draft only exists because a submit did not finish — most likely because no approver
 * was configured — and a row the submitter cannot see is a request they will fill in a second time.
 */

type StatusMeta = { label: string; Icon: typeof Clock; chip: string };

function statusMeta(status: MarketingExpenseStatus): StatusMeta {
  switch (status) {
    case "draft":
      return { label: "Draft", Icon: FileText, chip: "bg-slate-50 text-slate-600 ring-slate-500/20" };
    case "approved":
      return {
        label: "Approved",
        Icon: CheckCircle2,
        chip: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
      };
    case "denied":
      return { label: "Denied", Icon: XCircle, chip: "bg-rose-50 text-rose-700 ring-rose-600/20" };
    case "withdrawn":
      return { label: "Withdrawn", Icon: XCircle, chip: "bg-slate-50 text-slate-500 ring-slate-500/20" };
    case "pending":
    default:
      return {
        label: "Awaiting approval",
        Icon: Clock,
        chip: "bg-sky-50 text-sky-700 ring-sky-600/20",
      };
  }
}

/**
 * `neededBy` is a DATE-ONLY column, and `new Date("2026-10-01")` is midnight UTC — which
 * `toLocaleDateString()` renders as 30 September in Dallas. A deadline shown a day early is worse than no
 * deadline, so date-only values go through the shared helper that never builds an instant from them.
 */
const formatDate = formatDateOnly;

function StatTile({
  icon: Icon,
  label,
  value,
  tone,
  testId,
}: {
  icon: typeof Clock;
  label: string;
  value: number;
  tone: string;
  testId: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-white px-4 py-3 shadow-sm">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone}`}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p data-testid={testId} className="text-xl font-semibold leading-none text-slate-900">
          {value}
        </p>
        <p className="mt-1 truncate text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

export function MyMarketingExpenseRequestsPage() {
  const { requests, loading, error, refetch } = useMyMarketingExpenseRequests();
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);

  const stats = useMemo(() => {
    const count = (status: MarketingExpenseStatus) =>
      requests.filter((request) => request.status === status).length;
    return { pending: count("pending"), approved: count("approved"), denied: count("denied") };
  }, [requests]);

  const showList = !error && requests.length > 0;

  async function withdraw(request: MarketingExpenseRequestSummary) {
    setWithdrawingId(request.id);
    try {
      await withdrawMarketingExpenseRequest(request.id);
      toast.success(`${request.requestNumber} withdrawn`);
    } catch (err) {
      // Whether it was a 409 (already decided) or anything else, the list on screen is now suspect —
      // re-read it so the row's buttons match what the server will actually accept.
      toast.error(err instanceof Error ? err.message : "Could not withdraw the request.");
    } finally {
      setWithdrawingId(null);
      await refetch();
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-red/10 text-brand-red">
              <Megaphone className="h-5 w-5" />
            </span>
            <h1 className="text-2xl font-semibold tracking-tight">Marketing Expense Requests</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Your marketing &amp; advertising expense requests and where each one stands.
          </p>
        </div>
        {/*
          An anchor, not a Button-with-onClick. This is navigation: as a link it can be opened in a new tab,
          copied, and reached by a screen reader's link list. `Button` in this repo has no `asChild`, so the
          classes are applied to the Link directly rather than smuggled through a wrapper.
        */}
        <Link
          to="/marketing-expense-requests/new"
          data-testid="mer-new-request"
          className="inline-flex h-9 items-center justify-center rounded-md bg-brand-red px-4 text-sm font-semibold text-white transition-colors hover:bg-brand-red/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2"
        >
          <Plus className="mr-2 h-4 w-4" />
          New request
        </Link>
      </div>

      {showList && (
        <div className="grid grid-cols-3 gap-3">
          <StatTile
            testId="mer-stat-pending"
            icon={Clock}
            label="Awaiting approval"
            value={stats.pending}
            tone="bg-sky-100 text-sky-700"
          />
          <StatTile
            testId="mer-stat-approved"
            icon={CheckCircle2}
            label="Approved"
            value={stats.approved}
            tone="bg-emerald-100 text-emerald-700"
          />
          <StatTile
            testId="mer-stat-denied"
            icon={XCircle}
            label="Denied"
            value={stats.denied}
            tone="bg-rose-100 text-rose-700"
          />
        </div>
      )}

      {error && (
        <Card>
          <CardContent role="alert" className="flex items-center gap-2 p-4 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="space-y-2 p-4">
              {[0, 1, 2].map((index) => (
                <div key={index} className="h-14 animate-pulse rounded-lg bg-slate-100" />
              ))}
              <p className="sr-only">Loading your expense requests...</p>
            </div>
          ) : showList ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-2.5">Request</th>
                    <th className="px-4 py-2.5">Vendor / event</th>
                    <th className="px-4 py-2.5">Total</th>
                    <th className="px-4 py-2.5">Needed by</th>
                    <th className="px-4 py-2.5">Status</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {requests.map((request) => {
                    const meta = statusMeta(request.status);
                    return (
                      <tr
                        key={request.id}
                        data-testid={`mer-row-${request.id}`}
                        className="border-b transition-colors last:border-b-0 hover:bg-slate-50"
                      >
                        <td className="px-4 py-3 font-semibold text-slate-900">{request.requestNumber}</td>
                        <td className="px-4 py-3">
                          <p className="text-slate-700">{request.vendorEvent}</p>
                          {request.latestDecisionReason && (
                            <p className="mt-0.5 text-xs text-rose-700">
                              {request.latestDecidedByName
                                ? `${request.latestDecidedByName}: `
                                : ""}
                              {request.latestDecisionReason}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3 tabular-nums text-slate-700">
                          {formatMoney(request.totalRequested)}
                        </td>
                        <td className="px-4 py-3 text-slate-600">{formatDate(request.neededBy)}</td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${meta.chip}`}
                          >
                            <meta.Icon className="h-3.5 w-3.5" />
                            {meta.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {/* Only a PENDING request can be withdrawn — the server enforces the same rule,
                              and offering the button anywhere else is a promise it will refuse. */}
                          {request.status === "pending" && (
                            <Button
                              variant="outline"
                              size="sm"
                              data-testid={`mer-withdraw-${request.id}`}
                              disabled={withdrawingId === request.id}
                              onClick={() => void withdraw(request)}
                            >
                              {withdrawingId === request.id ? "Withdrawing…" : "Withdraw"}
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : !error ? (
            <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
                <Inbox className="h-6 w-6" />
              </span>
              <p className="text-sm font-medium text-slate-700">
                You have not submitted any expense requests yet
              </p>
              <p className="text-xs text-muted-foreground">
                Marketing and advertising spend goes through this form before the money is committed.
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
