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
import { useProjectTypes, useRegions } from "@/hooks/use-pipeline-config";
import { useTaskAssignees } from "@/hooks/use-task-assignees";
import { useSalesReps } from "@/hooks/use-sales-reps";
import { createServiceOpportunity, type Deal } from "@/hooks/use-deals";
import { applyDealRegionAutoSelection } from "./deal-region-auto-select";
import { getSelectedOptionLabel } from "./deal-form.helpers";
import { useAuth } from "@/lib/auth";
import {
  appendOfficeIdSearch,
  buildOfficeCodePrefixOptions,
  resolveDefaultOfficeCode,
} from "@/lib/office-selection";

interface ServiceOpportunityFormProps {
  onSuccess?: (deal: Deal) => void;
  // Prefill from whichever entry point sent the rep here (today: the property page). The POINT is that the
  // property is ALREADY chosen, so nobody retypes an address and mints a duplicate property record. These
  // are seeded straight into the initial state below and NEVER replayed through handleChange — replaying a
  // company change is exactly what would clear the prefilled property on mount.
  initialValues?: {
    name?: string;
    companyId?: string;
    propertyId?: string;
  };
  // The office whose data this form works in, for an entry point that arrives WITH one (the property page
  // threads ?officeId). A prefilled property lives in that office's Postgres schema, so its lookup and the
  // create must target the same office — otherwise a rep whose home office differs resolves nothing and
  // creates in the wrong tenant. Omitted (the deals-page entry point) keeps the historical behaviour: the
  // rep's stable home office.
  officeId?: string | null;
  // Where Cancel goes. Supplied by an entry point that knows where the rep came from, because the form's own
  // navigate(-1) has nowhere to go on a fresh tab or a shared link — and then Cancel would sit two inches
  // from a Back link that works, doing nothing. Omitted keeps the historical navigate(-1).
  cancelTo?: string;
}

function normalizeServiceCandidate(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
}

