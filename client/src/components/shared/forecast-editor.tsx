import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type ForecastPayload = {
  forecastWindow: "30_days" | "60_days" | "90_days" | "beyond_90" | "uncommitted" | null;
  forecastCategory: "commit" | "best_case" | "pipeline" | null;
  forecastConfidencePercent: number | null;
  forecastRevenue: string | null;
  forecastGrossProfit: string | null;
  forecastBlockers: string | null;
  nextMilestoneAt: string | null;
};

interface ForecastEditorProps {
  value: ForecastPayload;
  onSave: (payload: ForecastPayload) => Promise<void>;
}

export function ForecastEditor({ value, onSave }: ForecastEditorProps) {
  const [form, setForm] = useState<ForecastPayload>(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setForm(value);
  }, [value]);

  const update = <K extends keyof ForecastPayload>(key: K, next: ForecastPayload[K]) =>
    setForm((current) => ({ ...current, [key]: next }));

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(form);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save forecast");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-4 pt-4">
        <div className="space-y-1">
          <p className="text-sm font-medium">Forecast</p>
          <p className="text-xs text-muted-foreground">
            Keep the close window, commercial value, and blocker summary current.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Window</label>
            <Select
              value={form.forecastWindow ?? "uncommitted"}
              onValueChange={(next) => update("forecastWindow", next as ForecastPayload["forecastWindow"])}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="30_days">30 Days</SelectItem>
                <SelectItem value="60_days">60 Days</SelectItem>
                <SelectItem value="90_days">90 Days</SelectItem>
                <SelectItem value="beyond_90">Beyond 90</SelectItem>
                <SelectItem value="uncommitted">Uncommitted</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Category</label>
            <Select
              value={form.forecastCategory ?? "pipeline"}
              onValueChange={(next) => update("forecastCategory", next as ForecastPayload["forecastCategory"])}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="commit">Commit</SelectItem>
                <SelectItem value="best_case">Best Case</SelectItem>
                <SelectItem value="pipeline">Pipeline</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Confidence %</label>
            <Input
              type="number"
              min={0}
              max={100}
              value={form.forecastConfidencePercent ?? ""}
              onChange={(event) =>
                update("forecastConfidencePercent", event.target.value ? Number(event.target.value) : null)
              }
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Revenue</label>
            <Input
              value={form.forecastRevenue ?? ""}
              onChange={(event) => update("forecastRevenue", event.target.value || null)}
              placeholder="250000.00"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Gross Profit</label>
            <Input
              value={form.forecastGrossProfit ?? ""}
              onChange={(event) => update("forecastGrossProfit", event.target.value || null)}
              placeholder="40000.00"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Next Milestone</label>
            <Input
              type="date"
              value={form.nextMilestoneAt ? form.nextMilestoneAt.slice(0, 10) : ""}
              onChange={(event) => update("nextMilestoneAt", event.target.value || null)}
            />
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Blockers</label>
          <Textarea
            value={form.forecastBlockers ?? ""}
            onChange={(event) => update("forecastBlockers", event.target.value || null)}
            rows={3}
            placeholder="Budget still soft, waiting on owner approval..."
          />
        </div>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving}>
            <Save className="mr-2 h-4 w-4" />
            {saving ? "Saving..." : "Save Forecast"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
