import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Download,
  Edit,
  Filter,
  MapPin,
  RotateCcw,
  Tag,
  Trash2,
  Upload,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  PhotoViewerModal,
  type DealPhotoRecord,
  initials,
} from "@/components/photos/deal-photo-components";
import type { PhotoAuditEvent, PhotoAuditEventType } from "@/components/photos/photo-history-timeline";
import { api } from "@/lib/api";

const PHOTO_AUDIT_EVENTS: Array<{ value: PhotoAuditEventType; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { value: "uploaded", label: "Uploaded", icon: Upload },
  { value: "category_changed", label: "Category changed", icon: Tag },
  { value: "address_changed", label: "Address changed", icon: MapPin },
  { value: "caption_changed", label: "Caption changed", icon: Edit },
  { value: "downloaded", label: "Downloaded", icon: Download },
  { value: "deleted", label: "Deleted", icon: Trash2 },
  { value: "restored", label: "Restored", icon: RotateCcw },
  { value: "procore_synced", label: "Procore synced", icon: Cloud },
  { value: "procore_sync_failed", label: "Procore sync failed", icon: AlertCircle },
  { value: "procore_sync_retry_requested", label: "Procore retry requested", icon: RotateCcw },
];

const PROCORE_SYNC_STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "synced", label: "Synced" },
  { value: "failed", label: "Failed" },
  { value: "skipped", label: "Skipped" },
];

interface AdminPhotoAuditEvent extends PhotoAuditEvent {
  photo: {
    id: string;
    displayName: string;
    fileExtension: string | null;
    r2Key: string | null;
    externalUrl: string | null;
    externalThumbnailUrl: string | null;
  } | null;
  deal: {
    id: string;
    name: string;
    dealNumber: string;
  } | null;
}

interface AdminUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

function parseList(params: URLSearchParams, key: string) {
  return params.get(key)?.split(",").filter(Boolean) ?? [];
}

function setListParam(params: URLSearchParams, key: string, values: string[]) {
  if (values.length > 0) params.set(key, values.join(","));
  else params.delete(key);
}

function eventLabel(eventType: PhotoAuditEventType) {
  return PHOTO_AUDIT_EVENTS.find((event) => event.value === eventType)?.label ?? eventType;
}

function eventIcon(eventType: PhotoAuditEventType) {
  return PHOTO_AUDIT_EVENTS.find((event) => event.value === eventType)?.icon ?? Filter;
}

function buildAdminAuditQuery(searchParams: URLSearchParams) {
  const params = new URLSearchParams();
  for (const key of ["userId", "eventType", "procoreSyncStatus", "from", "to", "dealId", "photoId", "page", "perPage"]) {
    const value = searchParams.get(key);
    if (value) params.set(key, value);
  }
  if (!params.get("page")) params.set("page", "1");
  if (!params.get("perPage")) params.set("perPage", "50");
  return params;
}

function MetadataPreview({ metadata }: { metadata: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);
  const keys = Object.keys(metadata ?? {});
  if (keys.length === 0) return <span className="text-muted-foreground">None</span>;
  return (
    <div>
      <button type="button" className="max-w-[16rem] truncate text-left text-xs text-muted-foreground hover:text-foreground" onClick={() => setExpanded(!expanded)}>
        {JSON.stringify(metadata)}
      </button>
      {expanded && <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(metadata, null, 2)}</pre>}
    </div>
  );
}

