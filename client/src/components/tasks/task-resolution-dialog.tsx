import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type TaskResolutionAction = "complete" | "dismiss";

export const TASK_RESOLUTION_NOTE_MAX_LENGTH = 2_000;

interface TaskResolutionDialogProps {
  action: TaskResolutionAction;
  open: boolean;
  taskTitle: string;
  onOpenChange: (open: boolean) => void;
  onResolve: (resolutionNote: string) => Promise<void>;
  onResolved?: () => void;
}

const COPY: Record<
  TaskResolutionAction,
  {
    title: string;
    description: string;
    label: string;
    placeholder: string;
    submit: string;
    blankError: string;
  }
> = {
  complete: {
    title: "Mark task complete",
    description: "Record the action you took. This note is saved in the task history.",
    label: "What action did you take?",
    placeholder: "Called the customer and confirmed the next step.",
    submit: "Mark complete",
    blankError: "Describe the action you took before completing this task.",
  },
  dismiss: {
    title: "Dismiss task",
    description: "Explain why this task is being dismissed. This note is saved in the task history.",
    label: "Why is this task being dismissed?",
    placeholder: "No longer needed because the request was resolved elsewhere.",
    submit: "Dismiss task",
    blankError: "Explain why this task is being dismissed.",
  },
};

/**
 * A terminal task state needs a human-readable outcome. Keeping the input in one component means
 * every close surface asks the same question and sends the same trimmed, durable value to the API.
 */
export function TaskResolutionDialog({
  action,
  open,
  taskTitle,
  onOpenChange,
  onResolve,
  onResolved,
}: TaskResolutionDialogProps) {
  const [resolutionNote, setResolutionNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteId = useId();
  const errorId = useId();
  const copy = COPY[action];
  const trimmedNote = resolutionNote.trim();

  useEffect(() => {
    if (!open) {
      setResolutionNote("");
      setError(null);
      setSubmitting(false);
    }
  }, [open, action]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (submitting) return;
    onOpenChange(nextOpen);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;

    if (!trimmedNote) {
      setError(copy.blankError);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onResolve(trimmedNote);
      onOpenChange(false);
      onResolved?.();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : `Failed to ${action} task`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={!submitting} aria-describedby={`${noteId}-description`}>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription id={`${noteId}-description`}>{copy.description}</DialogDescription>
          <p className="truncate text-sm font-semibold text-slate-700" title={taskTitle}>
            {taskTitle}
          </p>
        </DialogHeader>
        <form className="space-y-3" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <label htmlFor={noteId} className="text-sm font-semibold text-slate-800">
              {copy.label}
            </label>
            <Textarea
              id={noteId}
              value={resolutionNote}
              onChange={(event) => {
                setResolutionNote(event.target.value);
                if (error) setError(null);
              }}
              placeholder={copy.placeholder}
              rows={4}
              maxLength={TASK_RESOLUTION_NOTE_MAX_LENGTH}
              disabled={submitting}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
              autoFocus
            />
          </div>
          {error ? (
            <p id={errorId} role="alert" className="text-sm font-medium text-brand-red">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !trimmedNote}>
              {submitting ? "Saving..." : copy.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
