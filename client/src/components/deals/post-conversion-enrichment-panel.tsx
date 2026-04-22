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
  onEditDetails,
  onEditNextStep,
}: {
  requiredFields: EnrichmentField[];
  missingFields: EnrichmentField[];
  onDismiss: () => void;
  onEditDetails: () => void;
  onEditNextStep: () => void;
}) {
  const completedCount = Math.max(requiredFields.length - missingFields.length, 0);
  const missingDetailFields = missingFields.filter((field) => field !== "nextStep");
  const nextStepMissing = missingFields.includes("nextStep");

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
          <p className="text-sm font-medium">Missing fields</p>
          <div className="flex flex-wrap gap-2">
            {missingFields.map((field) => (
              <span
                key={field}
                className="rounded-full border border-brand-red/20 bg-background px-3 py-1 text-sm"
              >
                {FIELD_LABELS[field]}
              </span>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {missingDetailFields.length > 0 ? (
            <Button onClick={onEditDetails}>Complete Deal Details</Button>
          ) : null}
          {nextStepMissing ? (
            <Button variant="outline" onClick={onEditNextStep}>
              Update Next Step
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
