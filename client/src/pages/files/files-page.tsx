import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowDownToLine,
  ArrowUpDown,
  Briefcase,
  Camera,
  ChevronDown,
  FileArchive,
  FileIcon,
  FileImage,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  LayoutGrid,
  Layers,
  List,
  Plus,
  Search,
  Trash2,
  Upload,
  Users,
  Video,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FileUploadZone } from "@/components/files/file-upload-zone";
import {
  SortHeaderButton,
  ariaSort,
  nextSortState,
  sortHeaderProps,
  type ColumnType,
  type SortState,
} from "@/components/reports/sortable";
import { useFiles, useFileStats, downloadFile, deleteFileRecord } from "@/hooks/use-files";
import type { FileRecord } from "@/hooks/use-files";
import { useDeals } from "@/hooks/use-deals";
import type { Deal } from "@/hooks/use-deals";
import { useContacts } from "@/hooks/use-contacts";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { displayNameOrFallback } from "@/lib/display-identifiers";
import { formatDealDisplayNumber, sanitizeHubspotDealIdentifiers } from "@/lib/deal-utils";
import { getFileMediaKind, type FileMediaKind } from "@/lib/file-media";
import {
  FILE_CATEGORIES,
  type FileCategory,
  getCategoryColor,
  getCategoryLabel,
  formatFileSize,
} from "@/lib/file-utils";
import {
  getImmediatePhotoPreviewUrl,
  shouldFetchSignedPhotoUrl,
} from "@/lib/photo-url-resolution";

type FileTab = "all" | "photos" | "documents";
type FileView = "grid" | "list";
type LinkedFilter = "any" | "deal" | "lead" | "contact" | "procore" | "change_order" | "unassigned";

const EYEBROW = "text-[11px] font-black uppercase tracking-[0.18em] text-slate-500";

const TYPE_FILTERS: Array<{ value: FileCategory | "all"; label: string }> = [
  { value: "all", label: "All Types" },
  // getCategoryLabel maps the catch-all "other" → "Uncategorized" so untyped docs stay visible
  // (filterable) and read consistently with their badges, rather than vanishing behind type filters.
  ...FILE_CATEGORIES.map((category) => ({ value: category, label: getCategoryLabel(category) })),
];

const PREVIEW_CACHE_MAX = 200;
const previewUrlCache = new Map<string, string>();
const previewUrlRequests = new Map<string, Promise<string>>();

function setPreviewUrlCache(key: string, value: string) {
  if (previewUrlCache.size >= PREVIEW_CACHE_MAX) {
    const firstKey = previewUrlCache.keys().next().value;
    if (firstKey) previewUrlCache.delete(firstKey);
  }
  previewUrlCache.set(key, value);
}

async function fetchCachedPreviewUrl(fileId: string): Promise<string> {
  const cached = previewUrlCache.get(fileId);
  if (cached) return cached;

  const pending = previewUrlRequests.get(fileId);
  if (pending) return pending;

  const request = api<{ url: string }>(`/files/${fileId}/download?preview=1`)
    .then((data) => {
      setPreviewUrlCache(fileId, data.url);
      return data.url;
    })
    .finally(() => {
      previewUrlRequests.delete(fileId);
    });

  previewUrlRequests.set(fileId, request);
  return request;
}

