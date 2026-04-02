import { eq } from "drizzle-orm";
import { files } from "@trock-crm/shared/schema";
import exifr from "exifr";
import { pool } from "../db.js";
import { getObjectBuffer, isR2Configured } from "../lib/r2-client.js";

/**
 * EXIF-capable MIME types. Only these file types can contain EXIF metadata.
 */
const EXIF_MIME_TYPES = new Set([
  "image/jpeg",
  "image/heic",
  "image/heif",
  "image/webp",
]);

/**
 * Extract EXIF metadata from a photo file uploaded to R2.
 *
 * Called by the domain_event handler when a `file.uploaded` event fires
 * with category === 'photo'. Downloads the file from R2, parses EXIF data,
 * and updates the file record with takenAt, geoLat, geoLng.
 *
 * Non-blocking: logs errors but never throws, so it doesn't block the
 * rest of the upload flow.
 */
export async function extractExif(
  fileId: string,
  officeId: string | null,
  payload: {
    r2Key: string;
    mimeType: string;
    category: string;
  }
): Promise<void> {
  // Only process photo files with EXIF-capable MIME types
  if (payload.category !== "photo") return;
  if (!EXIF_MIME_TYPES.has(payload.mimeType)) return;

  if (!isR2Configured()) {
    console.log(`[EXIF] R2 not configured -- skipping EXIF extraction for ${fileId}`);
    return;
  }

  try {
    // Download the file from R2
    const buffer = await getObjectBuffer(payload.r2Key);
    if (!buffer) {
      console.error(`[EXIF] No body returned for ${payload.r2Key}`);
      return;
    }

    // Extract EXIF data using exifr
    const exif = await exifr.parse(buffer, {
      pick: ["DateTimeOriginal", "GPSLatitude", "GPSLongitude"],
      gps: true, // enables parsed GPS coordinates
    });

    if (!exif) {
      console.log(`[EXIF] No EXIF data found in ${payload.r2Key}`);
      return;
    }

    // Build update fields
    const updates: { takenAt?: Date; geoLat?: string; geoLng?: string } = {};

    if (exif.DateTimeOriginal instanceof Date) {
      updates.takenAt = exif.DateTimeOriginal;
    }

    // exifr with gps:true returns latitude/longitude as numbers
    if (typeof exif.latitude === "number" && typeof exif.longitude === "number") {
      updates.geoLat = String(exif.latitude);
      updates.geoLng = String(exif.longitude);
    }

    if (Object.keys(updates).length === 0) {
      console.log(`[EXIF] No usable EXIF fields in ${payload.r2Key}`);
      return;
    }

    // Resolve the office slug to build the schema name
    if (!officeId) {
      console.error(`[EXIF] No officeId for file ${fileId} -- cannot update tenant schema`);
      return;
    }

    const officeResult = await pool.query(
      "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
      [officeId]
    );
    if (officeResult.rows.length === 0) {
      console.error(`[EXIF] Office not found or inactive: ${officeId}`);
      return;
    }

    const slug = officeResult.rows[0].slug;
    const slugRegex = /^[a-z][a-z0-9_]*$/;
    if (!slugRegex.test(slug)) {
      console.error(`[EXIF] Invalid office slug: ${slug}`);
      return;
    }

    const schemaName = `office_${slug}`;

    // Fix 10: If we extracted a takenAt date, recompute the folder_path
    // so photos are bucketed by their actual date, not the upload time.
    // First, read the current folder_path from the file record.
    let newFolderPath: string | null = null;
    if (updates.takenAt) {
      const currentResult = await pool.query(
        `SELECT folder_path FROM ${schemaName}.files WHERE id = $1`,
        [fileId]
      );
      if (currentResult.rows.length > 0) {
        const currentFolderPath: string | null = currentResult.rows[0].folder_path;
        if (currentFolderPath) {
          const exifMonth = updates.takenAt.toISOString().slice(0, 7); // "YYYY-MM"
          // Replace the trailing YYYY-MM date bucket if present
          const updatedPath = currentFolderPath.replace(/\d{4}-\d{2}$/, exifMonth);
          if (updatedPath !== currentFolderPath) {
            newFolderPath = updatedPath;
          }
        }
      }
    }

    // Build dynamic UPDATE query
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (updates.takenAt) {
      setClauses.push(`taken_at = $${paramIdx++}`);
      values.push(updates.takenAt);
    }
    if (updates.geoLat) {
      setClauses.push(`geo_lat = $${paramIdx++}`);
      values.push(updates.geoLat);
    }
    if (updates.geoLng) {
      setClauses.push(`geo_lng = $${paramIdx++}`);
      values.push(updates.geoLng);
    }
    if (newFolderPath) {
      setClauses.push(`folder_path = $${paramIdx++}`);
      values.push(newFolderPath);
    }

    setClauses.push(`updated_at = NOW()`);

    values.push(fileId);

    await pool.query(
      `UPDATE ${schemaName}.files SET ${setClauses.join(", ")} WHERE id = $${paramIdx}`,
      values
    );

    console.log(
      `[EXIF] Updated file ${fileId}: takenAt=${updates.takenAt?.toISOString() ?? "n/a"}, ` +
      `geo=${updates.geoLat ?? "n/a"},${updates.geoLng ?? "n/a"}` +
      (newFolderPath ? `, folderPath=${newFolderPath}` : "")
    );
  } catch (err) {
    // EXIF extraction is non-blocking -- log and continue
    console.error(`[EXIF] Failed to extract EXIF from ${payload.r2Key}:`, err);
  }
}
