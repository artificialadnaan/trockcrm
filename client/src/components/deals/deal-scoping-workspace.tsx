import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  FileText,
  Image,
  Loader2,
  Upload,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  activateServiceHandoff,
  getDealScopingIntake,
  type DealDetail,
  type DealResolvedFields,
  type DealScopingAttachmentRequirement,
  type DealScopingIntake,
  type DealScopingReadiness,
  linkExistingScopingAttachment,
  patchDealScopingIntake,
  patchResolvedDealFields,
  type WorkflowRoute,
} from "@/hooks/use-deals";
import { type FileRecord, uploadFile, useFiles } from "@/hooks/use-files";
import { useProjectTypes } from "@/hooks/use-pipeline-config";
import { PropertySelector } from "@/components/properties/property-selector";
import {
  buildScopingSeedFromResolvedFields,
  buildScopingSeedFromDeal,
  formatScopingAttachmentLabel,
  formatScopingFieldLabel,
  getScopingCompletionCounts,
  summarizeScopingRoute,
} from "@/lib/scoping-intake";

type SectionKey =
  | "projectOverview"
  | "opportunity"
  | "propertyDetails"
  | "scopeSummary"
  | "attachments";

const SECTION_ORDER: Array<{ key: SectionKey; label: string }> = [
  { key: "projectOverview", label: "Project Overview" },
  { key: "opportunity", label: "Opportunity Review" },
  { key: "propertyDetails", label: "Property Details" },
  { key: "scopeSummary", label: "Scope Summary" },
  { key: "attachments", label: "Attachments" },
];

const ATTACHMENT_REQUIREMENTS: Array<{
  key: "scope_docs" | "site_photos";
  label: string;
  category: "other" | "photo";
  icon: typeof FileText;
  hint: string;
}> = [
  {
    key: "scope_docs",
    label: "Scope docs",
    category: "other",
    icon: FileText,
    hint: "Upload scopes, plans, and estimating starter documents.",
  },
  {
    key: "site_photos",
    label: "Site photos",
    category: "photo",
    icon: Image,
    hint: "Upload current-condition photos that estimating or service needs immediately.",
  },
];

const ATTACHMENT_REQUIREMENT_BY_KEY = Object.fromEntries(
  ATTACHMENT_REQUIREMENTS.map((requirement) => [requirement.key, requirement])
) as Record<"scope_docs" | "site_photos", (typeof ATTACHMENT_REQUIREMENTS)[number]>;

const FILE_CATEGORY_LABELS: Record<string, string> = {
  photo: "Photo",
  other: "Other",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeSectionData(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...base };

  for (const [key, value] of Object.entries(incoming)) {
    if (isRecord(value) && isRecord(next[key])) {
      next[key] = mergeSectionData(
        next[key] as Record<string, unknown>,
        value
      );
      continue;
    }

    next[key] = value;
  }

  return next;
}

function buildWorkspaceSectionData(
  deal: DealDetail,
  intake?: DealScopingIntake | null,
  resolved?: DealResolvedFields | null
) {
  const seed = resolved ? buildScopingSeedFromResolvedFields(resolved) : buildScopingSeedFromDeal(deal);
  return mergeSectionData(seed, isRecord(intake?.sectionData) ? intake!.sectionData as Record<string, unknown> : {});
}

function getSectionValue(
  sectionData: Record<string, unknown>,
  section: SectionKey,
  field: string
) {
  const sectionValue = sectionData[section];
  if (!isRecord(sectionValue)) {
    return "";
  }
  const value = sectionValue[field];
  return typeof value === "string" ? value : "";
}

function getReadinessTone(status: DealScopingReadiness["status"]) {
  if (status === "activated") return "bg-green-50 text-green-700 border-green-200";
  if (status === "ready") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  return "bg-amber-50 text-amber-700 border-amber-200";
}

function getProjectTypeLabel(
  projectTypes: Array<{ id: string; name: string }>,
  projectTypeId: string | null
) {
  if (!projectTypeId) {
    return "Unassigned";
  }

  return projectTypes.find((type) => type.id === projectTypeId)?.name ?? "Unassigned";
}

