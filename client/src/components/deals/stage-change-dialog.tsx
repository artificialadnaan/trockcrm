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
  missingRequirements: StageRequirementState | null | undefined
): StageRequirementAction | null {
  if (!missingRequirements) {
    return null;
  }

  if (missingRequirements.fields.some((field) => field.includes("."))) {
    return {
      label: "Open Scoping Workspace",
      to: `/deals/${dealId}?tab=scoping`,
    };
  }

  if (missingRequirements.documents.length > 0) {
    return {
      label: "Open Files",
      to: `/deals/${dealId}?tab=files`,
    };
  }

  if (missingRequirements.fields.length > 0) {
    return {
      label: "Open Overview",
      to: `/deals/${dealId}?tab=overview`,
    };
  }

  return null;
}

interface StageChangeDialogProps {
  deal: {
    id: string;
    name: string;
    stageId: string;
    workflowRoute?: "normal" | "service" | null;
  };
  targetStageId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function StageChangeDialog({
  deal,
  targetStageId,
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
    const isLostTransition =
      canonicalTargetStageSlug === "production_lost" ||
      canonicalTargetStageSlug === "service_lost";

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

      // Validate override reason
      if (preflight.requiresOverride && !overrideReason.trim()) {
        setError("Please provide a reason for the override.");
        setSubmitting(false);
        return;
      }

      await changeDealStage(deal.id, targetStageId, {
        overrideReason: preflight.requiresOverride ? overrideReason : undefined,
        lostReasonId: isLostTransition ? lostReasonId : undefined,
        lostNotes: isLostTransition ? lostNotes : undefined,
        lostCompetitor: isLostTransition ? lostCompetitor || undefined : undefined,
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
  const isClosedLost =
    canonicalTargetStageSlug === "production_lost" ||
    canonicalTargetStageSlug === "service_lost";
  const isClosedWon =
    canonicalTargetStageSlug === "sent_to_production" ||
    canonicalTargetStageSlug === "service_sent_to_production";
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

  const shouldForceCompletion = isClosedLost && !isBidBoardLocked;
  const handleOpenChange = shouldForceCompletion ? () => {} : onOpenChange;
  const requirementAction = getStageRequirementAction(deal.id, preflight?.missingRequirements);

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
            disabled={isBlocked || preflightLoading || submitting}
            variant={isClosedLost ? "destructive" : "default"}
          >
            {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {isBlocked
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
