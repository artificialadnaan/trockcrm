import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createLead } from "@/hooks/use-leads";
import { usePipelineStages } from "@/hooks/use-pipeline-config";
import { useAdminUsers } from "@/hooks/use-admin-users";
import { useAuth } from "@/lib/auth";
import { CompanySelector } from "@/components/companies/company-selector";
import { PropertySelector } from "@/components/properties/property-selector";
import { getLeadCreationStages, getSelectedOptionLabel } from "./lead-new-page.helpers";

export function LeadNewPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { users, loading: usersLoading } = useAdminUsers();
  const { stages, loading: stagesLoading } = usePipelineStages();

  const [formData, setFormData] = useState({
    name: "",
    companyId: "",
    propertyId: "",
    stageId: "",
    assignedRepId: user?.role === "rep" ? user.id : "",
    source: "",
    description: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const leadStages = useMemo(() => {
    return getLeadCreationStages(stages);
  }, [stages]);

  const availableReps = useMemo(
    () => users.filter((candidate) => candidate.role === "rep" && candidate.isActive),
    [users]
  );
  const repOptions = useMemo(
    () => availableReps.map((rep) => ({ id: rep.id, name: rep.displayName })),
    [availableReps]
  );

  useEffect(() => {
    if (!formData.stageId && leadStages.length > 0) {
      setFormData((prev) => ({ ...prev, stageId: leadStages[0].id }));
    }
  }, [formData.stageId, leadStages]);

  const handleChange = (field: keyof typeof formData, value: string) => {
    setFormData((prev) => {
      const next = { ...prev, [field]: value };
      if (field === "companyId") {
        next.propertyId = "";
      }
      return next;
    });
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!formData.name.trim() || !formData.companyId || !formData.propertyId || !formData.stageId) {
      setError("Lead name, company, property, and stage are required");
      return;
    }

    if (!formData.assignedRepId) {
      setError("Assigned sales rep is required");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const result = await createLead({
        name: formData.name.trim(),
        companyId: formData.companyId,
        propertyId: formData.propertyId,
        stageId: formData.stageId,
        assignedRepId: formData.assignedRepId,
        source: formData.source.trim() || null,
        description: formData.description.trim() || null,
      });
      navigate(`/leads/${result.lead.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create lead");
    } finally {
      setSubmitting(false);
    }
  };

  const loading = usersLoading || stagesLoading;
  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 mb-1"
          onClick={() => navigate("/leads")}
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Leads
        </Button>
        <h2 className="text-2xl font-bold">New Lead</h2>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</div>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Lead Information</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="lead-name">Lead Name *</Label>
              <Input
                id="lead-name"
                value={formData.name}
                onChange={(e) => handleChange("name", e.target.value)}
                placeholder="e.g., Oakwood Apartments Roof Assessment"
              />
            </div>

            <div className="space-y-2">
              <Label>Company *</Label>
              <CompanySelector
                value={formData.companyId || null}
                onChange={(companyId) => handleChange("companyId", companyId)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label>Property *</Label>
              <PropertySelector
                companyId={formData.companyId || null}
                value={formData.propertyId || null}
                onChange={(propertyId) => handleChange("propertyId", propertyId)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label>Lead Stage *</Label>
              <Select value={formData.stageId || "none"} onValueChange={(value) => handleChange("stageId", value && value !== "none" ? value : "")}>
                <SelectTrigger>
                  <SelectValue placeholder="Select lead stage">
                    {(value) => getSelectedOptionLabel(leadStages, value ?? "", "Select lead stage")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Select lead stage</SelectItem>
                  {leadStages.map((stage) => (
                    <SelectItem key={stage.id} value={stage.id}>
                      {stage.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Assigned Sales Rep *</Label>
              <Select
                value={formData.assignedRepId || "none"}
                onValueChange={(value) => handleChange("assignedRepId", value && value !== "none" ? value : "")}
                disabled={user?.role === "rep"}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select rep">
                    {(value) => getSelectedOptionLabel(repOptions, value ?? "", "Select rep")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Select rep</SelectItem>
                  {availableReps.map((rep) => (
                    <SelectItem key={rep.id} value={rep.id}>
                      {rep.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="lead-source">Source</Label>
              <Input
                id="lead-source"
                value={formData.source}
                onChange={(e) => handleChange("source", e.target.value)}
                placeholder="e.g., Trade Show, Referral, Website"
              />
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="lead-description">Description</Label>
              <Textarea
                id="lead-description"
                rows={4}
                value={formData.description}
                onChange={(e) => handleChange("description", e.target.value)}
                placeholder="Brief pre-RFP context for this lead..."
              />
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => navigate("/leads")}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting || loading}>
            {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Create Lead
          </Button>
        </div>
      </form>
    </div>
  );
}
