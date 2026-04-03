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
import { Loader2 } from "lucide-react";

interface DealFormProps {
  deal?: Deal; // If provided, we're editing; otherwise creating
  onSuccess?: (deal: Deal) => void;
}

export function DealForm({ deal, onSuccess }: DealFormProps) {
  const navigate = useNavigate();
  const { stages } = usePipelineStages();
  const { hierarchy: projectTypeHierarchy } = useProjectTypes();
  const { regions } = useRegions();

  const isEdit = !!deal;
  const activeStages = stages.filter((s) => !s.isTerminal);

  const [formData, setFormData] = useState({
    name: deal?.name ?? "",
    stageId: deal?.stageId ?? "",
    description: deal?.description ?? "",
    ddEstimate: deal?.ddEstimate ?? "",
    bidEstimate: deal?.bidEstimate ?? "",
    awardedAmount: deal?.awardedAmount ?? "",
    propertyAddress: deal?.propertyAddress ?? "",
    propertyCity: deal?.propertyCity ?? "",
    propertyState: deal?.propertyState ?? "",
    propertyZip: deal?.propertyZip ?? "",
    projectTypeId: deal?.projectTypeId ?? "",
    regionId: deal?.regionId ?? "",
    source: deal?.source ?? "",
    winProbability: deal?.winProbability?.toString() ?? "",
    expectedCloseDate: deal?.expectedCloseDate ?? "",
  });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [closeDateWarning, setCloseDateWarning] = useState<string | null>(null);

  // Default stageId when activeStages finishes loading and form stageId is still empty
  useEffect(() => {
    if (!isEdit && !formData.stageId && activeStages.length > 0) {
      setFormData((prev) => ({ ...prev, stageId: activeStages[0].id }));
    }
  }, [activeStages, formData.stageId, isEdit]);

  const handleChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (fieldErrors[field]) {
      setFieldErrors((prev) => { const next = { ...prev }; delete next[field]; return next; });
    }
  };

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
        description: formData.description.trim() || null,
        ddEstimate: formData.ddEstimate || null,
        bidEstimate: formData.bidEstimate || null,
        awardedAmount: formData.awardedAmount || null,
        propertyAddress: formData.propertyAddress.trim() || null,
        propertyCity: formData.propertyCity.trim() || null,
        propertyState: formData.propertyState.trim() || null,
        propertyZip: formData.propertyZip.trim() || null,
        projectTypeId: formData.projectTypeId || null,
        regionId: formData.regionId || null,
        source: formData.source.trim() || null,
        winProbability: formData.winProbability ? parseInt(formData.winProbability, 10) : null,
        expectedCloseDate: formData.expectedCloseDate || null,
      };

      let result: Deal;
      if (isEdit) {
        const resp = await updateDeal(deal.id, payload as Partial<Deal>);
        result = resp.deal;
      } else {
        payload.stageId = formData.stageId;
        const resp = await createDeal(payload as Partial<Deal> & { name: string; stageId: string });
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
                    {activeStages.find((s) => s.id === formData.stageId)?.name ?? "Select stage"}
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
              <Input
                id="source"
                placeholder="e.g., Bid Board, Referral, Cold Call"
                value={formData.source}
                onChange={(e) => handleChange("source", e.target.value)}
              />
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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="projectType">Project Type</Label>
              <Select
                value={formData.projectTypeId}
                onValueChange={(val) => handleChange("projectTypeId", val ?? "")}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select type" />
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
                onValueChange={(val) => handleChange("regionId", val ?? "")}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select region" />
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
              <Label htmlFor="ddEstimate">DD Estimate ($)</Label>
              <Input
                id="ddEstimate"
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={formData.ddEstimate}
                onChange={(e) => handleChange("ddEstimate", e.target.value)}
              />
              {fieldErrors.ddEstimate && <p className="text-xs text-red-600">{fieldErrors.ddEstimate}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="bidEstimate">Bid Estimate ($)</Label>
              <Input
                id="bidEstimate"
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={formData.bidEstimate}
                onChange={(e) => handleChange("bidEstimate", e.target.value)}
              />
              {fieldErrors.bidEstimate && <p className="text-xs text-red-600">{fieldErrors.bidEstimate}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="awardedAmount">Awarded Amount ($)</Label>
              <Input
                id="awardedAmount"
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={formData.awardedAmount}
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
