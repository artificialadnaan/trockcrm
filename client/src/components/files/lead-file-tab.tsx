import { useCallback, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileUploadZone } from "./file-upload-zone";
import { FileList } from "./file-list";
import { FileSearchBar } from "./file-search-bar";
import { downloadFile, deleteFileRecord, useFiles } from "@/hooks/use-files";

export function LeadFileTab({ leadId }: { leadId: string }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [showUpload, setShowUpload] = useState(false);
  const { files, pagination, loading, error, refetch } = useFiles({
    leadId,
    search: search || undefined,
    page,
    limit: 25,
  });

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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Files</h3>
        <Button size="sm" onClick={() => setShowUpload((current) => !current)}>
          <Plus className="mr-1 h-4 w-4" />
          Upload
        </Button>
      </div>

      {showUpload ? (
        <FileUploadZone
          category="other"
          leadId={leadId}
          onUploadComplete={refetch}
        />
      ) : null}

      <FileSearchBar
        value={search}
        onChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
      />

      <FileList
        files={files}
        pagination={pagination}
        loading={loading}
        error={error}
        onPageChange={setPage}
        onDownload={handleDownload}
        onDelete={handleDelete}
        emptyMessage={search ? "No lead files match your search." : "No files uploaded to this lead yet."}
      />
    </div>
  );
}
