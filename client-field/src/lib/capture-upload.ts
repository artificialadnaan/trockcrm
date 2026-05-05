import imageCompression from "browser-image-compression";
import * as exifr from "exifr";
import { api } from "./api";

export type PhotoMetadata = {
  latitude?: number;
  longitude?: number;
  addressSource?: "exif" | "live_gps";
  takenAt?: string;
};

export type SessionPhoto = {
  id: string;
  file: File;
  previewUrl: string;
  metadata: PhotoMetadata;
  name: string;
};

export async function compressForUpload(file: File): Promise<File> {
  return imageCompression(file, {
    maxSizeMB: 1.2,
    maxWidthOrHeight: 2048,
    useWebWorker: true,
    initialQuality: 0.85,
    fileType: "image/jpeg",
  }) as Promise<File>;
}

export async function extractPhotoMetadata(file: File, source: "camera" | "gallery"): Promise<PhotoMetadata> {
  if (source === "camera") {
    return { takenAt: new Date().toISOString() };
  }

  try {
    const data: any = await exifr.parse(file, ["GPSLatitude", "GPSLongitude", "DateTimeOriginal", "latitude", "longitude"]);
    const latitude = typeof data?.latitude === "number" ? data.latitude : undefined;
    const longitude = typeof data?.longitude === "number" ? data.longitude : undefined;
    const takenAtValue = data?.DateTimeOriginal;
    return {
      latitude,
      longitude,
      addressSource: latitude !== undefined && longitude !== undefined ? "exif" : undefined,
      takenAt: takenAtValue instanceof Date ? takenAtValue.toISOString() : undefined,
    };
  } catch {
    return {};
  }
}

export function getLiveGps(): Promise<PhotoMetadata> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve({});
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        addressSource: "live_gps",
        takenAt: new Date().toISOString(),
      }),
      () => resolve({ takenAt: new Date().toISOString() }),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 }
    );
  });
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });
}

export function buildUploadMetadata(input: {
  dealId: string;
  objectKey: string;
  uploadToken: string;
  category: string | null;
  caption?: string | null;
  metadata: PhotoMetadata;
}) {
  return {
    dealId: input.dealId,
    objectKey: input.objectKey,
    uploadToken: input.uploadToken,
    category: input.category,
    caption: input.caption ?? null,
    latitude: input.metadata.latitude,
    longitude: input.metadata.longitude,
    addressSource: input.metadata.addressSource,
    takenAt: input.metadata.takenAt,
  };
}

export async function uploadSessionPhoto(input: {
  dealId: string;
  file: File;
  category: string | null;
  caption?: string | null;
  metadata: PhotoMetadata;
}) {
  const compressed = await compressForUpload(input.file);
  const upload = await api<{
    uploadUrl: string;
    objectKey: string;
    uploadToken: string;
  }>("/field/photos/upload-url", {
    method: "POST",
    json: {
      dealId: input.dealId,
      contentType: compressed.type || "image/jpeg",
      sizeBytes: compressed.size,
      category: input.category,
      caption: input.caption ?? null,
    },
  });

  const put = await fetch(upload.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": compressed.type || "image/jpeg" },
    body: compressed,
  });
  if (!put.ok) throw new Error("Upload to storage failed");

  return api("/field/photos/confirm-upload", {
    method: "POST",
    json: buildUploadMetadata({
      dealId: input.dealId,
      objectKey: upload.objectKey,
      uploadToken: upload.uploadToken,
      category: input.category,
      caption: input.caption,
      metadata: input.metadata,
    }),
  });
}

export async function runConcurrentUploads<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let nextIndex = 0;
  async function runNext() {
    const index = nextIndex++;
    if (index >= items.length) return;
    try {
      results[index] = { status: "fulfilled", value: await worker(items[index], index) };
    } catch (err) {
      results[index] = { status: "rejected", reason: err };
    }
    await runNext();
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runNext));
  return results;
}
