export type PhotoDownload = { id?: string; url: string; filename: string };

/**
 * Save one or more files to the user's computer via temporary `<a download>` elements.
 *
 * The server hands back presigned R2 URLs carrying `Content-Disposition: attachment`, so the browser saves
 * the FULL-RES original (with a real filename) even though the URL is cross-origin — no fetch/CORS needed.
 * Bulk downloads are staggered so the browser doesn't drop them as a single burst (it still shows its
 * one-time "allow multiple downloads" prompt, which is expected).
 */
export function triggerPhotoDownloads(downloads: PhotoDownload[], stepMs = 300): void {
  downloads
    .filter((download) => Boolean(download.url))
    .forEach((download, index) => {
      window.setTimeout(() => {
        const anchor = document.createElement("a");
        anchor.href = download.url;
        anchor.download = download.filename;
        anchor.rel = "noopener";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }, index * stepMs);
    });
}
