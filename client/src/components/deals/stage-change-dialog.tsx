import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useNavigate } from "react-router-dom";
import { DealStageBadge } from "./deal-stage-badge";
import { StageGateChecklist } from "./stage-gate-checklist";
import {
  preflightStageCheck,
  changeDealStage,
} from "@/hooks/use-deals";
import { useLostReasons } from "@/hooks/use-pipeline-config";
import { AlertTriangle, ArrowRight, ArrowLeft, Shield, Loader2 } from "lucide-react";
import { getDealStageMetadata } from "@/hooks/use-deals";
import { toCanonicalDealStageSlug } from "@trock-crm/shared/types";

// "Today" in the business timezone (America/Chicago), as YYYY-MM-DD. The expected-close-date cutoff
// uses this instead of a UTC date so a rep entering CT-today late in the evening (when UTC has already
// rolled to tomorrow) isn't wrongly blocked -- and so the client cutoff matches the server stage-gate's
// CT-anchored usable-date check exactly.
const businessTodayDateStr = (): string =>
  new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

interface StageRequirementState {
  fields: string[];
  documents: string[];
  approvals: string[];
}

interface StageRequirementAction {
  label: string;
  to: string;
}

export function getStageRequirementAction(
  dealId: string,
  missingRequirements: StageRequirementState | null | undefined,
  officeId?: string | null
): StageRequirementAction | null {
  const appendOfficeId = (path: string) => {
    if (!officeId) return path;
    return `${path}${path.includes("?") ? "&" : "?"}officeId=${encodeURIComponent(officeId)}`;
  };

  if (!missingRequirements) {
    return null;
  }

  if (missingRequirements.fields.some((field) => field.includes("."))) {
    return {
      label: "Open Scoping Workspace",
      to: appendOfficeId(`/deals/${dealId}?tab=scoping`),
    };
  }

  if (missingRequirements.documents.length > 0) {
    return {
      label: "Open Files",
      to: appendOfficeId(`/deals/${dealId}?tab=files`),
    };
  }

  if (missingRequirements.fields.length > 0) {
    return {
      label: "Open Overview",
      to: appendOfficeId(`/deals/${dealId}?tab=overview`),
    };
  }

  return null;
}

type StageGateMissing =
  | { fields?: string[]; documents?: string[]; approvals?: string[] }
  | null
  | undefined;

/**
 * True when the ONLY thing blocking the gate is a missing `expectedCloseDate` field -- no other
 * missing fields, documents, or approvals, and not a backward move, and not from the `close_out`
 * stage. In that case the inline date prompt alone can clear the gate (the server re-validates with
 * the pending date), so the dialog must not redirect to the overview OR demand a director override
 * reason.
 *
 * The `close_out` exclusion is load-bearing: the server stage-gate's close-out-checklist rule
 * (validateStageGate Rule 2) can require a director override on a `close_out -> won` move WITHOUT
 * surfacing anything in `missingRequirements`. That override source is invisible here, and the inline
 * date does NOT clear it -- so skipping the override there would let the dialog send no reason and get
 * a hard 400 (OVERRIDE_REQUIRED) from the server. From `close_out` we conservatively keep requiring
 * the override reason.
 */
export function isExpectedCloseDateSoleGateBlocker(
  missingRequirements: StageGateMissing,
  isBackwardMove: boolean | undefined,
  currentStageSlug: string | null | undefined
): boolean {
  const fields = missingRequirements?.fields ?? [];
  return (
    fields.length === 1 &&
    fields.includes("expectedCloseDate") &&
    (missingRequirements?.documents?.length ?? 0) === 0 &&
    (missingRequirements?.approvals?.length ?? 0) === 0 &&
    !isBackwardMove &&
    currentStageSlug !== "close_out"
  );
}

/**
 * True when the inline expected-close-date alone resolves the gate: it's the sole blocker AND the rep
 * has supplied a usable (today-or-future) value. When true the POST re-validates with the pending date
 * and the server no longer requires an override -- so the override-reason requirement (computed by the
 * preflight before this inline value existed) must be skipped, and the footer button unblocked.
 */
