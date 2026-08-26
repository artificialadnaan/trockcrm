import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import {
  clearTaskAssignmentModalShownTasks,
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
  /** Attempts made for this office and recheck cycle. Bounds retries so a persistent failure cannot loop. */
  attempts: number;
  /** A user-returned or assignment-signal recheck. Zero is the initial login check. */
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
 * ── WHY ASSIGNMENT VERSIONS, NOT JUST TASK IDS ──────────────────────────────────────────────────────
 * Suppressing a whole office would also suppress work assigned AFTER the modal was shown, which is the
 * one thing this feature exists to deliver. Remembering the individual assignment VERSION already put
 * on screen suppresses only that handoff: a task that leaves someone and comes back has the same id but
 * a new assigned_at version, so it must interrupt again. Keyed per office too, so the record stays
 * meaningful without assuming task ids never repeat across tenant schemas.
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
 * A successful interactive sign-in is a NEW login even if the previous cookie died without running
 * logout(), which is the path that leaves sessionStorage behind. This clears only the temporary
 * interruption record; acknowledgements remain server-side and untouched.
 */
function clearShownTasks(userId: string) {
  clearTaskAssignmentModalShownTasks(userId);
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
   * A pending assignment can arrive after /auth/me has already truthfully reported none. These are
   * explicit check cycles rather than a reset of the fetch state: resetting the state would reuse an
   * existing (office, attempt) request key and StrictMode could suppress the recheck as a duplicate.
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
    controller: AbortController | null;
  }>({ id: 0, key: null, office: null, controller: null });
  const mountedRef = useRef(false);
  const activeOfficeRef = useRef<string | null>(null);
  const openRef = useRef(open);
  const fetchStateRef = useRef(fetchState);
  // A click and its keyboard-generated click can arrive before React commits the loading state. This
  // closes that tiny window so one deliberate interaction maps to at most one direct recheck.
  const interactionRecheckQueuedRef = useRef(false);
  const suppressNextInteractionRecheckRef = useRef(false);

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

  // Event handlers deliberately read refs instead of rendering-time values. A person's next click can
  // happen between renders; the handler must check the current office and must not start a second
  // request while the first one is still in flight.
  useLayoutEffect(() => {
    openRef.current = open;
    fetchStateRef.current = fetchState;
    if (fetchState.status === "loading") interactionRecheckQueuedRef.current = false;
  }, [fetchState, open]);

  const requestAssignmentRecheck = useCallback(() => {
    const office = activeOfficeRef.current;
    if (
      !office ||
      openRef.current ||
      fetchStateRef.current.status === "loading" ||
      interactionRecheckQueuedRef.current
    ) {
      return false;
    }

    // Let an action dialog the person intentionally opened finish before a background assignment
    // check can present its own interruption. The next interaction will check again after it closes.
    if (document.querySelector('[data-slot="dialog-content"]')) return false;

    interactionRecheckQueuedRef.current = true;
    setRecheckGenerations((current) => ({
      ...current,
      [office]: (current[office] ?? 0) + 1,
    }));
    return true;
  }, []);

  // Commit the scope BEFORE passive fetch effects or promise continuations can run. A render guard keeps
  // stale data out of the DOM; this guard also keeps it out of state and sessionStorage. Abort releases
  // the underlying connection promptly, while the bumped identity remains authoritative for transports
  // or test doubles that still deliver a response after abort.
  useLayoutEffect(() => {
    activeOfficeRef.current = requestOfficeId;
    const request = requestRef.current;
    if (request.office === null || request.office === requestOfficeId) return;

    request.controller?.abort();
    requestRef.current = {
      id: request.id + 1,
      key: null,
      office: null,
      controller: null,
    };
    // An abandoned request must not leave its office represented as `loading`. A quiet flag office
    // may issue no replacement request at all, so nothing else would overwrite that state; returning
    // to the abandoned office would then treat the orphaned `loading` value as an in-flight answer and
    // suppress its fetch forever.
    setFetchState(IDLE_FETCH_STATE);
    setOpen(false);
  }, [requestOfficeId]);

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

  // Login only tells us what was pending at one instant. A task can be assigned through a different
  // API instance from the recipient's browser, so an in-memory real-time signal cannot be the source
  // of truth. Every deliberate interaction therefore performs one deduplicated, authoritative check.
  // This is event-driven rather than a timer: it never interrupts the action that is already underway,
  // but it makes a newly assigned task visible on the next click or keyboard action.
  useEffect(() => {
    const recheckOnInteraction = () => {
      // The click that closes this modal is not a new work interaction. Without this one-event
      // suppression, an assignment made while it was open could immediately fetch and reopen it after
      // Close, which is indistinguishable from a broken acknowledgement to the recipient.
      if (suppressNextInteractionRecheckRef.current) {
        suppressNextInteractionRecheckRef.current = false;
        return;
      }
      requestAssignmentRecheck();
    };
    const onClick = () => queueMicrotask(recheckOnInteraction);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      queueMicrotask(recheckOnInteraction);
    };

    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [requestAssignmentRecheck]);

  // Returning to a tab is a new work session from the recipient's point of view, so it gets the same
  // direct, authoritative check as an interaction.
  useEffect(() => {
    const recheckOnResume = () => {
      requestAssignmentRecheck();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") recheckOnResume();
    };

    window.addEventListener("focus", recheckOnResume);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", recheckOnResume);
      document.removeEventListener("visibilitychange", onVisibilityChange);
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

  // An explicit recheck is authoritative over the boot flag. It lets somebody discover a task assigned
  // after login even when `hasPendingTaskAssignments` was correctly false at login time. Its generation
  // becomes part of request identity, so it cannot be swallowed by the original request's dedupe key.
  const requestedRecheckGeneration =
    requestOfficeId === null ? 0 : (recheckGenerations[requestOfficeId] ?? 0);
  const activeRecheckGeneration =
    fetchState.office === requestOfficeId ? fetchState.recheckGeneration : 0;
  const hasQueuedRecheck = requestedRecheckGeneration > activeRecheckGeneration;
  const recheckAllowsFetch = requestedRecheckGeneration > 0;

  // Ask again when the answer we hold is not an answer for the office we are looking at: a different
  // office, nothing fetched yet, a requested live/session recheck, or a failure that has not used its
  // retry. `loading` and `loaded` both mean "leave it alone" unless a later recheck cycle is queued.
  const needsFetch =
    (shouldFetch || recheckAllowsFetch) &&
    requestOfficeId !== null &&
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
    const key = `${office}#${recheckGeneration}#${attempt}`;
    if (requestRef.current.key === key) return;

    const id = requestRef.current.id + 1;
    const controller = new AbortController();
    requestRef.current = { id, key, office, controller };
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
        // An empty list with the flag set is a real state, not an error: the flag and the list are two
        // queries against a moving table, and a task completed between them lands here. Assigned from
        // the result rather than only set to true, so an office whose answer is "nothing" closes a
        // modal the previous office had opened instead of rendering itself empty.
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
          newTotal: Math.max(result.newTotal - hiddenNewCount, unshown.filter((task) => task.isNew).length),
        });
        const opening = unshown.length > 0;
        setOpen(opening);
      })
      .catch(() => {
        if (
          !mountedRef.current ||
          activeOfficeRef.current !== office ||
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
      });
  }, [
    fetchState,
    hasQueuedRecheck,
    needsFetch,
    requestOfficeId,
    requestedRecheckGeneration,
  ]);

  // Persist only AFTER React committed the matching open dialog. The fetch continuation is too early:
  // AuthGate can unmount this component, or an office navigation can commit, between a response arriving
  // and the dialog being rendered. Writing there would suppress assignments nobody ever saw while the
  // server correctly retained no acknowledgement.
  useEffect(() => {
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
    if (!shownUser) return;

    // EVERY RENDERED TASK, not just the previously-unshown ones — they are all on screen. Only this
    // capped page is recorded; a sixth eligible task that never crossed the wire remains able to open
    // the dialog later.
    for (const rendered of fetchState.tasks) {
      shownTasksRef.current.keys.add(
        shownTaskKey(renderedOffice, rendered.id, rendered.assignmentVersion)
      );
    }
    persistShownTasks(shownUser, shownTasksRef.current.keys);
  }, [fetchState, open, requestOfficeId]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean, eventDetails?: { reason?: string }) => {
      // Base UI tells us whether it was a pointer press outside the popup, a close-button press, or
      // Escape. Only click-based dismissal should suppress this exact click; Escape must leave the
      // recipient's next actual click available to discover a later assignment.
      if (
        !nextOpen &&
        (eventDetails?.reason === "outside-press" || eventDetails?.reason === "close-press")
      ) {
        suppressNextInteractionRecheckRef.current = true;
      }
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

  const closeFromClick = useCallback(() => {
    // Escape is not a click, so it deliberately does not set this flag. Someone who dismisses with
    // Escape should get a direct check on their very next actual click.
    suppressNextInteractionRecheckRef.current = true;
    handleOpenChange(false);
  }, [handleOpenChange]);

  const handleViewAll = useCallback(() => {
    // CARRIES THE OFFICE SCOPE. A bare navigate("/tasks") drops ?officeId, and api() then resolves
    // x-office-id from a URL that no longer names an office — so the list that opens is the user's
    // HOME office, having just been told about assignments in another one. The tasks the modal named
    // are simply not there, and nothing says why.
    navigate(scopedHref("/tasks"));
    closeFromClick();
  }, [closeFromClick, navigate, scopedHref]);

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
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
          <img
            src="/task-assigned-confirmation.jpg"
            alt="T Rock Contracting team member in a branded shirt"
            width={960}
            height={1280}
            decoding="async"
            className="h-32 w-full object-cover object-[center_34%] sm:h-36"
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
          <Button variant="outline" onClick={closeFromClick}>
            Close
          </Button>
          <Button onClick={handleViewAll}>View all tasks</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