function getSelectDisplayLabel(
  value: string,
  options: Record<string, string>,
  fallback: string
) {
  return options[value] ?? fallback;
}

function getDefaultAttachmentRequirementKeys(route: WorkflowRoute) {
  return route === "service" ? ["site_photos"] : ["scope_docs", "site_photos"];
}

function normalizeWorkspaceReadiness(
  readiness: DealScopingReadiness,
  route: WorkflowRoute
) {
  const requiredAttachmentKeys =
    readiness.requiredAttachmentKeys.length > 0
      ? readiness.requiredAttachmentKeys
      : getDefaultAttachmentRequirementKeys(route);
  const attachmentRequirements = requiredAttachmentKeys
    .map((key) => {
      const baseRequirement =
        ATTACHMENT_REQUIREMENT_BY_KEY[key as keyof typeof ATTACHMENT_REQUIREMENT_BY_KEY];
      if (!baseRequirement) {
        return null;
      }

      const existingRequirement = readiness.attachmentRequirements.find(
        (requirement) => requirement.key === key
      );

      return (
        existingRequirement ?? {
          key,
          category: baseRequirement.category,
          label: baseRequirement.label,
          satisfied: !(readiness.errors.attachments[key]?.length ?? 0),
        }
      );
    })
    .filter((requirement): requirement is DealScopingAttachmentRequirement => Boolean(requirement));

  return {
    ...readiness,
    requiredAttachmentKeys,
    attachmentRequirements,
  };
}

