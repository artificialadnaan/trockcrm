export interface ActivityFeedFieldChange {
  key: string;
  label: string;
  fromDisplay: string | null;
  toDisplay: string | null;
  transition: "changed" | "set" | "cleared";
  masked: boolean;
}

export interface ActivityFeedEntryRecord {
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

export function ActivityFeedEntry({ entry }: { entry: ActivityFeedEntryRecord }) {
  return (
    <article className="flex flex-col gap-1 rounded-md border bg-white px-4 py-3">
      <p className="text-sm text-slate-900">{buildSummary(entry)}</p>
      <p className="text-xs text-slate-500">
        {new Date(entry.occurredAt).toLocaleString("en-US")}
      </p>
    </article>
  );
}
