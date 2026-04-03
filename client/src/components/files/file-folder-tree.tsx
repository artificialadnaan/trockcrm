import { useState } from "react";
import { Folder, FolderOpen, ChevronRight, ChevronDown } from "lucide-react";
import type { FolderNode } from "@/hooks/use-files";

interface FileFolderTreeProps {
  folders: FolderNode[];
  selectedPath: string | null;
  onSelectPath: (path: string | null) => void;
  loading?: boolean;
}

export function FileFolderTree({
  folders,
  selectedPath,
  onSelectPath,
  loading,
}: FileFolderTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpand = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  if (loading) {
    return (
      <div className="space-y-2 p-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-6 bg-muted animate-pulse rounded" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {/* "All Files" root */}
      <button
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors ${
          selectedPath === null
            ? "bg-brand-red/10 text-brand-red font-medium"
            : "hover:bg-accent text-foreground"
        }`}
        onClick={() => onSelectPath(null)}
      >
        <Folder className="h-4 w-4" />
        <span className="flex-1 text-left">All Files</span>
      </button>

      {folders.map((folder) => {
        const isExpanded = expanded.has(folder.path);
        const isSelected = selectedPath === folder.path;
        const hasSubfolders = folder.subfolders.length > 0;

        return (
          <div key={folder.path}>
            <div className="flex items-center">
              {hasSubfolders && (
                <button
                  className="p-0.5 hover:bg-accent rounded"
                  onClick={() => toggleExpand(folder.path)}
                >
                  {isExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </button>
              )}
              {!hasSubfolders && <div className="w-[22px]" />}

              <button
                className={`flex-1 flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors ${
                  isSelected
                    ? "bg-brand-red/10 text-brand-red font-medium"
                    : "hover:bg-accent text-foreground"
                }`}
                onClick={() => onSelectPath(folder.path)}
              >
                {isExpanded ? (
                  <FolderOpen className="h-4 w-4" />
                ) : (
                  <Folder className="h-4 w-4" />
                )}
                <span className="flex-1 text-left truncate">{folder.name}</span>
                {folder.count > 0 && (
                  <span className="text-xs text-muted-foreground">{folder.count}</span>
                )}
              </button>
            </div>

            {/* Subfolders */}
            {isExpanded &&
              folder.subfolders.map((sub) => (
                <button
                  key={sub.path}
                  className={`w-full flex items-center gap-2 pl-10 pr-2 py-1.5 rounded text-sm transition-colors ${
                    selectedPath === sub.path
                      ? "bg-brand-red/10 text-brand-red font-medium"
                      : "hover:bg-accent text-foreground"
                  }`}
                  onClick={() => onSelectPath(sub.path)}
                >
                  <Folder className="h-3.5 w-3.5" />
                  <span className="flex-1 text-left truncate">{sub.name}</span>
                  {sub.count > 0 && (
                    <span className="text-xs text-muted-foreground">{sub.count}</span>
                  )}
                </button>
              ))}
          </div>
        );
      })}
    </div>
  );
}
