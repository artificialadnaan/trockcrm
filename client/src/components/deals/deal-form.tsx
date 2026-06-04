import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePipelineStages, useProjectTypes, useRegions } from "@/hooks/use-pipeline-config";
import { createDeal, updateDeal } from "@/hooks/use-deals";
import type { Deal } from "@/hooks/use-deals";
import { LEAD_SOURCE_CATEGORIES } from "@trock-crm/shared/types";
import { Loader2, Lock } from "lucide-react";
import { getDefaultDealStageId, getNewDealStages, getSelectedOptionLabel } from "./deal-form.helpers";
import { CompanySelector } from "@/components/companies/company-selector";
import { PropertySelector } from "@/components/properties/property-selector";
import { useAuth } from "@/lib/auth";
import { useTaskAssignees } from "@/hooks/use-task-assignees";
import { useAccessibleOffices } from "@/hooks/use-accessible-offices";
import {
  buildOfficeCodePrefixOptions,
  resolveDefaultOfficeCode,
} from "@/lib/office-selection";
import { applyDealRegionAutoSelection } from "./deal-region-auto-select";

interface DealFormProps {
  deal?: Deal; // If provided, we're editing; otherwise creating
  onSuccess?: (deal: Deal) => void;
  initialValues?: Partial<{
    name: string;
    companyId: string;
    propertyId: string;
    description: string;
    projectTypeId: string;
    source: string;
  }>;
}

