import { useState, useCallback } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileUploadZone } from "./file-upload-zone";
import { FileList } from "./file-list";
import { FileSearchBar } from "./file-search-bar";
import {
  useFiles,
  downloadFile,
  deleteFileRecord,
} from "@/hooks/use-files";

interface ContactFileTabProps {
  contactId: string;
}

export function ContactFileTab({ contactId }: ContactFileTabProps) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [showUpload, setShowUpload] = useState(false);

  const { files, pagination, loading, error, refetch } = useFiles({
    contactId,
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
        <Button size="sm" onClick={() => setShowUpload(!showUpload)}>
          <Plus className="h-4 w-4 mr-1" />
          Upload
        </Button>
      </div>

      {showUpload && (
        <FileUploadZone
          category="correspondence"
          contactId={contactId}
          onUploadComplete={refetch}
          compact
        />
      )}

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
        loading={loading}
        error={error}
        onPageChange={setPage}
        onDownload={handleDownload}
        onDelete={handleDelete}
        emptyMessage="No files linked to this contact."
      />
    </div>
  );
}
