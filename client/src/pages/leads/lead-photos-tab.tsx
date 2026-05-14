import { useCallback, useState } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileList } from "@/components/files/file-list";
import { FileUploadZone } from "@/components/files/file-upload-zone";
import { deleteFileRecord, downloadFile, useFiles } from "@/hooks/use-files";

export function LeadPhotosTab({ leadId }: { leadId: string }) {
  const [page, setPage] = useState(1);
  const [showUpload, setShowUpload] = useState(false);
  const { files, pagination, loading, error, refetch } = useFiles({
    leadId,
    category: "photo",
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
      if (!window.confirm("Delete this photo?")) return;
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Photos</h3>
          <p className="text-sm text-muted-foreground">Lead-stage site photos and field documentation.</p>
        </div>
        <Button size="sm" onClick={() => setShowUpload((current) => !current)}>
          <Upload className="mr-1.5 h-4 w-4" />
          Upload
        </Button>
      </div>

      {showUpload ? (
        <FileUploadZone
          category="photo"
          leadId={leadId}
          compact
          onUploadComplete={refetch}
        />
      ) : null}

      <FileList
        files={files}
        pagination={pagination}
        loading={loading}
        error={error}
        onPageChange={setPage}
        onDownload={handleDownload}
        onDelete={handleDelete}
        emptyMessage="No photos have been added to this lead yet."
      />
    </div>
  );
}