function MultiSelectFilter({
  label,
  ariaLabel,
  selected,
  options,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  selected: string[];
  options: Array<{ value: string; label: string; avatarUrl?: string | null; icon?: React.ComponentType<{ className?: string }> }>;
  onChange: (values: string[]) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger render={<Button type="button" variant="outline" size="sm" aria-label={ariaLabel}><Filter className="mr-1.5 h-4 w-4" />{label}{selected.length ? ` (${selected.length})` : ""}</Button>} />
      <PopoverContent align="start" className="max-h-72 overflow-y-auto space-y-1">
        {options.map((option) => {
          const checked = selected.includes(option.value);
          const Icon = option.icon;
          return (
            <button
              key={option.value}
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
              onClick={() => onChange(checked ? selected.filter((value) => value !== option.value) : [...selected, option.value])}
            >
              <Checkbox checked={checked} onCheckedChange={() => undefined} />
              {option.avatarUrl !== undefined && <Avatar className="h-5 w-5"><AvatarImage src={option.avatarUrl ?? undefined} /><AvatarFallback>{initials(option.label)}</AvatarFallback></Avatar>}
              {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
              <span>{option.label}</span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

export function PhotoAuditPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [events, setEvents] = useState<AdminPhotoAuditEvent[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPageState] = useState(Number(searchParams.get("page") ?? "1"));
  const [perPage, setPerPage] = useState(Number(searchParams.get("perPage") ?? "50"));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPhoto, setSelectedPhoto] = useState<DealPhotoRecord | null>(null);

  const selectedUsers = useMemo(() => parseList(searchParams, "userId"), [searchParams]);
  const selectedEventTypes = useMemo(() => parseList(searchParams, "eventType"), [searchParams]);
  const selectedProcoreSyncStatuses = useMemo(() => parseList(searchParams, "procoreSyncStatus"), [searchParams]);
  const totalPages = Math.max(1, Math.ceil(total / perPage));

  const updateParams = useCallback((updater: (params: URLSearchParams) => void) => {
    const next = new URLSearchParams(searchParams);
    updater(next);
    if (!next.get("page")) next.set("page", "1");
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    let cancelled = false;
    void api<{ users: AdminUser[] }>("/admin/users")
      .then((data) => {
        if (!cancelled) setUsers(data.users);
      })
      .catch(() => {
        if (!cancelled) setUsers([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = buildAdminAuditQuery(searchParams);
      const data = await api<{ events: AdminPhotoAuditEvent[]; total: number; page: number; perPage: number }>(`/admin/photo-audit?${params}`);
      setEvents(data.events);
      setTotal(data.total);
      setPageState(data.page);
      setPerPage(data.perPage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load photo audit events");
    } finally {
      setLoading(false);
    }
  }, [searchParams]);

  useEffect(() => {
    void fetchEvents();
  }, [fetchEvents]);

  async function openPhoto(photoId: string) {
    const data = await api<{ file: DealPhotoRecord }>(`/files/${photoId}`);
    setSelectedPhoto(data.file);
  }

  async function patchSelectedPhoto(photoId: string, body: Record<string, unknown>) {
    const data = await api<{ file: DealPhotoRecord }>(`/files/${photoId}`, { method: "PATCH", json: body });
    setSelectedPhoto(data.file);
  }

  async function saveSelectedAddress(photoId: string, body: { address: string; latitude?: number; longitude?: number }) {
    const data = await api<{ file: DealPhotoRecord }>(`/files/${photoId}/address`, { method: "PATCH", json: body });
    setSelectedPhoto(data.file);
  }

  async function deleteSelectedPhoto(photoId: string) {
    await api(`/files/${photoId}`, { method: "DELETE" });
    setSelectedPhoto(null);
    await fetchEvents();
  }

  async function downloadSelectedPhoto(photoId: string) {
    const data = await api<{ url: string }>(`/files/${photoId}/download`);
    window.open(data.url, "_blank");
  }

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Photo Audit</h1>
        <p className="mt-1 text-sm text-gray-500">{total.toLocaleString()} events</p>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-gray-50 p-3">
        <MultiSelectFilter
          label="User"
          ariaLabel="User filter"
          selected={selectedUsers}
          options={users.map((user) => ({ value: user.id, label: user.displayName, avatarUrl: user.avatarUrl }))}
          onChange={(values) => updateParams((params) => {
            setListParam(params, "userId", values);
            params.set("page", "1");
          })}
        />
        <MultiSelectFilter
          label="Event"
          ariaLabel="Event type filter"
          selected={selectedEventTypes}
          options={PHOTO_AUDIT_EVENTS.map((event) => ({ value: event.value, label: event.label, icon: event.icon }))}
          onChange={(values) => updateParams((params) => {
            setListParam(params, "eventType", values);
            params.set("page", "1");
          })}
        />
        <MultiSelectFilter
          label="Procore"
          ariaLabel="Procore sync status filter"
          selected={selectedProcoreSyncStatuses}
          options={PROCORE_SYNC_STATUS_OPTIONS}
          onChange={(values) => updateParams((params) => {
            setListParam(params, "procoreSyncStatus", values);
            params.set("page", "1");
          })}
        />
        <DateField value={searchParams.get("from") ?? ""} onChange={(from) => updateParams((params) => { from ? params.set("from", from) : params.delete("from"); params.set("page", "1"); })} className="h-8 w-[9rem]" />
        <DateField value={searchParams.get("to") ?? ""} onChange={(to) => updateParams((params) => { to ? params.set("to", to) : params.delete("to"); params.set("page", "1"); })} className="h-8 w-[9rem]" />
        <Input
          className="h-8 w-44 text-sm"
          placeholder="Deal ID"
          value={searchParams.get("dealId") ?? ""}
          onChange={(event) => updateParams((params) => { event.target.value ? params.set("dealId", event.target.value) : params.delete("dealId"); params.set("page", "1"); })}
        />
        <Input
          className="h-8 w-52 text-sm"
          placeholder="Photo ID"
          value={searchParams.get("photoId") ?? ""}
          onChange={(event) => updateParams((params) => { event.target.value ? params.set("photoId", event.target.value) : params.delete("photoId"); params.set("page", "1"); })}
        />
        <Button type="button" variant="ghost" size="sm" onClick={() => setSearchParams(new URLSearchParams())}>Clear</Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <p className="text-destructive">{error}</p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => fetchEvents()}>Retry</Button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Timestamp</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Photo</TableHead>
              <TableHead>Deal</TableHead>
              <TableHead>IP address</TableHead>
              <TableHead>Metadata</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">Loading photo audit events...</TableCell></TableRow>
            ) : events.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No audit events match the current filters.</TableCell></TableRow>
            ) : (
              events.map((event) => {
                const Icon = eventIcon(event.eventType);
                return (
                  <TableRow key={event.id} className="align-top">
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{new Date(event.createdAt).toLocaleString()}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Avatar className="h-7 w-7"><AvatarImage src={event.userAvatarUrl ?? undefined} /><AvatarFallback>{initials(event.userName ?? "?")}</AvatarFallback></Avatar>
                          <span className="text-sm">{event.userName ?? event.userId.slice(0, 8)}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="gap-1"><Icon className="h-3.5 w-3.5" />{eventLabel(event.eventType)}</Badge>
                      </TableCell>
                      <TableCell>
                        {event.photo ? (
                          <button type="button" aria-label={`Open photo ${event.photo.displayName}`} className="flex items-center gap-2 text-left hover:underline" onClick={() => openPhoto(event.photo!.id)}>
                            <span className="h-10 w-10 overflow-hidden rounded border bg-muted">
                              {event.photo.externalThumbnailUrl ? <img src={event.photo.externalThumbnailUrl} alt="" className="h-full w-full object-cover" /> : null}
                            </span>
                            <span>
                              <span className="block text-sm font-medium">{event.photo.displayName}</span>
                              <span className="block text-xs text-muted-foreground">{event.photo.id.slice(0, 8)}...</span>
                            </span>
                          </button>
                        ) : <span className="text-muted-foreground">Unknown photo</span>}
                      </TableCell>
                      <TableCell>
                        {event.deal ? <Link className="text-sm text-brand-red hover:underline" to={`/deals/${event.deal.id}`}>{event.deal.name}</Link> : <span className="text-muted-foreground">No deal</span>}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{event.ipAddress ?? "N/A"}</TableCell>
                      <TableCell>
                        <MetadataPreview metadata={event.metadata ?? {}} />
                      </TableCell>
                    </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>Page {page} of {totalPages}</span>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => updateParams((params) => params.set("page", String(page - 1)))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => updateParams((params) => params.set("page", String(page + 1)))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <PhotoViewerModal
        photos={selectedPhoto ? [selectedPhoto] : []}
        selectedId={selectedPhoto?.id ?? null}
        onSelectedIdChange={(id) => !id && setSelectedPhoto(null)}
        getPhotoImageUrl={(photo) => photo.externalThumbnailUrl ?? photo.externalUrl ?? ""}
        patchPhoto={patchSelectedPhoto}
        savePhotoAddress={saveSelectedAddress}
        deletePhoto={deleteSelectedPhoto}
        downloadPhoto={downloadSelectedPhoto}
      />
    </div>
  );
}
