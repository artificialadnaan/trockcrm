import React, { useCallback, useState } from "react";
import {
  AlertCircle,
  Cloud,
  Download,
  Edit,
  History,
  MapPin,
  RotateCcw,
  Tag,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

export type PhotoAuditEventType =
  | "uploaded"
  | "category_changed"
  | "address_changed"
  | "caption_changed"
  | "downloaded"
  | "deleted"
  | "restored"
  | "procore_synced"
  | "procore_sync_failed";

export interface PhotoAuditEvent {
  id: string;
  eventType: PhotoAuditEventType;
  userId: string;
  userName: string | null;
  userAvatarUrl: string | null;
  createdAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
}

const AUDIT_EVENT_ICONS: Record<PhotoAuditEventType, React.ComponentType<{ className?: string }>> = {
  uploaded: Upload,
  category_changed: Tag,
  address_changed: MapPin,
  caption_changed: Edit,
  downloaded: Download,
  deleted: Trash2,
  restored: RotateCcw,
  procore_synced: Cloud,
  procore_sync_failed: AlertCircle,
};

function auditEventLabel(eventType: PhotoAuditEventType) {
  return eventType.replace(/_/g, " ");
}

function formatRelativeTime(value: string) {
  const diffSeconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const divisions: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
  ];
  const formatter = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
  for (const [unit, seconds] of divisions) {
    if (Math.abs(diffSeconds) >= seconds) return formatter.format(Math.round(diffSeconds / seconds), unit);
  }
  return formatter.format(diffSeconds, "second");
}

function valueLabel(value: unknown) {
  if (value === null || value === undefined || value === "") return "Uncategorized";
  return String(value).replace(/_/g, " ");
}

export function describePhotoAuditEvent(event: PhotoAuditEvent) {
  const actor = event.userName ?? "Someone";
  if (event.eventType === "uploaded") return `${actor} uploaded this photo`;
  if (event.eventType === "category_changed") {
    return `${actor} changed category from ${valueLabel(event.metadata.oldCategory)} to ${valueLabel(event.metadata.newCategory)}`;
  }
  if (event.eventType === "address_changed") return `${actor} edited address`;
  if (event.eventType === "caption_changed") return `${actor} edited caption`;
  if (event.eventType === "downloaded") return `${actor} downloaded this photo`;
  if (event.eventType === "deleted") return `${actor} deleted this photo`;
  if (event.eventType === "restored") return `${actor} restored this photo`;
  if (event.eventType === "procore_synced") return `${actor} synced this photo to Procore`;
  return `${actor} hit a Procore sync failure`;
}

export function PhotoHistoryTimeline({ photoId }: { photoId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<PhotoAuditEvent[]>([]);
  const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(new Set());

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ events: PhotoAuditEvent[] }>(`/files/${photoId}/audit-log`);
      setEvents(data.events);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load history");
    } finally {
      setLoading(false);
    }
  }, [photoId]);

  function handleToggle(event: React.SyntheticEvent<HTMLDetailsElement>) {
    const isOpen = event.currentTarget.open;
    setExpanded(isOpen);
    if (isOpen && !loaded && !loading) void fetchEvents();
  }

  function toggleEvent(eventId: string) {
    setExpandedEventIds((current) => {
      const next = new Set(current);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  }

  return (
    <details data-testid="photo-history" open={expanded} onToggle={handleToggle} className="rounded-md border p-3 text-sm">
      <summary className="flex cursor-pointer items-center gap-2 font-medium"><History className="h-4 w-4" />History</summary>
      <div className="mt-3 space-y-2">
        {loading && (
          <div className="space-y-2">
            <div className="h-8 animate-pulse rounded bg-muted" />
            <div className="h-8 animate-pulse rounded bg-muted" />
          </div>
        )}
        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm">
            <p className="text-destructive">{error}</p>
            <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => fetchEvents()}>Retry</Button>
          </div>
        )}
        {!loading && !error && loaded && events.length === 0 && (
          <p className="text-muted-foreground">No history available for this photo.</p>
        )}
        {!loading && !error && events.map((event) => {
          const Icon = AUDIT_EVENT_ICONS[event.eventType];
          const expandedDetails = expandedEventIds.has(event.id);
          const hasDetails = Object.keys(event.metadata ?? {}).length > 0 || event.ipAddress || event.userAgent;
          return (
            <div key={event.id} className="rounded-md border bg-background p-2">
              <button
                type="button"
                aria-label={`Toggle details for ${auditEventLabel(event.eventType)}`}
                className="flex w-full items-start gap-2 text-left"
                onClick={() => hasDetails && toggleEvent(event.id)}
              >
                <span className="mt-0.5 rounded-full bg-muted p-1.5"><Icon className="h-3.5 w-3.5" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{describePhotoAuditEvent(event)}</span>
                  <span className="block text-xs text-muted-foreground" title={new Date(event.createdAt).toLocaleString()}>
                    {formatRelativeTime(event.createdAt)}
                  </span>
                </span>
              </button>
              {expandedDetails && (
                <pre className="mt-2 max-h-48 overflow-auto rounded bg-muted p-2 text-xs">
                  {JSON.stringify({ metadata: event.metadata ?? {}, ipAddress: event.ipAddress, userAgent: event.userAgent }, null, 2)}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}
