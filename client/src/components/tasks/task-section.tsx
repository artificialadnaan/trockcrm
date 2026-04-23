import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TaskRow } from "./task-row";
import type { Task } from "@/hooks/use-tasks";

interface TaskSectionProps {
  title: string;
  tasks: Task[];
  count: number;
  variant?: "danger" | "warning" | "default" | "muted";
  defaultOpen?: boolean;
  onUpdate: () => void;
  pageSize?: number;
}

const variantStyles: Record<string, string> = {
  danger: "text-red-700",
  warning: "text-amber-700",
  default: "text-foreground",
  muted: "text-muted-foreground",
};

const badgeVariants: Record<string, string> = {
  danger: "bg-red-100 text-red-800",
  warning: "bg-amber-100 text-amber-800",
  default: "bg-blue-100 text-blue-800",
  muted: "bg-gray-100 text-gray-600",
};

export function TaskSection({
  title,
  tasks,
  count,
  variant = "default",
  defaultOpen = true,
  onUpdate,
  pageSize = 10,
}: TaskSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(tasks.length / pageSize));
  const pageStart = (page - 1) * pageSize;
  const visibleTasks = useMemo(
    () => tasks.slice(pageStart, pageStart + pageSize),
    [pageSize, pageStart, tasks],
  );

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  return (
    <div className="border rounded-lg">
      <button
        className="w-full flex items-center gap-2 px-4 py-3 hover:bg-muted/30 transition-colors"
        onClick={() => setOpen(!open)}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        <span className={`text-sm font-semibold ${variantStyles[variant]}`}>{title}</span>
        <Badge variant="secondary" className={`text-xs ${badgeVariants[variant]}`}>
          {count}
        </Badge>
      </button>

      {open && tasks.length > 0 && (
        <div className="px-2 pb-2 space-y-0.5">
          {visibleTasks.map((task) => (
            <TaskRow key={task.id} task={task} onUpdate={onUpdate} />
          ))}
          {tasks.length > pageSize && (
            <div className="flex items-center justify-between px-2 pt-3">
              <p className="text-xs text-muted-foreground">
                Showing {pageStart + 1}-{Math.min(pageStart + pageSize, tasks.length)} of {tasks.length}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  disabled={page === 1}
                >
                  Previous
                </Button>
                <span className="text-xs text-muted-foreground">
                  {page}/{totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                  disabled={page === totalPages}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {open && tasks.length === 0 && (
        <div className="px-4 pb-3 text-sm text-muted-foreground">
          No tasks in this section.
        </div>
      )}
    </div>
  );
}
