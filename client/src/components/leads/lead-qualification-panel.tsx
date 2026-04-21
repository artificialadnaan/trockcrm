import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  useLeadQualification,
  updateLead,
  type LeadQualificationRecord,
} from "@/hooks/use-leads";

function getStringValue(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function getBooleanValue(record: Record<string, unknown>, key: string) {
  return record[key] === true;
}

export function LeadQualificationPanel({
  leadId,
  onSaved,
}: {
  leadId: string;
  onSaved?: () => void;
}) {
  const { qualification, loading, refetch } = useLeadQualification(leadId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [estimatedOpportunityValue, setEstimatedOpportunityValue] = useState("");
  const [goDecision, setGoDecision] = useState<"go" | "no_go" | "">("");
  const [goDecisionNotes, setGoDecisionNotes] = useState("");
  const [qualificationData, setQualificationData] = useState<Record<string, unknown>>({});
  const [scopingSubsetData, setScopingSubsetData] = useState<Record<string, unknown>>({});

  useEffect(() => {
    const record = qualification as LeadQualificationRecord | null;
    setEstimatedOpportunityValue(record?.estimatedOpportunityValue ?? "");
    setGoDecision(record?.goDecision ?? "");
    setGoDecisionNotes(record?.goDecisionNotes ?? "");
    setQualificationData(record?.qualificationData ?? {});
    setScopingSubsetData(record?.scopingSubsetData ?? {});
  }, [qualification]);

  const updateQualificationField = (key: string, value: string | boolean) => {
    setQualificationData((current) => ({ ...current, [key]: value }));
  };

  const updateScopingField = (key: string, value: string) => {
    setScopingSubsetData((current) => ({ ...current, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateLead(leadId, {
        estimatedOpportunityValue: estimatedOpportunityValue || null,
        goDecision: goDecision || null,
        goDecisionNotes: goDecisionNotes || null,
        qualificationData,
        scopingSubsetData,
      });
      await refetch();
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save lead qualification");
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
      <CardHeader>
        <CardTitle className="text-base">Qualification Intake</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Project Location</Label>
            <Input
              value={getStringValue(qualificationData, "projectLocation")}
              onChange={(event) => updateQualificationField("projectLocation", event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Property Name</Label>
            <Input
              value={getStringValue(qualificationData, "propertyName")}
              onChange={(event) => updateQualificationField("propertyName", event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Property Address</Label>
            <Input
              value={getStringValue(qualificationData, "propertyAddress")}
              onChange={(event) => updateQualificationField("propertyAddress", event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Units</Label>
            <Input
              value={getStringValue(qualificationData, "unitCount")}
              onChange={(event) => updateQualificationField("unitCount", event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Stakeholder Name</Label>
            <Input
              value={getStringValue(qualificationData, "stakeholderName")}
              onChange={(event) => updateQualificationField("stakeholderName", event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Stakeholder Role</Label>
            <Input
              value={getStringValue(qualificationData, "stakeholderRole")}
              onChange={(event) => updateQualificationField("stakeholderRole", event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Budget Status</Label>
            <Input
              value={getStringValue(qualificationData, "budgetStatus")}
              onChange={(event) => updateQualificationField("budgetStatus", event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Budget Quarter</Label>
            <Input
              value={getStringValue(qualificationData, "budgetQuarter")}
              onChange={(event) => updateQualificationField("budgetQuarter", event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Project Type</Label>
            <Input
              value={getStringValue(qualificationData, "projectType")}
              onChange={(event) => updateQualificationField("projectType", event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Spec Package Status</Label>
            <Input
              value={getStringValue(qualificationData, "specPackageStatus")}
              onChange={(event) => updateQualificationField("specPackageStatus", event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Checklist Started</Label>
            <select
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value={getBooleanValue(qualificationData, "checklistStarted") ? "yes" : "no"}
              onChange={(event) => updateQualificationField("checklistStarted", event.target.value === "yes")}
            >
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label>Estimated Opportunity Value</Label>
            <Input
              value={estimatedOpportunityValue}
              onChange={(event) => setEstimatedOpportunityValue(event.target.value)}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label>Scope Summary</Label>
          <Textarea
            value={getStringValue(qualificationData, "scopeSummary")}
            onChange={(event) => updateQualificationField("scopeSummary", event.target.value)}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Go / No-Go Decision</Label>
            <select
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value={goDecision || "pending"}
              onChange={(event) => setGoDecision(event.target.value === "pending" ? "" : (event.target.value as "go" | "no_go"))}
            >
              <option value="pending">Pending</option>
              <option value="go">Go</option>
              <option value="no_go">No-Go</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label>Partial Scoping: Project Overview</Label>
            <Input
              value={getStringValue(scopingSubsetData, "projectOverview")}
              onChange={(event) => updateScopingField("projectOverview", event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Partial Scoping: Property Details</Label>
            <Input
              value={getStringValue(scopingSubsetData, "propertyDetails")}
              onChange={(event) => updateScopingField("propertyDetails", event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Partial Scoping: Scope Summary</Label>
            <Input
              value={getStringValue(scopingSubsetData, "scopeSummary")}
              onChange={(event) => updateScopingField("scopeSummary", event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Budget and Bid Context</Label>
            <Input
              value={getStringValue(scopingSubsetData, "budgetAndBidContext")}
              onChange={(event) => updateScopingField("budgetAndBidContext", event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Initial Quantities</Label>
            <Input
              value={getStringValue(scopingSubsetData, "initialQuantities")}
              onChange={(event) => updateScopingField("initialQuantities", event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Decision Timeline</Label>
            <Input
              value={getStringValue(scopingSubsetData, "decisionTimeline")}
              onChange={(event) => updateScopingField("decisionTimeline", event.target.value)}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label>Go / No-Go Notes</Label>
          <Textarea value={goDecisionNotes} onChange={(event) => setGoDecisionNotes(event.target.value)} />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <Button onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          Save Qualification
        </Button>
      </CardContent>
    </Card>
  );
}
