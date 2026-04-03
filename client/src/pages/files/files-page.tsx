import { useCallback, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileIcon,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  ImageIcon,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FileUploadZone } from "@/components/files/file-upload-zone";
import { useFiles, downloadFile, deleteFileRecord } from "@/hooks/use-files";
import type { FileRecord } from "@/hooks/use-files";
import { useDeals } from "@/hooks/use-deals";
import type { Deal } from "@/hooks/use-deals";
import { useContacts } from "@/hooks/use-contacts";
import { useAuth } from "@/lib/auth";
import {
  FILE_CATEGORIES,
  type FileCategory,
  getCategoryColor,
  getCategoryLabel,
  formatFileSize,
} from "@/lib/file-utils";

// ─── File Icon Helper ────────────────────────────────────────────────────────

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith("image/")) return ImageIcon;
  if (mimeType === "application/pdf" || mimeType.includes("word")) return FileText;
  if (
    mimeType.includes("sheet") ||
    mimeType.includes("excel") ||
    mimeType === "text/csv"
  )
    return FileSpreadsheet;
  return FileIcon;
}

// ─── File Card ───────────────────────────────────────────────────────────────

interface FileCardProps {
  file: FileRecord;
  onDownload: (id: string) => void;
  onDelete: (id: string) => void;
}

