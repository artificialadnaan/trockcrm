import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DateField } from "@/components/ui/date-field";
import { api } from "@/lib/api";
import type { DealDetail } from "@/hooks/use-deals";
import { formatShortDate } from "@/lib/deal-utils";

interface DealContractSignedCardProps {
  deal: DealDetail;
  canEdit: boolean;
  onUpdate: () => void;
}

export function DealContractSignedCard({ deal, canEdit, onUpdate }: DealContractSignedCardProps) {
  const [saving, setSaving] = useState(false);
  const value = deal.contractSignedDate ?? "";

  const handleChange = async (next: string) => {
    setSaving(true);
    try {
      await api(`/deals/${deal.id}/contract-signed-date`, {
        method: "PATCH",
        json: { date: next || null },
      });
      toast.success(next ? "Contract signed date updated" : "Contract signed date cleared");
      onUpdate();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update contract signed date");
    } finally {
      setSaving(false);
    }
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
          <DateField
            id="contract-signed-date"
            value={value}
            onChange={handleChange}
            disabled={saving}
          />
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
