import { useState, useCallback } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileUploadZone } from "./file-upload-zone";
import { FileFolderTree } from "./file-folder-tree";
import { FileList } from "./file-list";
import { FileSearchBar } from "./file-search-bar";
import { FileVersionHistory } from "./file-version-history";
import { DealFilePhotosSubview } from "./deal-file-photos-subview";
import { FileEditModal } from "./file-edit-modal";
import {
  useFiles,
  useDealFolders,
  downloadFile,
  openFile,
  deleteFileRecord,
  type FileRecord,
  type FileFilters,
} from "@/hooks/use-files";
import { FILE_CATEGORIES, getCategoryLabel, type FileCategory } from "@/lib/file-utils";

interface DealFileTabProps {
  dealId: string;
}

type FileKindFilter = "all" | "photos" | "documents";
type SortByOption = NonNullable<FileFilters["sortBy"]>;

export function DealFileTab({ dealId }: DealFileTabProps) {
  const [activeSubview, setActiveSubview] = useState<"all" | "photos">("all");
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [showUpload, setShowUpload] = useState(false);
  const [versionFileId, setVersionFileId] = useState<string | null>(null);
  const [editingFile, setEditingFile] = useState<FileRecord | null>(null);

  // Filter/sort controls (independent of the sidebar folder selection).
  const [fileKind, setFileKind] = useState<FileKindFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<FileCategory | "all">("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sortBy, setSortBy] = useState<SortByOption>("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const { folders, loading: foldersLoading, refetch: refetchFolders } =
    useDealFolders(dealId);

  const { files, pagination, loading: filesLoading, error, refetch: refetchFiles } =
    useFiles({
      dealId,
      folderPath: selectedFolder ?? undefined,
      search: search || undefined,
      fileKind: fileKind === "all" ? undefined : fileKind,
      category: categoryFilter === "all" ? undefined : categoryFilter,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      sortBy,
      sortDir,
      page,
      limit: 25,
    });

  const handleUploadComplete = useCallback(() => {
    refetchFiles();
    refetchFolders();
  }, [refetchFiles, refetchFolders]);

  const handleDownload = useCallback(async (fileId: string) => {
    try {
      await downloadFile(fileId);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Download failed");
    }
  }, []);

  const handleOpen = useCallback(async (fileId: string) => {
    try {
      await openFile(fileId);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Could not open file");
    }
  }, []);

  const handleDelete = useCallback(
    async (fileId: string) => {
      if (!window.confirm("Delete this file?")) return;
      try {
        await deleteFileRecord(fileId);
        refetchFiles();
        refetchFolders();
      } catch (err: unknown) {
        alert(err instanceof Error ? err.message : "Delete failed");
      }
    },
    [refetchFiles, refetchFolders]
  );

  // Determine the upload category from the selected folder. With no folder (or an uncategorized folder)
  // there's no explicit choice, so default to "auto" → the server infers the document type.
  const uploadCategory: FileCategory | "auto" = (() => {
    if (!selectedFolder) return "auto";
    const folder = folders.find(
      (f) => f.path === selectedFolder || f.subfolders.some((s) => s.path === selectedFolder)
    );
    return (folder?.category as FileCategory) ?? "auto";
  })();

  // Determine subcategory from subfolder selection
  const uploadSubcategory = (() => {
    if (!selectedFolder) return undefined;
    for (const folder of folders) {
      const sub = folder.subfolders.find((s) => s.path === selectedFolder);
      if (sub) return sub.name;
    }
    return undefined;
  })();

  // True only when an actual filter/date/type is applied — used to distinguish "filtered but empty"
  // from a deal that genuinely has zero files (so we keep the "No files uploaded yet" copy for the latter).
  const hasActiveFilters =
    fileKind !== "all" || categoryFilter !== "all" || dateFrom !== "" || dateTo !== "";

  // Version history view
  if (versionFileId) {
    return (
      <FileVersionHistory
        fileId={versionFileId}
        onBack={() => setVersionFileId(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Files</h3>
        <Button size="sm" onClick={() => setShowUpload(!showUpload)}>
          <Plus className="h-4 w-4 mr-1" />
          Upload
        </Button>
      </div>

      {/* Upload Zone (collapsible) */}
      {showUpload && activeSubview === "all" && (
        <FileUploadZone
          category={uploadCategory}
          subcategory={uploadSubcategory}
          folders={folders}
          dealId={dealId}
          onUploadComplete={handleUploadComplete}
        />
      )}

      <div className="inline-flex rounded-md border bg-background p-0.5">
        <button
          type="button"
          aria-pressed={activeSubview === "all"}
          aria-label="Show All Files sub-view"
          className={`rounded px-3 py-1.5 text-sm font-medium ${activeSubview === "all" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
          onClick={() => setActiveSubview("all")}
        >
          All Files
        </button>
        <button
          type="button"
          aria-pressed={activeSubview === "photos"}
          aria-label="Show Photos files sub-view"
          className={`rounded px-3 py-1.5 text-sm font-medium ${activeSubview === "photos" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
          onClick={() => setActiveSubview("photos")}
        >
          Photos
        </button>
      </div>

      {/* Main Content: Sidebar + File List */}
      {activeSubview === "photos" ? (
        <DealFilePhotosSubview dealId={dealId} />
      ) : (
        <div className="flex gap-4">
          {/* Folder Tree Sidebar */}
          <div className="w-52 flex-shrink-0 border-r pr-3 hidden md:block">
            <FileFolderTree
              folders={folders}
              selectedPath={selectedFolder}
              onSelectPath={(path) => {
                setSelectedFolder(path);
                setPage(1);
              }}
              loading={foldersLoading}
            />
          </div>

          {/* File List Area */}
          <div className="flex-1 min-w-0 space-y-3">
            <FileSearchBar
              value={search}
              onChange={(v) => {
                setSearch(v);
                setPage(1);
              }}
            />

            {/* Filter + sort controls (spec 5.5: photos/documents + by category, plus a date range). */}
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Type
                <select
                  data-testid="file-type-filter"
                  className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
                  value={fileKind}
                  onChange={(e) => {
                    setFileKind(e.target.value as FileKindFilter);
                    setPage(1);
                  }}
                >
                  <option value="all">All types</option>
                  <option value="documents">Documents</option>
                  <option value="photos">Photos</option>
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Category
                <select
                  data-testid="file-category-filter"
                  className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
                  value={categoryFilter}
                  onChange={(e) => {
                    setCategoryFilter(e.target.value as FileCategory | "all");
                    setPage(1);
                  }}
                >
                  <option value="all">All categories</option>
                  {FILE_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {getCategoryLabel(cat)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                From
                <input
                  data-testid="date-from"
                  type="date"
                  className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
                  value={dateFrom}
                  max={dateTo || undefined}
                  onChange={(e) => {
                    setDateFrom(e.target.value);
                    setPage(1);
                  }}
                />
              </label>

              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                To
                <input
                  data-testid="date-to"
                  type="date"
                  className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
                  value={dateTo}
                  min={dateFrom || undefined}
                  onChange={(e) => {
                    setDateTo(e.target.value);
                    setPage(1);
                  }}
                />
              </label>

              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Sort
                <select
                  data-testid="file-sort"
                  className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
                  value={sortBy}
                  onChange={(e) => {
                    setSortBy(e.target.value as SortByOption);
                    setPage(1);
                  }}
                >
                  <option value="created_at">Date added</option>
                  <option value="display_name">Name</option>
                  <option value="file_size_bytes">Size</option>
                  <option value="file_type">Type</option>
                </select>
              </label>

              <button
                type="button"
                data-testid="file-sort-dir"
                aria-label="Toggle sort direction"
                className="h-8 rounded-md border bg-background px-3 text-sm text-foreground hover:bg-accent"
                onClick={() => {
                  setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                  setPage(1);
                }}
              >
                {sortDir === "asc" ? "Asc" : "Desc"}
              </button>
            </div>

            <FileList
              files={files}
              pagination={pagination}
              loading={filesLoading}
              error={error}
              onPageChange={setPage}
              onDownload={handleDownload}
              onOpen={handleOpen}
              onDelete={handleDelete}
              onViewVersions={setVersionFileId}
              onEdit={setEditingFile}
              emptyMessage={
                search
                  ? "No files match your search."
                  : selectedFolder
                    ? "No files in this folder."
                    : hasActiveFilters
                      ? "No files match these filters."
                      : "No files uploaded yet. Click Upload to add files."
              }
            />
          </div>
        </div>
      )}

      <FileEditModal
        file={editingFile}
        onClose={() => setEditingFile(null)}
        onSaved={() => {
          refetchFiles();
          refetchFolders();
        }}
      />
    </div>
  );
}
