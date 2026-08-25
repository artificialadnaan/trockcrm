import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, MessageSquare, Send, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getTaskProjectContext } from "@/lib/task-project-context";
import {
  ackTaskReplies,
  completeTask,
  getTaskStatusLabel,
  isTerminalTaskStatus,
  postTaskComment,
  useTaskComments,
  useTaskTimeline,
  type Task,
  type TaskComment,
  type TaskLoopDescriptor,
  type TaskTimelineEntry,
} from "@/hooks/use-tasks";

/**
 * THE TASK DETAIL SURFACE — a drawer over the list, at the existing `/tasks/:taskId` route.
 *
 * `/tasks/:taskId` was never a detail page: App.tsx routes both `/tasks` and `/tasks/:taskId` to
 * TaskListPage, which rendered the one task as a "Linked task" banner with no thread, no composer and
 * no history. Both of this feature's emails deep-link here, so this is where the conversation has to
 * live.
 *
 * A DRAWER RATHER THAN A ROUTE-LEVEL PAGE, for two reasons. The routing already exists and already
 * points here, so every link that has ever been mailed keeps working without an App.tsx change (which
 * matters: a parallel branch owns that file). And the assigner's actual job is triage across several
 * open loops — the list stays behind the drawer, so closing one returns them to the rest instead of
 * to a back-navigation.
 */

/**
 * The statuses `completeTask` will actually accept.
 *
 * Mirrors the service's conditional UPDATE (pending / in_progress / waiting_on / blocked) and the
 * transition table, which has no `scheduled -> completed` edge. Offering the button outside this set
 * produced a misleading "Task already completed or dismissed" on every click.
 */
const COMPLETABLE_STATUSES = new Set(["pending", "in_progress", "waiting_on", "blocked"]);

function initialsOf(name: string | null | undefined) {
  if (!name) return "SY";
  return name
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function formatWhen(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The message the composer shows when a reply here reaches nobody. Stated plainly rather than
 *  rerouted to an office admin: mailing somebody about a task they never assigned is a different
 *  wrong answer, not a fix. */
function loopNotice(loop: TaskLoopDescriptor | null): string | null {
  if (!loop || loop.notifiesAssigner) return null;
  if (loop.reason === "no_assigner") {
    return "This task was created by the system, so nobody is notified of replies. Your reply is still recorded here.";
  }
  return `${loop.assignerName ?? "The person who assigned this"} is no longer active, so nobody is notified of replies. Your reply is still recorded here.`;
}

function CommentBubble({ comment }: { comment: TaskComment }) {
  const author = comment.authorName ?? "System";
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[10px] font-black text-white",
          comment.authorName ? "bg-brand-red" : "bg-slate-400"
        )}
      >
        {initialsOf(comment.authorName)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm font-black text-slate-950">{author}</span>
          <span className="text-xs font-semibold text-slate-500">{formatWhen(comment.createdAt)}</span>
          {comment.kind === "note" ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-slate-600">
              Note
            </span>
          ) : null}
        </p>
        {/* whitespace-pre-wrap, not dangerouslySetInnerHTML: the body is user text and stays text. */}
        <p className="mt-1 whitespace-pre-wrap break-words text-sm font-medium text-slate-700">
          {comment.body}
        </p>
      </div>
    </li>
  );
}

