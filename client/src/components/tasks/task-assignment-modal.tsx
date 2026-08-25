import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useOfficeScopeId, useOfficeScopedHref } from "@/hooks/use-office-scope";
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
          {/* "Created by", not "Assigned by". The PATCH flow reassigns without touching created_by, so
              after a reassignment the name here is the original author and not whoever routed it —
              nothing in the schema records that person. Stating what is known beats asserting what is
              not, on a dialog whose credibility is the only thing making it worth interrupting for. */}
          {task.createdByName ? `Created by ${task.createdByName}` : "Assigned to you"}
          {due ? ` · Due ${due}` : ""}
        </p>
      </div>
      <PriorityChip priority={task.priority} />
    </li>
  );
}

function AssignmentGroup({
  group,
  label,
  tasks,
}: {
  group: "new" | "outstanding";
  label: string | null;
  tasks: PendingAssignmentTask[];
}) {
  return (
    <section data-assignment-group={group}>
      {label && (
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600">{label}</h3>
      )}
      <ul className="flex flex-col gap-2">
        {tasks.map((task) => (
          <AssignmentRow key={task.id} task={task} />
        ))}
      </ul>
    </section>
  );
}

/**
 * THE WHOLE LIFECYCLE, IN ONE PIECE OF STATE.
 *
 * Three review rounds each fixed one symptom of the same mistake and exposed the next: the modal never
 * refetched when the office changed, then a late response from an abandoned office overwrote the
 * current one, then a failed request left the office latched so nothing ever retried. That is not three
 * bugs. It is one boolean being asked to hold four outcomes — NOT STARTED, IN FLIGHT, FAILED and
 * SUCCEEDED — and every round added another ref to express the case the previous one could not, until
 * the refs disagreed with each other. That is precisely how the StrictMode defect earlier in this
 * branch happened: a `cancelled` flag and a latch that cancelled out exactly.
 *
 * So the four outcomes are named. Every property the reviews asked for then falls out of the shape
 * instead of needing its own guard:
 *
 *   an office change      → `office` no longer matches, so the effect asks again
 *   a superseded response → fails the request-id check and writes nothing at all
 *   a failed request      → `error` is not `loaded`, so it is not an answer and a retry is allowed
 *   an error must not     → only `loaded` renders. A failure cannot reach the empty-state path,
 *   look like "none"        because it never becomes a state that renders.
 *
 * There is no latch. The machine already knows whether it has an answer.
 */
type FetchStatus = "idle" | "loading" | "loaded" | "error";

type FetchState = {
  /** The tenant this state describes. null only in `idle`. */
  office: string | null;
  status: FetchStatus;
  /** Attempts made for THIS office. Bounds the retry so a persistent failure cannot become a loop. */
  attempts: number;
  tasks: PendingAssignmentTask[];
  total: number;
  newTotal: number;
};

const IDLE_FETCH_STATE: FetchState = {
  office: null,
  status: "idle",
  attempts: 0,
  tasks: [],
  total: 0,
  newTotal: 0,
};

/**
 * One automatic retry, then stop.
 *
 * A failed request must not end the feature for the session — a single blip at login would otherwise
 * cost somebody the entire modal. But "error is not loaded, so try again" with no bound is a hot loop
 * against a server that is already unhappy, and the effect re-runs on every state write. Two attempts
 * is the smallest number that recovers from a transient failure without becoming one.
 */
export const MAX_FETCH_ATTEMPTS = 2;

/**
 * WHAT THIS PERSON HAS ALREADY BEEN INTERRUPTED WITH, FOR THE LIFE OF THIS BROWSING SESSION.
 *
 * ── WHY IT IS STORED AT ALL ────────────────────────────────────────────────────────────────────────
 * Urgent, high and overdue assignments stay eligible after acknowledgement — that is the repeat rule
 * and it is correct. But a reload throws away every ref in the component while the auth cookie lives
 * on, so boot calls /auth/me, the flag comes back true, and the same dialog opens again. Not once per
 * login: once per F5. That is the permanent-nag failure this feature was already rescued from once,
 * arriving through a different door.
 *
 * ── WHY sessionStorage, WHEN THE SPEC RULED BROWSER STORAGE OUT ────────────────────────────────────
 * It ruled it out for ACKNOWLEDGEMENT, and rightly: that is an accountability record, it has to survive
 * a new device and a cleared profile, and "I was never told" must be answerable from the database. It
 * still is — nothing here replaces that. This is the opposite kind of fact. "I have already shown you
 * this" is about one browsing session and SHOULD die with it, which is exactly what sessionStorage
 * does. logout() clears both storages, so the guard resets on precisely the event that starts a new
 * login. localStorage would be wrong in the other direction: it would outlive the browser and the
 * repeat would never fire again on that machine.
 *
 * ── WHY TASK IDS AND NOT OFFICES ───────────────────────────────────────────────────────────────────
 * Suppressing a whole office would also suppress work assigned AFTER the modal was shown, which is the
 * one thing this feature exists to deliver. Remembering the individual assignments already put on
 * screen suppresses only the repeat, and a genuinely new assignment still opens the dialog on the next
 * load. Keyed per office as well, so the record stays meaningful without assuming task ids never repeat
 * across tenant schemas.
 */