function FileCard({ file, onDownload, onDelete }: FileCardProps) {
  const Icon = getFileIcon(file.mimeType);
  const dateStr = new Date(file.createdAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg border border-border/60 bg-card hover:bg-accent/30 transition-colors group">
      <div className="mt-0.5 flex-shrink-0">
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate leading-snug">
          {file.displayName}
          {file.fileExtension}
          {file.version > 1 && (
            <span className="ml-1.5 text-[10px] font-mono text-muted-foreground border border-border px-1 py-0.5 rounded">
              v{file.version}
            </span>
          )}
        </p>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
          <span
            className={`inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${getCategoryColor(
              file.category
            )}`}
          >
            {getCategoryLabel(file.category)}
          </span>
          <span className="text-[11px] text-muted-foreground font-mono">
            {formatFileSize(file.fileSizeBytes)}
          </span>
          <span className="text-[11px] text-muted-foreground">{dateStr}</span>
          {file.uploadedBy && (
            <span className="text-[11px] text-muted-foreground truncate max-w-[120px]">
              {file.uploadedBy}
            </span>
          )}
        </div>

        {file.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {file.tags.slice(0, 4).map((tag) => (
              <Badge key={tag} variant="secondary" className="text-[9px] px-1.5 py-0">
                {tag}
              </Badge>
            ))}
            {file.tags.length > 4 && (
              <span className="text-[10px] text-muted-foreground">
                +{file.tags.length - 4}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => onDownload(file.id)}
          title="Download"
        >
          <Download className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-red-500 hover:text-red-600 hover:bg-red-50"
          onClick={() => onDelete(file.id)}
          title="Delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ─── Deal Section ─────────────────────────────────────────────────────────────

interface DealSectionProps {
  deal: Deal | null; // null = unassigned
  files: FileRecord[];
  onDownload: (id: string) => void;
  onDelete: (id: string) => void;
  defaultOpen?: boolean;
}

function DealSection({
  deal,
  files,
  onDownload,
  onDelete,
  defaultOpen = true,
}: DealSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  const totalBytes = files.reduce((sum, f) => sum + f.fileSizeBytes, 0);

  // Count per category
  const categoryCounts = useMemo(() => {
    const counts: Partial<Record<FileCategory, number>> = {};
    for (const f of files) {
      counts[f.category] = (counts[f.category] ?? 0) + 1;
    }
    return counts;
  }, [files]);

  const topCategories = Object.entries(categoryCounts)
    .sort((a, b) => (b[1] as number) - (a[1] as number))
    .slice(0, 3) as [FileCategory, number][];

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* Section Header */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 bg-muted/40 hover:bg-muted/60 transition-colors border-l-4 border-l-red-600 text-left"
      >
        <span className="flex-shrink-0 text-muted-foreground">
          {open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            {deal ? (
              <>
                <span className="font-mono text-xs font-bold uppercase tracking-widest text-red-600">
                  {deal.dealNumber}
                </span>
                <span className="font-semibold text-sm truncate">{deal.name}</span>
                {deal.projectTypeId && (
                  <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-mono border border-border px-1.5 py-0.5 rounded">
                    {deal.projectTypeId}
                  </span>
                )}
              </>
            ) : (
              <span className="font-semibold text-sm text-muted-foreground">
                Unassigned Files
              </span>
            )}
          </div>

          {deal?.propertyAddress && (
            <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
              {deal.propertyAddress}
              {deal.propertyCity ? `, ${deal.propertyCity}` : ""}
              {deal.propertyState ? `, ${deal.propertyState}` : ""}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 flex-shrink-0 text-right">
          <div className="hidden sm:flex items-center gap-1.5">
            {topCategories.map(([cat, count]) => (
              <span
                key={cat}
                className={`text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded ${getCategoryColor(
                  cat
                )}`}
              >
                {count} {getCategoryLabel(cat)}
              </span>
            ))}
          </div>
          <div className="text-right">
            <p className="text-xs font-mono font-bold text-foreground">
              {files.length} FILE{files.length !== 1 ? "S" : ""}
            </p>
            <p className="text-[10px] font-mono text-muted-foreground">
              {formatFileSize(totalBytes)}
            </p>
          </div>
        </div>
      </button>

      {/* Files Grid */}
      {open && (
        <div className="p-3 grid grid-cols-1 lg:grid-cols-2 gap-2 bg-background">
          {files.map((file) => (
            <FileCard
              key={file.id}
              file={file}
              onDownload={onDownload}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function FilesPage() {
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<FileCategory | "all">("all");
  const [sortBy, setSortBy] = useState<
    "created_at" | "display_name" | "file_size_bytes"
  >("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [showUpload, setShowUpload] = useState(false);
  const [uploadCategory, setUploadCategory] = useState<FileCategory>("other");
  const [uploadDealId, setUploadDealId] = useState("");

  const { deals } = useDeals({
    limit: 200,
    sortBy: "updated_at",
    sortDir: "desc",
  });
  const { contacts } = useContacts({ limit: 100, sortBy: "updated_at", sortDir: "desc" });

  // Reps must have scope; admins/directors load all
  const filesEnabled = user?.role !== "rep";

  const { files, loading, error, refetch } = useFiles(
    {
      search: search || undefined,
      sortBy,
      sortDir,
      limit: 200,
      category: categoryFilter !== "all" ? categoryFilter : undefined,
    },
    { enabled: filesEnabled }
  );

  // Build a dealId → Deal lookup map
  const dealMap = useMemo(() => {
    const map = new Map<string, Deal>();
    for (const d of deals) map.set(d.id, d);
    return map;
  }, [deals]);

  // Group files by dealId
  const grouped = useMemo(() => {
    const groups = new Map<string | null, FileRecord[]>();
    for (const file of files) {
      const key = file.dealId ?? null;
      const bucket = groups.get(key) ?? [];
      bucket.push(file);
      groups.set(key, bucket);
    }
    return groups;
  }, [files]);

  // Sort the deal keys: deals with most-recent file first, unassigned last
  const sortedDealKeys = useMemo(() => {
    const keys = Array.from(grouped.keys());
    const assigned = keys.filter((k) => k !== null) as string[];
    const hasUnassigned = grouped.has(null);

    // Sort assigned deals by first file's createdAt desc
    assigned.sort((a, b) => {
      const aFiles = grouped.get(a) ?? [];
      const bFiles = grouped.get(b) ?? [];
      const aLatest = aFiles[0]?.createdAt ?? "";
      const bLatest = bFiles[0]?.createdAt ?? "";
      return bLatest.localeCompare(aLatest);
    });

    return hasUnassigned ? [...assigned, null] : assigned;
  }, [grouped]);

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
      } catch (err: unknown) {
        alert(err instanceof Error ? err.message : "Delete failed");
      }
    },
    [refetch]
  );

  const uploadDeal = useMemo(
    () => deals.find((d) => d.id === uploadDealId) ?? null,
    [deals, uploadDealId]
  );

  const totalFiles = files.length;
  const totalBytes = useMemo(
    () => files.reduce((s, f) => s + f.fileSizeBytes, 0),
    [files]
  );

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-4xl font-black tracking-tighter uppercase leading-none">
            Project Files
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5 tracking-wide uppercase text-[11px] font-semibold">
            Organized by property and project
          </p>
        </div>
        <Button
          onClick={() => setShowUpload((v) => !v)}
          className="bg-gradient-to-br from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white shadow-md flex-shrink-0"
        >
          <Plus className="h-4 w-4 mr-1.5" />
          Upload File
        </Button>
      </div>

      {/* ── Stats strip ── */}
      {!loading && totalFiles > 0 && (
        <div className="flex items-center gap-6 text-[11px] uppercase tracking-widest font-mono text-muted-foreground border-b border-border pb-3">
          <span>
            <span className="text-foreground font-bold text-sm">{totalFiles}</span>{" "}
            FILES
          </span>
          <span>
            <span className="text-foreground font-bold text-sm">
              {formatFileSize(totalBytes)}
            </span>{" "}
            TOTAL
          </span>
          <span>
            <span className="text-foreground font-bold text-sm">
              {sortedDealKeys.filter((k) => k !== null).length}
            </span>{" "}
            DEALS
          </span>
        </div>
      )}

      {/* ── Upload Panel ── */}
      {showUpload && (
        <Card>
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <CardTitle className="text-sm uppercase tracking-widest font-black">
              Upload Files
            </CardTitle>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setShowUpload(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Category
                </label>
                <Select
                  value={uploadCategory}
                  onValueChange={(v) => setUploadCategory(v as FileCategory)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FILE_CATEGORIES.map((cat) => (
                      <SelectItem key={cat} value={cat}>
                        {getCategoryLabel(cat)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Assign to Deal
                </label>
                <Select
                  value={uploadDealId || "none"}
                  onValueChange={(v) => setUploadDealId(!v || v === "none" ? "" : v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No deal</SelectItem>
                    {deals.map((deal) => (
                      <SelectItem key={deal.id} value={deal.id}>
                        {deal.dealNumber} — {deal.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <FileUploadZone
              category={uploadCategory}
              dealId={uploadDealId || undefined}
              dealNumber={uploadDeal?.dealNumber}
              onUploadComplete={refetch}
            />
          </CardContent>
        </Card>
      )}

      {/* ── Filter / Sort Bar ── */}
      <div className="flex flex-wrap items-end gap-3">
        {/* Search */}
        <div className="flex-1 min-w-[200px] space-y-1">
          <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Search
          </label>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filename…"
              className="pl-8 h-9 text-sm"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Category */}
        <div className="space-y-1 min-w-[150px]">
          <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Category
          </label>
          <Select
            value={categoryFilter}
            onValueChange={(v) => setCategoryFilter(v as FileCategory | "all")}
          >
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {FILE_CATEGORIES.map((cat) => (
                <SelectItem key={cat} value={cat}>
                  {getCategoryLabel(cat)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Sort */}
        <div className="space-y-1 min-w-[140px]">
          <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Sort By
          </label>
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="created_at">Date</SelectItem>
              <SelectItem value="display_name">Name</SelectItem>
              <SelectItem value="file_size_bytes">Size</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Direction */}
        <div className="space-y-1 min-w-[130px]">
          <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Order
          </label>
          <Select
            value={sortDir}
            onValueChange={(v) => setSortDir(v as "asc" | "desc")}
          >
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="desc">Newest First</SelectItem>
              <SelectItem value="asc">Oldest First</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* ── Rep gate ── */}
      {!filesEnabled && (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-muted-foreground">
          <FolderOpen className="h-10 w-10 mx-auto mb-3 opacity-40" />
          <p className="font-semibold">Access Restricted</p>
          <p className="text-sm mt-1">
            Contact your director to access the file browser.
          </p>
        </div>
      )}

      {/* ── Loading ── */}
      {filesEnabled && loading && (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-16 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      )}

      {/* ── Error ── */}
      {filesEnabled && !loading && error && (
        <p className="text-red-600 text-sm">{error}</p>
      )}

      {/* ── Empty state ── */}
      {filesEnabled && !loading && !error && totalFiles === 0 && (
        <div className="rounded-lg border border-dashed border-border p-12 text-center text-muted-foreground">
          <FolderOpen className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="font-semibold text-base">No project files yet.</p>
          <p className="text-sm mt-1">
            Upload documents, photos, and contracts to organize them by property.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => setShowUpload(true)}
          >
            <Plus className="h-4 w-4 mr-1.5" />
            Upload First File
          </Button>
        </div>
      )}

      {/* ── Deal Sections ── */}
      {filesEnabled && !loading && !error && totalFiles > 0 && (
        <div className="space-y-3">
          {sortedDealKeys.map((dealId) => {
            const sectionFiles = grouped.get(dealId) ?? [];
            const deal = dealId ? (dealMap.get(dealId) ?? null) : null;
            return (
              <DealSection
                key={dealId ?? "__unassigned__"}
                deal={deal}
                files={sectionFiles}
                onDownload={handleDownload}
                onDelete={handleDelete}
                defaultOpen={sortedDealKeys.indexOf(dealId) === 0}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
