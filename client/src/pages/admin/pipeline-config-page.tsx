import { useState } from "react";
import { Save, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useAdminPipeline, type PipelineStageAdmin } from "@/hooks/use-admin-pipeline";

export function PipelineConfigPage() {
  const { stages, loading, saving, refetch, updateStage } = useAdminPipeline();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Partial<PipelineStageAdmin>>({});

  const startEdit = (stage: PipelineStageAdmin) => {
    setEditingId(stage.id);
    setEditValues({
      name: stage.name,
      color: stage.color ?? "#6B7280",
      staleThresholdDays: stage.staleThresholdDays,
      procoreStageMapping: stage.procoreStageMapping ?? "",
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValues({});
  };

  const saveEdit = async (id: string) => {
    await updateStage(id, {
      name: editValues.name,
      color: editValues.color,
      staleThresholdDays: editValues.staleThresholdDays ?? null,
      procoreStageMapping: editValues.procoreStageMapping || null,
    });
    setEditingId(null);
    setEditValues({});
  };

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Pipeline Configuration</h1>
          <p className="text-sm text-gray-500 mt-1">
            Stage order, stale thresholds, and Procore mappings
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
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stages.map((stage) => {
              const isEditing = editingId === stage.id;
              return (
                <TableRow key={stage.id}>
                  <TableCell className="text-gray-400 text-sm">{stage.displayOrder}</TableCell>
                  <TableCell>
                    {isEditing ? (
                      <Input
                        value={editValues.name ?? ""}
                        onChange={(e) => setEditValues((v) => ({ ...v, name: e.target.value }))}
                        className="h-8 w-36"
                      />
                    ) : (
                      <span className="font-medium">{stage.name}</span>
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
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
