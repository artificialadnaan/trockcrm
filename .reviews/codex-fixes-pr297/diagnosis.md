# Diagnosis: PR #297 Photo Previewability Findings

## Scope

This hotfix targets the three new PR #297 findings only:

- `client/src/lib/photo-url-resolution.ts`
- `server/src/modules/public-photo-tokens/service.ts`
- `client/src/components/photos/photo-lightbox.tsx`

The PR #294 findings are intentionally out of scope because `fix/codex-findings-pr293-294` is already handling them.

## 297-1: Client Previewability Inference Order

`isPhotoImagePreviewable` first honors explicit `mimeType`, then explicit `fileExtension`, then infers an extension with:

```ts
firstKnownExtension(photo.displayName, photo.r2Key, photo.externalThumbnailUrl, photo.externalUrl)
```

The inferred-extension branch is wrong because `displayName` is a user-facing label and can be renamed independently of the stored object. A photo record with `displayName="plan.pdf"` and `r2Key=".../photo.jpg"` is classified as non-previewable, so the Photos tab and feed skip thumbnail URL resolution even though the stored file is a real image.

Correct precedence: use authoritative storage/source paths first, and user-facing display name only as the last fallback.

## 297-2: Public Viewer Inference Order

`server/src/modules/public-photo-tokens/service.ts` has a local copy of the same helper logic in `isPublicPhotoImagePreviewable`, including the same `displayName`-first inferred-extension order. That causes tokenized public photo responses to return `imageUrl: null` for renamed image records.

Given the current client/server split and the go-live window, this PR keeps the local server helper and applies the same precedence there with a maintenance comment. Extracting a shared helper can be done later if the repo already has a browser/server-safe shared utility convention for this path.

## 297-3: Lightbox Download URL Resolution

`PhotoLightbox` currently exits early when `isPhotoImagePreviewable(photo)` is false:

```ts
if (!isPhotoImagePreviewable(photo)) {
  setLoadingUrl(false);
  return;
}
```

That prevents `fullResUrl` from being resolved for PDFs and other non-image records. The Download button is disabled by `disabled={!fullResUrl}`, so non-image files opened in the lightbox cannot be downloaded.

Correct behavior: always resolve the file URL for download/open purposes. Only the preview rendering should be gated by `isPhotoImagePreviewable`. Non-images should show the existing no-preview/file placeholder while keeping Download enabled once a URL is resolved.

## Assumptions

- `mimeType` and explicit `fileExtension` remain higher priority than path inference because they are canonical metadata when present.
- For inferred extensions only, storage source beats user label: `r2Key`, `externalThumbnailUrl`, `externalUrl`, then `displayName`.
- Non-image lightbox records may still use `/files/:id/download?preview=1` for initial URL resolution; `handleDownload` already requests `/files/:id/download` before launching the download.
