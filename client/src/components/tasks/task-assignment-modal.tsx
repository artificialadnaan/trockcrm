import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  acknowledgeTaskAssignments,
  fetchPendingAssignmentTasks,
  type PendingAssignmentTask,
} from "@/hooks/use-tasks";

/**
 * Colour per priority. Muted text is `text-slate-500` or darker throughout, never `text-slate-400`:
 * on a light surface at this size that is 2.56:1 against WCAG's 4.5:1, and the client ratchet in
 * lib/muted-text-contrast.test.ts fails a new file that adds one.
 */
const PRIORITY_STYLES: Record<string, string> = {
  urgent: "bg-red-100 text-red-800 ring-red-200",
  high: "bg-amber-100 text-amber-900 ring-amber-200",
  normal: "bg-slate-100 text-slate-700 ring-slate-200",
  low: "bg-slate-100 text-slate-600 ring-slate-200",
};

function PriorityChip({ priority }: { priority: string }) {
  const style = PRIORITY_STYLES[priority] ?? PRIORITY_STYLES.normal;
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-semibold capitalize ring-1 ring-inset ${style}`}
    >
      {priority}
    </span>
  );
}

/** `2026-08-24` rendered in the reader's locale. Parsed as a LOCAL date so it cannot slip a day. */
function formatDueDate(dueDate: string | null) {
  if (!dueDate) return null;
  const parsed = new Date(`${dueDate}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function AssignmentRow({ task }: { task: PendingAssignmentTask }) {
  const due = formatDueDate(task.dueDate);
  return (
    <li className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-slate-900">{task.title}</p>
        <p className="mt-0.5 text-xs text-slate-600">
          {task.assignedByName ? `Assigned by ${task.assignedByName}` : "Assigned to you"}
          {due ? ` · Due ${due}` : ""}
        </p>
      </div>
      <PriorityChip priority={task.priority} />
    </li>
  );
}

/**
 * The new-assignment popup: what landed on you while you were away.
 *
 * MOUNTED ONCE, ROUTE-INDEPENDENT, inside AuthGate and OUTSIDE its <Suspense> boundary. Outside,
 * because the post-login landing route is lazy() and the boundary wraps <Routes> — a modal declared
 * inside it cannot render until the dashboard chunk resolves, which is precisely the moment it is
 * supposed to be on screen. Inside AuthGate, because AuthGate returns children early for /p/,
 * /daily-summary/, /scorecards/:id/corrective-action and /reset-password: those are deliberately
 * unauthenticated pages, and a signed-in person opening a client photo link must not get an
 * interrupting task dialog over one. Declaration position is otherwise irrelevant to DOM and focus
 * order because DialogContent portals to document.body.
 *
 * ACKNOWLEDGEMENT HAPPENS IN EXACTLY ONE PLACE — `onOpenChange(false)`. Base UI funnels the close
 * button, the footer buttons, Escape and the backdrop through it, so wiring each of those separately
 * would produce several racing POSTs and then need a guard to undo the races. The one guard that does
 * exist here is a latch against re-posting for the same batch; the server's ON CONFLICT DO NOTHING is
 * the actual idempotency guarantee.
 */
export function TaskAssignmentModal() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<PendingAssignmentTask[]>([]);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState(false);

  // Survives the StrictMode mount/unmount/mount cycle, which is the point: an effect that re-fires
  // would fetch twice and, worse, could re-open a dialog the user has already dismissed.
  const fetchedRef = useRef(false);
  const acknowledgedRef = useRef(false);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);

  const hasPending = Boolean(user?.hasPendingTaskAssignments);

  useEffect(() => {
    if (!hasPending || fetchedRef.current) return;
    fetchedRef.current = true;

    let cancelled = false;
    void fetchPendingAssignmentTasks()
      .then((result) => {
        if (cancelled) return;
        // An empty list with the flag set is a real state, not an error: the flag and the list are two
        // queries against a moving table, and a task completed between them lands here. Opening an
        // empty modal is worse than not opening at all.
        if (result.tasks.length === 0) return;
        // Captured BEFORE the dialog mounts so focus can be handed back to it on close. Base UI's
        // default would restore to the trigger, and this dialog has none — nobody opened it.
        previouslyFocusedRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setTasks(result.tasks);
        setTotal(result.total);
        setOpen(true);
      })
      .catch(() => {
        // Silent. A modal nobody asked for is not worth a toast when it fails to appear.
      });

    return () => {
      cancelled = true;
    };
  }, [hasPending]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen || acknowledgedRef.current) return;
      acknowledgedRef.current = true;

      // Closing is not "ask me again". The decision was once-per-task, with repeats reserved for
      // urgent/high/overdue — and those repeat regardless of how the modal was dismissed, so a
      // dismissal path that quietly skipped this would produce a modal that reappears for no visible
      // reason. Not awaited: the dialog closes on the click, not on the round trip.
      void acknowledgeTaskAssignments(tasks.map((task) => task.id)).catch(() => {
        // A failed acknowledgement costs one repeat of this modal. Trapping the user inside a dialog
        // because the network blinked costs considerably more.
      });
    },
    [tasks]
  );

  const handleViewAll = useCallback(() => {
    navigate("/tasks");
    handleOpenChange(false);
  }, [handleOpenChange, navigate]);

  if (!open) return null;

  const remaining = Math.max(total - tasks.length, 0);
  const heading = tasks.length === 1 ? "You have a new task" : `You have ${total} new tasks`;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        ref={popupRef}
        // Base UI already hides everything outside the popup with aria-hidden, which is the stronger
        // half of the contract. aria-modal is set explicitly on top of it because assistive tech
        // support for the two mechanisms is not identical and this dialog interrupts people.
        aria-modal="true"
        // Not the first tabbable element: nobody asked for this dialog, and landing somebody on an
        // action button invites a reflex press. Focus goes to the dialog itself, which is what a
        // screen reader announces along with the heading it is labelled by.
        //
        // CALLBACKS, NOT THE REFS THEMSELVES. Passing `popupRef` directly makes Base UI read
        // `.current` at open time, which races the ref being attached to the very element it points
        // at — sometimes null, in which case Base UI moves focus nowhere and the user is left
        // outside an "interrupting" dialog with the page behind it aria-hidden. A callback is
        // evaluated when focus is actually moved, by which point the ref is populated.
        initialFocus={() => popupRef.current}
        finalFocus={() => previouslyFocusedRef.current}
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>
            Assigned to you since you were last here. They are on your tasks page too.
          </DialogDescription>
        </DialogHeader>

        <ul className="flex flex-col gap-2">
          {tasks.map((task) => (
            <AssignmentRow key={task.id} task={task} />
          ))}
        </ul>

        {remaining > 0 && (
          <p className="text-xs font-medium text-slate-600">
            and {remaining} more waiting on your tasks page
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Close
          </Button>
          <Button onClick={handleViewAll}>View all tasks</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
