import { Fragment, useMemo, useState } from "react";
import { Save, RefreshCw, ShieldCheck, FileCheck, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useAdminPipeline, type PipelineStageAdmin } from "@/hooks/use-admin-pipeline";
import {
  filterKnownStageGateValues,
  STAGE_GATE_APPROVAL_OPTIONS,
  STAGE_GATE_DOCUMENT_OPTIONS,
  STAGE_GATE_FIELD_OPTIONS,
  toggleStageGateValue,
  type StageGateOption,
} from "@/lib/stage-gate-options";
import { toast } from "sonner";

const EMPTY_GATE_TOUCH_STATE = {
  requiredFields: false,
  requiredDocuments: false,
  requiredApprovals: false,
};

function formatRequirementSummary(label: string, count: number) {
  return count === 0 ? `No ${label.toLowerCase()}` : `${count} ${label.toLowerCase()}`;
}

function StageGateEditorSection({
  title,
  description,
  values,
  options,
  onToggle,
  icon,
}: {
  title: string;
  description: string;
  values: string[];
  options: StageGateOption[];
  onToggle: (value: string) => void;
  icon: React.ReactNode;
}) {
  return (
    <Card className="border-slate-200 shadow-sm">
      <CardHeader className="space-y-2 pb-3">
        <div className="flex items-center gap-2 text-slate-700">
          {icon}
          <CardTitle className="text-sm">{title}</CardTitle>
        </div>
        <CardDescription className="text-xs leading-5">{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap gap-2 pb-2">
          <Badge variant="outline" className="border-slate-300 bg-white text-slate-700">
            {formatRequirementSummary(title, values.length)}
          </Badge>
        </div>
        <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
          {options.map((option) => {
            const checked = values.includes(option.value);
            return (
              <Label
                key={option.value}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2 transition-colors ${
                  checked ? "border-blue-300 bg-blue-50/70" : "border-slate-200 bg-white hover:bg-slate-50"
                }`}
              >
                <Checkbox checked={checked} onCheckedChange={() => onToggle(option.value)} className="mt-0.5" />
                <div className="space-y-1">
                  <div className="text-sm font-medium text-slate-900">{option.label}</div>
                  {option.description ? (
                    <div className="text-xs leading-5 text-slate-500">{option.description}</div>
                  ) : null}
                </div>
              </Label>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

export function PipelineConfigPage() {
  const { stages, loading, saving, refetch, updateStage } = useAdminPipeline();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Partial<PipelineStageAdmin>>({});
  const [touchedGateSections, setTouchedGateSections] = useState(EMPTY_GATE_TOUCH_STATE);

  const knownFieldValues = useMemo(
    () => new Set(STAGE_GATE_FIELD_OPTIONS.map((option) => option.value)),
    []
  );
  const knownDocumentValues = useMemo(
    () => new Set(STAGE_GATE_DOCUMENT_OPTIONS.map((option) => option.value)),
    []
  );
  const knownApprovalValues = useMemo(
    () => new Set(STAGE_GATE_APPROVAL_OPTIONS.map((option) => option.value)),
    []
  );

  const startEdit = (stage: PipelineStageAdmin) => {
    setEditingId(stage.id);
    setEditValues({
      name: stage.name,
      color: stage.color ?? "#6B7280",
      staleThresholdDays: stage.staleThresholdDays,
      procoreStageMapping: stage.procoreStageMapping ?? "",
      requiredFields: stage.requiredFields,
      requiredDocuments: stage.requiredDocuments,
      requiredApprovals: stage.requiredApprovals,
    });
    setTouchedGateSections(EMPTY_GATE_TOUCH_STATE);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValues({});
    setTouchedGateSections(EMPTY_GATE_TOUCH_STATE);
  };

  const saveEdit = async (id: string) => {
    const payload: Partial<PipelineStageAdmin> = {
      name: editValues.name,
      color: editValues.color,
      staleThresholdDays: editValues.staleThresholdDays ?? null,
      procoreStageMapping: editValues.procoreStageMapping || null,
    };

    if (touchedGateSections.requiredFields) {
      payload.requiredFields = filterKnownStageGateValues(
        editValues.requiredFields ?? [],
        STAGE_GATE_FIELD_OPTIONS
      );
    }

    if (touchedGateSections.requiredDocuments) {
      payload.requiredDocuments = filterKnownStageGateValues(
        editValues.requiredDocuments ?? [],
        STAGE_GATE_DOCUMENT_OPTIONS
      );
    }

    if (touchedGateSections.requiredApprovals) {
      payload.requiredApprovals = filterKnownStageGateValues(
        editValues.requiredApprovals ?? [],
        STAGE_GATE_APPROVAL_OPTIONS
      );
    }

    try {
      await updateStage(id, payload);
      setEditingId(null);
      setEditValues({});
      setTouchedGateSections(EMPTY_GATE_TOUCH_STATE);
      toast.success("Pipeline stage updated");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update pipeline stage";
      toast.error(message);
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Pipeline Configuration</h1>
          <p className="text-sm text-gray-500 mt-1">
            Stage order, stale thresholds, stage gates, and Procore mappings
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refetch} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">#</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Color</TableHead>
              <TableHead>Stale After (days)</TableHead>
              <TableHead>Procore Mapping</TableHead>
              <TableHead>Stage Gates</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stages.map((stage) => {
              const isEditing = editingId === stage.id;
              const unknownFieldCount = stage.requiredFields.filter((value) => !knownFieldValues.has(value)).length;
              const unknownDocumentCount = stage.requiredDocuments.filter((value) => !knownDocumentValues.has(value)).length;
              const unknownApprovalCount = stage.requiredApprovals.filter((value) => !knownApprovalValues.has(value)).length;

              return (
                <Fragment key={stage.id}>
                  <TableRow className={isEditing ? "bg-slate-50/70" : undefined}>
                    <TableCell className="text-gray-400 text-sm">{stage.displayOrder}</TableCell>
                    <TableCell className="min-w-[220px]">
                      {isEditing ? (
                        <Input
                          value={editValues.name ?? ""}
                          onChange={(e) => setEditValues((v) => ({ ...v, name: e.target.value }))}
                          className="h-8 w-44"
                        />
                      ) : (
                        <div className="space-y-1">
                          <span className="font-medium">{stage.name}</span>
                          <div className="text-xs uppercase tracking-[0.18em] text-slate-400">{stage.slug}</div>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {stage.isTerminal ? (
                        <Badge className="bg-gray-100 text-gray-600 text-xs">Terminal</Badge>
                      ) : stage.isActivePipeline ? (
                        <Badge className="bg-blue-100 text-blue-700 text-xs">Pipeline</Badge>
                      ) : (
                        <Badge className="bg-amber-100 text-amber-700 text-xs">DD</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {isEditing ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="color"
                            value={editValues.color ?? "#6B7280"}
                            onChange={(e) => setEditValues((v) => ({ ...v, color: e.target.value }))}
                            className="h-8 w-10 rounded cursor-pointer"
                          />
                          <span className="text-xs text-gray-500 font-mono">
                            {editValues.color}
                          </span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <div
                            className="h-4 w-4 rounded-full border border-gray-200"
                            style={{ backgroundColor: stage.color ?? "#6B7280" }}
                          />
                          <span className="text-xs text-gray-500 font-mono">{stage.color ?? "\u2014"}</span>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {isEditing ? (
                        <Input
                          type="number"
                          min={0}
                          placeholder="e.g. 14"
                          value={editValues.staleThresholdDays ?? ""}
                          onChange={(e) =>
                            setEditValues((v) => ({
                              ...v,
                              staleThresholdDays: e.target.value ? parseInt(e.target.value, 10) : null,
                            }))
                          }
                          className="h-8 w-24"
                        />
                      ) : (
                        <span className="text-sm text-gray-600">
                          {stage.staleThresholdDays != null ? `${stage.staleThresholdDays}d` : "\u2014"}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {isEditing ? (
                        <Input
                          placeholder="e.g. Active"
                          value={editValues.procoreStageMapping ?? ""}
                          onChange={(e) =>
                            setEditValues((v) => ({ ...v, procoreStageMapping: e.target.value }))
                          }
                          className="h-8 w-28"
                        />
                      ) : (
                        <span className="text-sm text-gray-600 font-mono">
                          {stage.procoreStageMapping ?? "\u2014"}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="min-w-[260px]">
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="outline" className="border-slate-300 bg-white text-slate-700">
                          {stage.requiredFields.length} fields
                        </Badge>
                        <Badge variant="outline" className="border-slate-300 bg-white text-slate-700">
                          {stage.requiredDocuments.length} docs
                        </Badge>
                        <Badge variant="outline" className="border-slate-300 bg-white text-slate-700">
                          {stage.requiredApprovals.length} approvals
                        </Badge>
                        {unknownFieldCount + unknownDocumentCount + unknownApprovalCount > 0 ? (
                          <Badge className="bg-amber-100 text-amber-800 text-xs">
                            {unknownFieldCount + unknownDocumentCount + unknownApprovalCount} legacy values
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      {isEditing ? (
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            className="h-7 bg-blue-600 hover:bg-blue-700 text-white"
                            onClick={() => saveEdit(stage.id)}
                            disabled={saving}
                          >
                            <Save className="h-3.5 w-3.5 mr-1" />
                            Save
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7" onClick={cancelEdit}>
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-gray-600"
                          onClick={() => startEdit(stage)}
                        >
                          Edit
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>

                  {isEditing ? (
                    <TableRow className="bg-slate-50/50">
                      <TableCell colSpan={8} className="px-4 py-5">
                        <div className="space-y-4">
                          <div className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 md:flex-row md:items-center md:justify-between">
                            <div>
                              Configure what must exist before this stage can be completed without an override.
                            </div>
                            <div className="text-xs uppercase tracking-[0.18em] text-slate-400">
                              Directors and admins can still override blocked moves
                            </div>
                          </div>

                          {unknownFieldCount + unknownDocumentCount + unknownApprovalCount > 0 ? (
                            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                              This stage has legacy gate values that are not supported by the current editor. They will stay untouched unless you change and save that gate section.
                            </div>
                          ) : null}

                          <div className="grid gap-4 xl:grid-cols-3">
                            <StageGateEditorSection
                              title="Required Fields"
                              description="Pick deal fields that must be populated before a rep can move into this stage."
                              values={filterKnownStageGateValues(editValues.requiredFields ?? [], STAGE_GATE_FIELD_OPTIONS)}
                              options={STAGE_GATE_FIELD_OPTIONS}
                              onToggle={(value) => {
                                setTouchedGateSections((current) => ({ ...current, requiredFields: true }));
                                setEditValues((current) => ({
                                  ...current,
                                  requiredFields: toggleStageGateValue(
                                    filterKnownStageGateValues(
                                      current.requiredFields ?? [],
                                      STAGE_GATE_FIELD_OPTIONS
                                    ),
                                    value
                                  ),
                                }));
                              }}
                              icon={<ListChecks className="h-4 w-4" />}
                            />
                            <StageGateEditorSection
                              title="Required Documents"
                              description="Pick document categories that must exist on the deal before advancing."
                              values={filterKnownStageGateValues(editValues.requiredDocuments ?? [], STAGE_GATE_DOCUMENT_OPTIONS)}
                              options={STAGE_GATE_DOCUMENT_OPTIONS}
                              onToggle={(value) => {
                                setTouchedGateSections((current) => ({ ...current, requiredDocuments: true }));
                                setEditValues((current) => ({
                                  ...current,
                                  requiredDocuments: toggleStageGateValue(
                                    filterKnownStageGateValues(
                                      current.requiredDocuments ?? [],
                                      STAGE_GATE_DOCUMENT_OPTIONS
                                    ),
                                    value
                                  ),
                                }));
                              }}
                              icon={<FileCheck className="h-4 w-4" />}
                            />
                            <StageGateEditorSection
                              title="Required Approvals"
                              description="Pick approval roles that must approve this stage move before a rep can advance."
                              values={filterKnownStageGateValues(editValues.requiredApprovals ?? [], STAGE_GATE_APPROVAL_OPTIONS)}
                              options={STAGE_GATE_APPROVAL_OPTIONS}
                              onToggle={(value) => {
                                setTouchedGateSections((current) => ({ ...current, requiredApprovals: true }));
                                setEditValues((current) => ({
                                  ...current,
                                  requiredApprovals: toggleStageGateValue(
                                    filterKnownStageGateValues(
                                      current.requiredApprovals ?? [],
                                      STAGE_GATE_APPROVAL_OPTIONS
                                    ),
                                    value
                                  ),
                                }));
                              }}
                              icon={<ShieldCheck className="h-4 w-4" />}
                            />
                          </div>

                          <Separator />

                          <div className="flex flex-wrap gap-2 text-xs text-slate-500">
                            <span>Saved requirements become visible in the deal stage preflight checklist.</span>
                            <span>Empty sections mean no gate for that category.</span>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
