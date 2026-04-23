import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import {
  useLeadQualification,
  updateLead,
  type LeadQualificationRecord,
} from "@/hooks/use-leads";
import { useProjectTypes } from "@/hooks/use-pipeline-config";

function getStringValue(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function getBooleanValue(record: Record<string, unknown>, key: string) {
  return record[key] === true;
}

function normalizeCurrencyInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/[$,\s]/g, "");
}

export function LeadQualificationPanel({
  leadId,
  projectTypeId,
  projectTypeName,
  onSaved,
}: {
  leadId: string;
  projectTypeId?: string | null;
  projectTypeName?: string | null;
  onSaved?: () => void;
}) {
  const { user } = useAuth();
  const { projectTypes } = useProjectTypes();
  const { qualification, loading, refetch } = useLeadQualification(leadId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [estimatedOpportunityValue, setEstimatedOpportunityValue] = useState("");
  const [goDecision, setGoDecision] = useState<"go" | "no_go" | "">("");
  const [goDecisionNotes, setGoDecisionNotes] = useState("");
  const [qualificationData, setQualificationData] = useState<Record<string, unknown>>({});
  const [selectedProjectTypeId, setSelectedProjectTypeId] = useState(projectTypeId ?? "");
  const canApprove = user?.role === "director" || user?.role === "admin";

  useEffect(() => {
    const record = qualification as LeadQualificationRecord | null;
    setEstimatedOpportunityValue(record?.estimatedOpportunityValue ?? "");
    setGoDecision(record?.goDecision ?? "");
    setGoDecisionNotes(record?.goDecisionNotes ?? "");
    setQualificationData(record?.qualificationData ?? {});
  }, [qualification]);

  useEffect(() => {
    setSelectedProjectTypeId(projectTypeId ?? "");
  }, [projectTypeId]);

  const updateQualificationField = (key: string, value: string | boolean) => {
    setQualificationData((current) => ({ ...current, [key]: value }));
  };

  const approvalStatus =
    goDecision === "go" ? "Approved" : goDecision === "no_go" ? "Rejected" : "Pending Director/Admin Approval";
  const selectedProjectType =
    projectTypes.find((entry) => entry.id === selectedProjectTypeId) ??
    (projectTypeId
      ? {
          id: projectTypeId,
          name: projectTypeName ?? (getStringValue(qualificationData, "projectType") || projectTypeId),
          slug: "",
          parentId: null,
          displayOrder: 0,
          isActive: true,
        }
      : null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateLead(leadId, {
        projectTypeId: selectedProjectTypeId || null,
        estimatedOpportunityValue: normalizeCurrencyInput(estimatedOpportunityValue) || null,
        goDecision: canApprove ? goDecision || null : undefined,
        goDecisionNotes: canApprove ? goDecisionNotes || null : undefined,
        qualificationData: {
          ...qualificationData,
          projectType: selectedProjectType?.name ?? "",
        },
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
            <Label>Property City</Label>
            <Input
              value={getStringValue(qualificationData, "propertyCity")}
              onChange={(event) => updateQualificationField("propertyCity", event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Property State</Label>
            <Input
              value={getStringValue(qualificationData, "propertyState")}
              onChange={(event) => updateQualificationField("propertyState", event.target.value)}
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
            <Select
              value={selectedProjectTypeId || "__none__"}
              onValueChange={(value) =>
                setSelectedProjectTypeId(value && value !== "__none__" ? value : "")
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select project type">
                  {selectedProjectType?.name ?? "Select project type"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Select project type</SelectItem>
                {projectTypes.map((projectType) => (
                  <SelectItem key={projectType.id} value={projectType.id}>
                    {projectType.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
            <Label>Rep Recommendation</Label>
            <select
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value={getStringValue(qualificationData, "goRecommendation") || "pending"}
              onChange={(event) =>
                updateQualificationField(
                  "goRecommendation",
                  event.target.value === "pending" ? "" : event.target.value
                )
              }
            >
              <option value="pending">Pending</option>
              <option value="go">Go</option>
              <option value="no_go">No-Go</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label>Approval Status</Label>
            <Input value={approvalStatus} readOnly />
          </div>
          <div className="space-y-2">
            <Label>Director/Admin Decision</Label>
            <select
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value={goDecision || "pending"}
              disabled={!canApprove}
              onChange={(event) => setGoDecision(event.target.value === "pending" ? "" : (event.target.value as "go" | "no_go"))}
            >
              <option value="pending">Pending</option>
              <option value="go">Go</option>
              <option value="no_go">No-Go</option>
            </select>
          </div>
        </div>

        <div className="space-y-2">
          <Label>Rep Recommendation Notes</Label>
          <Textarea
            value={getStringValue(qualificationData, "goRecommendationNotes")}
            onChange={(event) => updateQualificationField("goRecommendationNotes", event.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label>Director/Admin Decision Notes</Label>
          <Textarea
            value={goDecisionNotes}
            disabled={!canApprove}
            onChange={(event) => setGoDecisionNotes(event.target.value)}
          />
          {!canApprove ? (
            <p className="text-xs text-muted-foreground">
              Only directors and admins can record the final go/no-go approval.
            </p>
          ) : null}
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