function useInViewport<T extends HTMLElement>(): [(node: T | null) => void, boolean] {
  const [node, setNode] = useState<T | null>(null);
  const [inViewport, setInViewport] = useState(false);

  useEffect(() => {
    if (!node || inViewport) return;
    if (typeof IntersectionObserver === "undefined") {
      setInViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [inViewport, node]);

  return [setNode, inViewport];
}

function useFilePreviewUrl(file: FileRecord, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(() =>
    getImmediatePhotoPreviewUrl(file, previewUrlCache.get(file.id) ?? null)
  );

  useEffect(() => {
    const cachedSignedUrl = previewUrlCache.get(file.id) ?? null;
    const immediateUrl = getImmediatePhotoPreviewUrl(file, cachedSignedUrl);
    if (immediateUrl) {
      setUrl(immediateUrl);
      return;
    }
    if (!enabled) return;
    if (!shouldFetchSignedPhotoUrl(file, cachedSignedUrl)) return;

    let cancelled = false;
    fetchCachedPreviewUrl(file.id)
      .then((signedUrl) => {
        if (!cancelled) setUrl(signedUrl);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, file.externalThumbnailUrl, file.externalUrl, file.id, file.r2Key]);

  return url;
}

function getFileIcon(file: FileRecord) {
  const kind = getFileMediaKind(file);
  if (kind === "image") return FileImage;
  if (kind === "pdf") return FileText;
  if (kind === "video") return Video;
  if (kind === "document") {
    const mimeType = file.mimeType.toLowerCase();
    const ext = file.fileExtension.toLowerCase();
    if (mimeType.includes("sheet") || mimeType.includes("excel") || ext === ".csv" || ext === ".xls" || ext === ".xlsx") {
      return FileSpreadsheet;
    }
    if (mimeType.includes("zip") || ext === ".zip") return FileArchive;
    return FileText;
  }
  return FileIcon;
}

function getFileKindLabel(kind: FileMediaKind) {
  if (kind === "image") return "Image";
  if (kind === "pdf") return "PDF";
  if (kind === "video") return "Video";
  if (kind === "document") return "Document";
  return "File";
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function initials(name: string | null | undefined) {
  const parts = (name ?? "Unknown")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "U";
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function uploaderLabel(file: FileRecord) {
  return displayNameOrFallback(file.uploadedBy, "Unknown user");
}

function fileTitle(file: FileRecord) {
  const extension = file.fileExtension && !file.displayName.endsWith(file.fileExtension) ? file.fileExtension : "";
  return sanitizeHubspotDealIdentifiers(`${file.displayName}${extension}`, "Imported deal");
}

function linkedType(file: FileRecord): LinkedFilter {
  if (file.dealId) return "deal";
  if (file.leadId) return "lead";
  if (file.contactId) return "contact";
  if (file.procoreProjectId) return "procore";
  if (file.changeOrderId) return "change_order";
  return "unassigned";
}

function matchesLinkedFilter(file: FileRecord, filter: LinkedFilter) {
  if (filter === "any") return true;
  if (filter === "deal") return Boolean(file.dealId);
  if (filter === "lead") return Boolean(file.leadId);
  if (filter === "contact") return Boolean(file.contactId);
  if (filter === "procore") return Boolean(file.procoreProjectId);
  if (filter === "change_order") return Boolean(file.changeOrderId);
  return !file.dealId && !file.leadId && !file.contactId && !file.procoreProjectId && !file.changeOrderId;
}

function linkedLabel(file: FileRecord, dealMap: Map<string, Deal>) {
  if (file.dealId) {
    const deal = dealMap.get(file.dealId);
    const displayNumber = deal ? formatDealDisplayNumber(deal).label : "Deal";
    return {
      type: "deal" as const,
      label: deal ? `${displayNumber} · ${deal.name}` : "Linked deal",
      href: `/deals/${file.dealId}`,
    };
  }
  if (file.leadId) return { type: "lead" as const, label: "Linked lead", href: `/leads/${file.leadId}` };
  if (file.contactId) return { type: "contact" as const, label: "Linked contact", href: `/contacts/${file.contactId}` };
  if (file.procoreProjectId) {
    return { type: "procore" as const, label: `Procore project ${file.procoreProjectId}`, href: null };
  }
  if (file.changeOrderId) {
    return { type: "change_order" as const, label: "Linked change order", href: null };
  }
  return null;
}

function isDocument(file: FileRecord) {
  return file.category !== "photo" && !file.mimeType.startsWith("image/");
}

type FilesSortKey = "created_at" | "display_name" | "file_size_bytes";

// The clickable-header sort keys map 1:1 to the files API sortBy values; the column type drives the
// default direction (text → asc, number/date → desc) via the shared sort rule. Type / Linked To have no
// server sortField today and stay non-sortable.
const FILES_SORT_TYPES: Record<FilesSortKey, ColumnType> = {
  display_name: "text",
  file_size_bytes: "number",
  created_at: "date",
};

function nextSortBy(value: FilesSortKey): FilesSortKey {
  if (value === "created_at") return "display_name";
  if (value === "display_name") return "file_size_bytes";
  return "created_at";
}

function MetricCard({
  eyebrow,
  value,
  badge,
  caption,
  accent = "default",
}: {
  eyebrow: string;
  value: string;
  badge: string;
  caption: string;
  accent?: "default" | "red";
}) {
  if (accent === "red") {
    return (
      <div className="rounded-md border border-brand-red bg-brand-red p-5 text-white">
        <p className="text-[11px] font-black uppercase tracking-[0.18em] text-white/75">{eyebrow}</p>
        <p className="mt-3 text-4xl font-black tracking-tight md:text-5xl">{value}</p>
        <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-white/80">
          <span className="rounded-full bg-white/15 px-2 py-1 text-white">{badge}</span> {caption}
        </p>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-md border border-slate-200 bg-white p-5">
      <p className={EYEBROW}>{eyebrow}</p>
      <p className="mt-3 text-4xl font-black tracking-tight text-slate-950 md:text-5xl">{value}</p>
      <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <span className="rounded-full bg-slate-100 px-2 py-1 font-black text-slate-700">{badge}</span> {caption}
      </p>
      <div className="absolute inset-x-0 bottom-0 h-1 bg-brand-red" />
    </div>
  );
}

function FilterChip({
  active,
  children,
  onClick,
  dataAttribute,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
  dataAttribute?: Record<string, string>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide transition-colors ${
        active ? "bg-brand-red text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
      }`}
      {...dataAttribute}
    >
      {children}
    </button>
  );
}

function FileLinkChip({
  file,
  dealMap,
}: {
  file: FileRecord;
  dealMap: Map<string, Deal>;
}) {
  const navigate = useNavigate();
  const link = linkedLabel(file, dealMap);
  if (!link) return <span className="text-xs font-semibold text-slate-400">Unassigned</span>;

  const Icon = link.type === "deal" ? Briefcase : link.type === "contact" ? Users : Layers;
  if (!link.href) {
    return (
      <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-brand-red/10 px-2 py-0.5 text-[11px] font-bold text-brand-red ring-1 ring-brand-red/20">
        <Icon className="h-2.5 w-2.5 shrink-0" />
        <span className="truncate">{link.label}</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => navigate(link.href)}
      className="inline-flex max-w-full items-center gap-1 rounded-full bg-brand-red/10 px-2 py-0.5 text-[11px] font-bold text-brand-red ring-1 ring-brand-red/20 transition-opacity hover:opacity-80"
    >
      <Icon className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate">{link.label}</span>
    </button>
  );
}

function FileGridCard({
  file,
  dealMap,
  onDownload,
  onDelete,
}: {
  file: FileRecord;
  dealMap: Map<string, Deal>;
  onDownload: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [previewRef, previewInViewport] = useInViewport<HTMLDivElement>();
  const [previewFailed, setPreviewFailed] = useState(false);
  const mediaKind = getFileMediaKind(file);
  const Icon = getFileIcon(file);
  const isPhoto = mediaKind === "image";
  const previewUrl = useFilePreviewUrl(file, isPhoto && previewInViewport && !previewFailed);

  if (isPhoto) {
    return (
      <article className="group overflow-hidden rounded-md border border-slate-200 bg-white" data-file-card>
        <div ref={previewRef} className="relative aspect-[4/3] bg-slate-100">
          {previewUrl && !previewFailed ? (
            <img
              src={previewUrl}
              alt={fileTitle(file)}
              className="h-full w-full object-cover"
              loading="lazy"
              data-file-preview-image
              onError={() => setPreviewFailed(true)}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-slate-100">
              <FileImage className="h-8 w-8 text-slate-400" />
            </div>
          )}
          <div className="absolute bottom-2 right-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              type="button"
              onClick={() => onDownload(file.id)}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-slate-700 shadow-sm hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
              aria-label={`Download ${fileTitle(file)}`}
            >
              <ArrowDownToLine className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onDelete(file.id)}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-red-600 shadow-sm hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
              aria-label={`Delete ${fileTitle(file)}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="space-y-1 border-t border-slate-100 px-3 py-2">
          <p className="truncate text-xs font-bold text-slate-950">{fileTitle(file)}</p>
          <p className="text-[10px] text-slate-500">
            <span className="font-bold text-slate-700">{initials(uploaderLabel(file))}</span> · {uploaderLabel(file)} ·{" "}
            {formatDate(file.createdAt)} · {formatFileSize(file.fileSizeBytes)}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ring-slate-200 ${getCategoryColor(file.category)}`}>
              {getCategoryLabel(file.category)}
            </span>
            <FileLinkChip file={file} dealMap={dealMap} />
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className="group flex min-h-[170px] flex-col gap-2 rounded-md border border-slate-200 bg-white p-4 transition-colors hover:border-slate-300" data-file-card>
      <div className="flex items-start justify-between gap-2">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-slate-100">
          <Icon className="h-4 w-4 text-slate-600" />
        </span>
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            type="button"
            onClick={() => onDownload(file.id)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
            aria-label={`Download ${fileTitle(file)}`}
          >
            <ArrowDownToLine className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onDelete(file.id)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
            aria-label={`Delete ${fileTitle(file)}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">{getFileKindLabel(mediaKind)}</p>
      <p className="line-clamp-2 text-sm font-bold text-slate-950">{fileTitle(file)}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ring-slate-200 ${getCategoryColor(file.category)}`}>
          {getCategoryLabel(file.category)}
        </span>
        <FileLinkChip file={file} dealMap={dealMap} />
      </div>
      {file.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {file.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      <div className="mt-auto flex items-center justify-between border-t border-slate-100 pt-2 text-[10px] text-slate-500">
        <p>
          <span className="font-bold text-slate-700">{uploaderLabel(file)}</span> · {formatDate(file.createdAt)}
        </p>
        <p className="font-semibold tabular-nums">{formatFileSize(file.fileSizeBytes)}</p>
      </div>
    </article>
  );
}

function SortableFileTh({
  label,
  sortKey,
  sortState,
  onSort,
  numeric,
  className,
}: {
  label: string;
  sortKey: FilesSortKey;
  sortState: SortState;
  onSort: (key: FilesSortKey) => void;
  numeric?: boolean;
  className: string;
}) {
  const hp = sortHeaderProps(sortState, sortKey);
  return (
    <th className={className} aria-sort={ariaSort(hp.active, hp.dir)}>
      <SortHeaderButton label={label} numeric={numeric} active={hp.active} dir={hp.dir} onClick={() => onSort(sortKey)} />
    </th>
  );
}

function FilesTable({
  rows,
  dealMap,
  onDownload,
  onDelete,
  sortBy,
  sortDir,
  onSort,
}: {
  rows: FileRecord[];
  dealMap: Map<string, Deal>;
  onDownload: (id: string) => void;
  onDelete: (id: string) => void;
  sortBy: FilesSortKey;
  sortDir: "asc" | "desc";
  onSort: (key: FilesSortKey) => void;
}) {
  // Files always has a server sort (default created_at desc), so sortState is never null here.
  const sortState: SortState = { key: sortBy, dir: sortDir };
  return (
    <div className="overflow-x-auto" data-view="list">
      <table className="w-full min-w-[860px]">
        <thead>
          <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
            <SortableFileTh label="File" sortKey="display_name" sortState={sortState} onSort={onSort} className="px-5 py-3 text-left" />
            <th className="px-5 py-3 text-left">Type</th>
            <th className="px-5 py-3 text-left">Linked To</th>
            <SortableFileTh label="Size" sortKey="file_size_bytes" sortState={sortState} onSort={onSort} numeric className="px-5 py-3 text-right" />
            <SortableFileTh label="Uploaded" sortKey="created_at" sortState={sortState} onSort={onSort} className="px-5 py-3 text-left" />
            <th className="w-20 px-5 py-3" aria-hidden />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((file) => {
            const Icon = getFileIcon(file);
            return (
              <tr key={file.id} className="transition-colors hover:bg-slate-50">
                <td className="px-5 py-3">
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-slate-100">
                      <Icon className="h-4 w-4 text-slate-600" />
                    </span>
                    <p className="max-w-xs truncate text-sm font-bold text-slate-950">{fileTitle(file)}</p>
                  </div>
                </td>
                <td className="px-5 py-3">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ring-slate-200 ${getCategoryColor(file.category)}`}>
                    {getCategoryLabel(file.category)}
                  </span>
                </td>
                <td className="px-5 py-3">
                  <FileLinkChip file={file} dealMap={dealMap} />
                </td>
                <td className="px-5 py-3 text-right text-xs font-semibold tabular-nums text-slate-700">
                  {formatFileSize(file.fileSizeBytes)}
                </td>
                <td className="px-5 py-3 text-xs text-slate-500">
                  <span className="font-bold text-slate-700">{uploaderLabel(file)}</span> · {formatDate(file.createdAt)}
                </td>
                <td className="px-5 py-3 text-right">
                  <div className="flex justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => onDownload(file.id)}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-900"
                      aria-label={`Download ${fileTitle(file)}`}
                    >
                      <ArrowDownToLine className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(file.id)}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600"
                      aria-label={`Delete ${fileTitle(file)}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function FilesPage() {
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<FileTab>("all");
  const [view, setView] = useState<FileView>("grid");
  const [typeFilter, setTypeFilter] = useState<FileCategory | "all">("all");
  const [linkedFilter, setLinkedFilter] = useState<LinkedFilter>("any");
  const [sortBy, setSortBy] = useState<FilesSortKey>("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // Clickable list headers reuse the shared sort rule over the same sortBy/sortDir state the cycle button
  // uses, so both drive the SAME server-side ORDER BY (over the full set, not the in-memory window).
  const handleSort = (key: FilesSortKey) => {
    const next = nextSortState({ key: sortBy, dir: sortDir }, key, FILES_SORT_TYPES[key]);
    setSortBy(next.key as FilesSortKey);
    setSortDir(next.dir);
  };
  const [showUpload, setShowUpload] = useState(false);
  const [uploadCategory, setUploadCategory] = useState<FileCategory | "auto">("auto");
  const [uploadDealId, setUploadDealId] = useState("");

  const { deals } = useDeals({ limit: 200, sortBy: "updated_at", sortDir: "desc" });
  const { contacts } = useContacts({ limit: 100, sortBy: "updated_at", sortDir: "desc" });
  const filesEnabled = user?.role !== "rep";
  const fileKind = tab === "photos" ? "photos" : tab === "documents" ? "documents" : undefined;
  const effectiveCategory = typeFilter !== "all" ? typeFilter : undefined;
  const effectiveLinkedType = linkedFilter !== "any" ? linkedFilter : undefined;

  const { files, loading, error, refetch } = useFiles(
    {
      search: search.trim() || undefined,
      sortBy,
      sortDir,
      limit: 200,
      category: effectiveCategory,
      fileKind,
      linkedType: effectiveLinkedType,
    },
    { enabled: filesEnabled }
  );
  const { stats: fileStats, refetch: refetchFileStats } = useFileStats({ enabled: filesEnabled });

  const dealMap = useMemo(() => {
    const map = new Map<string, Deal>();
    for (const deal of deals) map.set(deal.id, deal);
    return map;
  }, [deals]);

  const visibleFiles = useMemo(() => {
    return files.filter((file) => {
      if (tab === "photos" && file.category !== "photo" && !file.mimeType.startsWith("image/")) return false;
      if (tab === "documents" && !isDocument(file)) return false;
      if (typeFilter !== "all" && file.category !== typeFilter) return false;
      if (!matchesLinkedFilter(file, linkedFilter)) return false;
      return true;
    });
  }, [files, linkedFilter, tab, typeFilter]);

  const photos = visibleFiles.filter((file) => file.category === "photo" || file.mimeType.startsWith("image/"));
  const documents = visibleFiles.filter(isDocument);
  const visibleBytes = visibleFiles.reduce((sum, file) => sum + file.fileSizeBytes, 0);
  const totalCounts = {
    all: fileStats?.totalFiles ?? files.length,
    photos: fileStats?.totalPhotos ?? files.filter((file) => file.category === "photo" || file.mimeType.startsWith("image/")).length,
    documents: fileStats?.totalDocuments ?? files.filter(isDocument).length,
  };
  const totalBytes = fileStats?.totalBytes ?? files.reduce((sum, file) => sum + file.fileSizeBytes, 0);
  const recentUploads = fileStats?.recentUploads ?? files.filter((file) => {
    const created = new Date(file.createdAt).getTime();
    return Number.isFinite(created) && Date.now() - created <= 3 * 24 * 60 * 60 * 1000;
  }).length;

  const uploadDeal = useMemo(() => deals.find((deal) => deal.id === uploadDealId) ?? null, [deals, uploadDealId]);
  const uploadDealDisplayNumber = uploadDeal ? formatDealDisplayNumber(uploadDeal).label : undefined;

  const handleDownload = useCallback(async (fileId: string) => {
    try {
      await downloadFile(fileId);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Download failed");
    }
  }, []);

  const handleDelete = useCallback(
    async (fileId: string) => {
      if (!window.confirm("Delete this file?")) return;
      try {
        await deleteFileRecord(fileId);
        refetch();
        refetchFileStats();
      } catch (err: unknown) {
        alert(err instanceof Error ? err.message : "Delete failed");
      }
    },
    [refetch, refetchFileStats]
  );

  const handleUploadComplete = useCallback(() => {
    refetch();
    refetchFileStats();
  }, [refetch, refetchFileStats]);

  const resetFilters = () => {
    setSearch("");
    setTypeFilter("all");
    setLinkedFilter("any");
    setTab("all");
  };

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-4xl font-black uppercase tracking-tight text-slate-950 md:text-5xl">Files</h1>
          <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.24em] text-slate-500">
            {totalCounts.all} files · {totalCounts.photos} photos · {totalCounts.documents} documents
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-black uppercase tracking-[0.18em] text-slate-600">
            Team Library
          </div>
          <Button size="lg" onClick={() => setShowUpload((value) => !value)}>
            <Plus className="mr-1.5 h-4 w-4" />
            Upload
          </Button>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <MetricCard eyebrow="Storage used" value={formatFileSize(totalBytes)} badge={`${totalCounts.all} files`} caption="across CRM" />
        <MetricCard eyebrow="Photos" value={String(totalCounts.photos)} badge="site walks" caption="audits · progress" />
        <MetricCard eyebrow="Recent uploads" value={String(recentUploads)} badge="last 3 days" caption="fresh on the books" accent="red" />
      </div>

      {showUpload ? (
        <Card className="overflow-hidden border-slate-200">
          <CardHeader className="flex flex-row items-center justify-between border-b border-slate-100 px-5 py-4">
            <div>
              <CardTitle className="text-sm font-black uppercase tracking-[0.18em] text-slate-950">Upload Files</CardTitle>
              <p className="mt-1 text-xs text-slate-500">Drag files into the dropzone or browse from your device.</p>
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowUpload(false)} aria-label="Close upload panel">
              <X className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent className="space-y-4 p-5">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <label className={EYEBROW}>Category</label>
                <Select value={uploadCategory} onValueChange={(value) => setUploadCategory(value as FileCategory | "auto")}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Default: let the server infer the document type from the filename. An explicit
                        pick (including Uncategorized) is respected as-is. */}
                    <SelectItem value="auto">Auto-detect</SelectItem>
                    {FILE_CATEGORIES.map((category) => (
                      <SelectItem key={category} value={category}>
                        {getCategoryLabel(category)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <label className={EYEBROW}>Assign to Deal</label>
                <Select value={uploadDealId || "none"} onValueChange={(value) => setUploadDealId(!value || value === "none" ? "" : value)}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No deal</SelectItem>
                    {deals.map((deal) => (
                      <SelectItem key={deal.id} value={deal.id}>
                        {formatDealDisplayNumber(deal).label} · {deal.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <FileUploadZone category={uploadCategory} dealId={uploadDealId || undefined} dealNumber={uploadDealDisplayNumber === "Pending" ? undefined : uploadDealDisplayNumber} onUploadComplete={handleUploadComplete} />
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
        <Card className="overflow-hidden border-slate-200">
          <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-1 rounded-md border border-slate-200 bg-white p-0.5">
              {([
                { key: "all", label: "All", icon: Layers, count: totalCounts.all },
                { key: "photos", label: "Photos", icon: Camera, count: totalCounts.photos },
                { key: "documents", label: "Documents", icon: FileText, count: totalCounts.documents },
              ] as const).map((item) => {
                const Icon = item.icon;
                const active = tab === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    data-filter-tab={item.key}
                    onClick={() => {
                      setTab(item.key);
                      setTypeFilter("all");
                      setView(item.key === "documents" ? "list" : "grid");
                    }}
                    className={`flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-bold transition-colors ${
                      active ? "bg-slate-100 text-slate-950" : "text-slate-500 hover:text-slate-900"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {item.label}
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-black tabular-nums ${active ? "bg-brand-red/10 text-brand-red" : "bg-slate-100 text-slate-600"}`}>
                      {item.count}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2 rounded-md bg-slate-100 px-3 py-2 lg:min-w-72">
                <Search className="h-4 w-4 text-slate-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  onInput={(event) => setSearch(event.currentTarget.value)}
                  placeholder="Search files"
                  className="min-w-0 flex-1 bg-transparent text-sm placeholder:text-slate-500 focus:outline-none"
                />
                {search ? (
                  <button type="button" onClick={() => setSearch("")} aria-label="Clear search">
                    <X className="h-3.5 w-3.5 text-slate-400" />
                  </button>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => setSortBy((value) => nextSortBy(value))}
                data-sort-button
                className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                <ArrowUpDown className="h-3.5 w-3.5" />
                Sort: {sortBy === "created_at" ? "Recent" : sortBy === "display_name" ? "Name" : "Size"}
                <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
              </button>
              <button
                type="button"
                onClick={() => setSortDir((value) => (value === "desc" ? "asc" : "desc"))}
                className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                aria-label="Toggle sort direction"
              >
                {sortDir === "desc" ? "Newest" : "Oldest"}
              </button>
              <div className="flex items-center gap-1 rounded-md border border-slate-200 bg-white p-0.5">
                <button
                  type="button"
                  onClick={() => setView("grid")}
                  aria-pressed={view === "grid"}
                  className={`flex h-7 w-7 items-center justify-center rounded-sm transition-colors ${view === "grid" ? "bg-slate-100 text-slate-950" : "text-slate-500 hover:text-slate-900"}`}
                  aria-label="Grid view"
                >
                  <LayoutGrid className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setView("list")}
                  aria-pressed={view === "list"}
                  className={`flex h-7 w-7 items-center justify-center rounded-sm transition-colors ${view === "list" ? "bg-slate-100 text-slate-950" : "text-slate-500 hover:text-slate-900"}`}
                  aria-label="List view"
                >
                  <List className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-3">
            <p className={`${EYEBROW} self-center`}>File type:</p>
            {TYPE_FILTERS.map((filter) => (
              <FilterChip
                key={filter.value}
                active={typeFilter === filter.value}
                onClick={() => {
                  setTypeFilter(filter.value);
                  if (filter.value === "all") {
                    setTab("all");
                    return;
                  }
                  if (filter.value === "photo") setTab("photos");
                  if (filter.value !== "photo") setTab("documents");
                }}
                dataAttribute={{ "data-type-filter": filter.value }}
              >
                {filter.label}
              </FilterChip>
            ))}
            {(linkedFilter !== "any" || typeFilter !== "all" || search || tab !== "all") ? (
              <button
                type="button"
                onClick={resetFilters}
                className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-slate-500 hover:text-slate-900"
              >
                <X className="h-3 w-3" />
                Clear filters
              </button>
            ) : null}
          </div>

          {!filesEnabled ? (
            <div className="px-5 py-16 text-center">
              <FolderOpen className="mx-auto h-10 w-10 text-slate-300" />
              <p className="mt-3 text-sm font-semibold text-slate-700">Access restricted</p>
              <p className="mt-1 text-sm text-slate-500">Contact your director to access the file browser.</p>
            </div>
          ) : loading ? (
            <div className="space-y-3 p-5">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="h-24 animate-pulse rounded-md bg-slate-100" />
              ))}
            </div>
          ) : error ? (
            <div className="px-5 py-12 text-center">
              <p className="text-sm font-semibold text-red-600">{error}</p>
            </div>
          ) : visibleFiles.length === 0 ? (
            <div className="px-5 py-16 text-center">
              <Layers className="mx-auto h-8 w-8 text-slate-300" />
              <p className="mt-2 text-sm font-semibold text-slate-700">No files match these filters.</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => setShowUpload(true)}>
                <Plus className="mr-1 h-4 w-4" />
                Upload first file
              </Button>
            </div>
          ) : view === "grid" ? (
            <div className="space-y-6 p-5" data-view="grid">
              {tab === "all" && photos.length > 0 ? (
                <section>
                  <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500">Photos · {photos.length}</p>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                    {photos.map((file) => (
                      <FileGridCard key={file.id} file={file} dealMap={dealMap} onDownload={handleDownload} onDelete={handleDelete} />
                    ))}
                  </div>
                </section>
              ) : tab === "photos" ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                  {photos.map((file) => (
                    <FileGridCard key={file.id} file={file} dealMap={dealMap} onDownload={handleDownload} onDelete={handleDelete} />
                  ))}
                </div>
              ) : null}

              {tab === "all" && documents.length > 0 ? (
                <section>
                  <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500">Documents · {documents.length}</p>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                    {documents.map((file) => (
                      <FileGridCard key={file.id} file={file} dealMap={dealMap} onDownload={handleDownload} onDelete={handleDelete} />
                    ))}
                  </div>
                </section>
              ) : tab === "documents" ? (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                  {documents.map((file) => (
                    <FileGridCard key={file.id} file={file} dealMap={dealMap} onDownload={handleDownload} onDelete={handleDelete} />
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <FilesTable
              rows={visibleFiles}
              dealMap={dealMap}
              onDownload={handleDownload}
              onDelete={handleDelete}
              sortBy={sortBy}
              sortDir={sortDir}
              onSort={handleSort}
            />
          )}

          <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-xs text-slate-600">
            <p>
              <span className="font-bold tabular-nums text-slate-950">{visibleFiles.length}</span> of{" "}
              <span className="tabular-nums">{files.length}</span> files
            </p>
            <p className="font-semibold tabular-nums">{formatFileSize(visibleBytes)}</p>
          </div>
        </Card>

        <aside className="space-y-4">
          <Card className="border-slate-200 p-4">
            <p className={EYEBROW}>Linked to</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {([
                ["any", "Any"],
                ["deal", "Deals"],
                ["lead", "Leads"],
                ["contact", "Contacts"],
                ["procore", "Procore"],
                ["change_order", "Change Orders"],
                ["unassigned", "Unassigned"],
              ] as const).map(([value, label]) => (
                <FilterChip
                  key={value}
                  active={linkedFilter === value}
                  onClick={() => setLinkedFilter(value)}
                  dataAttribute={{ "data-linked-filter": value }}
                >
                  {label}
                </FilterChip>
              ))}
            </div>
          </Card>

          <Card className="border-slate-200 p-4">
            <p className={EYEBROW}>Library Summary</p>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-500">Deals with files</dt>
                <dd className="font-black tabular-nums text-slate-950">
                  {fileStats?.dealsWithFiles ?? new Set(files.map((file) => file.dealId).filter(Boolean)).size}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-500">Contacts loaded</dt>
                <dd className="font-black tabular-nums text-slate-950">{contacts.length}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-500">Sort order</dt>
                <dd className="font-bold uppercase text-slate-700">{sortDir === "desc" ? "Newest" : "Oldest"}</dd>
              </div>
            </dl>
          </Card>

          <Card className="border-slate-200 p-4">
            <p className={EYEBROW}>Upload Flow</p>
            <div className="mt-4 flex items-start gap-3 rounded-md bg-slate-50 p-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand-red text-white">
                <Upload className="h-4 w-4" />
              </span>
              <p className="text-sm text-slate-600">Existing drag-drop and picker upload logic is preserved through FileUploadZone.</p>
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}
