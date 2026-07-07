import { useState, useCallback, useRef } from "react";
import { Upload, X, FileIcon, CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { uploadFile } from "@/hooks/use-files";
import type { FolderNode } from "@/hooks/use-files";
import {
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE_MB,
  MAX_FILE_SIZE_BYTES,
  getFileExtension,
  deriveUploadDisplayName,
  getCategoryLabel,
  resolveFolderUploadTarget,
} from "@/lib/file-utils";
import type { FileCategory } from "@/lib/file-utils";
import { Textarea } from "@/components/ui/textarea";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic"]);

interface FileUploadZoneProps {
  /** A real category is sent as the user's explicit choice; "auto" lets the server infer the type. */
  category: FileCategory | "auto";
  subcategory?: string;
  /** When provided, renders a folder picker whose choice overrides category/subcategory per upload. */
  folders?: FolderNode[];
  dealId?: string;
  leadId?: string;
  contactId?: string;
  tags?: string[];
  onUploadComplete?: () => void;
  compact?: boolean;
  dealNumber?: string;
}

interface UploadState {
  id: string; // Stable UUID for tracking
  file: File;
  previewName: string;
  progress: number;
  status: "pending" | "uploading" | "done" | "error";
  error?: string;
}

export function FileUploadZone({
  category,
  subcategory,
  folders,
  dealId,
  leadId,
  contactId,
  tags,
  onUploadComplete,
  compact = false,
  dealNumber,
}: FileUploadZoneProps) {
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [description, setDescription] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Folder picker selection (independent of the sidebar). "" = use the category/subcategory props
  // (which the parent derives from the selected sidebar folder). A real value is a FolderNode.path or a
  // subfolder path and OVERRIDES the upload's category/subcategory.
  const [pickedFolder, setPickedFolder] = useState("");
  const picked = folders ? resolveFolderUploadTarget(folders, pickedFolder) : null;
  const effectiveCategory: FileCategory | "auto" = picked ? picked.category : category;
  const effectiveSubcategory = picked ? picked.subcategory : subcategory;
  // Honest default-option label: when the parent inherited a real category from the sidebar folder,
  // the no-override upload files under THAT category — so say so rather than "Auto-detect".
  const defaultPickLabel =
    category === "auto"
      ? "Auto-detect"
      : `Current type: ${getCategoryLabel(category)}${subcategory ? ` / ${subcategory}` : ""}`;

  // Resolve the category the SERVER will use for THIS file, so the preview is honest: an "auto" image is
  // inferred as photo; an "auto" non-image is treated like every non-photo. For a real dropped photo the
  // filename is never synthetic, so deriveUploadDisplayName returns its ext-stripped real name (== what is
  // saved).
  const resolvePreviewCategory = (file: File): FileCategory => {
    if (effectiveCategory !== "auto") return effectiveCategory;
    const ext = getFileExtension(file.name);
    const isImage = file.type.startsWith("image/") || IMAGE_EXTENSIONS.has(ext);
    return isImage ? "photo" : "other";
  };

  const validateFile = (file: File): string | null => {
    const ext = getFileExtension(file.name);

    if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
      return `"${ext || "(none)"}" files are not supported.`;
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      return `File is ${(file.size / 1024 / 1024).toFixed(1)} MB. Max is ${MAX_FILE_SIZE_MB} MB.`;
    }
    if (file.size === 0) {
      return "File is empty.";
    }
    if (effectiveCategory === "photo" && !file.type.startsWith("image/") && !IMAGE_EXTENSIONS.has(ext)) {
      return "Photos must be image files.";
    }
    return null;
  };

  const handleFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const newFiles = Array.from(fileList);

      // Fix 12: Track uploads by stable UUID instead of array index
      const uploadStates: UploadState[] = newFiles.map((file) => ({
        id: crypto.randomUUID(),
        file,
        previewName: deriveUploadDisplayName(file.name, resolvePreviewCategory(file), dealNumber),
        progress: 0,
        status: "pending" as const,
      }));

      setUploads((prev) => [...prev, ...uploadStates]);

      let allSucceeded = true;

      for (let i = 0; i < newFiles.length; i++) {
        const file = newFiles[i];
        const uploadId = uploadStates[i].id;

        const validationError = validateFile(file);
        if (validationError) {
          allSucceeded = false;
          setUploads((prev) =>
            prev.map((u) =>
              u.id === uploadId
                ? { ...u, status: "error" as const, error: validationError }
                : u
            )
          );
          continue;
        }

        setUploads((prev) =>
          prev.map((u) =>
            u.id === uploadId ? { ...u, status: "uploading" as const } : u
          )
        );

        try {
          await uploadFile({
            file,
            category: effectiveCategory,
            subcategory: effectiveSubcategory,
            dealId,
            leadId,
            contactId,
            tags,
            description: description.trim() ? description.trim() : undefined,
            onProgress: (percent) => {
              setUploads((prev) =>
                prev.map((u) =>
                  u.id === uploadId ? { ...u, progress: percent } : u
                )
              );
            },
          });

          setUploads((prev) =>
            prev.map((u) =>
              u.id === uploadId
                ? { ...u, status: "done" as const, progress: 100 }
                : u
            )
          );
        } catch (err: unknown) {
          allSucceeded = false;
          setUploads((prev) =>
            prev.map((u) =>
              u.id === uploadId
                ? {
                    ...u,
                    status: "error" as const,
                    error: err instanceof Error ? err.message : "Upload failed",
                  }
                : u
            )
          );
        }
      }

      // Fix 12: Only fire onUploadComplete when all uploads succeed
      if (allSucceeded) {
        onUploadComplete?.();
        setDescription(""); // description is per-batch; don't leak it onto a later unrelated drop
      }
    },
    [effectiveCategory, effectiveSubcategory, dealId, leadId, contactId, tags, onUploadComplete, dealNumber, description]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files);
      }
    },
    [handleFiles]
  );

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => setDragOver(false);

  const clearCompleted = () => {
    setUploads((prev) => prev.filter((u) => u.status !== "done" && u.status !== "error"));
  };

  const hasCompleted = uploads.some((u) => u.status === "done" || u.status === "error");

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor="upload-desc" className="text-sm font-medium">
          Description (optional)
        </label>
        <Textarea
          id="upload-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="Applied to files added in this upload"
        />
      </div>

      {/* Folder picker — independent of the sidebar selection. "All Files" is NOT a valid target;
          the default option (value "") files under the inherited sidebar category / auto-detect. A
          folder WITH subfolders renders as an <optgroup>; a leaf folder renders as a bare <option>
          (avoids a redundant single-child group header for the majority of folders). */}
      {folders && folders.length > 0 && (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Save to folder
          <select
            data-testid="upload-folder-picker"
            className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
            value={pickedFolder}
            onChange={(e) => setPickedFolder(e.target.value)}
          >
            <option value="">{defaultPickLabel}</option>
            {folders.map((folder) =>
              folder.subfolders.length > 0 ? (
                <optgroup key={folder.path} label={folder.name}>
                  <option value={folder.path}>{folder.name}</option>
                  {folder.subfolders.map((sub) => (
                    <option key={sub.path} value={sub.path}>
                      {folder.name} / {sub.name}
                    </option>
                  ))}
                </optgroup>
              ) : (
                <option key={folder.path} value={folder.path}>
                  {folder.name}
                </option>
              )
            )}
          </select>
        </label>
      )}

      {/* Drop Zone */}
      <div
        className={`border-2 border-dashed rounded-lg transition-colors cursor-pointer ${
          dragOver
            ? "border-brand-red bg-brand-red/5"
            : "border-muted-foreground/25 hover:border-muted-foreground/50"
        } ${compact ? "p-4" : "p-8"}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => fileInputRef.current?.click()}
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <Upload
            className={`text-muted-foreground ${compact ? "h-6 w-6" : "h-10 w-10"}`}
          />
          <div>
            <p className={`font-medium ${compact ? "text-sm" : ""}`}>
              Drop files here or click to browse
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Max {MAX_FILE_SIZE_MB} MB. Images, PDF, Office docs, CSV, TXT, ZIP, EML, MSG.
            </p>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
          accept={Array.from(effectiveCategory === "photo" ? IMAGE_EXTENSIONS : ALLOWED_EXTENSIONS).join(",")}
        />
      </div>

      {/* Upload Progress List */}
      {uploads.length > 0 && (
        <div className="space-y-2">
          {uploads.map((upload) => (
            <div
              key={upload.id}
              className="flex items-center gap-3 rounded-lg border p-2 text-sm"
            >
              <FileIcon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="truncate font-medium">{upload.file.name}</p>
                {upload.status === "pending" && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Will be saved as: {upload.previewName}
                  </p>
                )}
                {upload.status === "uploading" && (
                  <div className="mt-1 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-brand-red rounded-full transition-all duration-300"
                      style={{ width: `${upload.progress}%` }}
                    />
                  </div>
                )}
                {upload.status === "error" && (
                  <p className="text-xs text-red-600 mt-0.5">{upload.error}</p>
                )}
              </div>
              <div className="flex-shrink-0">
                {upload.status === "uploading" && (
                  <Loader2 className="h-4 w-4 animate-spin text-brand-red" />
                )}
                {upload.status === "done" && (
                  <CheckCircle className="h-4 w-4 text-green-600" />
                )}
                {upload.status === "error" && (
                  <AlertCircle className="h-4 w-4 text-red-600" />
                )}
              </div>
            </div>
          ))}

          {hasCompleted && (
            <Button variant="ghost" size="sm" onClick={clearCompleted}>
              <X className="h-3 w-3 mr-1" />
              Clear completed
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