const SHOWN_STORAGE_PREFIX = "trock:task-assignment-modal:shown:";

/** Scoped to the person. The session-invalidation path bounces to /login WITHOUT clearing storage, so
 *  a second user signing in on the same tab must not inherit the first one's suppressions. */
function shownStorageKey(userId: string) {
  return `${SHOWN_STORAGE_PREFIX}${userId}`;
}

function shownTaskKey(officeId: string, taskId: string) {
  return `${officeId}:${taskId}`;
}

/**
 * Every read and write is wrapped. Private browsing and a full quota both throw here, and an
 * interrupting dialog that cannot render because storage said no is a far worse outcome than one that
 * repeats. On failure the in-memory set still covers the current mount, which is the common case.
 */
function readShownTasks(userId: string): string[] {
  try {
    const raw = window.sessionStorage.getItem(shownStorageKey(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function persistShownTasks(userId: string, keys: Set<string>) {
  try {
    window.sessionStorage.setItem(shownStorageKey(userId), JSON.stringify([...keys]));
  } catch {
    // Storage unavailable. The in-memory set still suppresses repeats for this mount.
  }
}

/**
 * A successful interactive sign-in is a NEW login even if the previous cookie died without running
 * logout(), which is the path that leaves sessionStorage behind. This clears only the temporary
 * interruption record; acknowledgements remain server-side and untouched.
 */
function clearShownTasks(userId: string) {
  try {
    window.sessionStorage.removeItem(shownStorageKey(userId));
  } catch {
    // Storage unavailable already falls back to the in-memory set.
  }
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
 * exist here is a latch against re-posting the same result; the server's ON CONFLICT DO NOTHING is
 * the actual idempotency guarantee.
 */
export function TaskAssignmentModal() {
  const {
    user,
    assignmentModalSession,
    assignmentModalSessionResetPending,
    consumeAssignmentModalSessionReset,
  } = useAuth();
  const navigate = useNavigate();
  const officeScopeId = useOfficeScopeId();
  const scopedHref = useOfficeScopedHref();
  const [fetchState, setFetchState] = useState<FetchState>(IDLE_FETCH_STATE);
  const [open, setOpen] = useState(false);

  /**
   * THE ONLY LIFECYCLE REF, and it holds a request IDENTITY rather than a lifecycle state.
   *
   * `id` is monotonic and answers "which request is this the answer to?" — a response whose id is no
   * longer current lost a race and is dropped without touching anything.
   *
   * `key` is the (office, attempt) pair the last request was issued for, and it exists for exactly one
   * reason: StrictMode runs the effect twice before the first run's state write commits, so the second
   * run reads a stale `fetchState` and would issue a duplicate request. Deduping on the attempt the
   * request was issued FOR is not a record of "done" — a genuine retry bumps `attempts` and a genuine
   * office change changes the office, so both produce a new key and both proceed.
   */
  const requestRef = useRef<{ id: number; key: string | null }>({ id: 0, key: null });

  /**
   * Assignments already put on screen for this person, hydrated from sessionStorage.
   *
   * Deliberately NOT part of fetchState. That answers "what am I currently showing" and is replaced on
   * every office change; this answers "what have I already shown" and has to outlive not just the
   * office change but the component itself. Asking one variable both questions is the shape that
   * produced the latch chain this file has already been through three times.
   *
   * Re-hydrated when the user changes, so a second person signing in on the same tab starts clean.
   * An explicit successful login also gets its own AuthProvider token, which resets only this shown
   * set. `/auth/me` deliberately does not advance that token: a reload remains the same login.
   */
  const shownTasksRef = useRef<{ userId: string | null; session: number; keys: Set<string> }>({
    userId: null,
    session: 0,
    keys: new Set(),
  });
  const acknowledgedRef = useRef(false);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);

  // The tenant every request from this component will land in. `?officeId` verbatim when present,
  // otherwise the user's home office — exactly the fallback authMiddleware applies when no header
  // arrives, resolved here so it can be PINNED on the request instead of left ambient.
  const requestOfficeId = officeScopeId ?? user?.officeId ?? null;

  // Hydrated during render, and re-hydrated whenever the person or their explicit-login session
  // changes. Mutating a ref here rather than in an effect is deliberate: `needsFetch` and the open
  // decision below both read it in the same pass, and an effect would leave one render seeing an empty
  // set — which is one dialog nobody wanted. A pending reset belongs to an actual successful login;
  // a `/auth/me` refresh leaves the token unchanged and therefore rehydrates the persisted shown set.
  const shownUserId = user?.id ?? null;
  const hasNewModalSession = shownTasksRef.current.session !== assignmentModalSession;
  if (
    shownUserId !== null &&
    (shownTasksRef.current.userId !== shownUserId || hasNewModalSession)
  ) {
    const resetShownTasks = assignmentModalSessionResetPending && hasNewModalSession;
    if (resetShownTasks) clearShownTasks(shownUserId);
    shownTasksRef.current = {
      userId: shownUserId,
      session: assignmentModalSession,
      keys: resetShownTasks ? new Set() : new Set(readShownTasks(shownUserId)),
    };
  }

  // The pending bit lives in AuthProvider rather than this component so a public-route transition
  // cannot make a later remount re-apply an old login reset. It is consumed only after this render has
  // synchronously installed the empty set above; otherwise a fetch could see the prior suppression for
  // one frame and silently skip the very modal the new login is meant to show.
  useEffect(() => {
    if (shownUserId !== null && assignmentModalSessionResetPending) {
      consumeAssignmentModalSessionReset(assignmentModalSession);
    }
  }, [
    assignmentModalSession,
    assignmentModalSessionResetPending,
    consumeAssignmentModalSessionReset,
    shownUserId,
  ]);

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

  // Ask again when the answer we hold is not an answer for the office we are looking at: a different
  // office, nothing fetched yet, or a failure that has not used up its retry. `loading` and `loaded`
  // both mean "leave it alone" — one has a request in flight, the other has an answer.
  const needsFetch =
    shouldFetch &&
    requestOfficeId !== null &&
    (fetchState.office !== requestOfficeId ||
      fetchState.status === "idle" ||
      (fetchState.status === "error" && fetchState.attempts < MAX_FETCH_ATTEMPTS));

  useEffect(() => {
    if (!needsFetch || requestOfficeId === null) return;

    const office = requestOfficeId;
    const attempt = (fetchState.office === office ? fetchState.attempts : 0) + 1;
    const key = `${office}#${attempt}`;
    if (requestRef.current.key === key) return;

    const id = requestRef.current.id + 1;
    requestRef.current = { id, key };
    setFetchState({ office, status: "loading", attempts: attempt, tasks: [], total: 0, newTotal: 0 });
    // Anything currently on screen belonged to the previous answer. Closed directly rather than through
    // handleOpenChange, because an office change is not a dismissal and must not acknowledge anything.
    setOpen(false);

    // BOTH settle paths check the id before writing, and neither writes anything when it loses.
    //
    // No `cancelled` cleanup flag: pairing one with a request identity is the mistake that made the
    // modal never open under StrictMode earlier in this branch, because the flag belonged to a mount
    // that no longer existed while the identity belonged to the request that was still in flight. The
    // id is the single authority on whether a response is wanted.
    fetchPendingAssignmentTasks(office)
      .then((result) => {
        if (id !== requestRef.current.id) return;
        // Captured BEFORE the dialog mounts so focus can be handed back on close. Base UI's default
        // restores to the trigger, and this dialog has none — nobody opened it.
        previouslyFocusedRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        acknowledgedRef.current = false;
        setFetchState({
          office,
          status: "loaded",
          attempts: attempt,
          tasks: result.tasks,
          total: result.total,
          newTotal: result.newTotal,
        });
        // An empty list with the flag set is a real state, not an error: the flag and the list are two
        // queries against a moving table, and a task completed between them lands here. Assigned from
        // the result rather than only set to true, so an office whose answer is "nothing" closes a
        // modal the previous office had opened instead of rendering itself empty.
        // Open only if there is something in here this person has not already been shown. A response
        // made entirely of repeats they closed earlier — the ordinary case after a reload — opens
        // nothing; one carrying a newly assigned task still does.
        const unshown = result.tasks.filter(
          (candidate) => !shownTasksRef.current.keys.has(shownTaskKey(office, candidate.id))
        );
        const opening = unshown.length > 0;

        // Recorded HERE, at the point the dialog actually goes on screen, and nowhere else. An empty
        // list opens nothing, so nothing is recorded; the same is true of the error path below and of
        // any response that failed the id check above. Recording from the mere arrival of a response
        // would mark work as seen that nobody ever laid eyes on.
        //
        // EVERY RENDERED TASK, not just the unshown ones — they are all on screen. And only the ones
        // in `result.tasks`, which is the server's capped page: a sixth eligible task that never
        // crossed the wire was never shown either, and must stay able to open this dialog later.
        if (opening && shownTasksRef.current.userId) {
          for (const rendered of result.tasks) {
            shownTasksRef.current.keys.add(shownTaskKey(office, rendered.id));
          }
          persistShownTasks(shownTasksRef.current.userId, shownTasksRef.current.keys);
        }
        setOpen(opening);
      })
      .catch(() => {
        if (id !== requestRef.current.id) return;
        // Recorded as a FAILURE, never as an empty result. Those must not be the same state: only
        // `loaded` renders, so an error can never reach the modal and reassure somebody that they have
        // nothing waiting when the truth is that nobody managed to ask.
        setFetchState({ office, status: "error", attempts: attempt, tasks: [], total: 0, newTotal: 0 });
      });
  }, [needsFetch, requestOfficeId, fetchState]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen || acknowledgedRef.current || fetchState.status !== "loaded") return;
      acknowledgedRef.current = true;

      // Closing is not "ask me again". The decision was once-per-task, with repeats reserved for
      // urgent/high/overdue — and those repeat regardless of how the modal was dismissed, so a
      // dismissal path that quietly skipped this would produce a modal that reappears for no visible
      // reason. Not awaited: the dialog closes on the click, not on the round trip.
      //
      // Posted against `fetchState.office` — the office the ids were READ from — never the office in the
      // URL at this instant. Task ids exist in exactly one schema; sent to another, the server's
      // ownership re-derivation matches nothing, writes nothing, and still answers 204. Nothing
      // surfaces anywhere and the modal simply returns at the next login.
      //
      // DEFENCE IN DEPTH, and worth being honest that it is: the render guard below already refuses
      // to render a result whose office no longer matches the URL, and handleOpenChange is only
      // reachable from a rendered dialog — so at every point this line can execute, the two values
      // are provably equal. Mutating it to `requestOfficeId` does not fail a test, and no test here
      // pretends otherwise. It stays because "post where you read" is the invariant this code is
      // actually built on, and expressing it directly is what keeps that true if the render guard is
      // ever relaxed. The alternative is correctness that depends entirely on a condition twenty
      // lines away.
      void acknowledgeTaskAssignments(
        fetchState.tasks.map((task) => task.id),
        fetchState.office
      ).catch(() => {
        // A failed acknowledgement costs one repeat of this modal. Trapping the user inside a dialog
        // because the network blinked costs considerably more.
      });
    },
    [fetchState]
  );

  const handleViewAll = useCallback(() => {
    // CARRIES THE OFFICE SCOPE. A bare navigate("/tasks") drops ?officeId, and api() then resolves
    // x-office-id from a URL that no longer names an office — so the list that opens is the user's
    // HOME office, having just been told about assignments in another one. The tasks the modal named
    // are simply not there, and nothing says why.
    navigate(scopedHref("/tasks"));
    handleOpenChange(false);
  }, [handleOpenChange, navigate, scopedHref]);

  // A result belonging to an office the user has since navigated away from is never shown. Derived
  // rather than cleared in an effect, so there is no render in which one tenant's assignments are on
  // screen under another tenant's scope — and, because handleOpenChange is only reachable from a
  // rendered dialog, no way for a stale result to be acknowledged either.
  // ONLY `loaded` renders. idle and loading have no answer yet, and `error` must never be dressed up
  // as "nothing assigned to you" — a reassuring empty state built on a failed request tells the person
  // the opposite of the truth, on the one screen whose whole job is to tell them something.
  if (!open || fetchState.status !== "loaded" || fetchState.office !== requestOfficeId) return null;

  const { tasks, total, newTotal } = fetchState;
  const remaining = Math.max(total - tasks.length, 0);

  // Split for display, never re-derived: `isNew` comes from the same NOT EXISTS the server selected
  // the row with, so a row can never be filed under a heading that contradicts why it was returned.
  const newTasks = tasks.filter((task) => task.isNew);
  const outstandingTasks = tasks.filter((task) => !task.isNew);

  // A repeat is not a new assignment. Urgent, high and overdue work comes back on EVERY login until it
  // leaves pending, so counting it as new makes the headline false from the second showing onwards.
  const heading =
    newTotal === 0
      ? "Still on your plate"
      : newTotal === 1
        ? "You have a new task"
        : `You have ${newTotal} new tasks`;
  const description =
    newTotal === 0
      ? "Still outstanding, and still assigned to you."
      : "Assigned to you since you were last here. They are on your tasks page too.";

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
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {newTasks.length > 0 && (
          <AssignmentGroup
            group="new"
            // No heading when there is nothing to contrast it with — the dialog title already says
            // these are new, and a lone "New" label above the only list is noise.
            label={outstandingTasks.length > 0 ? "New" : null}
            tasks={newTasks}
          />
        )}
        {outstandingTasks.length > 0 && (
          <AssignmentGroup group="outstanding" label="Still outstanding" tasks={outstandingTasks} />
        )}

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
