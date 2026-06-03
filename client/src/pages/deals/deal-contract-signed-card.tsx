import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DateField } from "@/components/ui/date-field";
import { api } from "@/lib/api";
import type { DealDetail } from "@/hooks/use-deals";
import { formatShortDate } from "@/lib/deal-utils";

interface DealContractSignedCardProps {
  deal: DealDetail;
  canEdit: boolean;
  // Returns a promise when it triggers a refetch; awaited so the in-flight lock
  // is held until the persisted value catches up (see `send`).
  onUpdate: () => void | Promise<void>;
}

export function DealContractSignedCard({ deal, canEdit, onUpdate }: DealContractSignedCardProps) {
  const [saving, setSaving] = useState(false);
  const value = deal.contractSignedDate ?? "";
  // Local draft so typing never persists. A native <input type="date"> fires a
  // change the instant MM/DD/YYYY form a complete date — saving on every change
  // committed a wrong/intermediate value mid-year-entry and the refetch reset
  // the field. We persist only on explicit commit (blur / Enter).
  const [draft, setDraft] = useState(value);
  const inFlightRef = useRef(false); // a PATCH is currently awaiting
  const pendingRef = useRef<string | null>(null); // latest value committed while a PATCH was in flight
  const fieldRef = useRef<HTMLDivElement>(null);

  // Re-sync the draft when the persisted value changes (a save's refetch, or an
  // external update) — but never while the field is focused, which would clobber
  // an edit the user is still making. (The parent keys this card by deal.id, so
  // navigating to another deal remounts it with a fresh draft.)
  useEffect(() => {
    if (!fieldRef.current?.contains(document.activeElement)) setDraft(value);
  }, [value]);

  const send = async (next: string) => {
    inFlightRef.current = true;
    setSaving(true);
    try {
      await api(`/deals/${deal.id}/contract-signed-date`, {
        method: "PATCH",
        json: { date: next || null },
      });
      toast.success(next ? "Contract signed date updated" : "Contract signed date cleared");
      // Hold the in-flight lock until the refetch lands so the persisted value
      // catches up before we release — closing the window where a blur could
      // re-send an already-saved value.
      await onUpdate();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update contract signed date");
      setDraft(value); // revert the draft to the persisted value on failure
    } finally {
      inFlightRef.current = false;
      setSaving(false);
      // Flush the latest value committed while this write was in flight — sent in
      // order so the user's last commit wins, never an out-of-order overwrite.
      // Skip only the value we just sent (e.g. an Enter-then-blur on the same
      // date), so an unchanged re-commit can't re-fire the #612 side effects.
      const queued = pendingRef.current;
      pendingRef.current = null;
      if (queued !== null && queued !== next) {
        void send(queued);
      }
    }
  };

  const commit = (nextRaw: string) => {
    const next = nextRaw || "";
    // A write is in flight → defer the latest value; it is sent (in order) when
    // the current write completes, so concurrent PATCHes can't race out of order
    // and the user's last commit always wins.
    if (inFlightRef.current) {
      pendingRef.current = next;
      return;
    }
    // Idle: skip a no-op so a stray blur doesn't re-fire the #612 side effects.
    if (next === value) return;
    void send(next);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4" />
          Contract Signed
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {canEdit ? (
          <>
            <div ref={fieldRef}>
              <DateField
                id="contract-signed-date"
                value={draft}
                onChange={setDraft}
                onCommit={commit}
              />
            </div>
            {saving ? (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" />
                Saving…
              </p>
            ) : null}
          </>
        ) : (
          <div className="text-sm">
            {deal.contractSignedDate ? (
              formatShortDate(deal.contractSignedDate)
            ) : (
              <span className="text-muted-foreground">Not signed yet</span>
            )}
          </div>
        )}
        {!canEdit ? (
          <p className="text-xs text-muted-foreground italic">
            Only admins and directors can edit this date.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
