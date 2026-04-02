import {
  FileIcon,
  ImageIcon,
  FileText,
  FileSpreadsheet,
  Download,
  MoreHorizontal,
  Trash2,
  Edit,
  History,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { FileRecord } from "@/hooks/use-files";
import { formatFileSize } from "@/lib/file-utils";

interface FileRowProps {
  file: FileRecord;
  onDownload: (fileId: string) => void;
  onDelete: (fileId: string) => void;
  onViewVersions?: (fileId: string) => void;
  onEdit?: (file: FileRecord) => void;
}

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith("image/")) return ImageIcon;
  if (mimeType === "application/pdf" || mimeType.includes("word")) return FileText;
  if (mimeType.includes("sheet") || mimeType.includes("excel") || mimeType === "text/csv")
    return FileSpreadsheet;
  return FileIcon;
}

export function FileRow({
  file,
  onDownload,
  onDelete,
  onViewVersions,
  onEdit,
}: FileRowProps) {
  const Icon = getFileIcon(file.mimeType);

  return (
    <div className="flex items-center gap-3 p-3 border-b last:border-b-0 hover:bg-accent/50 transition-colors">
      <Icon className="h-5 w-5 text-muted-foreground flex-shrink-0" />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium truncate">{file.displayName}{file.fileExtension}</p>
          {file.version > 1 && (
            <Badge variant="outline" className="text-xs">
              v{file.version}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5">
          <span className="text-xs text-muted-foreground">
            {formatFileSize(file.fileSizeBytes)}
          </span>
          <span className="text-xs text-muted-foreground">
            {new Date(file.createdAt).toLocaleDateString()}
          </span>
          {file.tags.length > 0 && (
            <div className="flex gap-1">
              {file.tags.slice(0, 3).map((tag) => (
                <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0">
                  {tag}
                </Badge>
              ))}
              {file.tags.length > 3 && (
                <span className="text-[10px] text-muted-foreground">
                  +{file.tags.length - 3}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 flex-shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => onDownload(file.id)}
          title="Download"
        >
          <Download className="h-4 w-4" />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            {onEdit && (
              <DropdownMenuItem onClick={() => onEdit(file)}>
                <Edit className="h-4 w-4 mr-2" />
                Edit Details
              </DropdownMenuItem>
            )}
            {onViewVersions && file.version > 1 && (
              <DropdownMenuItem onClick={() => onViewVersions(file.id)}>
                <History className="h-4 w-4 mr-2" />
                Version History
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => onDelete(file.id)} className="text-red-600">
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
