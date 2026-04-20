import { useState } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

type MatchReviewAction = "select" | "reject";

interface EstimateMatchRow {
  id: string;
  extractionId?: string | null;
  catalogItemId?: string | null;
  catalogCodeId?: string | null;
  historicalLineItemId?: string | null;
  matchType?: string | null;
  matchScore?: string | number | null;
  status?: string | null;
  reasonJson?: unknown;
  evidenceJson?: unknown;
}

function formatStatus(value: string | null | undefined) {
  if (!value) return "unknown";
  return value.replace(/_/g, " ");
}

function formatMatchType(value: string | null | undefined) {
  if (!value) return "candidate";
  return value.replace(/_/g, " ");
}

function formatScore(value: string | number | null | undefined) {
  if (value == null || value === "") return "No score";
  const numeric = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(numeric)) return `${value}`;
  return `${Math.round(numeric <= 1 ? numeric * 100 : numeric)}%`;
}

function summarizeUnknown(value: unknown) {
  if (!value) return "No detail";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "No detail";
  }
}

function createRefresh() {
  return async () => {
    if (typeof window !== "undefined" && typeof window.location?.reload === "function") {
      window.location.reload();
    }
  };
}

async function runEstimateMatchReviewAction({
  action,
  dealId,
  matchId,
  refresh,
}: {
  action: MatchReviewAction;
  dealId: string;
  matchId: string;
  refresh: () => Promise<void>;
}) {
  await api(`/deals/${dealId}/estimating/matches/${matchId}/${action}`, {
    method: "POST",
  });
  await refresh();
}

export function EstimateCatalogMatchTable({ rows }: { rows: EstimateMatchRow[] }) {
  const { dealId } = useParams<{ dealId: string }>();
  const [selectedRowId, setSelectedRowId] = useState<string | null>(rows[0]?.id ?? null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const selectedRow =
    rows.find((row) => row.id === selectedRowId) ?? rows[0] ?? null;

  const handleAction = async (row: EstimateMatchRow, action: MatchReviewAction) => {
    if (!dealId) {
      toast.error("Missing deal id for catalog review");
      return;
    }

    setPendingAction(`${row.id}:${action}`);
    try {
      await runEstimateMatchReviewAction({
        action,
        dealId,
        matchId: row.id,
        refresh: createRefresh(),
      });
      toast.success(action === "select" ? "Match selected" : "Match rejected");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update match");
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <section className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">Catalog Match</h3>
        <p className="text-xs text-muted-foreground">
          Resolve suggested mappings before pricing recommendations are trusted.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">
          No catalog match suggestions are ready for estimator review yet.
        </div>
      ) : (
        <>
          <div className="border-b bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
            {rows.length} catalog matches. Selected:{" "}
            <span className="font-medium text-foreground">
              {selectedRow?.id || "None"}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b bg-muted/30 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Row</th>
                  <th className="px-3 py-2 font-medium">Extraction</th>
                  <th className="px-3 py-2 font-medium">Candidate</th>
                  <th className="px-3 py-2 font-medium">Reason</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const isSelected = row.id === selectedRow?.id;
                  const selectBusy = pendingAction === `${row.id}:select`;
                  const rejectBusy = pendingAction === `${row.id}:reject`;

                  return (
                    <tr
                      key={row.id}
                      className={isSelected ? "border-b bg-muted/20 align-top" : "border-b align-top"}
                    >
                      <td className="px-3 py-2">
                        <Button
                          size="xs"
                          variant={isSelected ? "secondary" : "ghost"}
                          onClick={() => setSelectedRowId(row.id)}
                        >
                          {isSelected ? "Selected" : "Focus"}
                        </Button>
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium text-foreground">{row.extractionId || row.id}</div>
                        <div className="text-xs text-muted-foreground">{formatMatchType(row.matchType)}</div>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        <div>Item {row.catalogItemId || "n/a"}</div>
                        <div>Code {row.catalogCodeId || "n/a"}</div>
                        <div>History {row.historicalLineItemId || "n/a"}</div>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {summarizeUnknown(row.reasonJson)}
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium capitalize">{formatStatus(row.status)}</div>
                        <div className="text-xs text-muted-foreground">
                          Score {formatScore(row.matchScore)}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={selectBusy || rejectBusy || !dealId}
                            onClick={() => handleAction(row, "select")}
                          >
                            {selectBusy ? "Selecting..." : "Select"}
                          </Button>
                          <Button
                            size="xs"
                            variant="destructive"
                            disabled={selectBusy || rejectBusy || !dealId}
                            onClick={() => handleAction(row, "reject")}
                          >
                            {rejectBusy ? "Rejecting..." : "Reject"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="px-4 py-3 text-xs text-muted-foreground">
            Evidence: {selectedRow ? summarizeUnknown(selectedRow.evidenceJson) : "No evidence"}
          </div>
        </>
      )}
    </section>
  );
}