function TimelineRow({ entry }: { entry: TaskTimelineEntry }) {
  // The summary names the first change and appends "(+N more)". Saying that and then providing no way
  // to see the rest is worse than not mentioning them, so every reported change is listed.
  const extraChanges = entry.fieldChanges.length > 1 ? entry.fieldChanges : [];

  return (
    <li className="flex gap-3 border-l-2 border-slate-200 pl-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-800">{entry.summary}</p>
        {extraChanges.length > 0 ? (
          <ul className="mt-1 space-y-0.5">
            {extraChanges.map((change) => (
              <li key={change.key} className="text-xs font-medium text-slate-600">
                <span className="font-black">{change.label}</span>
                {change.transition === "set"
                  ? `: set to ${change.toDisplay}`
                  : change.transition === "cleared"
                    ? ": cleared"
                    : `: ${change.fromDisplay} → ${change.toDisplay}`}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-xs font-semibold text-slate-500">{formatWhen(entry.occurredAt)}</p>
      </div>
    </li>
  );
}

export function TaskConversationDrawer({
  task,
  currentUserId,
  onClose,
  onChanged,
  completeRequested = false,
}: {
  task: Task;
  currentUserId: string;
  onClose: () => void;
  onChanged: () => void;
  /**
   * Arrived from the reply email's "Mark complete" CTA (`?complete=1`).
   *
   * It FOCUSES the action; it deliberately does not perform it. A link in an email is a GET, and a GET
   * that mutates is one mail-scanner prefetch away from closing tasks nobody touched — so the close
   * still costs one deliberate click by an authenticated assigner.
   */
  completeRequested?: boolean;
}) {
  const [tab, setTab] = useState<"conversation" | "timeline">("conversation");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [closing, setClosing] = useState(false);
  // A drawer instance survives task switches. Async work begun for A must never continue mutating B
  // after the list reuses this component for a different task.
  const taskGenerationRef = useRef(0);

  const {
    comments,
    loop,
    unreadReplyCount,
    canComment,
    loading: commentsLoading,
    error: commentsError,
    refetch: refetchComments,
  } = useTaskComments(task.id);
  const {
    entries,
    loading: timelineLoading,
    error: timelineError,
    refetch: refetchTimeline,
  } = useTaskTimeline(task.id);

  /**
   * Am I the person waiting on this task?
   *
   * FROM THE SERVER, not re-derived. `loop.assignerId` is `resolveTaskAssignerId(task)` — the same
   * `lastAssignedBy ?? createdBy` rule that decides reply delivery, acknowledgement authority and the
   * "Needs your attention" scope. Comparing `createdBy` here instead was a second copy of that rule,
   * and it drifted the moment a task changed hands: the NEW assigner opened the task and never sent
   * the acknowledgement that clears it from their bucket, while the ORIGINAL creator was shown an
   * unread badge and kept firing an acknowledgement the server 403s.
   *
   * `loop` is null until the thread lands, which reads as "not the assigner" — the safe direction,
   * and moot anyway because an acknowledgement additionally requires rendered comments.
   */
  const isAssigner = Boolean(loop?.assignerId) && loop?.assignerId === currentUserId;
  const isDone = isTerminalTaskStatus(task.status);
  // Both halves: a status the API will accept AND the server's verdict that THIS viewer may close it.
  // Either one alone leaves a button that looks live and 403s.
  const canComplete = COMPLETABLE_STATUSES.has(task.status) && task.canClose !== false;
  const projectContext = getTaskProjectContext(task);
  const notice = loopNotice(loop);

  // The drawer is ONE instance reused for every task the list opens, so anything task-scoped has to be
  // reset here or it outlives the task it belongs to. Three things do:
  //
  //   * the tab, so a view left on History cannot carry over and suppress the next acknowledgement;
  //   * the DRAFT, or Send posts one task's text — which is where the specific, sometimes sensitive
  //     sentence lives — into another task's thread;
  //   * `ackedRef`, which exists to stop re-posting the same thread head. Keyed to the timestamp alone
  //     it also swallows a DIFFERENT task whose head happens to match, and two replies rounding to the
  //     same second is not rare.
  const ackedRef = useRef<string | null>(null);
  useEffect(() => {
    taskGenerationRef.current += 1;
    setTab("conversation");
    setDraft("");
    // A send for the previous task must not leave the newly opened task's composer disabled.
    setSending(false);
    ackedRef.current = null;
  }, [task.id]);

  const completeButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!completeRequested || !canComplete) return;
    completeButtonRef.current?.focus();
  }, [completeRequested, canComplete]);

  /**
   * The timestamp the user has actually RENDERED — the newest comment on screen, not `Date.now()`.
   *
   * This is the whole ack contract: a reply that arrives between this render and the acknowledgement
   * is NOT covered by it, so it re-raises the task instead of being buried by somebody who never saw
   * it. Sending `now()` here would silently reintroduce that lost update.
   */
  const renderedUpTo = useMemo(() => {
    let newest: string | null = null;
    for (const comment of comments) {
      // Only comments belonging to THIS task. While the drawer has swung to B and B's thread has not
      // landed, `comments` still holds A's — and posting A's timestamp against B is accepted by the
      // server, because A's timestamp is a perfectly valid one. That records the assigner as having
      // read replies that were never on screen, which is the single guarantee this feature sells.
      // The hook's request-id guard discards a late RESPONSE; it cannot un-commit state already set.
      if (comment.taskId !== task.id) continue;
      if (comment.kind !== "reply") continue;
      // The API preserves the database timestamp's microseconds for acknowledgement. Date only keeps
      // milliseconds, so `>=` intentionally takes the later row from the server's created_at/id order
      // when two replies share one displayed millisecond.
      if (!newest || new Date(comment.createdAt).getTime() >= new Date(newest).getTime()) {
        newest = comment.createdAt;
      }
    }
    return newest;
  }, [comments, task.id]);

  // Acknowledge on open, once per rendered thread head. Guarded on the exact timestamp rather than a
  // boolean so a NEW reply arriving while the drawer is open is acknowledged too — and so a refetch
  // that returns the same head does not re-post.
  useEffect(() => {
    // ...AND ONLY WHILE THE CONVERSATION IS ON SCREEN. The acknowledgement is a claim that a specific
    // person SAW something; recording it while the History tab is showing would take the task out of
    // their bucket on the strength of replies they were never shown.
    if (tab !== "conversation") return;
    if (!isAssigner || !renderedUpTo || ackedRef.current === renderedUpTo) return;
    ackedRef.current = renderedUpTo;
    ackTaskReplies(task.id, renderedUpTo)
      .then((result) => {
        if (result.acknowledged) onChanged();
      })
      .catch((error) => {
        // A failed acknowledgement leaves the task in the bucket, which is the safe direction.
        console.error("[tasks] ack failed", error);
        ackedRef.current = null;
      });
  }, [tab, isAssigner, renderedUpTo, task.id, onChanged]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;

    const taskId = task.id;
    const taskGeneration = taskGenerationRef.current;
    setSending(true);
    try {
      await postTaskComment(taskId, body);
      // The request did succeed for its original task, but its continuation is no longer allowed to
      // clear the new draft or refetch the old thread after the drawer has moved to another task.
      if (taskGeneration !== taskGenerationRef.current) return;
      setDraft("");
      await refetchComments();
      if (taskGeneration !== taskGenerationRef.current) return;
      await refetchTimeline();
      if (taskGeneration !== taskGenerationRef.current) return;
      onChanged();
    } catch (error) {
      if (taskGeneration !== taskGenerationRef.current) return;
      console.error("[tasks] reply failed", error);
      toast.error(error instanceof Error ? error.message : "Failed to post your reply");
    } finally {
      if (taskGeneration === taskGenerationRef.current) setSending(false);
    }
  };

  const complete = async () => {
    setClosing(true);
    try {
      await completeTask(task.id);
      onChanged();
      onClose();
    } catch (error) {
      console.error("[tasks] complete failed", error);
      toast.error(error instanceof Error ? error.message : "Failed to complete task");
    } finally {
      setClosing(false);
    }
  };

  return (
    <section
      aria-label={`Conversation for ${task.title}`}
      data-testid="task-conversation-drawer"
      className="overflow-hidden rounded-lg border border-brand-red/30 bg-white"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-brand-red/20 bg-brand-red/5 px-4 py-3">
        <div className="min-w-0">
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-brand-red">Task</p>
          <h2 className="truncate text-lg font-black uppercase leading-tight text-slate-950">
            {task.title}
          </h2>
          <p className="mt-1 flex flex-wrap gap-x-3 text-xs font-semibold text-slate-500">
            <span>{getTaskStatusLabel(task.status)}</span>
            <span>Assigned to {task.assignedToName ?? "Unassigned"}</span>
            {/* The project, from the SAME resolver the list row uses. This is what an assignee
                arriving from the assignment email needs first, and it is the requirement the old
                "Linked task" banner carried — the drawer replaces that banner, so it inherits it. */}
            {projectContext ? <span className="truncate">{projectContext}</span> : null}
            {/* Assigner-only: the assignee's own replies are not "new" to the person who wrote them. */}
            {isAssigner && unreadReplyCount > 0 ? (
              <span className="font-black text-brand-red">
                {unreadReplyCount} new {unreadReplyCount === 1 ? "reply" : "replies"}
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canComplete ? (
            <Button
              ref={completeButtonRef}
              type="button"
              size="sm"
              onClick={complete}
              disabled={closing}
              data-complete-requested={completeRequested ? "true" : "false"}
              className={cn(completeRequested ? "ring-2 ring-brand-red ring-offset-2" : "")}
            >
              <Check className="mr-2 h-4 w-4" />
              Mark complete
            </Button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the task conversation"
            className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="flex gap-1 border-b border-slate-200 px-4 pt-3" role="tablist">
        {(["conversation", "timeline"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cn(
              "rounded-t-md px-3 py-2 text-xs font-black uppercase tracking-wide focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red",
              tab === value
                ? "border-b-2 border-brand-red text-slate-950"
                : "text-slate-500 hover:text-slate-800"
            )}
          >
            {value === "conversation" ? "Conversation" : "History"}
          </button>
        ))}
      </div>

      {tab === "conversation" ? (
        <div className="flex flex-col">
          <div className="max-h-80 overflow-y-auto px-4 py-4">
            {commentsError ? (
              <p className="text-sm font-semibold text-brand-red">{commentsError}</p>
            ) : commentsLoading ? (
              <p className="text-sm font-semibold text-slate-500">Loading the conversation…</p>
            ) : comments.length === 0 ? (
              <p className="flex items-center gap-2 text-sm font-semibold text-slate-500">
                <MessageSquare className="h-4 w-4" aria-hidden />
                No replies yet.
              </p>
            ) : (
              <ul className="space-y-4">
                {comments.map((comment) => (
                  <CommentBubble key={comment.id} comment={comment} />
                ))}
              </ul>
            )}
          </div>

          {notice ? (
            <p className="flex items-start gap-2 border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {notice}
            </p>
          ) : null}

          {canComment === false ? (
            <p className="border-t border-slate-200 px-4 py-3 text-xs font-semibold text-slate-500">
              You cannot reply to this task — only the assignee, the person who assigned it, or an
              admin can.
            </p>
          ) : (
          <form onSubmit={submit} className="flex items-end gap-2 border-t border-slate-200 p-3">
            <label htmlFor="task-reply-composer" className="sr-only">
              Reply to this task
            </label>
            <textarea
              id="task-reply-composer"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={2}
              placeholder="Write a reply…"
              className="min-h-[44px] w-full flex-1 resize-y rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-brand-red focus:ring-2 focus:ring-brand-red/20"
            />
            <Button type="submit" size="sm" disabled={sending || draft.trim().length === 0}>
              <Send className="mr-2 h-4 w-4" />
              Send
            </Button>
          </form>
          )}
        </div>
      ) : (
        <div className="max-h-96 overflow-y-auto px-4 py-4">
          {timelineError ? (
            // "Nothing has happened yet" and "we could not load the history" are different facts.
            <p className="text-sm font-semibold text-brand-red">{timelineError}</p>
          ) : timelineLoading ? (
            <p className="text-sm font-semibold text-slate-500">Loading the history…</p>
          ) : entries.length === 0 ? (
            <p className="text-sm font-semibold text-slate-500">Nothing has happened yet.</p>
          ) : (
            <ul className="space-y-3">
              {entries.map((entry) => (
                <TimelineRow key={entry.id} entry={entry} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
