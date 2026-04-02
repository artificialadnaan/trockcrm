import { FileIcon } from "lucide-react";
import { FileRow } from "./file-row";
import { Button } from "@/components/ui/button";
import type { FileRecord, Pagination } from "@/hooks/use-files";

interface FileListProps {
  files: FileRecord[];
  pagination: Pagination;
  loading: boolean;
  error: string | null;
  onPageChange: (page: number) => void;
  onDownload: (fileId: string) => void;
  onDelete: (fileId: string) => void;
  onViewVersions?: (fileId: string) => void;
  onEdit?: (file: FileRecord) => void;
  emptyMessage?: string;
}

export function FileList({
  files,
  pagination,
  loading,
  error,
  onPageChange,
  onDownload,
  onDelete,
  onViewVersions,
  onEdit,
  emptyMessage = "No files yet",
}: FileListProps) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-14 bg-muted animate-pulse rounded" />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className="text-red-600 text-sm py-4">{error}</p>;
  }

  if (files.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <FileIcon className="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p>{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="border rounded-lg overflow-hidden">
        {files.map((file) => (
          <FileRow
            key={file.id}
            file={file}
            onDownload={onDownload}
            onDelete={onDelete}
            onViewVersions={onViewVersions}
            onEdit={onEdit}
          />
        ))}
      </div>

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <span className="text-sm text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages} ({pagination.total} files)
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page <= 1}
              onClick={() => onPageChange(pagination.page - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => onPageChange(pagination.page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