export function ServiceOpportunityForm({
  onSuccess,
  initialValues,
  officeId,
  cancelTo,
}: ServiceOpportunityFormProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { offices } = useAccessibleOffices();
  const { hierarchy: projectTypeHierarchy } = useProjectTypes();
  const { regions, loading: regionsLoading } = useRegions();

  // The STABLE home office (primary office), NOT the switchable active office — the cosmetic office prefix
  // is decoupled from any session office switch, so pickers + create always use the rep's home data office.
  const homeOfficeId = user?.officeId ?? null;
  // Every office-scoped read and the create below use THIS id: the caller's office when it supplied one,
  // the home office otherwise. Nothing else in the form may reach for homeOfficeId directly, or the two
  // would drift and we would resolve a property in one office and create the deal in another.
  const effectiveOfficeId = officeId ?? homeOfficeId;
  const officeOptions = buildOfficeCodePrefixOptions();
  const initialOfficeCode = resolveDefaultOfficeCode({
    offices,
    homeOfficeId: effectiveOfficeId,
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
    name: initialValues?.name ?? "",
    companyId: initialValues?.companyId ?? "",
    propertyId: initialValues?.propertyId ?? "",
    description: "",
    assignedRepId: user?.role === "rep" ? user.id : "",
    salesSourceUserId: "",
    officeCode: initialOfficeCode,
    expectedCloseDate: "",
    winProbability: "",
    regionId: "",
    // Captured SYNCHRONOUSLY from PropertySelector's onPropertySelected (the record it already loaded,
    // including search results beyond page 1). No async by-id fetch, so a fast select-then-Create can't
    // race: the region is derived from the property the user actually picked, never a stale/blank one.
    propertyState: "",
  });
  const [regionManuallyOverridden, setRegionManuallyOverridden] = useState(false);
  // The company/property pair we were opened with, frozen at first render (lazy init — never recomputed, so
  // a re-render can neither resurrect nor lose it). Two jobs: explain a property that has no owner company,
  // and make a cleared prefill recoverable in one click.
  const [preloaded] = useState(() => ({
    companyId: initialValues?.companyId ?? "",
    propertyId: initialValues?.propertyId ?? "",
  }));
  // A company change has dropped the property we were opened with. Correct behaviour (a property belongs to
  // exactly one company) but never a dead end — losing the prefill is how a rep ends up at "Add New Property"
  // typing an address that already exists.
  const preloadedPropertyCleared =
    Boolean(preloaded.propertyId) && formData.propertyId !== preloaded.propertyId;
  // The property arrived with no owner company. The server requires property.companyId === companyId, so no
  // company choice can make this pair valid — say so up front rather than let the rep fill the whole form
  // and eat a 400 (or go mint the property a second time under some other company).
  const preloadedPropertyHasNoCompany = Boolean(preloaded.propertyId) && !preloaded.companyId;
  // The id of the property whose RECORD we actually hold (emitted by PropertySelector on pick and on
  // resolution of an externally-set value).
  const [resolvedPropertyId, setResolvedPropertyId] = useState("");
  // A picked property resolves synchronously, but a PREFILLED one is just an id until an async
  // /properties/:id lookup returns. In that window propertyState is still "" — so regionPending sees nothing
  // pending and Create is live, and a fast rep saves a region-less deal that falls out of the region
  // reports. Prefill is what made that reachable (nobody could click Create that fast before), so prefill
  // has to hold the door: no submit until the record behind the id is in hand.
  const propertyResolutionPending = Boolean(formData.propertyId) && resolvedPropertyId !== formData.propertyId;
  // The non-Service escape hatch has to leave with everything the rep already has. A bare /leads/new drops
  // the company, the property and the name, so the rep lands on an empty form and retypes the address —
  // a second property record for one building, which is the exact failure this entry point exists to
  // prevent. Same param shape as the property page's New lead link, read from LIVE state so it keeps up
  // with edits rather than replaying a stale prefill.
  const leadEscapeHref = (() => {
    const params = new URLSearchParams();
    if (formData.propertyId) params.set("propertyId", formData.propertyId);
    if (formData.companyId) params.set("companyId", formData.companyId);
    const trimmedName = formData.name.trim();
    if (trimmedName) params.set("name", trimmedName);
    const query = params.toString();
    return appendOfficeIdSearch(query ? `/leads/new?${query}` : "/leads/new", officeId);
  })();

  // Region auto-detects from the selected property's state (same rule + columns as the deal form), but a
  // manual pick wins.
  const selectedPropertyState = formData.propertyState;
  useEffect(() => {
    setFormData((prev) => {
      const nextRegionId = applyDealRegionAutoSelection({
        regions,
        propertyState: selectedPropertyState,
        currentRegionId: prev.regionId,
        manualOverride: regionManuallyOverridden,
      });
      return nextRegionId === prev.regionId ? prev : { ...prev, regionId: nextRegionId };
    });
  }, [regions, selectedPropertyState, regionManuallyOverridden]);
  // When the region was auto-derived (not manually picked), show it as a not-yet-saved suggestion.
  const regionIsSuggestion = !regionManuallyOverridden && Boolean(formData.regionId);
  const regionSuggestionName = regionIsSuggestion
    ? getSelectedOptionLabel(regions, formData.regionId, "")
    : "";
  // A picked property has a state to map, but regions haven't loaded yet (cold/slow /pipeline/regions) and
  // the user hasn't manually chosen a region — so auto-detect can't resolve one. Block Create until regions
  // arrive (the effect then fills regionId), otherwise the deal would save region-less and fall out of the
  // region reports. Once loaded-but-empty or the property has no state, this is false (no deadlock).
  const regionPending =
    regionsLoading && Boolean(formData.propertyState) && !regionManuallyOverridden && !formData.regionId;

  const handleRegionChange = (value: string) => {
    setRegionManuallyOverridden(true);
    handleChange("regionId", value);
  };
  // The office picker is a project-number PREFIX only: pickers + create target the rep's HOME (active)
  // office, so choosing DFW vs ATL never changes which companies/properties/reps are available nor where the
  // opportunity is created — only the deal_number prefix.
  const selectedOfficeLabel =
    officeOptions.find((office) => office.code === formData.officeCode)?.label ?? "Select office";
  const { assignees, loading: assigneesLoading } = useTaskAssignees({ officeId: effectiveOfficeId });
  // "sales-source" scopes the feed to the office's internal CRM roster (any role except field_contractor —
  // reps, directors like Chase Kelly, etc., matching assertSalesSourceIsCrmUser), so a plain rep sees real
  // source choices (not just themselves) and no pick 422s on submit.
  const { salesReps, loading: salesRepsLoading } = useSalesReps(effectiveOfficeId ?? undefined, {
    purpose: "sales-source",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFormData((prev) => {
      const officeCode = resolveDefaultOfficeCode({
        offices,
        homeOfficeId: effectiveOfficeId,
        currentOfficeCode: prev.officeCode,
      });
      return officeCode === prev.officeCode ? prev : { ...prev, officeCode };
    });
  }, [effectiveOfficeId, offices]);

  const handleChange = (field: keyof typeof formData, value: string) => {
    setFormData((prev) => {
      const next = { ...prev, [field]: value };
      // Switching companies must drop the property — a property belongs to exactly one company and the
      // server rejects a mismatched pair. Guarded on an ACTUAL change: a picker that re-emits the company it
      // is already showing (value resolution / remount) would otherwise silently wipe a prefilled property,
      // which is precisely the duplicate-address failure the prefill exists to prevent.
      if (field === "companyId" && value !== prev.companyId) {
        next.propertyId = "";
        next.propertyState = "";
      }
      // Clearing the property must drop its captured state too, so region auto-detect doesn't keep deriving
      // from a property that's no longer selected (onPropertySelected only fires on a NEW selection).
      if (field === "propertyId" && !value) {
        next.propertyState = "";
      }
      // officeCode is a cosmetic prefix that no longer rescopes the data, so changing it must NOT clear the
      // company/property/rep selections (the pickers stay on the home office regardless of the prefix).
      // If the assigned rep is changed to the current sales source, clear the sales source — self-sourcing
      // would cause a floor-gate double-count (the same person would appear in both roles).
      if (field === "assignedRepId" && next.salesSourceUserId && next.salesSourceUserId === value) {
        next.salesSourceUserId = "";
      }
      return next;
    });
    setError(null);
  };

  // Puts BOTH ids back in a single update. Routing this through handleChange would set the company and then
  // immediately clear the property again, which is the whole bug this restore exists to undo.
  const restorePreloadedSelection = () => {
    setFormData((prev) => ({
      ...prev,
      companyId: preloaded.companyId,
      propertyId: preloaded.propertyId,
      // PropertySelector re-emits the resolved record whenever its value changes, so the state (and with it
      // the auto-detected region) refills on its own — blanking it here just avoids a frame of stale region.
      propertyState: "",
    }));
    // …and because the state is blank again, the record counts as un-held until that re-emit arrives, or a
    // Create fired in between would slip through the region guard exactly as it would on a fresh prefill.
    setResolvedPropertyId("");
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
    if (!effectiveOfficeId || !formData.officeCode) {
      setError("Cannot create opportunity: no active office. Contact admin.");
      return;
    }
    if (!serviceProjectType) {
      setError("Cannot create opportunity: Service project type is unavailable. Contact admin.");
      return;
    }
    if (formData.winProbability !== "") {
      // Number() (not parseInt) so exponent input like "1e2" is read as 100, not 1; require a whole 0-100.
      const wp = Number(formData.winProbability);
      if (!Number.isInteger(wp) || wp < 0 || wp > 100) {
        setError("Win probability must be a whole number between 0 and 100");
        return;
      }
    }
    // Same safety net one step earlier: a prefilled property is an id until its record arrives, and until
    // then we cannot even tell whether a region is owed.
    if (propertyResolutionPending) {
      setError("Loading the property — one moment, then Create so the deal lands in the right region report.");
      return;
    }
    // Safety net for the button guard: don't create while a region is still resolving for the selected
    // property, or the deal would save region-less and miss the region reports.
    if (regionPending) {
      setError("Loading regions — one moment, then Create so the deal lands in the right region report.");
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
          salesSourceUserId: formData.salesSourceUserId || null,
          description: formData.description.trim() || null,
          expectedCloseDate: formData.expectedCloseDate || null,
          winProbability: formData.winProbability !== "" ? Number(formData.winProbability) : null,
          regionId: formData.regionId || null,
          officeCode: formData.officeCode, // cosmetic prefix; the record is created on the office below
          projectType: "service",
          projectTypeId: serviceProjectType.id,
        },
        { officeId: effectiveOfficeId }
      );

      if (onSuccess) {
        onSuccess(resp.deal);
      } else {
        // The deal was created in effectiveOfficeId, and DealDetailPage derives its tenant from ?officeId —
        // so a redirect without it loads a cross-office deal from the viewer's default office and shows
        // "not found" for a record that saved perfectly. The rep then creates it a second time.
        navigate(appendOfficeIdSearch(`/deals/${resp.deal.id}`, officeId));
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
              <Link to={leadEscapeHref} className="font-semibold text-brand-red underline-offset-4 hover:underline">
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

          {/* A property record with no owner company should not exist — properties.company_id is NOT NULL —
              so this is a data fault, not a state the rep can walk out of. Nothing in the app can set an
              existing property's company either: the PATCH allowlist excludes it, the edit page has no such
              field, and the only writer is the director-gated company MERGE (which repoints one company to
              another and cannot fill an empty one). So this says what is true and stops, rather than sending
              the rep to a page that cannot help — the one thing it must never do is imply "make a new
              property", which is how the duplicate address gets created. */}
          {preloadedPropertyHasNoCompany ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
              <p className="font-semibold">This property has no owner company.</p>
              <p className="mt-1">
                A service opportunity is created for the company that owns the property, so this one can&apos;t be
                saved — and a property&apos;s company can&apos;t be changed from the app. Ask an admin to fix the
                property record. Don&apos;t re-enter the address here: that creates a second property for the same
                building.
              </p>
            </div>
          ) : null}

          {preloadedPropertyCleared ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
              <p>
                Changing the company cleared the property this page was opened with. Restore it if that
                wasn&apos;t intentional — re-adding the address would create a duplicate property.
              </p>
              <Button type="button" size="sm" variant="outline" onClick={restorePreloadedSelection}>
                Restore property
              </Button>
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Company <span className="text-red-500">*</span></Label>
              <CompanySelector
                value={formData.companyId || null}
                onChange={(companyId) => handleChange("companyId", companyId)}
                officeId={effectiveOfficeId ?? undefined}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Property <span className="text-red-500">*</span></Label>
              <PropertySelector
                companyId={formData.companyId || null}
                value={formData.propertyId || null}
                onChange={(propertyId) => handleChange("propertyId", propertyId)}
                // Capture the picked property's state synchronously (fires on click + on value resolution
                // for search-selected properties) so region auto-detect never races a separate fetch.
                // Recording WHICH property this record was for is what lets a prefilled id — resolved
                // asynchronously, long after Create becomes clickable — hold submit until its state lands.
                onPropertySelected={(property) => {
                  setFormData((prev) => ({ ...prev, propertyState: property.state ?? "" }));
                  setResolvedPropertyId(property.id);
                }}
                officeId={effectiveOfficeId ?? undefined}
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
            <Label>Sales Source (optional)</Label>
            <Select
              value={formData.salesSourceUserId || "__none__"}
              onValueChange={(v) => handleChange("salesSourceUserId", v && v !== "__none__" ? v : "")}
            >
              <SelectTrigger>
                <SelectValue placeholder={salesRepsLoading ? "Loading reps..." : "None"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {salesReps.filter((r) => r.id !== formData.assignedRepId).map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Set at creation. Admins and directors can update it on the deal detail page.
            </p>
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

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="winProbability">Win Probability (%)</Label>
              <Input
                id="winProbability"
                type="number"
                min="0"
                max="100"
                placeholder="0-100"
                value={formData.winProbability}
                onChange={(event) => handleChange("winProbability", event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="region">Region</Label>
              <Select
                value={formData.regionId || "none"}
                onValueChange={(val) => handleRegionChange(val && val !== "none" ? val : "")}
              >
                <SelectTrigger id="region">
                  <SelectValue placeholder="Select region">
                    {regionIsSuggestion
                      ? `Auto: ${regionSuggestionName}`
                      : getSelectedOptionLabel(regions, formData.regionId, "Select region")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Select region</SelectItem>
                  {regions.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {regionIsSuggestion && (
                <p className="text-xs text-amber-600">
                  Auto-detected {regionSuggestionName} from {selectedPropertyState} — not saved yet. Create to confirm.
                </p>
              )}
            </div>
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
        <Button
          type="submit"
          disabled={submitting || regionPending || propertyResolutionPending}
          title={propertyResolutionPending ? "Loading property…" : regionPending ? "Loading regions…" : undefined}
        >
          {submitting || regionPending || propertyResolutionPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Create Service Opportunity
        </Button>
        <Button type="button" variant="outline" onClick={() => (cancelTo ? navigate(cancelTo) : navigate(-1))}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
