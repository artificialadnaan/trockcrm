import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TaskCreateDialog } from "@/components/tasks/task-create-dialog";
import { TaskEditDialog } from "@/components/tasks/task-edit-dialog";
import { getTaskStatusLabel, useProjectTasks } from "@/hooks/use-tasks";
import type { Task } from "@/hooks/use-tasks";
import { useAuth } from "@/lib/auth";

function formatDueDate(dueDate: string | null) {
  if (!dueDate) return "No due date";
  return new Date(`${dueDate}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-zinc-100 text-zinc-700",
  scheduled: "bg-slate-100 text-slate-700",
  in_progress: "bg-blue-100 text-blue-800",
  waiting_on: "bg-amber-100 text-amber-800",
  blocked: "bg-red-100 text-red-800",
  completed: "bg-green-100 text-green-800",
  dismissed: "bg-zinc-200 text-zinc-600",
};

export function ProjectTasksTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const { user } = useAuth();
  const { tasks, loading, error, refetch } = useProjectTasks(projectId);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const canManage = user?.role === "admin" || user?.role === "director";

  const sortedTasks = useMemo(() => {
    const priorityRank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
    return [...tasks].sort((a, b) => {
      const aOverdue = a.isOverdue ? 1 : 0;
      const bOverdue = b.isOverdue ? 1 : 0;
      if (aOverdue !== bOverdue) return bOverdue - aOverdue;
      return (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9);
    });
  }, [tasks]);

  const handleTaskUpdated = () => {
    refetch();
    onChanged();
  };

  if (loading) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">Loading project tasks…</p>
        <div className="h-16 rounded-md bg-muted animate-pulse" />
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>;
  }

  const createAction = canManage ? (
    <TaskCreateDialog
      onCreated={handleTaskUpdated}
      projectScopedProjectId={projectId}
    />
  ) : null;

  if (tasks.length === 0) {
    return (
      <div className="space-y-4 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-6">
        <div>
          <p className="text-sm font-medium text-foreground">No tasks yet</p>
          <p className="text-sm text-muted-foreground">
            Add project-scoped tasks here. Assigned users will also see these tasks in their main Tasks page.
          </p>
        </div>
        {createAction}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {tasks.length} project task{tasks.length === 1 ? "" : "s"}
        </p>
        {createAction}
      </div>

      <div className="space-y-3">
        {sortedTasks.map((task) => {
          const canEditTask = canManage || task.assignedTo === user?.id;
          return (
            <div
              key={task.id}
              className="rounded-lg border border-slate-200 bg-white px-4 py-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-foreground">{task.title}</p>
                  {task.description ? (
                    <p className="text-sm text-muted-foreground">{task.description}</p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    Assigned to {task.assignedToName ?? "Unassigned"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    className={`border-0 text-[10px] uppercase tracking-wide ${STATUS_COLORS[task.status] ?? "bg-zinc-100 text-zinc-700"}`}
                  >
                    {getTaskStatusLabel(task.status)}
                  </Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canEditTask}
                    onClick={() => {
                      if (!canEditTask) return;
                      setSelectedTask(task);
                      setEditOpen(true);
                    }}
                  >
                    {canEditTask ? "Edit Task" : "View only"}
                  </Button>
                </div>
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                Due {formatDueDate(task.dueDate)}
                {task.isOverdue ? " • Overdue" : ""}
              </div>
            </div>
          );
        })}
      </div>

      {selectedTask ? (
        <TaskEditDialog
          task={selectedTask}
          open={editOpen}
          onOpenChange={(nextOpen) => {
            setEditOpen(nextOpen);
            if (!nextOpen) setSelectedTask(null);
          }}
          onUpdated={handleTaskUpdated}
        />
      ) : null}
    </div>
  );
}
