import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, X, Clock, Handshake, Users, Mail, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  completeTask as apiCompleteTask,
  dismissTask as apiDismissTask,
  snoozeTask as apiSnoozeTask,
} from "@/hooks/use-tasks";
import type { Task } from "@/hooks/use-tasks";
import { TaskEditDialog } from "./task-edit-dialog";

interface TaskRowProps {
  task: Task;
  onUpdate: () => void;
}

const priorityColors: Record<string, string> = {
  urgent: "bg-red-100 text-red-800 border-red-200",
  high: "bg-orange-100 text-orange-800 border-orange-200",
  normal: "bg-blue-100 text-blue-800 border-blue-200",
  low: "bg-gray-100 text-gray-800 border-gray-200",
};

const typeIcons: Record<string, typeof Handshake> = {
  follow_up: Clock,
  stale_deal: Handshake,
  inbound_email: Mail,
  touchpoint: Users,
  manual: Check,
  system: Check,
  approval_request: Check,
};

export function TaskRow({ task, onUpdate }: TaskRowProps) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const handleComplete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setLoading(true);
    try {
      await apiCompleteTask(task.id);
      onUpdate();
    } catch (err) {
      console.error("Failed to complete task:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleDismiss = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setLoading(true);
    try {
      await apiDismissTask(task.id);
      onUpdate();
    } catch (err) {
      console.error("Failed to dismiss task:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleSnooze = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];
    setLoading(true);
    try {
      await apiSnoozeTask(task.id, tomorrow);
      onUpdate();
    } catch (err) {
      console.error("Failed to snooze task:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleClick = () => {
    setEditOpen(true);
  };

  const handleNavigate = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (task.dealId) navigate(`/deals/${task.dealId}`);
    else if (task.contactId) navigate(`/contacts/${task.contactId}`);
    else if (task.emailId) navigate("/email");
  };

  const IconComponent = typeIcons[task.type] ?? Check;
  const isCompleted = task.status === "completed" || task.status === "dismissed";

  return (
    <>
    <div
      className={`flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-muted/50 cursor-pointer transition-colors ${
        isCompleted ? "opacity-60" : ""
      }`}
      onClick={handleClick}
    >
      <IconComponent className="h-4 w-4 text-muted-foreground shrink-0" />

      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium truncate ${isCompleted ? "line-through" : ""}`}>
          {task.title}
        </p>
        {task.dueDate && (
          <p className={`text-xs ${task.isOverdue ? "text-red-600 font-medium" : "text-muted-foreground"}`}>
            Due: {new Date(task.dueDate + "T00:00:00").toLocaleDateString()}
          </p>
        )}
      </div>

      <Badge variant="outline" className={`text-xs shrink-0 ${priorityColors[task.priority] ?? ""}`}>
        {task.priority}
      </Badge>

      {!isCompleted && (
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleComplete}
            disabled={loading}
            title="Complete"
          >
            <Check className="h-3.5 w-3.5 text-green-600" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleSnooze}
            disabled={loading}
            title="Snooze to tomorrow"
          >
            <Clock className="h-3.5 w-3.5 text-amber-600" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleDismiss}
            disabled={loading}
            title="Dismiss"
          >
            <X className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
          {(task.dealId || task.contactId || task.emailId) && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleNavigate}
              title="Go to linked record"
            >
              <Pencil className="h-3.5 w-3.5 text-blue-500" />
            </Button>
          )}
        </div>
      )}
    </div>
    <TaskEditDialog task={task} open={editOpen} onOpenChange={setEditOpen} onUpdated={onUpdate} />
    </>
  );
}
