import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Save } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useLeadScoping, updateLeadScoping } from "@/hooks/use-leads";
import {
  LEAD_SCOPING_FIELD_DEFINITIONS,
  LEAD_SCOPING_SECTION_KEYS,
  type LeadScopingFieldDefinition,
  type LeadScopingSectionData,
  type LeadScopingSectionKey,
} from "../../../../shared/src/types/lead-scoping.js";

const SECTION_LABELS: Record<LeadScopingSectionKey, string> = {
  projectOverview: "Project Overview",
  budgetAndBidInfo: "Budget and Bid Info",
  propertyDetails: "Property Details",
  projectScopeSummary: "Project Scope Summary",
  interiorUnitRenovationScope: "Interior Unit Renovation Scope",
  exteriorScope: "Exterior Scope",
  amenitiesSiteImprovements: "Amenities / Site Improvements",
  quantities: "Quantities",
  siteLogistics: "Site Logistics",
  siteConditionsObserved: "Site Conditions Observed",
  materialsSpecifications: "Materials / Specifications",
  attachmentsProvided: "Attachments Provided",
};

function prettifyOption(option: string) {
  return option.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function getFieldValue(
  sectionData: LeadScopingSectionData,
  sectionKey: LeadScopingSectionKey,
  fieldKey: string
) {
  const section = sectionData[sectionKey];
  const value = section && typeof section === "object" ? section[fieldKey] : undefined;
  return typeof value === "string" ? value : "";
}

function renderSelectOptions(field: LeadScopingFieldDefinition) {
  if (field.type === "tri_state") {
    return ["yes", "no", "na"].map((option) => (
      <option key={option} value={option}>
        {prettifyOption(option)}
      </option>
    ));
  }

  return (field.options ?? []).map((option) => (
    <option key={option} value={option}>
      {prettifyOption(option)}
    </option>
  ));
}

export function LeadScopingWorkspace({
  leadId,
  onSaved,
}: {
  leadId: string;
  onSaved?: () => void;
}) {
  const { intake, readiness, loading, error, refetch } = useLeadScoping(leadId);
  const [sectionData, setSectionData] = useState<LeadScopingSectionData>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    setSectionData(intake?.sectionData ?? {});
  }, [intake?.sectionData]);

  const incompleteSections = useMemo(
    () =>
      LEAD_SCOPING_SECTION_KEYS.filter(
        (sectionKey) => readiness?.completionState?.[sectionKey]?.isComplete !== true
      ),
    [readiness?.completionState]
  );

  const setFieldValue = (
    sectionKey: LeadScopingSectionKey,
    fieldKey: string,
    value: string
  ) => {
    setSectionData((current) => ({
      ...current,
      [sectionKey]: {
        ...((current[sectionKey] as Record<string, unknown> | undefined) ?? {}),
        [fieldKey]: value,
      },
    }));
    setSaveMessage(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      await updateLeadScoping(leadId, { sectionData });
      await refetch();
      onSaved?.();
      setSaveMessage("Lead scoping checklist saved.");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save lead scoping");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base">Lead Scoping Checklist</CardTitle>
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              readiness?.isReadyForGoNoGo
                ? "bg-emerald-100 text-emerald-700"
                : "bg-amber-100 text-amber-700"
            }`}
          >
            {readiness?.isReadyForGoNoGo ? "Ready for Go/No-Go" : "Not Ready"}
          </span>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          {readiness?.isReadyForGoNoGo ? (
            <p className="flex items-center gap-2 font-medium text-emerald-700">
              <CheckCircle2 className="h-4 w-4" />
              All lead-scoping checklist sections are complete.
            </p>
          ) : (
            <div className="space-y-1">
              <p className="flex items-center gap-2 font-medium text-amber-700">
                <AlertCircle className="h-4 w-4" />
                Complete every section before moving a lead into Lead Go/No-Go.
              </p>
              <p>Incomplete sections: {incompleteSections.map((section) => SECTION_LABELS[section]).join(", ")}</p>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {error ? <p className="text-sm text-red-600">{error}</p> : null}

        {LEAD_SCOPING_SECTION_KEYS.map((sectionKey) => {
          const fields = LEAD_SCOPING_FIELD_DEFINITIONS[sectionKey];
          const sectionComplete = readiness?.completionState?.[sectionKey]?.isComplete === true;

          return (
            <div key={sectionKey} className="space-y-4 rounded-2xl border border-slate-200 p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-slate-950">{SECTION_LABELS[sectionKey]}</h3>
                <span className={`text-xs font-medium ${sectionComplete ? "text-emerald-700" : "text-amber-700"}`}>
                  {sectionComplete ? "Complete" : "Incomplete"}
                </span>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                {fields.map((field) => {
                  const value = getFieldValue(sectionData, sectionKey, field.key);
                  const missing =
                    readiness?.completionState?.[sectionKey]?.missingFields?.includes(field.key) === true ||
                    readiness?.completionState?.[sectionKey]?.missingAttachments?.includes(field.key) === true;

                  return (
                    <div
                      key={`${sectionKey}.${field.key}`}
                      className={`space-y-2 rounded-xl border p-3 ${
                        missing ? "border-amber-300 bg-amber-50/70" : "border-slate-200 bg-white"
                      } ${field.type === "textarea" ? "md:col-span-2" : ""}`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <Label>{field.label}</Label>
                        {(field.type === "text" || field.type === "textarea" || field.type === "date") && (
                          <Button
                            type="button"
                            size="sm"
                            variant={value === "na" ? "default" : "outline"}
                            onClick={() => setFieldValue(sectionKey, field.key, "na")}
                          >
                            N/A
                          </Button>
                        )}
                      </div>

                      {field.type === "textarea" ? (
                        <Textarea
                          value={value === "na" ? "" : value}
                          placeholder={value === "na" ? "Marked as N/A" : "Enter details"}
                          onChange={(event) => setFieldValue(sectionKey, field.key, event.target.value)}
                        />
                      ) : field.type === "text" || field.type === "date" ? (
                        <Input
                          type={field.type === "date" ? "date" : "text"}
                          value={value === "na" ? "" : value}
                          placeholder={value === "na" ? "Marked as N/A" : "Enter value"}
                          onChange={(event) => setFieldValue(sectionKey, field.key, event.target.value)}
                        />
                      ) : (
                        <select
                          className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                          value={value}
                          onChange={(event) => setFieldValue(sectionKey, field.key, event.target.value)}
                        >
                          <option value="">Select an option</option>
                          {renderSelectOptions(field)}
                        </select>
                      )}

                      {field.type === "attachment" ? (
                        <p className="text-xs text-muted-foreground">
                          Choose <span className="font-medium">Provided</span> only when the supporting file has been uploaded to this lead.
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {saveError ? <p className="text-sm text-red-600">{saveError}</p> : null}
        {saveMessage ? <p className="text-sm text-emerald-700">{saveMessage}</p> : null}

        <Button onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          Save Lead Scoping
        </Button>
      </CardContent>
    </Card>
  );
}
