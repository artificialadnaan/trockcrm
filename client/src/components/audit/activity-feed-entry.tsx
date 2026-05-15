import { useState } from "react";
import { ChevronDown, ChevronUp, Layers } from "lucide-react";

export interface ActivityFeedFieldChange {
  key: string;
  label: string;
  fromDisplay: string | null;
  toDisplay: string | null;
  transition: "changed" | "set" | "cleared";
  masked: boolean;
}

export interface ActivityFeedEntryRecord {
  type?: "single";
  id: number | string;
  actorLabel: string;
  actorType: "user" | "system";
  action: string;
  entityType: string;
  entityName: string;
  entitySecondaryId?: string | null;
  occurredAt: string;
  summary?: string | null;
  fieldChanges: ActivityFeedFieldChange[];
  visibilityScope: "internal" | "customer_safe" | "role_restricted";
}

export interface ActivityFeedGroupRecord {
  type: "group";
  id: string;
  processName: string;
  startTime: string;
  endTime: string;
  totalCount: number;
  distinctEntityCount: number;
  entityType: string;
  action: string;
  previewEntities: Array<{ name: string; snapshot: string | null }>;
  childEntries?: ActivityFeedEntryRecord[];
}

export type ActivityFeedItemRecord = ActivityFeedEntryRecord | ActivityFeedGroupRecord;

function formatEntityLabel(entry: ActivityFeedEntryRecord): string {
  return entry.entitySecondaryId
    ? `${entry.entityName} (${entry.entitySecondaryId})`
    : entry.entityName;
}

function buildSummary(entry: ActivityFeedEntryRecord): string {
  if (entry.summary) return entry.summary;
  const firstChange = entry.fieldChanges[0];
  const entityLabel = formatEntityLabel(entry);

  if ((entry.action === "update" || entry.action === "stage_transition") && firstChange) {
    if (firstChange.key === "stageId" && firstChange.fromDisplay && firstChange.toDisplay) {
      return `${entry.actorLabel} moved ${entityLabel} from ${firstChange.fromDisplay} to ${firstChange.toDisplay}`;
    }

    if (firstChange.transition === "set") {
      return `${entry.actorLabel} set ${firstChange.label} to ${firstChange.toDisplay} on ${entityLabel}`;
    }

    if (firstChange.transition === "cleared") {
      return `${entry.actorLabel} cleared ${firstChange.label} on ${entityLabel}`;
    }

    const verb = entry.actorType === "system" ? "updated" : "changed";
    return `${entry.actorLabel} ${verb} ${firstChange.label} from ${firstChange.fromDisplay} to ${firstChange.toDisplay} on ${entityLabel}`;
  }

  return `${entry.actorLabel} updated ${entityLabel}`;
}

function formatActionLabel(action: string): string {
  if (action === "insert" || action === "create" || action === "created") return "created";
  if (action === "soft_delete" || action === "delete" || action === "deleted") return "deleted";
  if (action === "stage_transition") return "moved";
  return "updated";
}

function formatPluralEntity(entityType: string, count: number): string {
  if (count === 1 || entityType.endsWith("s")) return entityType;
  return `${entityType}s`;
}

function formatGroupTime(entry: ActivityFeedGroupRecord): string {
  const start = new Date(entry.startTime);
  const end = new Date(entry.endTime);
  const startLabel = start.toLocaleString("en-US");
  if (Math.abs(end.getTime() - start.getTime()) < 1000) return startLabel;
  return `${startLabel} - ${end.toLocaleTimeString("en-US")}`;
}

function ActivityFeedSingleEntry({ entry, nested = false }: { entry: ActivityFeedEntryRecord; nested?: boolean }) {
  return (
    <article className={`flex flex-col gap-1 rounded-md border bg-white px-4 py-3 ${nested ? "border-slate-200 bg-slate-50" : ""}`}>
      <p className="text-sm text-slate-900">{buildSummary(entry)}</p>
      <p className="text-xs text-slate-500">
        {new Date(entry.occurredAt).toLocaleString("en-US")}
      </p>
    </article>
  );
}

