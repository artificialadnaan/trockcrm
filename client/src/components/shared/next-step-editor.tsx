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

type NextStepPayload = {
  nextStep: string | null;
  nextStepDueAt: string | null;
  supportNeededType: "leadership" | "estimating" | "operations" | "executive_team" | null;
  supportNeededNotes: string | null;
  decisionMakerName?: string | null;
  budgetStatus?: string | null;
};

interface NextStepEditorProps {
  value: NextStepPayload;
  onSave: (payload: NextStepPayload) => Promise<void>;
}

export function NextStepEditor({ value, onSave }: NextStepEditorProps) {
  const [form, setForm] = useState<NextStepPayload>(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setForm(value);
  }, [value]);

  const update = <K extends keyof NextStepPayload>(key: K, next: NextStepPayload[K]) =>
    setForm((current) => ({ ...current, [key]: next }));

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(form);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save next step");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-4 pt-4">
        <div className="space-y-1">
          <p className="text-sm font-medium">Next Step</p>
          <p className="text-xs text-muted-foreground">
            Capture the next move and flag support before the record goes stale.
          </p>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Next Step</label>
          <Textarea
            value={form.nextStep ?? ""}
            onChange={(event) => update("nextStep", event.target.value || null)}
            rows={3}
            placeholder="Schedule owner review call and confirm budget cap."
          />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Due</label>
            <Input
              type="date"
              value={form.nextStepDueAt ? form.nextStepDueAt.slice(0, 10) : ""}
              onChange={(event) => update("nextStepDueAt", event.target.value || null)}
            />
          </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Support Needed</label>
            <Select
              value={form.supportNeededType ?? "none"}
              onValueChange={(next) =>
                update("supportNeededType", next === "none" ? null : next as NextStepPayload["supportNeededType"])
              }
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="leadership">Leadership</SelectItem>
                <SelectItem value="estimating">Estimating</SelectItem>
                <SelectItem value="operations">Operations</SelectItem>
                <SelectItem value="executive_team">Executive Team</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Decision Maker</label>
            <Input
              value={form.decisionMakerName ?? ""}
              onChange={(event) => update("decisionMakerName", event.target.value || null)}
              placeholder="Jane Smith"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Budget Status</label>
            <Input
              value={form.budgetStatus ?? ""}
              onChange={(event) => update("budgetStatus", event.target.value || null)}
              placeholder="Budget approved pending final bid"
            />
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Support Notes</label>
          <Textarea
            value={form.supportNeededNotes ?? ""}
            onChange={(event) => update("supportNeededNotes", event.target.value || null)}
            rows={2}
            placeholder="Need leadership on the pricing call."
          />
        </div>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving}>
            <Save className="mr-2 h-4 w-4" />
            {saving ? "Saving..." : "Save Next Step"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
