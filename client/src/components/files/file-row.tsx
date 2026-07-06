import {
  Download,
  MoreHorizontal,
  Trash2,
  Edit,
  History,
  ExternalLink,
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
import { getFileTypeBadge } from "@/lib/file-type-badge";

interface FileRowProps {
  file: FileRecord;
  onDownload: (fileId: string) => void;
  onOpen?: (fileId: string) => void;
  onDelete: (fileId: string) => void;
  onViewVersions?: (fileId: string) => void;
  onEdit?: (file: FileRecord) => void;
}

export function FileRow({
  file,
  onDownload,
  onOpen,
  onDelete,
  onViewVersions,
  onEdit,
}: FileRowProps) {
  const badge = getFileTypeBadge(file.mimeType, file.fileExtension);
  const BadgeIcon = badge.Icon;

  return (
    <div className="flex items-center gap-3 p-3 border-b last:border-b-0 hover:bg-accent/50 transition-colors">
      {/* Real preview when the list resolved a thumbnail (image or PDF first page); a colored type badge
          otherwise so non-image documents are still visually distinct. */}
      {file.thumbnailUrl ? (
        <img
          src={file.thumbnailUrl}
          alt={file.displayName}
          loading="lazy"
          className="h-10 w-10 rounded object-cover flex-shrink-0 border bg-muted"
        />
      ) : (
        <div
          className={`h-10 w-10 rounded flex flex-col items-center justify-center flex-shrink-0 border ${badge.className}`}
        >
          <BadgeIcon className="h-4 w-4" />
          <span className="text-[8px] font-semibold leading-none mt-0.5">{badge.label}</span>
        </div>
      )}

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
        {onOpen && (
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11 md:h-8 md:w-8"
            onClick={() => onOpen(file.id)}
            title="Open"
          >
            <ExternalLink className="h-4 w-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11 md:h-8 md:w-8"
          onClick={() => onDownload(file.id)}
          title="Download"
        >
          <Download className="h-4 w-4" />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon" className="h-11 w-11 md:h-8 md:w-8">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            {onOpen && (
              <DropdownMenuItem onClick={() => onOpen(file.id)}>
                <ExternalLink className="h-4 w-4 mr-2" />
                Open in New Tab
              </DropdownMenuItem>
            )}
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