export function isGateResolvedByInlineCloseDate(
  missingRequirements: StageGateMissing,
  isBackwardMove: boolean | undefined,
  currentStageSlug: string | null | undefined,
  expectedCloseDate: string,
  today: string
): boolean {
  const dateUsable = expectedCloseDate !== "" && expectedCloseDate >= today;
  return isExpectedCloseDateSoleGateBlocker(missingRequirements, isBackwardMove, currentStageSlug) && dateUsable;
}

interface StageChangeDialogProps {
  deal: {
    id: string;
    name: string;
    stageId: string;
    workflowRoute?: "normal" | "service" | null;
  };
  targetStageId: string;
  officeId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function getStageChangeDialogSemantics(
  canonicalTargetStageSlug: string | null,
  isBidBoardLocked = false
) {
  const isClosedLost =
    canonicalTargetStageSlug === "lost" ||
    canonicalTargetStageSlug === "production_lost" ||
    canonicalTargetStageSlug === "service_lost" ||
    canonicalTargetStageSlug === "closed_lost";
  const isClosedWon =
    canonicalTargetStageSlug === "won" ||
    canonicalTargetStageSlug === "sent_to_production" ||
    canonicalTargetStageSlug === "service_sent_to_production" ||
    canonicalTargetStageSlug === "closed_won";

  return {
    isClosedLost,
    isClosedWon,
    shouldForceCompletion: isClosedLost && !isBidBoardLocked,
  };
}

export function StageChangeDialog({
  deal,
  targetStageId,
  officeId,
  open,
  onOpenChange,
  onSuccess,
}: StageChangeDialogProps) {
  const { reasons } = useLostReasons();
  const workflowRoute = deal.workflowRoute ?? "normal";
  const navigate = useNavigate();

  const [preflight, setPreflight] = useState<Awaited<ReturnType<typeof preflightStageCheck>> | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [overrideReason, setOverrideReason] = useState("");
  const [lostReasonId, setLostReasonId] = useState("");
  const [lostNotes, setLostNotes] = useState("");
  const [lostCompetitor, setLostCompetitor] = useState("");
  const [expectedCloseDate, setExpectedCloseDate] = useState("");

  // Derived gate state -- the single source of truth for both submit-time validation and the footer
  // button. Inline expected-close-date prompt: when the only thing the gate is missing is
  // expectedCloseDate, let the rep set a usable (today-or-future) date here and advance in one action.
  const todayDateStr = businessTodayDateStr();
  const needsExpectedCloseDate = (preflight?.missingRequirements?.fields ?? []).includes("expectedCloseDate");
  const onlyExpectedCloseDateMissing = isExpectedCloseDateSoleGateBlocker(
    preflight?.missingRequirements,
    preflight?.isBackwardMove,
    preflight?.currentStage?.slug
  );
  const unblockedByExpectedCloseDate = isGateResolvedByInlineCloseDate(
    preflight?.missingRequirements,
    preflight?.isBackwardMove,
    preflight?.currentStage?.slug,
    expectedCloseDate,
    todayDateStr
  );

  // Run preflight check on mount
  useEffect(() => {
    if (!open) return;
    setPreflightLoading(true);
    setError(null);

    preflightStageCheck(deal.id, targetStageId)
      .then((result) => setPreflight(result))
      .catch((err) => setError(err instanceof Error ? err.message : "Preflight check failed"))
      .finally(() => setPreflightLoading(false));
  }, [deal.id, targetStageId, open]);

  const handleSubmit = async () => {
    if (!preflight) return;
    setSubmitting(true);
    setError(null);
    const canonicalTargetStageSlug = toCanonicalDealStageSlug(preflight.targetStage.slug, workflowRoute);
    const { isClosedLost: isLostTransition } = getStageChangeDialogSemantics(canonicalTargetStageSlug);

    try {
      // Validate lost deal fields
      if (isLostTransition) {
        if (!lostReasonId) {
          setError("Please select a reason for losing this deal.");
          setSubmitting(false);
          return;
        }
        if (!lostNotes.trim()) {
          setError("Please provide notes about why this deal was lost.");
          setSubmitting(false);
          return;
        }
      }

      // Validate override reason -- but skip it when the inline expected-close-date alone resolves the
      // gate: the POST re-validates with that pending date and the server no longer requires an override
      // (preflight.requiresOverride was computed before this inline value existed).
      if (preflight.requiresOverride && !unblockedByExpectedCloseDate && !overrideReason.trim()) {
        setError("Please provide a reason for the override.");
        setSubmitting(false);
        return;
      }

      // Require a usable (today-or-future) expected close date when the gate needs it.
      if (needsExpectedCloseDate) {
        if (!expectedCloseDate) {
          setError("Please set an expected close date to advance.");
          setSubmitting(false);
          return;
        }
        if (expectedCloseDate < todayDateStr) {
          setError("Expected close date must be today or later.");
          setSubmitting(false);
          return;
        }
      }

      await changeDealStage(deal.id, targetStageId, {
        overrideReason:
          preflight.requiresOverride && !unblockedByExpectedCloseDate ? overrideReason : undefined,
        lostReasonId: isLostTransition ? lostReasonId : undefined,
        lostNotes: isLostTransition ? lostNotes : undefined,
        lostCompetitor: isLostTransition ? lostCompetitor || undefined : undefined,
        expectedCloseDate: needsExpectedCloseDate ? expectedCloseDate : undefined,
      });

      onSuccess();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Stage change failed");
    } finally {
      setSubmitting(false);
    }
  };

  const isBlocked = preflight != null && !preflight.allowed;
  const bidBoardOwnership = preflight?.bidBoardOwnership;
  const isBidBoardLocked = Boolean(preflight?.bidBoardLocked);
  const canonicalTargetStageSlug =
    preflight == null ? null : toCanonicalDealStageSlug(preflight.targetStage.slug, workflowRoute);
  const { isClosedLost, isClosedWon, shouldForceCompletion } =
    getStageChangeDialogSemantics(canonicalTargetStageSlug, isBidBoardLocked);
  const currentStageMeta =
    preflight == null
      ? null
      : getDealStageMetadata(
          {
            stageId: preflight.currentStage.id,
            workflowRoute,
            isBidBoardOwned: Boolean(isBidBoardLocked),
            bidBoardStageSlug: isBidBoardLocked ? preflight.currentStage.slug : null,
            readOnlySyncedAt: isBidBoardLocked ? new Date().toISOString() : null,
          },
          [preflight.currentStage, preflight.targetStage]
        );
  const targetStageMeta =
    preflight == null
      ? null
      : getDealStageMetadata(
          {
            stageId: preflight.targetStage.id,
            workflowRoute,
            isBidBoardOwned: Boolean(isBidBoardLocked),
            bidBoardStageSlug: isBidBoardLocked ? preflight.targetStage.slug : null,
            readOnlySyncedAt: isBidBoardLocked ? new Date().toISOString() : null,
          },
          [preflight.currentStage, preflight.targetStage]
        );

  const handleOpenChange = shouldForceCompletion ? () => {} : onOpenChange;
  const effectiveBlocked = isBlocked && !unblockedByExpectedCloseDate;
  const requirementAction = onlyExpectedCloseDateMissing
    ? null
    : getStageRequirementAction(deal.id, preflight?.missingRequirements, officeId);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[520px]" showCloseButton={!shouldForceCompletion}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {preflight?.isBackwardMove ? (
              <>
                <ArrowLeft className="h-5 w-5 text-orange-500" />
                Move Deal Backward
              </>
            ) : isClosedLost ? (
              <>
                <AlertTriangle className="h-5 w-5 text-red-500" />
                Close Deal as Lost
              </>
            ) : isClosedWon ? (
              "Close Deal as Won"
            ) : (
              "Advance Deal Stage"
            )}
          </DialogTitle>
          <DialogDescription>
            {deal.name}
          </DialogDescription>
        </DialogHeader>

        {preflightLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : preflight ? (
          <div className="space-y-4">
            {/* Stage Transition Display */}
            <div className="flex items-center gap-3 py-2">
              <DealStageBadge
                stageId={preflight.currentStage.id}
                readOnly={Boolean(currentStageMeta?.isReadOnlyInCrm)}
                ownership={currentStageMeta?.sourceOfTruth}
              />
              {preflight.isBackwardMove ? (
                <ArrowLeft className="h-4 w-4 text-orange-500" />
              ) : (
                <ArrowRight className="h-4 w-4 text-green-500" />
              )}
              <DealStageBadge
                stageId={preflight.targetStage.id}
                readOnly={Boolean(targetStageMeta?.isReadOnlyInCrm)}
                ownership={targetStageMeta?.sourceOfTruth}
              />
            </div>

            {/* Blocked State */}
            {isBlocked && (
              <div className="space-y-3 rounded-lg border border-red-200 bg-red-50 p-3">
                <p className="text-sm text-red-700 font-medium">
                  {preflight.blockReason}
                </p>
                {requirementAction && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="border-red-200 bg-white text-red-700 hover:bg-red-100 hover:text-red-800"
                    onClick={() => {
                      onOpenChange(false);
                      navigate(requirementAction.to);
                    }}
                  >
                    {requirementAction.label}
                  </Button>
                )}
              </div>
            )}

            {isBidBoardLocked && bidBoardOwnership && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <p className="font-medium">Bid Board mirror</p>
                <p className="mt-1 font-medium">Read-only in CRM</p>
                <p className="mt-1">{bidBoardOwnership.message}</p>
                <p className="mt-3 font-medium">Still editable in CRM</p>
                <p className="mt-1">{bidBoardOwnership.canEditInCrm.join(", ")}</p>
                <p className="mt-3 font-medium">Mirrored from Bid Board</p>
                <p className="mt-1">{bidBoardOwnership.mirroredInCrm.join(", ")}</p>
              </div>
            )}

            {/* Gate Checklist */}
            <StageGateChecklist missingRequirements={preflight.missingRequirements} />

            {/* Inline Expected Close Date prompt (set + advance in one action) */}
            {needsExpectedCloseDate && (
              <div className="space-y-2 border-t pt-3">
                <Label htmlFor="expectedCloseDate">
                  Expected Close Date <span className="text-red-500">*</span>
                </Label>
                <p className="text-xs text-muted-foreground">
                  Set a target close date (today or later) to advance into Estimating -- this powers the
                  pipeline forecast.
                </p>
                <Input
                  id="expectedCloseDate"
                  type="date"
                  min={todayDateStr}
                  value={expectedCloseDate}
                  onChange={(e) => setExpectedCloseDate(e.target.value)}
                />
              </div>
            )}

            {/* Override Reason (for directors) */}
            {preflight.requiresOverride && (
              <div className="space-y-2 border-t pt-3">
                <div className="flex items-center gap-2 text-sm font-medium text-red-700">
                  <Shield className="h-4 w-4" />
                  Director Override
                </div>
                <Label htmlFor="overrideReason">
                  Override Reason <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="overrideReason"
                  placeholder="Why are you overriding the requirements?"
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                />
              </div>
            )}

            {/* Closed Lost Fields */}
            {isClosedLost && (
              <div className="space-y-3 border-t pt-3">
                <p className="text-sm font-medium text-red-700">
                  This deal is being closed as lost. All fields below are required.
                </p>
                <div className="space-y-2">
                  <Label htmlFor="lostReason">
                    Reason <span className="text-red-500">*</span>
                  </Label>
                  <Select value={lostReasonId} onValueChange={(val) => setLostReasonId(val ?? "")}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select reason..." />
                    </SelectTrigger>
                    <SelectContent>
                      {reasons.map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          {r.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lostNotes">
                    Notes <span className="text-red-500">*</span>
                  </Label>
                  <textarea
                    id="lostNotes"
                    className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    placeholder="Describe why this deal was lost..."
                    value={lostNotes}
                    onChange={(e) => setLostNotes(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lostCompetitor">Competitor (optional)</Label>
                  <Input
                    id="lostCompetitor"
                    placeholder="Who won the deal?"
                    value={lostCompetitor}
                    onChange={(e) => setLostCompetitor(e.target.value)}
                  />
                </div>
              </div>
            )}

            {/* Closed Won Confirmation */}
            {isClosedWon && (
              <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                <p className="text-sm text-green-700">
                  Deal marked as won. The close date will be set to today.
                </p>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}
          </div>
        ) : (
          error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )
        )}

        <DialogFooter>
          {!shouldForceCompletion && (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          )}
          <Button
            onClick={handleSubmit}
            disabled={effectiveBlocked || preflightLoading || submitting}
            variant={isClosedLost ? "destructive" : "default"}
          >
            {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {effectiveBlocked
              ? isBidBoardLocked
                ? "Read-only in CRM"
                : "Blocked"
              : isClosedLost
              ? "Close as Lost"
              : isClosedWon
              ? "Close as Won"
              : preflight?.isBackwardMove
              ? "Move Backward"
              : "Advance"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
