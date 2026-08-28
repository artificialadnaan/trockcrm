import { ExternalLink } from "lucide-react";
import { appendOfficeIdSearch } from "@/lib/office-selection";
import { getTaskProjectContext } from "@/lib/task-project-context";
import { cn } from "@/lib/utils";
import type { Task } from "@/hooks/use-tasks";

type ProjectTask = Parameters<typeof getTaskProjectContext>[0];

/**
 * The office the CURRENT PAGE is in, from `window.location` — deliberately not from the router.
 *
 * lib/api.ts reads office context from `window.location.search` and turns it into the `x-office-id`
 * header on every request. Reading the same place means the office in this link is by construction
 * the office the task was FETCHED from; taking it from the router instead would introduce a second
 * source that can only ever agree or be wrong.
 *
 * Callers may still pass `officeId` explicitly — the task list does, because it already derives one
 * for the row's other link and one value per row beats two.
 */
function readOfficeIdFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("officeId")?.trim() || null;
}

/**
 * The task's project, as a link that opens the deal in a NEW TAB.
 *
 * ONE component for all three surfaces that name a task's project — the list row, the conversation
 * drawer and the edit dialog — for the same reason getTaskProjectContext itself is shared: a task
 * showing one project label in the list and another in the drawer is the reconciliation failure this
 * repo keeps re-learning. The label comes from that one resolver; only the wrapper is new.
 *
 * ⚠️ THE LINK MUST CARRY ?officeId WHEN THE CURRENT PAGE HAS ONE. Office context in this app is
 * URL-driven: lib/api.ts reads `?officeId` off window.location and injects it as `x-office-id`. Drop
 * it and a cross-office deal is fetched against the READER's own schema, which 404s or bounces them
 * home — the standing property-edit trap, and the same reason the task deep link in every email
 * carries it.
 *
 * `target="_blank"` is the ask, and it is also the right default here: the reader is triaging a list
 * and wants the project alongside it, not instead of it. `rel="noopener noreferrer"` because a bare
 * `_blank` hands the opened page a live `window.opener` handle back into the CRM session.
 *
 * RENDERS NOTHING when the task has no deal. getTaskProjectContext already returns null in that case,
 * so there is no "plain text" branch to write — an earlier draft had one and it was unreachable.
 */
export function TaskProjectLink({
  task,
  officeId,
  className,
  showIcon = true,
}: {
  task: Pick<Task, "dealId" | "dealName" | "dealIsChangeOrder" | "dealNumber" | "projectNumber">;
  /** Omit to read it off the current URL — see readOfficeIdFromLocation. */
  officeId?: string | null;
  className?: string;
  showIcon?: boolean;
}) {
  // Null exactly when `dealId` is null, which is why there is no separate no-deal branch below.
  const label = getTaskProjectContext(task as ProjectTask);
  if (!label || !task.dealId) return null;

  const href = appendOfficeIdSearch(
    `/deals/${encodeURIComponent(task.dealId)}`,
    officeId === undefined ? readOfficeIdFromLocation() : officeId
  );

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="task-project-link"
      // NO stopPropagation here, deliberately. The row around this is click-to-edit and stops at any
      // anchor or button; a second guard on this side would make that one untestable — with the click
      // swallowed here, deleting the row's guard changes nothing observable and every test still
      // passes. One guard, in the place that owns the behaviour, with a test that can see it fail.
      title={`Open ${label} in a new tab`}
      className={cn(
        "inline-flex min-w-0 items-center gap-1 rounded text-brand-red underline decoration-brand-red/30 underline-offset-2 hover:decoration-brand-red focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red",
        className
      )}
    >
      <span className="truncate">{label}</span>
      {showIcon ? <ExternalLink className="h-3 w-3 shrink-0" aria-hidden /> : null}
    </a>
  );
}
