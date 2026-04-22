import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

type EnrichmentField = "projectTypeId" | "regionId" | "expectedCloseDate" | "nextStep";

const FIELD_LABELS: Record<EnrichmentField, string> = {
  projectTypeId: "Project Type",
  regionId: "Region",
  expectedCloseDate: "Expected Close Date",
  nextStep: "Next Step",
};

export function PostConversionEnrichmentPanel({
  requiredFields,
  missingFields,
  onDismiss,
  onEditField,
}: {
  requiredFields: EnrichmentField[];
  missingFields: EnrichmentField[];
  onDismiss: () => void;
  onEditField: (field: EnrichmentField) => void;
}) {
  const completedCount = Math.max(requiredFields.length - missingFields.length, 0);

  return (
    <Card className="border-brand-red/25 bg-brand-red/5">
      <CardHeader className="gap-2">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">Complete Deal Setup</h2>
            <p className="text-sm text-muted-foreground">
              {completedCount} of {requiredFields.length} complete
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <p className="text-sm font-medium">Finish these fields</p>
          <div className="flex flex-wrap gap-2">
            {missingFields.map((field) => (
              <Button
                key={field}
                variant="outline"
                className="justify-start rounded-full border-brand-red/20 bg-background text-sm"
                onClick={() => onEditField(field)}
              >
                {FIELD_LABELS[field]}
              </Button>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
