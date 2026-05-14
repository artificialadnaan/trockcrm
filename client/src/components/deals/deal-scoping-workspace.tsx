import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  FileText,
  Image,
  Info,
  Loader2,
  Upload,
  Wrench,
  X,
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
import { usePipelineStages, useProjectTypes, type PipelineStage } from "@/hooks/use-pipeline-config";
import { useAuth } from "@/lib/auth";
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
  | "scope"
  | "scopeSummary"
  | "attachments";

const SECTION_ORDER: Array<{ key: SectionKey; label: string }> = [
  { key: "projectOverview", label: "Project Overview" },
  { key: "opportunity", label: "Opportunity Review" },
  { key: "propertyDetails", label: "Property Details" },
  { key: "scope", label: "Scope" },
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

function getSectionElementId(section: SectionKey) {
  return `scoping-section-${section}`;
}

function getFieldElementId(section: string, field: string) {
  return `scoping-field-${section}-${field}`;
}

function scrollToScopingTarget(targetId: string) {
  document.getElementById(targetId)?.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
}

const OPPORTUNITY_PROGRESS_OPTIONS = [
  { value: "scheduled", label: "Scheduled" },
  { value: "reviewing", label: "Reviewing" },
  { value: "completed", label: "Completed" },
] as const;

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

function omitSectionKeys(value: unknown, keys: string[]) {
  if (!isRecord(value)) {
    return {};
  }

  const next = { ...value };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

export function stripLineageOwnedWorkspaceFields(
  sectionData: Record<string, unknown>,
  hasSourceLead: boolean
) {
  if (!hasSourceLead) {
    return sectionData;
  }

  return {
    ...sectionData,
    projectOverview: omitSectionKeys(sectionData.projectOverview, ["propertyName", "bidDueDate"]),
    propertyDetails: omitSectionKeys(sectionData.propertyDetails, [
      "propertyAddress",
      "propertyCity",
      "propertyState",
      "propertyZip",
    ]),
    scopeSummary: omitSectionKeys(sectionData.scopeSummary, ["summary"]),
  };
}

export function buildWorkspaceSectionData(
  deal: DealDetail,
  intake?: DealScopingIntake | null,
  resolved?: DealResolvedFields | null
) {
  const seed = resolved ? buildScopingSeedFromResolvedFields(resolved) : buildScopingSeedFromDeal(deal);
  const intakeSectionData = isRecord(intake?.sectionData)
    ? intake!.sectionData as Record<string, unknown>
    : {};
  return mergeSectionData(
    seed,
    stripLineageOwnedWorkspaceFields(intakeSectionData, Boolean(deal.sourceLeadId))
  );
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

function createWorkspaceFingerprint(
  projectTypeId: string | null,
  sectionData: Record<string, unknown>
) {
  return JSON.stringify({ projectTypeId, sectionData });
}

function getSelectedScopeProjectTypeIds(
  sectionData: Record<string, unknown>,
  projectTypeId: string | null
) {
  const scopeValue = sectionData.scope;
  if (isRecord(scopeValue) && Array.isArray(scopeValue.selectedProjectTypeIds)) {
    return scopeValue.selectedProjectTypeIds.filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0
    );
  }

  return projectTypeId ? [projectTypeId] : [];
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

function isOpportunityOrLater(stageId: string | null | undefined, stages: PipelineStage[]) {
  const stage = stages.find((entry) => entry.id === stageId);
  const opportunity = stages.find(
    (entry) => entry.slug === "opportunity" && entry.workflowFamily === "standard_deal"
  );

  if (!stage || !opportunity) {
    return true;
  }

  if (stage.workflowFamily !== opportunity.workflowFamily) {
    return stage.workflowFamily !== "lead";
  }

  return stage.displayOrder >= opportunity.displayOrder;
}

function getSelectDisplayLabel(
  value: string,
  options: Record<string, string>,
  fallback: string
) {
  return options[value] ?? fallback;
}

export function buildLineageResolvedPatch(input: {
  hasSourceLead: boolean;
  canWriteProjectType: boolean;
  projectTypeId: string | null;
  sectionData: Record<string, unknown>;
  resolvedFields: DealResolvedFields | null;
}) {
  if (!input.hasSourceLead || !input.resolvedFields) {
    return {};
  }

  const patch: Record<string, unknown> = {};
  const bidDueDate = getSectionValue(input.sectionData, "projectOverview", "bidDueDate");
  const summary = getSectionValue(input.sectionData, "scopeSummary", "summary");
  const currentBidDueDate =
    typeof input.resolvedFields.bidDueDate === "string" ? input.resolvedFields.bidDueDate : "";
  const currentSummary = input.resolvedFields.description ?? "";

  if (input.canWriteProjectType && input.projectTypeId !== input.resolvedFields.projectTypeId) {
    patch.projectTypeId = input.projectTypeId;
  }

  if (bidDueDate !== currentBidDueDate) {
    patch.bidDueDate = bidDueDate;
  }

  if (summary !== currentSummary) {
    patch.description = summary;
  }

  return patch;
}

export function buildScopingAutosavePatch(input: {
  hasSourceLead: boolean;
  canWriteProjectType: boolean;
  projectTypeId: string | null;
  sectionData: Record<string, unknown>;
}) {
  if (!input.hasSourceLead) {
    return {
      ...(input.canWriteProjectType ? { projectTypeId: input.projectTypeId } : {}),
      sectionData: input.sectionData,
    };
  }

  const scopingOwnedSectionData: Record<string, unknown> = {};
  if (isRecord(input.sectionData.opportunity)) {
    scopingOwnedSectionData.opportunity = input.sectionData.opportunity;
  }
  if (isRecord(input.sectionData.scope)) {
    scopingOwnedSectionData.scope = input.sectionData.scope;
  }

  return {
    sectionData: scopingOwnedSectionData,
  };
}

export function canAutosaveScopingWorkspace(input: {
  hasSourceLead: boolean;
  resolvedFields: DealResolvedFields | null;
}) {
  return !input.hasSourceLead || Boolean(input.resolvedFields);
}

function getDefaultAttachmentRequirementKeys(route: WorkflowRoute) {
  return [];
}

function normalizeWorkspaceReadiness(
  readiness: DealScopingReadiness,
  route: WorkflowRoute
) {
  const requiredAttachmentKeys =
    readiness.requiredAttachmentKeys.length > 0
      ? readiness.requiredAttachmentKeys
      : getDefaultAttachmentRequirementKeys(route);
  const attachmentRequirements = ATTACHMENT_REQUIREMENTS
    .map((baseRequirement) => {
      const existingRequirement = readiness.attachmentRequirements.find(
        (requirement) => requirement.key === baseRequirement.key
      );

      return (
        existingRequirement ?? {
          key: baseRequirement.key,
          category: baseRequirement.category,
          label: baseRequirement.label,
          satisfied: false,
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
  onReadinessChanged,
  mode = "edit",
  readOnlySubmittedAt,
  canForceEdit = false,
}: {
  deal: DealDetail;
  onDealUpdated: () => void;
  onReadinessChanged?: () => void;
  mode?: "edit" | "readonly";
  readOnlySubmittedAt?: string | null;
  canForceEdit?: boolean;
}) {
  const { user } = useAuth();
  const { projectTypes } = useProjectTypes();
  const { stages } = usePipelineStages();
  const { files, refetch: refetchFiles } = useFiles({
    dealId: deal.id,
    limit: 50,
  });

  const [intake, setIntake] = useState<DealScopingIntake | null>(null);
  const [readiness, setReadiness] = useState<DealScopingReadiness | null>(null);
  const [resolvedFields, setResolvedFields] = useState<DealResolvedFields | null>(null);
  const [sectionData, setSectionData] = useState<Record<string, unknown>>({});
  const [projectTypeId, setProjectTypeId] = useState<string | null>(deal.projectTypeId);
  const [intendedProjectNumber, setIntendedProjectNumber] = useState<string | null>(
    deal.intendedProjectNumber ?? null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dismissedError, setDismissedError] = useState(false);
  const [initialLoadFailed, setInitialLoadFailed] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [activatingService, setActivatingService] = useState(false);
  const [forceEditingReadOnlyScope, setForceEditingReadOnlyScope] = useState(false);
  const [autosaveRetryToken, setAutosaveRetryToken] = useState(0);
  const lastSavedFingerprintRef = useRef("");
  const latestWorkspaceFingerprintRef = useRef("");
  const autosaveInFlightRef = useRef(false);
  const hydrationCompleteRef = useRef(false);
  const readinessSignatureRef = useRef<string | null>(null);
  const loadRequestIdRef = useRef(0);
  const currentWorkspaceFingerprint = createWorkspaceFingerprint(projectTypeId, sectionData);
  const activeWorkflowRoute: WorkflowRoute = resolvedFields?.workflowRoute ?? deal.workflowRoute ?? "normal";
  const activeCompanyId = resolvedFields?.companyId ?? deal.companyId;
  const activePropertyId = resolvedFields?.propertyId ?? deal.propertyId;
  const hasSourceLead = Boolean(deal.sourceLeadId);
  const projectTypeLabel = getProjectTypeLabel(projectTypes, projectTypeId);
  const projectTypeLocked = user?.role !== "admin" && isOpportunityOrLater(deal.stageId, stages);
  const preBidMeetingLabel = getSelectDisplayLabel(
    getSectionValue(sectionData, "opportunity", "preBidMeetingCompleted"),
    { yes: "Completed", scheduled: "Scheduled", reviewing: "Reviewing", completed: "Completed" },
    "Pending"
  );
  const siteVisitDecisionLabel = getSelectDisplayLabel(
    getSectionValue(sectionData, "opportunity", "siteVisitDecision"),
    {
      required: "Scheduled",
      not_required: "Completed",
      scheduled: "Scheduled",
      reviewing: "Reviewing",
      completed: "Completed",
    },
    "Pending"
  );
  const siteVisitCompletedLabel = getSelectDisplayLabel(
    getSectionValue(sectionData, "opportunity", "siteVisitCompleted"),
    { completed: "Completed" },
    "Pending"
  );
  const readOnlyModeActive = mode === "readonly" && !forceEditingReadOnlyScope;
  const adminOverrideEditing = mode === "readonly" && forceEditingReadOnlyScope;
  const editingDisabled = initialLoadFailed || readOnlyModeActive;
  latestWorkspaceFingerprintRef.current = currentWorkspaceFingerprint;
  const submittedAtLabel = readOnlySubmittedAt
    ? new Date(readOnlySubmittedAt).toLocaleDateString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;
  const saveStatusLabel = initialLoadFailed
    ? "Unable to load - retry"
    : readOnlyModeActive
      ? "Read-only"
    : saveState === "saving"
      ? "Saving..."
      : saveState === "error"
        ? "Save failed"
        : hydrationCompleteRef.current
          ? "Saved"
          : "Loading";
  const saveStatusDetail = initialLoadFailed
    ? "Scoping intake did not load. Retry before editing."
    : readOnlyModeActive
      ? "Submitted scope is available for reference. Edits are locked after RFP submission."
    : saveState === "saving"
      ? "Autosaving changes..."
      : saveState === "saved"
        ? "All changes saved."
        : saveState === "error"
          ? "Autosave failed. Keep editing and retry."
          : hydrationCompleteRef.current
            ? `Last saved ${intake?.lastAutosavedAt ? new Date(intake.lastAutosavedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "just now"}.`
            : "Loading scoping intake...";

  const showError = (message: string) => {
    setError(message);
    setDismissedError(false);
  };

  const clearError = () => {
    setError(null);
    setDismissedError(false);
  };

  const applyReadiness = (nextReadiness: DealScopingReadiness, notifyOnChange: boolean) => {
    const normalized = normalizeWorkspaceReadiness(nextReadiness, activeWorkflowRoute);
    const previousSignature = readinessSignatureRef.current;
    const nextSignature = JSON.stringify({
      status: normalized.status,
      errors: normalized.errors,
      completionState: normalized.completionState,
    });
    readinessSignatureRef.current = nextSignature;
    setReadiness(normalized);
    if (notifyOnChange && previousSignature && previousSignature !== nextSignature) {
      onReadinessChanged?.();
    }
  };

  const loadIntake = async (options: { notifyReadinessChange?: boolean } = {}) => {
    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;
    const wasInitialHydration = !hydrationCompleteRef.current;
    if (wasInitialHydration) {
      setLoading(true);
      setInitialLoadFailed(false);
    }
    clearError();
    try {
      const result = await getDealScopingIntake(deal.id);
      if (requestId !== loadRequestIdRef.current) {
        return;
      }
      const nextSectionData = buildWorkspaceSectionData(deal, result.intake, result.resolved);
      setIntake(result.intake);
      applyReadiness(result.readiness, Boolean(options.notifyReadinessChange));
      setResolvedFields(result.resolved);
      setSectionData(nextSectionData);
      const nextProjectTypeId = hasSourceLead
        ? result.resolved.projectTypeId ?? null
        : result.intake.projectTypeId ?? result.resolved.projectTypeId ?? deal.projectTypeId;
      setProjectTypeId(nextProjectTypeId);
      lastSavedFingerprintRef.current = createWorkspaceFingerprint(nextProjectTypeId, nextSectionData);
      hydrationCompleteRef.current = true;
      setInitialLoadFailed(false);
      setSaveState("idle");
    } catch (err) {
      if (requestId !== loadRequestIdRef.current) {
        return;
      }
      if (wasInitialHydration) {
        hydrationCompleteRef.current = false;
        setInitialLoadFailed(true);
      } else {
        setInitialLoadFailed(false);
      }
      setSaveState("error");
      showError(err instanceof Error ? err.message : "Failed to load scoping intake");
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    hydrationCompleteRef.current = false;
    setForceEditingReadOnlyScope(false);
    void loadIntake();
  }, [deal.id, mode]);

  useEffect(() => {
    if (!hydrationCompleteRef.current) {
      return;
    }

    if (readOnlyModeActive) {
      return;
    }

    if (!canAutosaveScopingWorkspace({ hasSourceLead, resolvedFields })) {
      return;
    }

    const requestFingerprint = currentWorkspaceFingerprint;
    if (requestFingerprint === lastSavedFingerprintRef.current) {
      return;
    }

    if (autosaveInFlightRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(async () => {
      autosaveInFlightRef.current = true;
      setSaveState("saving");
      try {
        const resolvedPatch = buildLineageResolvedPatch({
          hasSourceLead,
          canWriteProjectType: !projectTypeLocked,
          projectTypeId,
          sectionData,
          resolvedFields,
        });
        if (Object.keys(resolvedPatch).length > 0) {
          const resolvedResult = await patchResolvedDealFields(deal.id, {
            ...resolvedPatch,
            ...(adminOverrideEditing ? { forceEditAfterRfp: true } : {}),
          });
          if ("projectTypeId" in resolvedPatch) {
            setIntendedProjectNumber(resolvedResult.resolved.deal?.intendedProjectNumber ?? null);
          }
        }

        const result = await patchDealScopingIntake(
          deal.id,
          {
            ...buildScopingAutosavePatch({
              hasSourceLead,
              canWriteProjectType: !projectTypeLocked,
              projectTypeId,
              sectionData,
            }),
            ...(adminOverrideEditing ? { forceEditAfterRfp: true } : {}),
          }
        );
        const responseFingerprint = createWorkspaceFingerprint(projectTypeId, sectionData);
        if (latestWorkspaceFingerprintRef.current !== requestFingerprint) {
          return;
        }

        setIntake(result.intake);
        applyReadiness(result.readiness, true);
        setResolvedFields(result.resolved);
        lastSavedFingerprintRef.current = responseFingerprint;
        setSaveState("saved");
        window.setTimeout(() => setSaveState("idle"), 1200);
      } catch (err) {
        setSaveState("error");
        showError(err instanceof Error ? err.message : "Autosave failed");
      } finally {
        autosaveInFlightRef.current = false;
        if (latestWorkspaceFingerprintRef.current !== lastSavedFingerprintRef.current) {
          setAutosaveRetryToken((current) => current + 1);
        }
      }
    }, 400);

    return () => window.clearTimeout(timeoutId);
  }, [activeWorkflowRoute, adminOverrideEditing, autosaveRetryToken, currentWorkspaceFingerprint, deal, deal.id, hasSourceLead, projectTypeId, readOnlyModeActive, resolvedFields, sectionData]);

  const completionCounts = getScopingCompletionCounts(readiness?.completionState);
  const attachmentRequirements = readiness?.attachmentRequirements ?? [];
  const visibleAttachmentRequirements = useMemo(
    () =>
      ATTACHMENT_REQUIREMENTS.map((requirement) => ({
        ...requirement,
        status:
          attachmentRequirements.find(
            (attachmentRequirement) => attachmentRequirement.key === requirement.key
          ) ?? null,
      })),
    [attachmentRequirements]
  );
  const visibleSections = useMemo(
    () =>
      SECTION_ORDER.filter((section) =>
        section.key === "attachments" ||
        section.key === "scope" ||
        Boolean(readiness?.completionState[section.key])
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
  const selectedScopeProjectTypeIds = useMemo(
    () => getSelectedScopeProjectTypeIds(sectionData, projectTypeId),
    [projectTypeId, sectionData]
  );

  const updateField = (section: SectionKey, field: string, value: string) => {
    if (editingDisabled) return;
    setSectionData((current) =>
      mergeSectionData(current, {
        [section]: {
          ...(isRecord(current[section]) ? current[section] : {}),
          [field]: value,
        },
      })
    );
    clearError();
  };

  const updateScopeSelection = (nextSelectedIds: string[]) => {
    if (editingDisabled) return;
    const uniqueSelectedIds = Array.from(new Set(nextSelectedIds.filter(Boolean)));
    if (!projectTypeLocked) {
      setProjectTypeId(uniqueSelectedIds[0] ?? null);
    }
    setSectionData((current) =>
      mergeSectionData(current, {
        scope: {
          ...(isRecord(current.scope) ? current.scope : {}),
          selectedProjectTypeIds: uniqueSelectedIds,
        },
      })
    );
    clearError();
  };

  const handleProjectTypeChange = (value: string | null) => {
    const nextProjectTypeId = value === "__none__" ? null : value;
    updateScopeSelection(nextProjectTypeId ? [nextProjectTypeId] : []);
  };

  const toggleScopeProjectType = (projectTypeOptionId: string) => {
    const nextSelectedIds = selectedScopeProjectTypeIds.includes(projectTypeOptionId)
      ? selectedScopeProjectTypeIds.filter((id) => id !== projectTypeOptionId)
      : [...selectedScopeProjectTypeIds, projectTypeOptionId];
    updateScopeSelection(nextSelectedIds);
  };

  const handleLinkExisting = async (fileId: string, requirementKey: string) => {
    if (editingDisabled) return;
    try {
      await linkExistingScopingAttachment(deal.id, {
        fileId,
        intakeSection: "attachments",
        intakeRequirementKey: requirementKey,
        ...(adminOverrideEditing ? { forceEditAfterRfp: true } : {}),
      });
      await Promise.all([refetchFiles(), loadIntake({ notifyReadinessChange: true })]);
      toast.success(`Linked file to ${formatScopingAttachmentLabel(requirementKey)}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to link file");
    }
  };

  const handlePropertyChange = async (propertyId: string) => {
    if (editingDisabled) return;
    setSaveState("saving");
    try {
      const result = await patchResolvedDealFields(deal.id, {
        propertyId,
        ...(adminOverrideEditing ? { forceEditAfterRfp: true } : {}),
      });
      const nextResolved = result.resolved.resolved;
      setResolvedFields(nextResolved);
      setSectionData((current) =>
        mergeSectionData(current, buildScopingSeedFromResolvedFields(nextResolved))
      );
      setSaveState("saved");
      window.setTimeout(() => setSaveState("idle"), 1200);
    } catch (err) {
      setSaveState("error");
      showError(err instanceof Error ? err.message : "Failed to change property");
    }
  };

  const handleUpload = async (
    requirement: (typeof ATTACHMENT_REQUIREMENTS)[number],
    fileList: FileList | null
  ) => {
    if (editingDisabled) return;
    if (!fileList?.length) return;

    setUploadingKey(requirement.key);
    setUploadProgress(0);
    try {
      for (const file of Array.from(fileList)) {
        const uploaded = await uploadFile({
          file,
          category: requirement.category,
          dealId: deal.id,
          ...(adminOverrideEditing ? { forceEditAfterRfp: true } : {}),
          onProgress: setUploadProgress,
        });
        await linkExistingScopingAttachment(deal.id, {
          fileId: uploaded.id,
          intakeSection: "attachments",
          intakeRequirementKey: requirement.key,
          ...(adminOverrideEditing ? { forceEditAfterRfp: true } : {}),
        });
      }
      await Promise.all([refetchFiles(), loadIntake({ notifyReadinessChange: true })]);
      toast.success(`${requirement.label} uploaded and linked.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploadingKey(null);
      setUploadProgress(null);
    }
  };

  const handleActivateService = async () => {
    if (editingDisabled) return;
    setActivatingService(true);
    try {
      await activateServiceHandoff(deal.id);
      await loadIntake({ notifyReadinessChange: true });
      onDealUpdated();
      toast.success("Service handoff activated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to activate service handoff");
    } finally {
      setActivatingService(false);
    }
  };

  const handleForceEdit = () => {
    const confirmed = window.confirm(
      "This scope was submitted to Bid Board. Editing now may cause inconsistency. Continue?"
    );
    if (!confirmed) {
      return;
    }
    setForceEditingReadOnlyScope(true);
  };

  if (loading) {
    return <div className="h-72 animate-pulse rounded-lg bg-muted" />;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <div className={`fixed right-4 top-4 z-40 rounded-full border px-3 py-1 text-xs font-medium shadow-sm ${
        initialLoadFailed
          ? "border-red-200 bg-red-50 text-red-700"
          : "bg-background"
      }`}>
        {saveStatusLabel}
      </div>
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
                  <button
                    key={section.key}
                    type="button"
                    className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => scrollToScopingTarget(getSectionElementId(section.key))}
                  >
                    <span>{section.label}</span>
                    {complete ? (
                      <CheckCircle2 className="h-4 w-4 text-green-600" />
                    ) : (
                      <Clock3 className="h-4 w-4 text-amber-500" />
                    )}
                  </button>
                );
              })}
            </div>

            <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              {saveStatusDetail}
            </div>

            {initialLoadFailed ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full border-red-200 bg-white text-red-700 hover:bg-red-100 hover:text-red-800"
                onClick={() => void loadIntake()}
              >
                Retry loading scope
              </Button>
            ) : null}
          </CardContent>
        </Card>

        {readiness && readiness.errors.sections && Object.keys(readiness.errors.sections).length > 0 && (
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
                  <button
                    key={`${section}.${field}`}
                    type="button"
                    className="block w-full rounded-md px-2 py-1 text-left text-red-600 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => scrollToScopingTarget(getFieldElementId(section, field))}
                  >
                    {formatScopingFieldLabel(`${section}.${field}`)}
                  </button>
                ))
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <div className="space-y-4">
        {error && !dismissedError ? (
          <div className="flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <div>
              <div className="font-medium">Scoping intake needs attention</div>
              <div className="mt-1">{error}</div>
              {initialLoadFailed ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3 border-red-200 bg-white text-red-700 hover:bg-red-100 hover:text-red-800"
                  onClick={() => void loadIntake()}
                >
                  Retry loading scope
                </Button>
              ) : null}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-red-700 hover:bg-red-100 hover:text-red-800"
              onClick={() => setDismissedError(true)}
              aria-label="Dismiss scoping intake error"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : null}

        {mode === "readonly" ? (
          <div className={`rounded-lg border px-4 py-3 text-sm ${
            adminOverrideEditing
              ? "border-red-200 bg-red-50 text-red-800"
              : "border-amber-200 bg-amber-50 text-amber-900"
          }`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-medium">
                  {adminOverrideEditing
                    ? "Admin force edit enabled"
                    : `This scope was submitted to Bid Board${submittedAtLabel ? ` on ${submittedAtLabel}` : ""}. Read-only.`}
                </div>
                <div className="mt-1">
                  {adminOverrideEditing
                    ? "Changes will be saved as an audited admin override."
                    : "Submitted values remain visible for reference, but edits are locked after RFP submission."}
                </div>
              </div>
              {canForceEdit && !adminOverrideEditing ? (
                <Button type="button" variant="outline" size="sm" onClick={handleForceEdit}>
                  Force edit
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Scoping Workspace</CardTitle>
            <CardDescription>
              {readOnlyModeActive
                ? "Submitted deal scope is available here for reference after Bid Board handoff."
                : "Prefilled deal data is editable here and reused downstream for Bid Board handoff."}
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
                onValueChange={handleProjectTypeChange}
                disabled={editingDisabled || projectTypeLocked}
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
              {intendedProjectNumber ? (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="font-mono">Intended: {intendedProjectNumber}</span>
                  <Info
                    className="h-3.5 w-3.5"
                    aria-label="The deal number stays fixed because downstream systems (SyncHub, Procore, Bid Board) reference it. The intended number reflects the current project type."
                  >
                    <title>
                      The deal number stays fixed because downstream systems (SyncHub, Procore, Bid Board) reference it. The intended number reflects the current project type.
                    </title>
                  </Info>
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card id={getSectionElementId("projectOverview")} className="scroll-mt-6">
          <CardHeader>
            <CardTitle>Project Overview</CardTitle>
            <CardDescription>Route, property identity, and estimating kickoff timing.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div id={getFieldElementId("projectOverview", "propertyName")} className="space-y-2 scroll-mt-6">
              <Label htmlFor="propertyName">Property Name</Label>
              <div
                id="propertyName"
                className="flex h-10 items-center rounded-md border bg-muted/40 px-3 text-sm text-muted-foreground"
              >
                {getSectionValue(sectionData, "projectOverview", "propertyName") || "Unassigned"}
              </div>
            </div>
            {activeWorkflowRoute === "normal" && (
              <div id={getFieldElementId("projectOverview", "bidDueDate")} className="space-y-2 scroll-mt-6">
                <Label htmlFor="bidDueDate">Bid Due Date</Label>
                <Input
                  id="bidDueDate"
                  type="date"
                  value={getSectionValue(sectionData, "projectOverview", "bidDueDate")}
                  disabled={editingDisabled}
                  onChange={(event) => updateField("projectOverview", "bidDueDate", event.target.value)}
                />
              </div>
            )}
          </CardContent>
        </Card>

        <Card id={getSectionElementId("opportunity")} className="scroll-mt-6">
          <CardHeader>
            <CardTitle>Opportunity Review</CardTitle>
            <CardDescription>
              Capture the pre-bid meeting and site visit decision before deeper estimating work.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div id={getFieldElementId("opportunity", "preBidMeetingCompleted")} className="space-y-2 scroll-mt-6">
              <Label htmlFor="preBidMeetingCompleted">Pre-Bid Meeting Completed</Label>
              <Select
                value={getSectionValue(sectionData, "opportunity", "preBidMeetingCompleted") || "__unset__"}
                disabled={editingDisabled}
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
                  {OPPORTUNITY_PROGRESS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div id={getFieldElementId("opportunity", "siteVisitDecision")} className="space-y-2 scroll-mt-6">
              <Label htmlFor="siteVisitDecision">Site Visit Decision</Label>
              <Select
                value={getSectionValue(sectionData, "opportunity", "siteVisitDecision") || "__unset__"}
                disabled={editingDisabled}
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
                  {OPPORTUNITY_PROGRESS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div id={getFieldElementId("opportunity", "siteVisitCompleted")} className="space-y-2 scroll-mt-6">
              <Label htmlFor="siteVisitCompleted">Site Visit Completed</Label>
              <Select
                value={getSectionValue(sectionData, "opportunity", "siteVisitCompleted") || "__unset__"}
                disabled={editingDisabled}
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

            <div id={getFieldElementId("opportunity", "estimatorConsultationNotes")} className="space-y-2 md:col-span-2 scroll-mt-6">
              <Label htmlFor="estimatorConsultationNotes">Estimator Consultation Notes</Label>
              <Textarea
                id="estimatorConsultationNotes"
                rows={3}
                value={getSectionValue(sectionData, "opportunity", "estimatorConsultationNotes")}
                disabled={editingDisabled}
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

        <Card id={getSectionElementId("propertyDetails")} className="scroll-mt-6">
          <CardHeader>
            <CardTitle>Property Details</CardTitle>
            <CardDescription>Property identity comes from the linked lead/property record.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div id={getFieldElementId("propertyDetails", "propertyAddress")} className="space-y-2 scroll-mt-6">
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
                disabled={editingDisabled}
                officeId={intake?.officeId ?? null}
                repairIncompleteAddressOnSelect
              />
            </div>
          </CardContent>
        </Card>

        <Card id={getSectionElementId("scope")} className="scroll-mt-6 border-primary/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-1 text-xl">
              Scope <span className="text-red-600" aria-hidden="true">*</span>
            </CardTitle>
            <CardDescription>
              Select at least one scope item that applies to this project. You can choose multiple.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div id={getFieldElementId("scope", "selectedProjectTypeIds")} className="space-y-3 scroll-mt-6">
              <Label>Scope Items</Label>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {projectTypes.map((type) => {
                  const selected = selectedScopeProjectTypeIds.includes(type.id);
                  return (
                    <Button
                      key={type.id}
                      type="button"
                      variant={selected ? "default" : "outline"}
                      className="justify-start"
                      aria-pressed={selected}
                      disabled={editingDisabled}
                      onClick={() => toggleScopeProjectType(type.id)}
                    >
                      {selected ? <CheckCircle2 className="mr-2 h-4 w-4" /> : null}
                      {type.name}
                    </Button>
                  );
                })}
              </div>
              {projectTypes.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active scope items are configured.</p>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card id={getSectionElementId("scopeSummary")} className="scroll-mt-6">
          <CardHeader>
            <CardTitle>Scope Summary</CardTitle>
            <CardDescription>This summary feeds the deal description and the next team’s kickoff context.</CardDescription>
          </CardHeader>
          <CardContent>
            <div id={getFieldElementId("scopeSummary", "summary")} className="space-y-2 scroll-mt-6">
              <Label htmlFor="scopeSummary">Summary</Label>
              <Textarea
                id="scopeSummary"
                rows={6}
                value={getSectionValue(sectionData, "scopeSummary", "summary")}
                disabled={editingDisabled}
                onChange={(event) => updateField("scopeSummary", "summary", event.target.value)}
                placeholder="Describe the customer’s scope, constraints, and special conditions."
              />
            </div>
          </CardContent>
        </Card>

        <Card id={getSectionElementId("attachments")} className="scroll-mt-6">
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
                            Optional
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {requirement.hint} Category: {categoryLabel}.
                      </p>
                    </div>
                    <Label className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium ${
                      editingDisabled
                        ? "cursor-not-allowed opacity-50"
                        : "cursor-pointer hover:bg-muted"
                    }`}>
                      {uploadingKey === requirement.key ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Upload className="h-4 w-4" />
                      )}
                      {uploadingKey === requirement.key && uploadProgress != null
                        ? `Uploading ${uploadProgress}%`
                        : "Upload"}
                      <input
                        type="file"
                        multiple
                        className="hidden"
                        disabled={editingDisabled}
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
                              disabled={editingDisabled}
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
                disabled={editingDisabled || activatingService || readiness?.status === "draft" || intake?.status === "activated"}
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

      </div>
    </div>
  );
}