export function DealForm({ deal, onSuccess, initialValues }: DealFormProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { stages } = usePipelineStages();
  const { hierarchy: projectTypeHierarchy } = useProjectTypes();
  const { regions } = useRegions();
  const { offices } = useAccessibleOffices();

  const isEdit = !!deal;
  const isBidBoardOwned = Boolean(deal?.isBidBoardOwned);
  const showRelationshipSelectors = !isEdit || !deal?.companyId || !deal?.propertyId;
  const activeStages = getNewDealStages(stages);
  const projectTypeOptions = projectTypeHierarchy.flatMap((parent) => [
    { id: parent.id, name: parent.name },
    ...parent.children.map((child) => ({ id: child.id, name: child.name })),
  ]);
  // The STABLE home office (primary office), NOT the switchable active office. The office picker is a
  // cosmetic project-number prefix, so pickers + create always operate on the rep's home data office —
  // even if their session active office was switched via x-office-id, the deal is never created in a
  // different (possibly empty) schema.
  const homeOfficeId = user?.officeId ?? null;
  const officeOptions = buildOfficeCodePrefixOptions();
  const initialOfficeCode = resolveDefaultOfficeCode({
    offices,
    homeOfficeId,
    currentOfficeCode: deal?.officeCode === "atl" || deal?.officeCode === "dfw" ? deal.officeCode : "",
  });
  const initialSource = deal?.source ?? initialValues?.source ?? "";
  const initialSourceIsCategory = LEAD_SOURCE_CATEGORIES.includes(initialSource as (typeof LEAD_SOURCE_CATEGORIES)[number]);

  const [formData, setFormData] = useState({
    name: deal?.name ?? initialValues?.name ?? "",
    stageId: deal?.stageId ?? "",
    assignedRepId: deal?.assignedRepId ?? (user?.role === "rep" ? user.id : ""),
    companyId: deal?.companyId ?? initialValues?.companyId ?? "",
    propertyId: deal?.propertyId ?? initialValues?.propertyId ?? "",
    description: deal?.description ?? initialValues?.description ?? "",
    ddEstimate: deal?.ddEstimate ?? "",
    bidEstimate: deal?.bidEstimate ?? "",
    awardedAmount: deal?.awardedAmount ?? "",
    propertyAddress: deal?.propertyAddress ?? "",
    propertyCity: deal?.propertyCity ?? "",
    propertyState: deal?.propertyState ?? "",
    propertyZip: deal?.propertyZip ?? "",
    officeCode: initialOfficeCode,
    projectTypeId: deal?.projectTypeId ?? initialValues?.projectTypeId ?? "",
    regionId: deal?.regionId ?? "",
    source: initialSourceIsCategory || !initialSource ? initialSource : "Other",
    sourceDetail: initialSourceIsCategory ? "" : initialSource,
    winProbability: deal?.winProbability?.toString() ?? "",
    expectedCloseDate: deal?.expectedCloseDate ?? "",
  });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [closeDateWarning, setCloseDateWarning] = useState<string | null>(null);
  const [regionManuallyOverridden, setRegionManuallyOverridden] = useState(() => Boolean(deal?.regionId));
  const isPropertyAddressManaged = Boolean(formData.propertyId);
  const selectedOfficeLabel =
    officeOptions.find((office) => office.code === formData.officeCode)?.label ?? "Select office";
  // The office picker is a project-number PREFIX only. Pickers + create target the rep's HOME (active)
  // office, so choosing DFW vs ATL never changes which companies/properties/reps are available nor where the
  // record is created — only the deal_number prefix.
  const { assignees, loading: assigneesLoading } = useTaskAssignees({ officeId: !isEdit ? homeOfficeId : null });
  const assigneeOptions = assignees.map((assignee) => ({ id: assignee.id, name: assignee.displayName }));

  // Default stageId when activeStages finishes loading and form stageId is still empty
  useEffect(() => {
    if (!isEdit && !formData.stageId && activeStages.length > 0) {
      setFormData((prev) => ({ ...prev, stageId: getDefaultDealStageId(stages) }));
    }
  }, [activeStages.length, formData.stageId, isEdit, stages]);

  useEffect(() => {
    if (isEdit) return;
    setFormData((prev) => {
      const officeCode = resolveDefaultOfficeCode({
        offices,
        homeOfficeId,
        currentOfficeCode: prev.officeCode,
      });
      return officeCode === prev.officeCode ? prev : { ...prev, officeCode };
    });
  }, [homeOfficeId, isEdit, offices]);

  const handleChange = (field: string, value: string) => {
    setFormData((prev) => {
      const next = { ...prev, [field]: value };
      if (field === "companyId") {
        next.propertyId = "";
      }
      // officeCode is a cosmetic prefix that no longer rescopes the data, so changing it must NOT clear the
      // company/property/rep selections (the pickers stay on the home office regardless of the prefix).
      if (field === "source" && value !== "Other") {
        next.sourceDetail = "";
      }
      return next;
    });
    if (fieldErrors[field]) {
      setFieldErrors((prev) => { const next = { ...prev }; delete next[field]; return next; });
    }
  };

  const handleRegionChange = (value: string) => {
    setRegionManuallyOverridden(true);
    handleChange("regionId", value);
  };

  useEffect(() => {
    setFormData((prev) => {
      const nextRegionId = applyDealRegionAutoSelection({
        regions,
        propertyState: prev.propertyState,
        currentRegionId: prev.regionId,
        manualOverride: regionManuallyOverridden,
      });
      return nextRegionId === prev.regionId ? prev : { ...prev, regionId: nextRegionId };
    });
  }, [regions, formData.propertyState, regionManuallyOverridden]);

  const validateDealForm = (): boolean => {
    const errs: Record<string, string> = {};
    const MAX_MONEY = 999999999;

    const monetary: Array<keyof typeof formData> = ["ddEstimate", "bidEstimate", "awardedAmount"];
    for (const field of monetary) {
      const raw = formData[field];
      if (raw !== "" && raw != null) {
        const n = parseFloat(raw as string);
        if (isNaN(n) || n < 0) {
          errs[field] = "Must be 0 or greater";
        } else if (n > MAX_MONEY) {
          errs[field] = "Must not exceed $999,999,999";
        }
      }
    }

    if (formData.winProbability !== "") {
      const wp = parseInt(formData.winProbability, 10);
      if (isNaN(wp) || wp < 0 || wp > 100) {
        errs.winProbability = "Must be between 0 and 100";
      }
    }

    if (formData.description.length > 5000) {
      errs.description = "Must be 5000 characters or fewer";
    }
    if (formData.source === "Other" && !formData.sourceDetail.trim()) {
      errs.sourceDetail = "Source detail is required when Source is Other";
    }

    setFieldErrors(errs);

    // Close date warning (non-blocking)
    if (formData.expectedCloseDate) {
      const closeDate = new Date(formData.expectedCloseDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (closeDate < today) {
        setCloseDateWarning("Expected close date is in the past");
      } else {
        setCloseDateWarning(null);
      }
    } else {
      setCloseDateWarning(null);
    }

    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      setError("Deal name is required");
      return;
    }
    if (!isEdit && !formData.assignedRepId) {
      setError("Assigned sales rep is required");
      return;
    }
    if (!formData.companyId || !formData.propertyId) {
      setError("Company and property are required");
      return;
    }
    if (!formData.stageId && !isEdit) {
      setError("Stage is required");
      return;
    }

    if (!validateDealForm()) return;

    setSubmitting(true);
    setError(null);

    try {
      const payload: Record<string, unknown> = {
        name: formData.name.trim(),
        companyId: formData.companyId,
        propertyId: formData.propertyId,
        description: formData.description.trim() || null,
        propertyAddress: formData.propertyAddress.trim() || null,
        propertyCity: formData.propertyCity.trim() || null,
        propertyState: formData.propertyState.trim() || null,
        propertyZip: formData.propertyZip.trim() || null,
        projectTypeId: formData.projectTypeId || null,
        regionId: formData.regionId || null,
        source:
          formData.source === "Other"
            ? formData.sourceDetail.trim() || null
            : formData.source.trim() || null,
        winProbability: formData.winProbability ? parseInt(formData.winProbability, 10) : null,
        expectedCloseDate: formData.expectedCloseDate || null,
      };

      if (!isBidBoardOwned) {
        payload.ddEstimate = formData.ddEstimate || null;
        payload.bidEstimate = formData.bidEstimate || null;
        payload.awardedAmount = formData.awardedAmount || null;
      }

      let result: Deal;
      if (isEdit) {
        if (!deal.sourceLeadId) {
          payload.migrationMode = true;
        }
        const resp = await updateDeal(deal.id, payload as Partial<Deal>);
        result = resp.deal;
      } else {
        if (!formData.officeCode) {
          setError("Cannot create deal: select an office (project-number prefix).");
          return;
        }
        if (!homeOfficeId) {
          setError("Cannot create deal: no active office. Contact admin.");
          return;
        }

        const selectedProjectType = projectTypeOptions.find((option) => option.id === formData.projectTypeId);

        payload.stageId = formData.stageId;
        payload.assignedRepId = formData.assignedRepId;
        payload.officeCode = formData.officeCode;
        if (selectedProjectType) {
          payload.projectType = selectedProjectType.name;
        }
        payload.creationContext = "direct";
        const resp = await createDeal(
          payload as Partial<Deal> & { name: string; stageId: string },
          { officeId: homeOfficeId }
        );
        result = resp.deal;
      }

      if (onSuccess) {
        onSuccess(result);
      } else {
        navigate(`/deals/${result.id}`);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save deal");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-3xl">
      {/* Basic Info */}
      <Card>
        <CardHeader>
          <CardTitle>Deal Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isEdit && deal && (
            <div className="space-y-2">
              <Label>Deal Number</Label>
              <Input value={deal.dealNumber} disabled />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="name">
              Deal Name <span className="text-red-500">*</span>
            </Label>
            <Input
              id="name"
              placeholder="e.g., Oakwood Apartments Reroofing"
              value={formData.name}
              onChange={(e) => handleChange("name", e.target.value)}
            />
          </div>

          {showRelationshipSelectors && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Company <span className="text-red-500">*</span></Label>
                <CompanySelector
                  value={formData.companyId || null}
                  onChange={(companyId) => handleChange("companyId", companyId)}
                  officeId={homeOfficeId ?? undefined}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>Property <span className="text-red-500">*</span></Label>
                <PropertySelector
                  companyId={formData.companyId || null}
                  value={formData.propertyId || null}
                  onChange={(propertyId) => handleChange("propertyId", propertyId)}
                  officeId={homeOfficeId ?? undefined}
                  required
                  repairIncompleteAddressOnSelect
                  onPropertySelected={(property) => {
                    setFormData((prev) => ({
                      ...prev,
                      propertyId: property.id,
                      propertyAddress: property.address ?? "",
                      propertyCity: property.city ?? "",
                      propertyState: property.state ?? "",
                      propertyZip: property.zip ?? "",
                    }));
                  }}
                  onPropertyRepaired={(property) => {
                    setFormData((prev) => ({
                      ...prev,
                      propertyId: property.id,
                      propertyAddress: property.address ?? "",
                      propertyCity: property.city ?? "",
                      propertyState: property.state ?? "",
                      propertyZip: property.zip ?? "",
                    }));
                  }}
                />
              </div>
            </div>
          )}

          {!isEdit && (
            <div className="space-y-2">
              <Label>Assigned Sales Rep <span className="text-red-500">*</span></Label>
              <Select
                value={formData.assignedRepId || "none"}
                onValueChange={(value) => handleChange("assignedRepId", value && value !== "none" ? value : "")}
                disabled={user?.role === "rep"}
              >
                <SelectTrigger>
                  <SelectValue placeholder={assigneesLoading ? "Loading assignees..." : "Select assignee"}>
                    {getSelectedOptionLabel(assigneeOptions, formData.assignedRepId, assigneesLoading ? "Loading assignees..." : "Select assignee")}
                  </SelectValue>
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
          )}

          {!isEdit && (
            <div className="space-y-2">
              <Label htmlFor="stage">
                Initial Stage <span className="text-red-500">*</span>
              </Label>
              <Select
                value={formData.stageId}
                onValueChange={(val) => handleChange("stageId", val ?? "")}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select stage">
                    {getSelectedOptionLabel(activeStages, formData.stageId, "Select stage")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {activeStages.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <textarea
              id="description"
              className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="Brief description of the deal..."
              value={formData.description}
              onChange={(e) => handleChange("description", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{formData.description.length}/5000</p>
            {fieldErrors.description && <p className="text-xs text-red-600">{fieldErrors.description}</p>}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="source">Source</Label>
              <Select
                value={formData.source || "none"}
                onValueChange={(value) => handleChange("source", value === "none" ? "" : value ?? "")}
              >
                <SelectTrigger id="source">
                  <SelectValue placeholder="Select source">
                    {formData.source || "Select source"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Select source</SelectItem>
                  {LEAD_SOURCE_CATEGORIES.map((sourceCategory) => (
                    <SelectItem key={sourceCategory} value={sourceCategory}>
                      {sourceCategory}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {formData.source === "Other" ? (
                <div className="mt-2 space-y-2">
                  <Label htmlFor="sourceDetail">Source detail</Label>
                  <Input
                    id="sourceDetail"
                    value={formData.sourceDetail}
                    onChange={(e) => handleChange("sourceDetail", e.target.value)}
                  />
                  {fieldErrors.sourceDetail && <p className="text-xs text-red-600">{fieldErrors.sourceDetail}</p>}
                </div>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="winProbability">Win Probability (%)</Label>
              <Input
                id="winProbability"
                type="number"
                min="0"
                max="100"
                placeholder="0-100"
                value={formData.winProbability}
                onChange={(e) => handleChange("winProbability", e.target.value)}
              />
              {fieldErrors.winProbability && <p className="text-xs text-red-600">{fieldErrors.winProbability}</p>}
            </div>
          </div>

          {!isEdit && (
            <div className="space-y-2">
              <Label htmlFor="officeCode">
                Office <span className="text-red-500">*</span>
              </Label>
              <Select
                value={formData.officeCode || "none"}
                onValueChange={(val) => handleChange("officeCode", val && val !== "none" ? val : "")}
              >
                <SelectTrigger id="officeCode">
                  <SelectValue placeholder="Select office">
                    {selectedOfficeLabel}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {officeOptions.length === 0 ? (
                    <SelectItem value="none" disabled>
                      No offices available
                    </SelectItem>
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
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="projectType">Project Type</Label>
              <Select
                value={formData.projectTypeId}
                onValueChange={(val) => handleChange("projectTypeId", val ?? "")}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select type">
                    {getSelectedOptionLabel(projectTypeOptions, formData.projectTypeId, "Select type")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {projectTypeHierarchy.flatMap((parent) => [
                    <SelectItem key={parent.id} value={parent.id} className="font-medium">
                      {parent.name}
                    </SelectItem>,
                    ...parent.children.map((child) => (
                      <SelectItem key={child.id} value={child.id} className="pl-6">
                        {child.name}
                      </SelectItem>
                    )),
                  ])}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="region">Region</Label>
              <Select
                value={formData.regionId}
                onValueChange={(val) => handleRegionChange(val ?? "")}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select region">
                    {getSelectedOptionLabel(regions, formData.regionId, "Select region")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {regions.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="expectedCloseDate">Expected Close Date</Label>
            <Input
              id="expectedCloseDate"
              type="date"
              value={formData.expectedCloseDate}
              onChange={(e) => handleChange("expectedCloseDate", e.target.value)}
            />
            {closeDateWarning && <p className="text-xs text-amber-600">{closeDateWarning}</p>}
          </div>
        </CardContent>
      </Card>

      {/* Estimates */}
      <Card>
        <CardHeader>
          <CardTitle>Estimates</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <FieldLockLabel
                htmlFor="ddEstimate"
                label="DD Estimate ($)"
                locked={isBidBoardOwned}
                message="DD estimate is mirrored from Bid Board after estimating handoff."
              />
              <Input
                id="ddEstimate"
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={formData.ddEstimate}
                disabled={isBidBoardOwned}
                onChange={(e) => handleChange("ddEstimate", e.target.value)}
              />
              {fieldErrors.ddEstimate && <p className="text-xs text-red-600">{fieldErrors.ddEstimate}</p>}
            </div>
            <div className="space-y-2">
              <FieldLockLabel
                htmlFor="bidEstimate"
                label="Bid Estimate ($)"
                locked={isBidBoardOwned}
                message="Bid estimate is mirrored from Bid Board after estimating handoff."
              />
              <Input
                id="bidEstimate"
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={formData.bidEstimate}
                disabled={isBidBoardOwned}
                onChange={(e) => handleChange("bidEstimate", e.target.value)}
              />
              {fieldErrors.bidEstimate && <p className="text-xs text-red-600">{fieldErrors.bidEstimate}</p>}
            </div>
            <div className="space-y-2">
              <FieldLockLabel
                htmlFor="awardedAmount"
                label="Awarded Amount ($)"
                locked={isBidBoardOwned}
                message="Awarded amount is mirrored from Bid Board after estimating handoff."
              />
              <Input
                id="awardedAmount"
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={formData.awardedAmount}
                disabled={isBidBoardOwned}
                onChange={(e) => handleChange("awardedAmount", e.target.value)}
              />
              {fieldErrors.awardedAmount && <p className="text-xs text-red-600">{fieldErrors.awardedAmount}</p>}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Property */}
      <Card>
        <CardHeader>
          <CardTitle>Property Location</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="propertyAddress">Address</Label>
            <Input
              id="propertyAddress"
              placeholder="123 Main St"
              value={formData.propertyAddress}
              readOnly={isPropertyAddressManaged}
              onChange={(e) => handleChange("propertyAddress", e.target.value)}
            />
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="propertyCity">City</Label>
              <Input
                id="propertyCity"
                placeholder="Dallas"
                value={formData.propertyCity}
                readOnly={isPropertyAddressManaged}
                onChange={(e) => handleChange("propertyCity", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="propertyState">State</Label>
              <Input
                id="propertyState"
                maxLength={2}
                placeholder="TX"
                value={formData.propertyState}
                readOnly={isPropertyAddressManaged}
                onChange={(e) =>
                  handleChange("propertyState", e.target.value.toUpperCase())
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="propertyZip">ZIP</Label>
              <Input
                id="propertyZip"
                maxLength={10}
                placeholder="75201"
                value={formData.propertyZip}
                readOnly={isPropertyAddressManaged}
                onChange={(e) => handleChange("propertyZip", e.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Error */}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={submitting}>
          {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {isEdit ? "Save Changes" : "Create Deal"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => navigate(-1)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function FieldLockLabel({
  htmlFor,
  label,
  locked,
  message,
}: {
  htmlFor: string;
  label: string;
  locked: boolean;
  message: string;
}) {
  return (
    <Label htmlFor={htmlFor} className="inline-flex items-center gap-1.5">
      {label}
      {locked ? (
        <span aria-label={message} title={message}>
          <Lock
            className="h-3.5 w-3.5 text-amber-600"
            aria-hidden="true"
          />
        </span>
      ) : null}
    </Label>
  );
}
