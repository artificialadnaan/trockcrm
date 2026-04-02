import { useState, useCallback } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileUploadZone } from "./file-upload-zone";
import { FileFolderTree } from "./file-folder-tree";
import { FileList } from "./file-list";
import { FileSearchBar } from "./file-search-bar";
import { FileVersionHistory } from "./file-version-history";
import {
  useFiles,
  useDealFolders,
  downloadFile,
  deleteFileRecord,
} from "@/hooks/use-files";
import type { FileCategory } from "@/lib/file-utils";

interface DealFileTabProps {
  dealId: string;
}

export function DealFileTab({ dealId }: DealFileTabProps) {
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [showUpload, setShowUpload] = useState(false);
  const [versionFileId, setVersionFileId] = useState<string | null>(null);

  const { folders, loading: foldersLoading, refetch: refetchFolders } =
    useDealFolders(dealId);

  const { files, pagination, loading: filesLoading, error, refetch: refetchFiles } =
    useFiles({
      dealId,
      folderPath: selectedFolder ?? undefined,
      search: search || undefined,
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

  // Determine the upload category from the selected folder
  const uploadCategory: FileCategory = (() => {
    if (!selectedFolder) return "other";
    const folder = folders.find(
      (f) => f.path === selectedFolder || f.subfolders.some((s) => s.path === selectedFolder)
    );
    return (folder?.category as FileCategory) ?? "other";
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
      {showUpload && (
        <FileUploadZone
          category={uploadCategory}
          subcategory={uploadSubcategory}
          dealId={dealId}
          onUploadComplete={handleUploadComplete}
        />
      )}

      {/* Main Content: Sidebar + File List */}
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

          <FileList
            files={files}
            pagination={pagination}
            loading={filesLoading}
            error={error}
            onPageChange={setPage}
            onDownload={handleDownload}
            onDelete={handleDelete}
            onViewVersions={setVersionFileId}
            emptyMessage={
              search
                ? "No files match your search."
                : selectedFolder
                  ? "No files in this folder."
                  : "No files uploaded yet. Click Upload to add files."
            }
          />
        </div>
      </div>
    </div>
  );
}
