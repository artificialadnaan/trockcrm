import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import type { FileCategory } from "@/lib/file-utils";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FileRecord {
  id: string;
  category: FileCategory;
  subcategory: string | null;
  folderPath: string | null;
  tags: string[];
  displayName: string;
  systemFilename: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  fileExtension: string;
  r2Key: string;
  r2Bucket: string;
  dealId: string | null;
  contactId: string | null;
  procoreProjectId: number | null;
  changeOrderId: string | null;
  description: string | null;
  notes: string | null;
  version: number;
  parentFileId: string | null;
  takenAt: string | null;
  geoLat: string | null;
  geoLng: string | null;
  uploadedBy: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FileFilters {
  dealId?: string;
  contactId?: string;
  category?: FileCategory;
  folderPath?: string;
  search?: string;
  tags?: string[];
  page?: number;
  limit?: number;
  sortBy?: "display_name" | "created_at" | "file_size_bytes" | "taken_at";
  sortDir?: "asc" | "desc";
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface FolderNode {
  name: string;
  path: string;
  category: FileCategory;
  count: number;
  subfolders: Array<{ name: string; path: string; count: number }>;
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

export function useFiles(filters: FileFilters = {}, options?: { enabled?: boolean }) {
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const enabled = options?.enabled ?? true;

  const fetchFiles = useCallback(async () => {
    if (!enabled) {
      setFiles([]);
      setPagination({
        page: filters.page ?? 1,
        limit: filters.limit ?? 50,
        total: 0,
        totalPages: 0,
      });
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.dealId) params.set("dealId", filters.dealId);
      if (filters.contactId) params.set("contactId", filters.contactId);
      if (filters.category) params.set("category", filters.category);
      if (filters.folderPath) params.set("folderPath", filters.folderPath);
      if (filters.search) params.set("search", filters.search);
      if (filters.tags && filters.tags.length > 0) params.set("tags", filters.tags.join(","));
      if (filters.page) params.set("page", String(filters.page));
      if (filters.limit) params.set("limit", String(filters.limit));
      if (filters.sortBy) params.set("sortBy", filters.sortBy);
      if (filters.sortDir) params.set("sortDir", filters.sortDir);

      const qs = params.toString();
      const data = await api<{ files: FileRecord[]; pagination: Pagination }>(
        `/files${qs ? `?${qs}` : ""}`
      );
      setFiles(data.files);
      setPagination(data.pagination);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load files");
    } finally {
      setLoading(false);
    }
  }, [
    enabled,
    filters.dealId,
    filters.contactId,
    filters.category,
    filters.folderPath,
    filters.search,
    filters.tags?.join(","),
    filters.page,
    filters.limit,
    filters.sortBy,
    filters.sortDir,
  ]);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  return { files, pagination, loading, error, refetch: fetchFiles };
}

export function useDealFolders(dealId: string | undefined) {
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchFolders = useCallback(async () => {
    if (!dealId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ folders: FolderNode[] }>(
        `/files/deal/${dealId}/folders`
      );
      setFolders(data.folders);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load folders");
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    fetchFolders();
  }, [fetchFolders]);

  return { folders, loading, error, refetch: fetchFolders };
}

export function useDealPhotos(dealId: string | undefined, page: number = 1) {
  const [photos, setPhotos] = useState<FileRecord[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPhotos = useCallback(async () => {
    if (!dealId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ photos: FileRecord[]; pagination: Pagination }>(
        `/files/deal/${dealId}/photos?page=${page}&limit=50`
      );
      setPhotos(data.photos);
      setPagination(data.pagination);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load photos");
    } finally {
      setLoading(false);
    }
  }, [dealId, page]);

  useEffect(() => {
    fetchPhotos();
  }, [fetchPhotos]);

  return { photos, pagination, loading, error, refetch: fetchPhotos };
}

export function useFileVersions(fileId: string | undefined) {
  const [versions, setVersions] = useState<FileRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchVersions = useCallback(async () => {
    if (!fileId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ versions: FileRecord[] }>(
        `/files/${fileId}/versions`
      );
      setVersions(data.versions);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load versions");
    } finally {
      setLoading(false);
    }
  }, [fileId]);

  useEffect(() => {
    fetchVersions();
  }, [fetchVersions]);

  return { versions, loading, error, refetch: fetchVersions };
}

export function useTagSuggestions(dealId?: string) {
  const [tags, setTags] = useState<string[]>([]);

  const fetchTags = useCallback(async () => {
    try {
      const params = dealId ? `?dealId=${dealId}` : "";
      const data = await api<{ tags: string[] }>(`/files/tags${params}`);
      setTags(data.tags);
    } catch {
      // Silently fail -- autocomplete is a nice-to-have
    }
  }, [dealId]);

  useEffect(() => {
    fetchTags();
  }, [fetchTags]);

  return { tags, refetch: fetchTags };
}

// ─── Mutation Functions ──────────────────────────────────────────────────────

export interface UploadFileInput {
  file: File;
  category: FileCategory;
  subcategory?: string;
  dealId?: string;
  contactId?: string;
  procoreProjectId?: number;
  changeOrderId?: string;
  description?: string;
  tags?: string[];
  onProgress?: (percent: number) => void;
}

/**
 * Upload a file via server-side proxy to R2 (avoids CORS issues with presigned URLs).
 * Sends the file as raw body with metadata in headers.
 * Uses XHR for upload progress tracking.
 */
export async function uploadFile(input: UploadFileInput): Promise<FileRecord> {
  const {
    file,
    category,
    subcategory,
    dealId,
    contactId,
    description,
    tags,
    onProgress,
  } = input;

  const baseUrl = (import.meta as any).env?.VITE_API_URL || "";

  return new Promise<FileRecord>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${baseUrl}/api/files/upload-direct`);

    // Send metadata in headers
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("X-Original-Filename", file.name);
    xhr.setRequestHeader("X-File-Category", category);
    if (subcategory) xhr.setRequestHeader("X-File-Subcategory", subcategory);
    if (dealId) xhr.setRequestHeader("X-Deal-Id", dealId);
    if (contactId) xhr.setRequestHeader("X-Contact-Id", contactId);
    if (description) xhr.setRequestHeader("X-File-Description", description);
    if (tags && tags.length > 0) xhr.setRequestHeader("X-File-Tags", tags.join(","));

    // Include auth cookie
    xhr.withCredentials = true;

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          resolve(data.file);
        } catch {
          reject(new Error("Failed to parse upload response"));
        }
      } else {
        try {
          const data = JSON.parse(xhr.responseText);
          reject(new Error(data.message || `Upload failed with status ${xhr.status}`));
        } catch {
          reject(new Error(`Upload failed with status ${xhr.status}`));
        }
      }
    };

    xhr.onerror = () => reject(new Error("Upload failed: network error"));
    xhr.send(file);
  });
}

/**
 * Get a presigned download URL for a file and trigger browser download.
 */
export async function downloadFile(fileId: string): Promise<void> {
  const data = await api<{ url: string; filename: string }>(
    `/files/${fileId}/download`
  );

  // Trigger browser download
  const link = document.createElement("a");
  link.href = data.url;
  link.download = data.filename;
  link.target = "_blank";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export async function updateFileMetadata(
  fileId: string,
  input: {
    displayName?: string;
    description?: string | null;
    notes?: string | null;
    tags?: string[];
    category?: FileCategory;
    subcategory?: string | null;
    folderPath?: string | null;
  }
): Promise<FileRecord> {
  const { file } = await api<{ file: FileRecord }>(`/files/${fileId}`, {
    method: "PATCH",
    json: input,
  });
  return file;
}

export async function deleteFileRecord(fileId: string): Promise<void> {
  await api(`/files/${fileId}`, { method: "DELETE" });
}
