import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TaskRow } from "./task-row";
import type { Task } from "@/hooks/use-tasks";

interface TaskSectionProps {
  title: string;
  tasks: Task[];
  count: number;
  variant?: "danger" | "warning" | "default" | "muted";
  defaultOpen?: boolean;
  onUpdate: () => void;
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
}: TaskSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

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
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} onUpdate={onUpdate} />
          ))}
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