function ActivityFeedGroupEntry({
  entry,
  onLoadGroupChildren,
}: {
  entry: ActivityFeedGroupRecord;
  onLoadGroupChildren?: (groupId: string, page?: number, limit?: number) => Promise<{ rows: ActivityFeedEntryRecord[]; total: number }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<ActivityFeedEntryRecord[]>(entry.childEntries ?? []);
  const [childrenPage, setChildrenPage] = useState(1);
  const [childrenTotal, setChildrenTotal] = useState(entry.totalCount);
  const [hasFetchedChildren, setHasFetchedChildren] = useState(false);
  const [loadingChildren, setLoadingChildren] = useState(false);
  const actionLabel = formatActionLabel(entry.action);
  const hasLoadedAllChildren = children.length >= childrenTotal;
  const pluralEntityType = formatPluralEntity(entry.entityType, entry.totalCount);

  async function loadChildrenPage(page: number) {
    if (!onLoadGroupChildren) return;
    setLoadingChildren(true);
    try {
      const result = await onLoadGroupChildren(entry.id, page, 100);
      setChildren((current) => page === 1 ? result.rows : [...current, ...result.rows]);
      setChildrenPage(page);
      setChildrenTotal(result.total);
      setHasFetchedChildren(true);
    } finally {
      setLoadingChildren(false);
    }
  }

  async function toggleExpanded() {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (!nextExpanded || hasFetchedChildren || !onLoadGroupChildren) return;
    await loadChildrenPage(1);
  }

  return (
    <article className="rounded-md border border-slate-200 bg-slate-50">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left"
        onClick={() => { void toggleExpanded(); }}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${entry.processName} batch`}
      >
        <span className="flex min-w-0 gap-3">
          <span className="mt-0.5 rounded-md bg-white p-1.5 text-slate-500 shadow-sm">
            <Layers className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-slate-950">
              {entry.processName}
              <span className="mx-2 text-slate-400">-</span>
              {entry.totalCount.toLocaleString()} {pluralEntityType} {actionLabel}
            </span>
            <span className="mt-1 block text-xs text-slate-500">
              {formatGroupTime(entry)}
              <span className="mx-2 text-slate-300">-</span>
              {entry.distinctEntityCount.toLocaleString()} distinct {formatPluralEntity(entry.entityType, entry.distinctEntityCount)}
            </span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1 rounded-md border bg-white px-2 py-1 text-xs font-medium text-slate-600">
          {expanded ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
          {expanded ? "Collapse" : "Expand"}
        </span>
      </button>

      {expanded ? (
        <div className="space-y-2 border-t border-slate-200 px-4 py-3">
          {loadingChildren ? (
            <p className="rounded-md border bg-white px-3 py-2 text-sm text-slate-500">
              Loading batch entries...
            </p>
          ) : children.length > 0 ? (
            children.map((child) => (
              <ActivityFeedSingleEntry key={child.id} entry={child} nested />
            ))
          ) : (
            <p className="rounded-md border bg-white px-3 py-2 text-sm text-slate-500">
              No preview entries are available for this batch.
            </p>
          )}
          {!onLoadGroupChildren || loadingChildren || hasLoadedAllChildren ? null : (
            <div className="flex items-center justify-between rounded-md border bg-white px-3 py-2 text-xs text-slate-500">
              <span>Showing {children.length.toLocaleString()} of {childrenTotal.toLocaleString()} entries</span>
              <button
                type="button"
                className="rounded-md border px-2 py-1 font-medium text-slate-700"
                onClick={() => { void loadChildrenPage(childrenPage + 1); }}
              >
                Load more
              </button>
            </div>
          )}
        </div>
      ) : null}
    </article>
  );
}

export function ActivityFeedEntry({
  entry,
  onLoadGroupChildren,
}: {
  entry: ActivityFeedItemRecord;
  onLoadGroupChildren?: (groupId: string, page?: number, limit?: number) => Promise<{ rows: ActivityFeedEntryRecord[]; total: number }>;
}) {
  if (entry.type === "group") {
    return <ActivityFeedGroupEntry entry={entry} onLoadGroupChildren={onLoadGroupChildren} />;
  }

  return <ActivityFeedSingleEntry entry={entry} />;
}
