import { FileText, Download, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useFileVersions, downloadFile } from "@/hooks/use-files";
import { formatFileSize } from "@/lib/file-utils";

interface FileVersionHistoryProps {
  fileId: string;
  onBack: () => void;
}

export function FileVersionHistory({ fileId, onBack }: FileVersionHistoryProps) {
  const { versions, loading, error } = useFileVersions(fileId);

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-12 bg-muted animate-pulse rounded" />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className="text-red-600 text-sm">{error}</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <h4 className="text-sm font-semibold">Version History</h4>
      </div>

      <div className="space-y-2">
        {versions.map((v) => (
          <div
            key={v.id}
            className="flex items-center gap-3 p-3 border rounded-lg"
          >
            <FileText className="h-4 w-4 text-muted-foreground" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Version {v.version}</span>
                {v.id === fileId && (
                  <Badge variant="secondary" className="text-xs">Current</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {formatFileSize(v.fileSizeBytes)} &middot;{" "}
                {new Date(v.createdAt).toLocaleString()}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => downloadFile(v.id)}
            >
              <Download className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
