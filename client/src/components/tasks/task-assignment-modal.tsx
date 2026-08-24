import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useOfficeScopeId } from "@/hooks/use-office-scope";
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

/** What the modal is currently holding, and the tenant it was read from. The two travel together. */
type PendingBatch = {
  /**
   * The office the ids below belong to. Task ids are only meaningful inside one tenant schema, so this
   * is carried on the batch rather than re-read at acknowledge time — see handleOpenChange.
   */
  officeId: string;
  tasks: PendingAssignmentTask[];
  total: number;
};

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
  const officeScopeId = useOfficeScopeId();
  const [batch, setBatch] = useState<PendingBatch | null>(null);
  const [open, setOpen] = useState(false);

  // KEYED BY OFFICE, not a boolean. Office scope is URL-driven (?officeId -> x-office-id -> search
  // path) and an authorized cross-office user changes it by navigating, with no remount and no
  // refreshUser — so a one-shot latch means the modal is fetched for the boot tenant and never again.
  // Holding the office it fetched for makes "have we asked yet" a question about a tenant instead of
  // about the component, which is what it always was.
  //
  // Still a REF, and still compared before it is written, because that is what survives the StrictMode
  // mount/unmount/mount cycle: the first mount claims the office, the remount sees it already claimed
  // and does not fetch again.
  const fetchedOfficeRef = useRef<string | null>(null);
  const acknowledgedRef = useRef(false);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);

  // The tenant every request from this component will land in. `?officeId` verbatim when present,
  // otherwise the user's home office — exactly the fallback authMiddleware applies when no header
  // arrives, resolved here so it can be PINNED on the request instead of left ambient.
  const requestOfficeId = officeScopeId ?? user?.officeId ?? null;

  // The office the server computed `hasPendingTaskAssignments` under. authMiddleware promotes
  // x-office-id into activeOfficeId, so a boot on ?officeId=X yields a flag that describes X.
  const flagOfficeId = user?.activeOfficeId ?? user?.officeId ?? null;

  // THE FLAG ONLY SPEAKS FOR ITS OWN OFFICE. Nothing calls refreshUser on an office change, so it
  // reports the boot office for the rest of the session. Gating every office on it would mean a
  // cross-office user whose boot office is quiet never sees an assignment anywhere else — the flag
  // would be answering a question it was never asked. Where it cannot speak, ask the server; the cost
  // is one indexed LIMIT 5 query per office actually visited.
  const shouldFetch =
    requestOfficeId !== null &&
    (requestOfficeId === flagOfficeId ? Boolean(user?.hasPendingTaskAssignments) : true);

  useEffect(() => {
    if (!shouldFetch || requestOfficeId === null) return;
    if (fetchedOfficeRef.current === requestOfficeId) return;
    fetchedOfficeRef.current = requestOfficeId;
    const fetchedForOfficeId = requestOfficeId;

    // NO `cancelled` FLAG, and its absence is deliberate. Pairing one with a claim-before-fetch ref is
    // actively WRONG under StrictMode, which is how the app runs in development: the first mount
    // claims the office and starts the fetch, the immediate unmount sets cancelled, the remount
    // returns early because the office is already claimed, and the in-flight response is then thrown
    // away by a flag belonging to a mount that no longer exists. The modal never opens at all. React
    // 18+ does not warn about setting state after unmount, and this component lives for the whole
    // session anyway, so there is nothing left for the flag to protect.
    //
    // The office change case does not need one either: the response is tagged with the office it was
    // REQUESTED for, and a batch whose office no longer matches the URL is never rendered and never
    // acknowledged. A late response for an abandoned office is inert rather than raced.
    void fetchPendingAssignmentTasks(fetchedForOfficeId)
      .then((result) => {
        // An empty list with the flag set is a real state, not an error: the flag and the list are two
        // queries against a moving table, and a task completed between them lands here. Opening an
        // empty modal is worse than not opening at all.
        if (result.tasks.length === 0) return;
        // Captured BEFORE the dialog mounts so focus can be handed back to it on close. Base UI's
        // default would restore to the trigger, and this dialog has none — nobody opened it.
        previouslyFocusedRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        acknowledgedRef.current = false;
        setBatch({ officeId: fetchedForOfficeId, tasks: result.tasks, total: result.total });
        setOpen(true);
      })
      .catch(() => {
        // Silent. A modal nobody asked for is not worth a toast when it fails to appear.
      });
  }, [shouldFetch, requestOfficeId]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen || acknowledgedRef.current || batch === null) return;
      acknowledgedRef.current = true;

      // Closing is not "ask me again". The decision was once-per-task, with repeats reserved for
      // urgent/high/overdue — and those repeat regardless of how the modal was dismissed, so a
      // dismissal path that quietly skipped this would produce a modal that reappears for no visible
      // reason. Not awaited: the dialog closes on the click, not on the round trip.
      //
      // Posted against `batch.officeId` — the office the ids were READ from — never the office in the
      // URL at this instant. Those differ the moment somebody changes office scope, and the ids only
      // exist in one schema: sent to the other, the server's ownership re-derivation matches nothing,
      // writes nothing, and still answers 204. Nothing surfaces. The modal simply returns next login.
      void acknowledgeTaskAssignments(
        batch.tasks.map((task) => task.id),
        batch.officeId
      ).catch(() => {
        // A failed acknowledgement costs one repeat of this modal. Trapping the user inside a dialog
        // because the network blinked costs considerably more.
      });
    },
    [batch]
  );

  const handleViewAll = useCallback(() => {
    navigate("/tasks");
    handleOpenChange(false);
  }, [handleOpenChange, navigate]);

  // A batch belonging to an office the user has since navigated away from is never shown. Derived
  // rather than cleared in an effect, so there is no render in which one tenant's assignments are on
  // screen under another tenant's scope — and, because handleOpenChange is only reachable from a
  // rendered dialog, no way for a stale batch to be acknowledged either.
  if (!open || batch === null || batch.officeId !== requestOfficeId) return null;

  const { tasks, total } = batch;
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
        // Not the first tabbable element, which is Base UI's default: nobody asked for this dialog,
        // and landing somebody on an action button invites a reflex press. Focus goes to the dialog
        // itself, which is what a screen reader announces along with the heading it is labelled by.
        //
        // finalFocus is named explicitly because the default restores focus to the TRIGGER, and this
        // dialog has none — it opens because the server said so. previouslyFocusedRef is captured
        // just before the dialog mounts, so whatever the person was doing gets focus back.
        initialFocus={popupRef}
        finalFocus={previouslyFocusedRef}
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
