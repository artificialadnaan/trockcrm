import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

export type EstimateResolvedMarket = {
  id: string;
  name: string;
  slug?: string | null;
  type?: string | null;
};

export type EstimateMarketResolutionSource = {
  type?: string | null;
  key?: string | null;
  marketId?: string | null;
} | null;

export type EstimateMarketChoice = {
  id: string;
  name: string;
  slug: string;
  type: string;
  stateCode?: string | null;
  regionId?: string | null;
};

export type EstimateMarketContext = {
  effectiveMarket: EstimateResolvedMarket;
  resolutionLevel: string;
  resolutionSource?: EstimateMarketResolutionSource;
  location?: {
    zip?: string | null;
    state?: string | null;
    regionId?: string | null;
  } | null;
  isOverridden?: boolean;
  override?: {
    id?: string;
    marketId: string;
    marketName?: string | null;
    marketSlug?: string | null;
    overrideReason?: string | null;
    overriddenByUserId?: string | null;
    createdAt?: string | Date | null;
    updatedAt?: string | Date | null;
  } | null;
  fallbackSource?: {
    type?: string | null;
    key?: string | null;
    marketId?: string | null;
  } | null;
} | null;

export type EstimateRerunStatus = {
  status: "idle" | "queued" | "running" | "failed";
  rerunRequestId?: string | null;
  queueJobId?: number | null;
  generationRunId?: string | null;
  source?: string | null;
  errorSummary?: string | null;
} | null;

export async function loadEstimateMarketChoicesAction(dealId: string) {
  const response = await api(`/deals/${dealId}/estimating/markets`);
  return (response?.markets ?? []) as EstimateMarketChoice[];
}

export async function runEstimateSetMarketOverrideAction(args: {
  dealId: string;
  marketId: string;
  reason?: string | null;
  refresh: () => Promise<void>;
}) {
  await api(`/deals/${args.dealId}/estimating/market-override`, {
    method: "PUT",
    json: {
      marketId: args.marketId,
      reason: args.reason ?? null,
    },
  });
  await args.refresh();
}

export async function runEstimateClearMarketOverrideAction(args: {
  dealId: string;
  reason?: string | null;
  refresh: () => Promise<void>;
}) {
  await api(`/deals/${args.dealId}/estimating/market-override`, {
    method: "DELETE",
    json: {
      reason: args.reason ?? null,
    },
  });
  await args.refresh();
}

export function formatEstimateResolutionLevel(value: string | null | undefined) {
  if (!value) return "Unknown";
  return value.replace(/_/g, " ");
}

export function getEstimateRerunLabel(status: EstimateRerunStatus) {
  if (!status || status.status === "idle") return "No override rerun pending";
  if (status.status === "queued") return "Override rerun queued";
  if (status.status === "running") return "Override rerun running";
  return "Override rerun failed";
}

export function getEstimateResolutionSourceLabel(
  resolutionSource: EstimateMarketResolutionSource | undefined
) {
  const sourceType = resolutionSource?.type ?? "unknown source";
  return resolutionSource?.key ? `${sourceType} (${resolutionSource.key})` : sourceType;
}

export function canApplyEstimateMarketOverride(args: {
  marketContext: EstimateMarketContext;
  selectedMarketId: string;
  pendingAction: "set" | "clear" | null;
}) {
  if (!args.selectedMarketId || args.pendingAction !== null) {
    return false;
  }

  if (!args.marketContext) {
    return true;
  }

  const currentMarketId = args.marketContext.override?.marketId ?? args.marketContext.effectiveMarket.id;
  if (!currentMarketId) {
    return true;
  }

  if (args.marketContext.isOverridden) {
    return args.selectedMarketId !== currentMarketId;
  }

  return args.selectedMarketId !== args.marketContext.effectiveMarket.id;
}

function getEstimateLocationLabel(marketContext: EstimateMarketContext) {
  const parts = [
    marketContext?.location?.zip?.trim(),
    marketContext?.location?.state?.trim(),
    marketContext?.location?.regionId?.trim(),
  ].filter((value): value is string => Boolean(value));

  return parts.length > 0 ? parts.join(" · ") : "No location context";
}

