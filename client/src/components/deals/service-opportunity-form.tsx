import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CompanySelector } from "@/components/companies/company-selector";
import { PropertySelector } from "@/components/properties/property-selector";
import { useAccessibleOffices } from "@/hooks/use-accessible-offices";
import { useProjectTypes } from "@/hooks/use-pipeline-config";
import { useTaskAssignees } from "@/hooks/use-task-assignees";
import { createServiceOpportunity, type Deal } from "@/hooks/use-deals";
import { useAuth } from "@/lib/auth";
import {
  buildOfficeCodePrefixOptions,
  resolveDefaultOfficeCode,
} from "@/lib/office-selection";

interface ServiceOpportunityFormProps {
  onSuccess?: (deal: Deal) => void;
}

function normalizeServiceCandidate(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
}

export function ServiceOpportunityForm({ onSuccess }: ServiceOpportunityFormProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { offices } = useAccessibleOffices();
  const { hierarchy: projectTypeHierarchy } = useProjectTypes();

  const activeOfficeId = user?.activeOfficeId ?? user?.officeId ?? null;
  const officeOptions = buildOfficeCodePrefixOptions();
  const initialOfficeCode = resolveDefaultOfficeCode({
    offices,
    activeOfficeId,
    currentOfficeCode: "",
  });

  const serviceProjectType = useMemo(() => {
    const options = projectTypeHierarchy.flatMap((parent) => [parent, ...parent.children]);
    return (
      options.find((option) => normalizeServiceCandidate(option.slug) === "service") ??
      options.find((option) => normalizeServiceCandidate(option.name) === "service") ??
      null
    );
  }, [projectTypeHierarchy]);

  const [formData, setFormData] = useState({
    name: "",
    companyId: "",
    propertyId: "",
    description: "",
    assignedRepId: user?.role === "rep" ? user.id : "",
    officeCode: initialOfficeCode,
    expectedCloseDate: "",
  });
  // The office picker is a project-number PREFIX only: pickers + create target the rep's HOME (active)
  // office, so choosing DFW vs ATL never changes which companies/properties/reps are available nor where the
  // opportunity is created — only the deal_number prefix.
  const selectedOfficeLabel =
    officeOptions.find((office) => office.code === formData.officeCode)?.label ?? "Select office";
  const { assignees, loading: assigneesLoading } = useTaskAssignees({ officeId: activeOfficeId });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFormData((prev) => {
      const officeCode = resolveDefaultOfficeCode({
        offices,
        activeOfficeId,
        currentOfficeCode: prev.officeCode,
      });
      return officeCode === prev.officeCode ? prev : { ...prev, officeCode };
    });
  }, [activeOfficeId, offices]);

  const handleChange = (field: keyof typeof formData, value: string) => {
    setFormData((prev) => {
      const next = { ...prev, [field]: value };
      if (field === "companyId") {
        next.propertyId = "";
      }
      // officeCode is a cosmetic prefix that no longer rescopes the data, so changing it must NOT clear the
      // company/property/rep selections (the pickers stay on the home office regardless of the prefix).
      return next;
    });
    setError(null);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!formData.name.trim()) {
      setError("Opportunity name is required");
      return;
    }
    if (!formData.companyId || !formData.propertyId) {
      setError("Company and property are required");
      return;
    }
    if (!formData.assignedRepId) {
      setError("Assigned sales rep is required");
      return;
    }
    if (!activeOfficeId || !formData.officeCode) {
      setError("Cannot create opportunity: no active office. Contact admin.");
      return;
    }
    if (!serviceProjectType) {
      setError("Cannot create opportunity: Service project type is unavailable. Contact admin.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const resp = await createServiceOpportunity(
        {
          name: formData.name.trim(),
          companyId: formData.companyId,
          propertyId: formData.propertyId,
          assignedRepId: formData.assignedRepId,
          description: formData.description.trim() || null,
          expectedCloseDate: formData.expectedCloseDate || null,
          officeCode: formData.officeCode, // cosmetic prefix; the record is created on the home office below
          projectType: "service",
          projectTypeId: serviceProjectType.id,
        },
        { officeId: activeOfficeId }
      );

      if (onSuccess) {
        onSuccess(resp.deal);
      } else {
        navigate(`/deals/${resp.deal.id}`);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create service opportunity");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="max-w-3xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Service Opportunity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Project Type</span>
              <span className="rounded-full bg-brand-red px-2.5 py-1 text-xs font-black uppercase tracking-wide text-white">
                Service
              </span>
            </div>
            <p className="mt-2 text-sm text-slate-600">
              Direct-create is only available for Service projects. For other project types,{" "}
              <Link to="/leads/new" className="font-semibold text-brand-red underline-offset-4 hover:underline">
                start a new Lead
              </Link>
              .
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="name">
              Opportunity Name <span className="text-red-500">*</span>
            </Label>
            <Input
              id="name"
              placeholder="e.g., Cedar Springs service repair"
              value={formData.name}
              onChange={(event) => handleChange("name", event.target.value)}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Company <span className="text-red-500">*</span></Label>
              <CompanySelector
                value={formData.companyId || null}
                onChange={(companyId) => handleChange("companyId", companyId)}
                officeId={activeOfficeId ?? undefined}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Property <span className="text-red-500">*</span></Label>
              <PropertySelector
                companyId={formData.companyId || null}
                value={formData.propertyId || null}
                onChange={(propertyId) => handleChange("propertyId", propertyId)}
                officeId={activeOfficeId ?? undefined}
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Assigned Sales Rep <span className="text-red-500">*</span></Label>
            <Select
              value={formData.assignedRepId || "none"}
              onValueChange={(value) => handleChange("assignedRepId", value && value !== "none" ? value : "")}
              disabled={user?.role === "rep"}
            >
              <SelectTrigger>
                <SelectValue placeholder={assigneesLoading ? "Loading assignees..." : "Select assignee"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Select assignee</SelectItem>
                {assignees.map((assignee) => (
                  <SelectItem key={assignee.id} value={assignee.id}>
                    {assignee.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="officeCode">
              Office <span className="text-red-500">*</span>
            </Label>
            <Select
              value={formData.officeCode || "none"}
              onValueChange={(value) => handleChange("officeCode", value && value !== "none" ? value : "")}
            >
              <SelectTrigger id="officeCode">
                <SelectValue placeholder="Select office">
                  {selectedOfficeLabel}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {officeOptions.length === 0 ? (
                  <SelectItem value="none" disabled>No offices available</SelectItem>
                ) : (
                  officeOptions.map((office) => (
                    <SelectItem key={office.code} value={office.code}>
                      {office.label}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <textarea
              id="description"
              className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="Brief service scope..."
              value={formData.description}
              onChange={(event) => handleChange("description", event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="expectedCloseDate">Expected Close Date</Label>
            <Input
              id="expectedCloseDate"
              type="date"
              value={formData.expectedCloseDate}
              onChange={(event) => handleChange("expectedCloseDate", event.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={submitting}>
          {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Create Service Opportunity
        </Button>
        <Button type="button" variant="outline" onClick={() => navigate(-1)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
