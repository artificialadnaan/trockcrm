import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import {
  clearTaskAssignmentModalSessionState,
  persistTaskAssignmentModalCheckedOffices,
  readTaskAssignmentModalCheckedOffices,
  taskAssignmentModalShownStorageKey,
} from "@/lib/task-assignment-modal-shown";
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
          {/* last_assigned_by is set on every handoff; before the first one, the server falls back to
              created_by. The modal therefore tells the recipient who actually routed this assignment
              without losing the useful creator fallback for an untouched task. */}
          {task.assignedByName ? `Assigned by ${task.assignedByName}` : "Assigned to you"}
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
  /** Attempts made for this office and session check. Bounds retries so a persistent failure cannot loop. */
  attempts: number;
  /** The interaction-triggered check this answer belongs to. Zero means no check has been requested. */
  recheckGeneration: number;
  tasks: PendingAssignmentTask[];
  total: number;
  newTotal: number;
};

const IDLE_FETCH_STATE: FetchState = {
  office: null,
  status: "idle",
  attempts: 0,
  recheckGeneration: 0,
  tasks: [],
  total: 0,
  newTotal: 0,
};

/**
 * One automatic retry, then stop.
 *
 * A failed request must not end the feature for the session — one transient blip after an ordinary
 * click should not cost somebody the entire reminder. But "error is not loaded, so try again" with no
 * bound is a hot loop against a server that is already unhappy, and the effect re-runs on every state
 * write. Two attempts is the smallest number that recovers from a transient failure without becoming one.
 */
export const MAX_FETCH_ATTEMPTS = 2;

// An assignment prompt must never land on top of an interaction the person has already opened. These
// are the popup-content slots shared by the CRM's Base UI wrappers; checking content rather than
// triggers means the request-time guard also covers nested menus and portals.
const ACTIVE_INTERACTION_POPUP_SLOTS = [
  "dialog-content",
  "sheet-content",
  "select-content",
  "dropdown-menu-content",
  "dropdown-menu-sub-content",
  "popover-content",
];
const ACTIVE_INTERACTION_POPUP_SELECTOR = ACTIVE_INTERACTION_POPUP_SLOTS.map(
  (slot) => `[data-slot="${slot}"]`
).join(", ");

// A click can close a portal before its queued recheck gets to inspect the DOM. Preserve the event's
// origin too, including the trigger that begins opening a portal and the overlays that dismiss one.
const INTERACTION_SURFACE_SELECTOR = [
  ...ACTIVE_INTERACTION_POPUP_SLOTS,
  "dialog-overlay",
  "sheet-overlay",
  "dialog-trigger",
  "sheet-trigger",
  "select-trigger",
  "dropdown-menu-trigger",
  "dropdown-menu-sub-trigger",
  "popover-trigger",
]
  .map((slot) => `[data-slot="${slot}"]`)
  .join(", ");

function isInteractionSurface(target: EventTarget | null) {
  return target instanceof Element && target.closest(INTERACTION_SURFACE_SELECTOR) !== null;
}

function isTextEntryOrNativePicker(target: EventTarget | null) {
  return (
    target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable], [role="textbox"]') !== null
  );
}

/**
 * WHAT THIS PERSON HAS ALREADY BEEN INTERRUPTED WITH, FOR THE LIFE OF THIS BROWSING SESSION.
 *
 * ── WHY IT IS STORED AT ALL ────────────────────────────────────────────────────────────────────────
 * Urgent, high and overdue assignments stay eligible after acknowledgement — that is the repeat rule
 * and it is correct. But a reload throws away every ref in the component while the browser session
 * lives, so the same dialog must not open again simply because somebody refreshed the page. That is the
 * permanent-nag failure this feature was already rescued from once, arriving through a different door.
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
 * ── WHY ASSIGNMENT VERSIONS, NOT JUST TASK IDS ──────────────────────────────────────────────────────
 * The session's check budget is intentionally per office, but the interruption record remains per
 * assignment VERSION. That keeps the acknowledgement/display state precise: a task that leaves someone
 * and comes back has the same id but a new assigned_at version, so it is a different handoff. Keying it
 * per office also avoids assuming task ids never repeat across tenant schemas.
 */