export function EstimateMarketOverridePanel({
  dealId,
  marketContext,
  rerunStatus,
  onRefresh,
}: {
  dealId: string;
  marketContext: EstimateMarketContext;
  rerunStatus: EstimateRerunStatus;
  onRefresh: () => Promise<void>;
}) {
  const [marketChoices, setMarketChoices] = useState<EstimateMarketChoice[]>([]);
  const [selectedMarketId, setSelectedMarketId] = useState<string>(marketContext?.effectiveMarket.id ?? "");
  const [reason, setReason] = useState<string>(marketContext?.override?.overrideReason ?? "");
  const [loadingChoices, setLoadingChoices] = useState(false);
  const [pendingAction, setPendingAction] = useState<"set" | "clear" | null>(null);
  const canApplyOverride = canApplyEstimateMarketOverride({
    marketContext,
    selectedMarketId,
    pendingAction,
  });

  useEffect(() => {
    setSelectedMarketId(marketContext?.override?.marketId ?? marketContext?.effectiveMarket.id ?? "");
    setReason(marketContext?.override?.overrideReason ?? "");
  }, [marketContext]);

  useEffect(() => {
    let cancelled = false;
    setLoadingChoices(true);
    loadEstimateMarketChoicesAction(dealId)
      .then((choices) => {
        if (!cancelled) {
          setMarketChoices(choices);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMarketChoices([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingChoices(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [dealId]);

  const handleApplyOverride = async () => {
    if (!selectedMarketId) return;
    setPendingAction("set");
    try {
      await runEstimateSetMarketOverrideAction({
        dealId,
        marketId: selectedMarketId,
        reason,
        refresh: onRefresh,
      });
      toast.success("Market override updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update market override");
    } finally {
      setPendingAction(null);
    }
  };

  const handleClearOverride = async () => {
    setPendingAction("clear");
    try {
      await runEstimateClearMarketOverrideAction({
        dealId,
        reason,
        refresh: onRefresh,
      });
      toast.success("Market override cleared");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to clear market override");
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <section className="rounded-lg border bg-background p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Market Context</h3>
        {marketContext?.isOverridden ? <Badge variant="secondary">Override active</Badge> : null}
        {!marketContext?.isOverridden && marketContext ? (
          <Badge variant="outline">Auto-detected</Badge>
        ) : null}
        <Badge variant={rerunStatus?.status === "failed" ? "destructive" : "outline"}>
          {getEstimateRerunLabel(rerunStatus)}
        </Badge>
      </div>

      <div className="mt-3 grid gap-3 text-sm">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Effective market</div>
          <div className="mt-1 font-medium">
            {marketContext?.effectiveMarket.name ?? "No market resolved"}
          </div>
          <div className="text-xs text-muted-foreground">
            {formatEstimateResolutionLevel(marketContext?.resolutionLevel)} via{" "}
            {getEstimateResolutionSourceLabel(marketContext?.resolutionSource)}
          </div>
          <div className="text-xs text-muted-foreground">
            Location: {getEstimateLocationLabel(marketContext)}
          </div>
          {marketContext?.fallbackSource ? (
            <div className="text-xs text-muted-foreground">
              Fallback source: {getEstimateResolutionSourceLabel(marketContext.fallbackSource)}
            </div>
          ) : null}
          {marketContext?.override?.overrideReason ? (
            <div className="text-xs text-muted-foreground">
              Override reason: {marketContext.override.overrideReason}
            </div>
          ) : null}
        </div>

        <div className="grid gap-2">
          <Label htmlFor={`estimate-market-override-${dealId}`}>Override market</Label>
          <select
            id={`estimate-market-override-${dealId}`}
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={selectedMarketId}
            onChange={(event) => setSelectedMarketId(event.target.value)}
          >
            <option value="">{loadingChoices ? "Loading market choices..." : "Select a market"}</option>
            {marketChoices.map((market) => (
              <option key={market.id} value={market.id}>
                {market.name}
              </option>
            ))}
          </select>
          <div className="text-xs text-muted-foreground">
            {marketChoices.length > 0
              ? `Loaded ${marketChoices.length} canonical market choices`
              : "Canonical market choices load from the server."}
          </div>
        </div>

        <div className="grid gap-2">
          <Label htmlFor={`estimate-market-override-reason-${dealId}`}>Override reason</Label>
          <Input
            id={`estimate-market-override-reason-${dealId}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Explain why this market should override auto-detection"
          />
        </div>

        {rerunStatus?.status === "failed" && rerunStatus.errorSummary ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {rerunStatus.errorSummary}
          </div>
        ) : null}
        {rerunStatus?.status !== "idle" ? (
          <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            {getEstimateRerunLabel(rerunStatus)}
            {rerunStatus?.rerunRequestId ? ` · request ${rerunStatus.rerunRequestId}` : ""}
            {rerunStatus?.generationRunId ? ` · run ${rerunStatus.generationRunId}` : ""}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!canApplyOverride} onClick={handleApplyOverride}>
            {pendingAction === "set" ? "Applying..." : "Apply override"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!marketContext?.override || pendingAction !== null}
            onClick={handleClearOverride}
          >
            {pendingAction === "clear" ? "Clearing..." : "Clear override"}
          </Button>
        </div>
      </div>
    </section>
  );
}