export function DealScopingWorkspace({
  deal,
  onDealUpdated,
}: {
  deal: DealDetail;
  onDealUpdated: () => void;
}) {
  const { projectTypes } = useProjectTypes();
  const { files, refetch: refetchFiles } = useFiles({
    dealId: deal.id,
    limit: 50,
  });

  const [intake, setIntake] = useState<DealScopingIntake | null>(null);
  const [readiness, setReadiness] = useState<DealScopingReadiness | null>(null);
  const [resolvedFields, setResolvedFields] = useState<DealResolvedFields | null>(null);
  const [sectionData, setSectionData] = useState<Record<string, unknown>>({});
  const [projectTypeId, setProjectTypeId] = useState<string | null>(deal.projectTypeId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [activatingService, setActivatingService] = useState(false);
  const lastSavedFingerprintRef = useRef("");
  const hydrationCompleteRef = useRef(false);
  const activeWorkflowRoute: WorkflowRoute = resolvedFields?.workflowRoute ?? deal.workflowRoute ?? "normal";
  const activeCompanyId = resolvedFields?.companyId ?? deal.companyId;
  const activePropertyId = resolvedFields?.propertyId ?? deal.propertyId;
  const projectTypeLabel = getProjectTypeLabel(projectTypes, projectTypeId);
  const preBidMeetingLabel = getSelectDisplayLabel(
    getSectionValue(sectionData, "opportunity", "preBidMeetingCompleted"),
    { yes: "Completed" },
    "Pending"
  );
  const siteVisitDecisionLabel = getSelectDisplayLabel(
    getSectionValue(sectionData, "opportunity", "siteVisitDecision"),
    {
      required: "Site Visit Required",
      not_required: "No Site Visit Required",
    },
    "Pending"
  );
  const siteVisitCompletedLabel = getSelectDisplayLabel(
    getSectionValue(sectionData, "opportunity", "siteVisitCompleted"),
    { completed: "Completed" },
    "Pending"
  );

  const loadIntake = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getDealScopingIntake(deal.id);
      const nextSectionData = buildWorkspaceSectionData(deal, result.intake, result.resolved);
      setIntake(result.intake);
      setReadiness(normalizeWorkspaceReadiness(result.readiness, activeWorkflowRoute));
      setResolvedFields(result.resolved);
      setSectionData(nextSectionData);
      setProjectTypeId(result.intake.projectTypeId ?? result.resolved.projectTypeId ?? deal.projectTypeId);
      lastSavedFingerprintRef.current = JSON.stringify({
        projectTypeId: result.intake.projectTypeId ?? result.resolved.projectTypeId ?? deal.projectTypeId,
        sectionData: nextSectionData,
      });
      hydrationCompleteRef.current = true;
      setSaveState("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load scoping intake");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    hydrationCompleteRef.current = false;
    void loadIntake();
  }, [deal.id]);

  useEffect(() => {
    if (!hydrationCompleteRef.current) {
      return;
    }

    const fingerprint = JSON.stringify({ projectTypeId, sectionData });
    if (fingerprint === lastSavedFingerprintRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(async () => {
      setSaveState("saving");
      try {
        const result = await patchDealScopingIntake(deal.id, {
          projectTypeId,
          sectionData,
        });
        const nextSectionData = buildWorkspaceSectionData(deal, result.intake, result.resolved);
        setIntake(result.intake);
        setReadiness(normalizeWorkspaceReadiness(result.readiness, activeWorkflowRoute));
        setResolvedFields(result.resolved);
        setSectionData(nextSectionData);
        lastSavedFingerprintRef.current = JSON.stringify({
          projectTypeId,
          sectionData: nextSectionData,
        });
        setSaveState("saved");
        onDealUpdated();
        window.setTimeout(() => setSaveState("idle"), 1200);
      } catch (err) {
        setSaveState("error");
        setError(err instanceof Error ? err.message : "Autosave failed");
      }
    }, 700);

    return () => window.clearTimeout(timeoutId);
  }, [activeWorkflowRoute, deal, deal.id, onDealUpdated, projectTypeId, sectionData]);

  const completionCounts = getScopingCompletionCounts(readiness?.completionState);
  const attachmentRequirements = readiness?.attachmentRequirements ?? [];
  const visibleAttachmentRequirements = useMemo(() => {
    const requirementKeys =
      readiness?.requiredAttachmentKeys ??
      ATTACHMENT_REQUIREMENTS.map((requirement) => requirement.key);

    return requirementKeys
      .map((key) => {
        const baseRequirement =
          ATTACHMENT_REQUIREMENT_BY_KEY[key as keyof typeof ATTACHMENT_REQUIREMENT_BY_KEY];
        if (!baseRequirement) {
          return null;
        }

        return {
          ...baseRequirement,
          status:
            attachmentRequirements.find(
              (requirement) => requirement.key === key
            ) ?? null,
        };
      })
      .filter((requirement): requirement is (typeof ATTACHMENT_REQUIREMENTS)[number] & { status: DealScopingAttachmentRequirement | null } => Boolean(requirement));
  }, [attachmentRequirements, readiness?.requiredAttachmentKeys]);
  const visibleSections = useMemo(
    () =>
      SECTION_ORDER.filter((section) =>
        section.key === "attachments" || Boolean(readiness?.completionState[section.key])
      ),
    [readiness?.completionState]
  );
  const linkedFilesByRequirement = useMemo(() => {
    const map = new Map<string, FileRecord[]>();
    for (const requirement of ATTACHMENT_REQUIREMENTS) {
      map.set(requirement.key, []);
    }
    for (const file of files) {
      const key = file.intakeRequirementKey ?? "";
      if (!map.has(key)) continue;
      map.get(key)!.push(file);
    }
    return map;
  }, [files]);
  const unlinkedFiles = useMemo(
    () => files.filter((file) => !file.intakeRequirementKey),
    [files]
  );

  const updateField = (section: SectionKey, field: string, value: string) => {
    setSectionData((current) =>
      mergeSectionData(current, {
        [section]: {
          ...(isRecord(current[section]) ? current[section] : {}),
          [field]: value,
        },
      })
    );
    setError(null);
  };

  const handleLinkExisting = async (fileId: string, requirementKey: string) => {
    try {
      await linkExistingScopingAttachment(deal.id, {
        fileId,
        intakeSection: "attachments",
        intakeRequirementKey: requirementKey,
      });
      await Promise.all([refetchFiles(), loadIntake()]);
      toast.success(`Linked file to ${formatScopingAttachmentLabel(requirementKey)}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to link file");
    }
  };

  const handlePropertyChange = async (propertyId: string) => {
    setSaveState("saving");
    try {
      const result = await patchResolvedDealFields(deal.id, { propertyId });
      const nextResolved = result.resolved.resolved;
      setResolvedFields(nextResolved);
      setSectionData((current) =>
        mergeSectionData(current, buildScopingSeedFromResolvedFields(nextResolved))
      );
      setSaveState("saved");
      window.setTimeout(() => setSaveState("idle"), 1200);
    } catch (err) {
      setSaveState("error");
      setError(err instanceof Error ? err.message : "Failed to change property");
    }
  };

  const handleUpload = async (
    requirement: (typeof ATTACHMENT_REQUIREMENTS)[number],
    fileList: FileList | null
  ) => {
    if (!fileList?.length) return;

    setUploadingKey(requirement.key);
    try {
      for (const file of Array.from(fileList)) {
        const uploaded = await uploadFile({
          file,
          category: requirement.category,
          dealId: deal.id,
        });
        await linkExistingScopingAttachment(deal.id, {
          fileId: uploaded.id,
          intakeSection: "attachments",
          intakeRequirementKey: requirement.key,
        });
      }
      await Promise.all([refetchFiles(), loadIntake()]);
      toast.success(`${requirement.label} uploaded and linked.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploadingKey(null);
    }
  };

  const handleActivateService = async () => {
    setActivatingService(true);
    try {
      await activateServiceHandoff(deal.id);
      await loadIntake();
      onDealUpdated();
      toast.success("Service handoff activated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to activate service handoff");
    } finally {
      setActivatingService(false);
    }
  };

  if (loading) {
    return <div className="h-72 animate-pulse rounded-lg bg-muted" />;
  }

  if (error && !readiness) {
    return (
      <Card>
        <CardContent className="py-8">
          <p className="text-sm text-red-600">{error}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
        <Card size="sm">
          <CardHeader>
            <CardTitle>Scoping Progress</CardTitle>
            <CardDescription>
              Sales intake must be complete before this deal can move forward.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className={`rounded-lg border px-3 py-2 text-sm ${getReadinessTone(readiness?.status ?? "draft")}`}>
              <div className="font-medium">
                {summarizeScopingRoute(activeWorkflowRoute)}
              </div>
              <div className="mt-1 text-xs">
                {completionCounts.completed}/{completionCounts.total} sections complete
              </div>
            </div>

            <div className="space-y-2">
              {visibleSections.map((section) => {
                const entry = readiness?.completionState[section.key];
                const complete = entry?.isComplete ?? false;
                return (
                  <div key={section.key} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                    <span>{section.label}</span>
                    {complete ? (
                      <CheckCircle2 className="h-4 w-4 text-green-600" />
                    ) : (
                      <Clock3 className="h-4 w-4 text-amber-500" />
                    )}
                  </div>
                );
              })}
            </div>

            <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              {saveState === "saving" && "Autosaving changes..."}
              {saveState === "saved" && "All changes saved."}
              {saveState === "error" && "Autosave failed. Keep editing and retry."}
              {saveState === "idle" && `Last saved ${intake?.lastAutosavedAt ? new Date(intake.lastAutosavedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "just now"}.`}
            </div>
          </CardContent>
        </Card>

        {readiness && (readiness.errors.sections && Object.keys(readiness.errors.sections).length > 0 || readiness.errors.attachments && Object.keys(readiness.errors.attachments).length > 0) && (
          <Card size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                Blocking Items
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {Object.entries(readiness.errors.sections).flatMap(([section, fields]) =>
                fields.map((field) => (
                  <div key={`${section}.${field}`} className="text-red-600">
                    {formatScopingFieldLabel(`${section}.${field}`)}
                  </div>
                ))
              )}
              {attachmentRequirements
                .filter((attachment) => !attachment.satisfied)
                .map((attachment) => (
                  <div key={attachment.key} className="text-red-600">
                    {formatScopingAttachmentLabel(attachment.key)} ({FILE_CATEGORY_LABELS[attachment.category] ?? attachment.category})
                  </div>
                ))}
            </CardContent>
          </Card>
        )}
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Scoping Workspace</CardTitle>
            <CardDescription>
              Prefilled deal data is editable here and reused downstream for Bid Board handoff.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="workflowRoute">Workflow Route</Label>
              <div
                id="workflowRoute"
                className="flex h-10 items-center rounded-md border px-3 text-sm text-muted-foreground"
              >
                {activeWorkflowRoute === "service" ? "Service" : "Standard"}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="projectTypeId">Project Type</Label>
              <Select
                value={projectTypeId ?? "__none__"}
                onValueChange={(value) => setProjectTypeId(value === "__none__" ? null : value)}
              >
                <SelectTrigger id="projectTypeId">
                  <SelectValue>{projectTypeLabel}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Unassigned</SelectItem>
                  {projectTypes.map((type) => (
                    <SelectItem key={type.id} value={type.id}>
                      {type.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Project Overview</CardTitle>
            <CardDescription>Route, property identity, and estimating kickoff timing.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="propertyName">Property Name</Label>
              <div
                id="propertyName"
                className="flex h-10 items-center rounded-md border bg-muted/40 px-3 text-sm text-muted-foreground"
              >
                {getSectionValue(sectionData, "projectOverview", "propertyName") || "Unassigned"}
              </div>
            </div>
            {activeWorkflowRoute === "normal" && (
              <div className="space-y-2">
                <Label htmlFor="bidDueDate">Bid Due Date</Label>
                <Input
                  id="bidDueDate"
                  type="date"
                  value={getSectionValue(sectionData, "projectOverview", "bidDueDate")}
                  onChange={(event) => updateField("projectOverview", "bidDueDate", event.target.value)}
                />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Opportunity Review</CardTitle>
            <CardDescription>
              Capture the pre-bid meeting and site visit decision before deeper estimating work.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="preBidMeetingCompleted">Pre-Bid Meeting Completed</Label>
              <Select
                value={getSectionValue(sectionData, "opportunity", "preBidMeetingCompleted") || "__unset__"}
                onValueChange={(value) =>
                  updateField(
                    "opportunity",
                    "preBidMeetingCompleted",
                    value === "__unset__" ? "" : (value ?? "")
                  )
                }
              >
                <SelectTrigger id="preBidMeetingCompleted">
                  <SelectValue>{preBidMeetingLabel}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__unset__">Pending</SelectItem>
                  <SelectItem value="yes">Completed</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="siteVisitDecision">Site Visit Decision</Label>
              <Select
                value={getSectionValue(sectionData, "opportunity", "siteVisitDecision") || "__unset__"}
                onValueChange={(value) =>
                  updateField(
                    "opportunity",
                    "siteVisitDecision",
                    value === "__unset__" ? "" : (value ?? "")
                  )
                }
              >
                <SelectTrigger id="siteVisitDecision">
                  <SelectValue>{siteVisitDecisionLabel}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__unset__">Pending</SelectItem>
                  <SelectItem value="required">Site Visit Required</SelectItem>
                  <SelectItem value="not_required">No Site Visit Required</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="siteVisitCompleted">Site Visit Completed</Label>
              <Select
                value={getSectionValue(sectionData, "opportunity", "siteVisitCompleted") || "__unset__"}
                onValueChange={(value) =>
                  updateField(
                    "opportunity",
                    "siteVisitCompleted",
                    value === "__unset__" ? "" : (value ?? "")
                  )
                }
              >
                <SelectTrigger id="siteVisitCompleted">
                  <SelectValue>{siteVisitCompletedLabel}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__unset__">Pending</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="estimatorConsultationNotes">Estimator Consultation Notes</Label>
              <Textarea
                id="estimatorConsultationNotes"
                rows={3}
                value={getSectionValue(sectionData, "opportunity", "estimatorConsultationNotes")}
                onChange={(event) =>
                  updateField(
                    "opportunity",
                    "estimatorConsultationNotes",
                    event.target.value
                  )
                }
                placeholder="Capture scope clarifications, bid strategy, and site-visit context."
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Property Details</CardTitle>
            <CardDescription>Property identity comes from the linked lead/property record.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Linked Property</Label>
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                <div className="font-medium text-foreground">
                  {getSectionValue(sectionData, "projectOverview", "propertyName") || "Unassigned"}
                </div>
                <div className="text-muted-foreground">
                  {[
                    getSectionValue(sectionData, "propertyDetails", "propertyAddress"),
                    getSectionValue(sectionData, "propertyDetails", "propertyCity"),
                    getSectionValue(sectionData, "propertyDetails", "propertyState"),
                    getSectionValue(sectionData, "propertyDetails", "propertyZip"),
                  ].filter(Boolean).join(", ") || "No address on property record"}
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Change Property</Label>
              <PropertySelector
                companyId={activeCompanyId}
                value={activePropertyId}
                onChange={handlePropertyChange}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Scope Summary</CardTitle>
            <CardDescription>This summary feeds the deal description and the next team’s kickoff context.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label htmlFor="scopeSummary">Summary</Label>
              <Textarea
                id="scopeSummary"
                rows={6}
                value={getSectionValue(sectionData, "scopeSummary", "summary")}
                onChange={(event) => updateField("scopeSummary", "summary", event.target.value)}
                placeholder="Describe the customer’s scope, constraints, and special conditions."
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Attachments</CardTitle>
            <CardDescription>Upload documents directly here or reuse existing deal files without double entry.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {visibleAttachmentRequirements.map((requirement) => {
              const RequirementIcon = requirement.icon;
              const linkedFiles = linkedFilesByRequirement.get(requirement.key) ?? [];
              const isSatisfied = requirement.status?.satisfied ?? false;
              const categoryLabel =
                FILE_CATEGORY_LABELS[requirement.category] ?? requirement.category;

              return (
                <div key={requirement.key} className="rounded-xl border p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <RequirementIcon className="h-4 w-4 text-muted-foreground" />
                        <h4 className="font-medium">{requirement.label}</h4>
                        {isSatisfied ? (
                          <Badge variant="outline" className="text-green-700">
                            Complete
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-amber-700">
                            Required
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {requirement.hint} Required category: {categoryLabel}.
                      </p>
                    </div>
                    <Label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted">
                      {uploadingKey === requirement.key ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Upload className="h-4 w-4" />
                      )}
                      Upload
                      <input
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(event) => {
                          void handleUpload(requirement, event.target.files);
                          event.currentTarget.value = "";
                        }}
                      />
                    </Label>
                  </div>

                  <div className="mt-3 space-y-2">
                    {linkedFiles.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No files linked yet.</p>
                    ) : (
                      linkedFiles.map((file) => (
                        <div key={file.id} className="flex items-center justify-between rounded-md bg-muted px-3 py-2 text-sm">
                          <span className="truncate">{file.displayName || file.originalFilename}</span>
                          <span className="text-xs text-muted-foreground">
                            {new Date(file.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                      ))
                    )}
                  </div>

                  {unlinkedFiles.length > 0 && (
                    <div className="mt-3 border-t pt-3">
                      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Reuse Existing Deal Files
                      </p>
                      <div className="space-y-2">
                        {unlinkedFiles.slice(0, 6).map((file) => (
                          <div key={`${requirement.key}-${file.id}`} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
                            <span className="truncate">{file.displayName || file.originalFilename}</span>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => void handleLinkExisting(file.id, requirement.key)}
                            >
                              Link
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>

        {activeWorkflowRoute === "service" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Wrench className="h-4 w-4 text-muted-foreground" />
                Service Handoff
              </CardTitle>
              <CardDescription>
                Service routing does not rely on a pipeline stage move. Activate the handoff after scoping is complete.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                disabled={activatingService || readiness?.status === "draft" || intake?.status === "activated"}
                onClick={() => void handleActivateService()}
              >
                {activatingService && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Activate Service Handoff
              </Button>
              {intake?.status === "activated" && (
                <Badge variant="outline" className="text-green-700">
                  Activated
                </Badge>
              )}
              {readiness?.status === "draft" && (
                <span className="text-sm text-muted-foreground">
                  Finish all required scoping items before activation.
                </span>
              )}
            </CardContent>
          </Card>
        )}

        {error && readiness && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