/** Scoped to the person. The session-invalidation path bounces to /login WITHOUT clearing storage, so
 *  a second user signing in on the same tab must not inherit the first one's suppressions. */
function shownStorageKey(userId: string) {
  return taskAssignmentModalShownStorageKey(userId);
}

function shownTaskKey(officeId: string, taskId: string, assignmentVersion: string) {
  return `${officeId}:${taskId}:${assignmentVersion}`;
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
 * The new-assignment popup: what landed on you while you were away.
 *
 * MOUNTED ONCE, ROUTE-INDEPENDENT, inside AuthGate and OUTSIDE its <Suspense> boundary. Outside,
 * because the post-login landing route is lazy() and the boundary wraps <Routes> — a modal declared
 * inside it cannot render until the recipient's next interaction arrives. Inside AuthGate, because
 * AuthGate returns children early for /p/,
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
   * A task can arrive after authentication has completed. Each office gets one explicit, deferred
   * check per browser session; its generation keeps that check distinct from a retry or another office.
   */
  const [recheckGenerations, setRecheckGenerations] = useState<Record<string, number>>({});

  /**
   * THE REQUEST IDENTITY, not another copy of the fetch lifecycle state.
   *
   * `id` is monotonic and answers "which request is this the answer to?" — a response whose id is no
   * longer current lost a race and is dropped without touching anything.
   *
   * `key` is the (office, recheck generation, attempt) triple the last request was issued for, and it exists for exactly one
   * reason: StrictMode runs the effect twice before the first run's state write commits, so the second
   * run reads a stale `fetchState` and would issue a duplicate request. Deduping on the attempt the
   * request was issued FOR is not a record of "done": a genuine retry bumps `attempts`, a requested
   * recheck bumps its generation, and an office change changes the office, so each produces a new key.
   * The neighbouring
   * refs answer only commit facts — whether this component is mounted and which office was committed —
   * so an async continuation cannot turn an abandoned response back into lifecycle state.
   */
  const requestRef = useRef<{
    id: number;
    key: string | null;
    office: string | null;
    userId: string | null;
    session: number;
    controller: AbortController | null;
  }>({ id: 0, key: null, office: null, userId: null, session: 0, controller: null });
  const mountedRef = useRef(false);
  const activeOfficeRef = useRef<string | null>(null);
  // Office identity alone is not enough: an explicit account/session transition can retain the same
  // office id while the old request is still resolving. Keep that transition synchronous too.
  const activeReminderSessionRef = useRef<{ userId: string | null; session: number }>({
    userId: null,
    session: 0,
  });
  const openRef = useRef(open);
  // State updates are asynchronous, but a response may settle in the same turn as a newer click. This
  // ref records the latest requested generation synchronously so that older answers never briefly
  // render and get marked as shown before their replacement request starts.
  const latestRequestedRecheckGenerationRef = useRef<Record<string, number>>({});

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
  /**
   * A successful empty answer is still an answer. Remembering it for this browser session is what
   * prevents the document click listener from becoming a request on every ordinary CRM action.
   */
  const checkedOfficesRef = useRef<{ userId: string | null; session: number; offices: Set<string> }>({
    userId: null,
    session: 0,
    offices: new Set(),
  });
  // Claimed before React schedules the fetch state so a burst of clicks maps to one request. A failure
  // or a response deliberately deferred behind a popup releases the claim for the next eligible click.
  const checkingOfficesRef = useRef(new Set<string>());
  const acknowledgedRef = useRef(false);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);

  // The tenant every request from this component will land in. `?officeId` verbatim when present,
  // otherwise the user's home office — exactly the fallback authMiddleware applies when no header
  // arrives, resolved here so it can be PINNED on the request instead of left ambient.
  const requestOfficeId = officeScopeId ?? user?.officeId ?? null;
  const requestUserId = user?.id ?? null;

  // Event handlers deliberately read refs instead of rendering-time values. A person's next click can
  // happen between renders, but the current office/session claim still makes it one request.
  useLayoutEffect(() => {
    openRef.current = open;
  }, [open]);

  const markOfficeChecked = useCallback((office: string) => {
    const checked = checkedOfficesRef.current;
    if (!checked.userId) return;
    checked.offices.add(office);
    checkingOfficesRef.current.delete(office);
    persistTaskAssignmentModalCheckedOffices(checked.userId, checked.offices);
  }, []);

  const requestAssignmentRecheck = useCallback(() => {
    const office = activeOfficeRef.current;
    const checked = checkedOfficesRef.current;
    if (
      !office ||
      !checked.userId ||
      openRef.current ||
      checked.offices.has(office) ||
      checkingOfficesRef.current.has(office)
    ) {
      return false;
    }

    // Let a popup the person intentionally opened finish before a background assignment check can
    // present its own interruption. The next interaction will check again after it closes.
    if (document.querySelector(ACTIVE_INTERACTION_POPUP_SELECTOR)) return false;

    checkingOfficesRef.current.add(office);
    const nextGeneration = (latestRequestedRecheckGenerationRef.current[office] ?? 0) + 1;
    latestRequestedRecheckGenerationRef.current[office] = nextGeneration;
    setRecheckGenerations((current) => ({
      ...current,
      [office]: Math.max(current[office] ?? 0, nextGeneration),
    }));
    return true;
  }, []);

  // Commit the scope BEFORE passive fetch effects or promise continuations can run. A render guard keeps
  // stale data out of the DOM; this guard also keeps it out of state and sessionStorage. Abort releases
  // the underlying connection promptly, while the bumped identity remains authoritative for transports
  // or test doubles that still deliver a response after abort.
  useLayoutEffect(() => {
    const previousOffice = activeOfficeRef.current;
    const previousReminderSession = activeReminderSessionRef.current;
    const sessionChanged =
      previousReminderSession.userId !== requestUserId ||
      previousReminderSession.session !== assignmentModalSession;
    activeOfficeRef.current = requestOfficeId;
    activeReminderSessionRef.current = {
      userId: requestUserId,
      session: assignmentModalSession,
    };
    if (previousOffice !== null && previousOffice !== requestOfficeId) {
      // A scope change can commit after the click queued a check but before the passive fetch effect
      // starts it. Release that unissued claim too; otherwise returning to the original office would
      // look permanently in flight despite never having sent a request.
      checkingOfficesRef.current.delete(previousOffice);
    }
    const request = requestRef.current;
    if (sessionChanged) {
      request.controller?.abort();
      if (request.office !== null) checkingOfficesRef.current.delete(request.office);
      requestRef.current = {
        id: request.id + 1,
        key: null,
        office: null,
        userId: null,
        session: 0,
        controller: null,
      };
      checkingOfficesRef.current.clear();
      setFetchState(IDLE_FETCH_STATE);
      setOpen(false);
      return;
    }
    if (request.office === null || request.office === requestOfficeId) return;

    request.controller?.abort();
    checkingOfficesRef.current.delete(request.office);
    requestRef.current = {
      id: request.id + 1,
      key: null,
      office: null,
      userId: null,
      session: 0,
      controller: null,
    };
    // An abandoned request must not leave its office represented as `loading`. Returning to that office
    // later must be able to use its next eligible interaction to ask again.
    setFetchState(IDLE_FETCH_STATE);
    setOpen(false);
  }, [assignmentModalSession, requestOfficeId, requestUserId]);

  // The active bit invalidates a continuation synchronously on unmount. Abort is deferred one microtask
  // solely for React StrictMode's development-only setup -> cleanup -> setup probe: that is not a real
  // unmount, reactivates this same ref synchronously, and should keep the one deduplicated request alive.
  // A real unmount leaves the bit false, so its request is then aborted without being allowed to write.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const controller = requestRef.current.controller;
      queueMicrotask(() => {
        if (!mountedRef.current) controller?.abort();
      });
    };
  }, []);

  // Authentication is a critical rendering path, so it deliberately does NOT ask for pending tasks.
  // Instead the recipient's next ordinary CRM click requests one authoritative answer for the current
  // office. A successful answer is remembered for the browser session, making all later clicks, focus
  // changes and visibility changes local no-ops rather than more database work.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      // After this office has its one answer, the listener should be effectively free: no selector
      // walks, no queued microtask, and most importantly no route back to the database on every click.
      const activeOffice = activeOfficeRef.current;
      const checked = checkedOfficesRef.current;
      if (
        !activeOffice ||
        !checked.userId ||
        openRef.current ||
        checked.offices.has(activeOffice) ||
        checkingOfficesRef.current.has(activeOffice)
      ) {
        return;
      }

      // Native controls emit click only after their Enter/Space activation has taken effect. The modal
      // must never turn typing, a native picker, or a popup choice into an interruption.
      const interactionSurfaceActive =
        document.querySelector(ACTIVE_INTERACTION_POPUP_SELECTOR) ||
        isInteractionSurface(event.target) ||
        isTextEntryOrNativePicker(event.target);
      if (openRef.current || interactionSurfaceActive) return;

      // Run after the click's own handler has had a chance to open a popup or move scope. The callback
      // repeats the popup guard because a React portal can commit in this microtask.
      queueMicrotask(() => {
        if (
          openRef.current ||
          document.querySelector(ACTIVE_INTERACTION_POPUP_SELECTOR) ||
          isTextEntryOrNativePicker(document.activeElement)
        ) {
          return;
        }
        requestAssignmentRecheck();
      });
    };

    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
    };
  }, [requestAssignmentRecheck]);

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
    if (resetShownTasks) clearTaskAssignmentModalSessionState(shownUserId);
    shownTasksRef.current = {
      userId: shownUserId,
      session: assignmentModalSession,
      keys: resetShownTasks ? new Set() : new Set(readShownTasks(shownUserId)),
    };
    checkedOfficesRef.current = {
      userId: shownUserId,
      session: assignmentModalSession,
      offices: resetShownTasks ? new Set() : new Set(readTaskAssignmentModalCheckedOffices(shownUserId)),
    };
    checkingOfficesRef.current.clear();
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

  // An interaction check is authoritative. Its generation becomes part of request identity, so it
  // cannot be swallowed by an earlier in-flight request or its retry.
  const requestedRecheckGeneration =
    requestOfficeId === null ? 0 : (recheckGenerations[requestOfficeId] ?? 0);
  const activeRecheckGeneration =
    fetchState.office === requestOfficeId ? fetchState.recheckGeneration : 0;
  const hasQueuedRecheck = requestedRecheckGeneration > activeRecheckGeneration;
  const recheckAllowsFetch = requestedRecheckGeneration > 0;
  // A generation records identity, not permission. It remains in React state after an office switch,
  // while the claim is deliberately released for an abandoned request. Requiring the claim prevents a
  // stale generation from silently turning a later office return back into an eager fetch.
  const hasRequestedSessionCheck =
    requestOfficeId !== null && checkingOfficesRef.current.has(requestOfficeId);

  // A request exists only after the deferred interaction has explicitly asked for one. A failed answer
  // retries once on its own; after that, the next eligible click starts a fresh generation instead of
  // hammering an unhealthy server.
  const needsFetch =
    recheckAllowsFetch &&
    hasRequestedSessionCheck &&
    requestOfficeId !== null &&
    fetchState.status !== "loading" &&
    (hasQueuedRecheck ||
      fetchState.office !== requestOfficeId ||
      fetchState.status === "idle" ||
      (fetchState.status === "error" && fetchState.attempts < MAX_FETCH_ATTEMPTS));

  useEffect(() => {
    if (!needsFetch || requestOfficeId === null) return;

    const office = requestOfficeId;
    const recheckGeneration = hasQueuedRecheck
      ? requestedRecheckGeneration
      : fetchState.office === office
        ? fetchState.recheckGeneration
        : 0;
    const attempt =
      fetchState.office === office && fetchState.recheckGeneration === recheckGeneration
        ? fetchState.attempts + 1
        : 1;
    const key = `${requestUserId ?? "anonymous"}:${assignmentModalSession}:${office}#${recheckGeneration}#${attempt}`;
    if (requestRef.current.key === key) return;

    const id = requestRef.current.id + 1;
    const controller = new AbortController();
    requestRef.current = {
      id,
      key,
      office,
      userId: requestUserId,
      session: assignmentModalSession,
      controller,
    };
    setFetchState({
      office,
      status: "loading",
      attempts: attempt,
      recheckGeneration,
      tasks: [],
      total: 0,
      newTotal: 0,
    });
    // Anything currently on screen belonged to the previous answer. Closed directly rather than through
    // handleOpenChange, because an office change is not a dismissal and must not acknowledge anything.
    setOpen(false);

    // BOTH settle paths require the same mounted component, request identity and committed office before
    // writing. Abort is resource cleanup; these checks are the correctness boundary because a transport
    // is still allowed to settle after its signal flips.
    fetchPendingAssignmentTasks(office, controller.signal)
      .then((result) => {
        if (
          !mountedRef.current ||
          activeOfficeRef.current !== office ||
          activeReminderSessionRef.current.userId !== requestUserId ||
          activeReminderSessionRef.current.session !== assignmentModalSession ||
          requestRef.current.userId !== requestUserId ||
          requestRef.current.session !== assignmentModalSession ||
          id !== requestRef.current.id
        ) {
          return;
        }
        requestRef.current.controller = null;
        // Captured BEFORE the dialog mounts so focus can be handed back on close. Base UI's default
        // restores to the trigger, and this dialog has none — nobody opened it.
        previouslyFocusedRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        acknowledgedRef.current = false;
        // An empty list is a real answer, not an error. Assigned from the result rather than only set
        // to true, so an office whose answer is "nothing" closes a modal the previous office had
        // opened instead of rendering itself empty.
        // Open only if there is something in here this person has not already been shown. A response
        // made entirely of repeats they closed earlier — the ordinary case after a reload — opens
        // nothing; one carrying a newly assigned task still does.
        const unshown = result.tasks.filter(
          (candidate) =>
            !shownTasksRef.current.keys.has(
              shownTaskKey(office, candidate.id, candidate.assignmentVersion)
            )
        );
        const hiddenCount = result.tasks.length - unshown.length;
        const hiddenNewCount = result.tasks.filter(
          (candidate) =>
            candidate.isNew &&
            shownTasksRef.current.keys.has(
              shownTaskKey(office, candidate.id, candidate.assignmentVersion)
            )
        ).length;
        // A later assignment can share a capped response with an urgent/high/overdue repeat already
        // shown in this session. The repeat keeps the server's total true, but it must not return to
        // the dialog just because its new neighbour opens one — nor be acknowledged again as part of
        // that neighbour's batch. Remove just those returned cards from the count too: server totals
        // include the whole capped response, while rows beyond it were never shown and still belong in
        // "N more" / the new-work heading.
        setFetchState({
          office,
          status: "loaded",
          attempts: attempt,
          recheckGeneration,
          tasks: unshown,
          total: Math.max(result.total - hiddenCount, unshown.length),
          newTotal: Math.max(
            result.newTotal - hiddenNewCount,
            unshown.filter((task) => task.isNew).length,
          ),
        });
        // A response can race with somebody opening a picker, editor, or Base UI popup after this
        // request began. Keep an unseen answer retryable for a later click rather than covering the
        // work they are already doing. Empty and already-shown answers are complete for this session.
        const opening =
          unshown.length > 0 &&
          (latestRequestedRecheckGenerationRef.current[office] ?? 0) === recheckGeneration &&
          !document.querySelector(ACTIVE_INTERACTION_POPUP_SELECTOR) &&
          !isTextEntryOrNativePicker(document.activeElement);
        if (unshown.length === 0) {
          markOfficeChecked(office);
        } else if (!opening) {
          checkingOfficesRef.current.delete(office);
        }
        setOpen(opening);
      })
      .catch(() => {
        if (
          !mountedRef.current ||
          activeOfficeRef.current !== office ||
          activeReminderSessionRef.current.userId !== requestUserId ||
          activeReminderSessionRef.current.session !== assignmentModalSession ||
          requestRef.current.userId !== requestUserId ||
          requestRef.current.session !== assignmentModalSession ||
          id !== requestRef.current.id
        ) {
          return;
        }
        requestRef.current.controller = null;
        // Recorded as a FAILURE, never as an empty result. Those must not be the same state: only
        // `loaded` renders, so an error can never reach the modal and reassure somebody that they have
        // nothing waiting when the truth is that nobody managed to ask.
        setFetchState({
          office,
          status: "error",
          attempts: attempt,
          recheckGeneration,
          tasks: [],
          total: 0,
          newTotal: 0,
        });
        if (attempt >= MAX_FETCH_ATTEMPTS) checkingOfficesRef.current.delete(office);
      });
  }, [
    fetchState,
    hasQueuedRecheck,
    needsFetch,
    requestOfficeId,
    requestedRecheckGeneration,
    markOfficeChecked,
    assignmentModalSession,
    requestUserId,
  ]);

  // Persist only AFTER React committed the matching open dialog. The fetch continuation is too early:
  // AuthGate can unmount this component, or an office navigation can commit, between a response arriving
  // and the dialog being rendered. Writing there would suppress assignments nobody ever saw while the
  // server correctly retained no acknowledgement.
  useLayoutEffect(() => {
    const renderedOffice = fetchState.office;
    if (
      !open ||
      fetchState.status !== "loaded" ||
      renderedOffice === null ||
      renderedOffice !== requestOfficeId ||
      activeOfficeRef.current !== requestOfficeId
    ) {
      return;
    }

    const shownUser = shownTasksRef.current.userId;
    if (
      !shownUser ||
      activeReminderSessionRef.current.userId !== shownUser ||
      activeReminderSessionRef.current.session !== assignmentModalSession ||
      requestRef.current.userId !== shownUser ||
      requestRef.current.session !== assignmentModalSession
    ) {
      return;
    }

    // EVERY RENDERED TASK, not just the previously-unshown ones — they are all on screen. Only this
    // capped page is recorded; a sixth eligible task that never crossed the wire remains able to open
    // the dialog later.
    for (const rendered of fetchState.tasks) {
      shownTasksRef.current.keys.add(
        shownTaskKey(renderedOffice, rendered.id, rendered.assignmentVersion)
      );
    }
    persistShownTasks(shownUser, shownTasksRef.current.keys);
    markOfficeChecked(renderedOffice);
  }, [assignmentModalSession, fetchState, markOfficeChecked, open, requestOfficeId]);

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
        fetchState.tasks.map(({ id, assignmentVersion, acknowledgementToken }) => ({
          id,
          assignmentVersion,
          acknowledgementToken,
        })),
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
        ? "Task assigned"
        : "Tasks assigned";
  const description =
    newTotal === 0
      ? "Still outstanding, and still assigned to you."
      : newTotal === 1
        ? "You have a new task assigned to you since you were last here. It is on your tasks page too."
        : `You have ${newTotal} new tasks assigned to you since you were last here. They are on your tasks page too.`;

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
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50 p-2">
          <img
            src="/task-assigned-confirmation.jpg"
            alt="T Rock Contracting team member in a branded shirt"
            width={960}
            height={1280}
            decoding="async"
            className="h-auto max-h-[40svh] w-auto max-w-full object-contain"
          />
        </div>

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
