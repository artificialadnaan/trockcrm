import { useCallback, useEffect, useRef, useState } from "react";
import { api, isApiError } from "@/lib/api";

// ── Types (mirror the server corrective-action-api.ts CorrectiveActionItemView shape) ─────────────────
export interface CorrectiveActionResponsePhoto {
  id: string;
  fileId: string;
  clientUploadId: string | null;
  caption: string | null;
  // The Plan 2 read endpoint returns fileId only (no presigned URL). `url` is optional so a future
  // URL-resolving variant can populate it; the responder page renders a thumbnail only when present.
  url?: string | null;
}

export interface CorrectiveActionItem {
  id: string;
  itemType: string;
  itemRef: string;
  itemLabel: string;
  status: string;
  responseComment: string | null;
  respondedByUserId: string | null;
  responderName: string | null;
  responderEmail: string | null;
  respondedAt: string | null;
  photos: CorrectiveActionResponsePhoto[];
}

interface CorrectiveActionsResponse {
  items: CorrectiveActionItem[];
}

// The corrective-action endpoints live on the FIELD router (/field/scorecards/:id/corrective-actions). They
// accept EITHER a CRM/field session OR a recipient-bound `?token` (the email-only web responder has no
// session). `withToken` appends the token as a query param so a logged-out recipient can reach the route.
function withToken(path: string, token?: string): string {
  if (!token) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}token=${encodeURIComponent(token)}`;
}

// A token responder may open the public page in a browser that ALSO holds a CRM auth cookie. The global CSRF
// middleware then treats an unsafe /api/field/* request as a field-app request and demands the field header
// (`x-requested-with: XMLHttpRequest`) — the CRM double-submit header alone is rejected, so a valid token
// could READ but not POST/upload. Send the field header ONLY for token-mode writes; session (non-token) calls
// stay unchanged.
function tokenFieldCsrf(token?: string): { fieldCsrf: true } | Record<string, never> {
  return token ? { fieldCsrf: true } : {};
}

/** Read a scorecard's corrective-action items + their inline responses. Session mode omits the token. */
export async function getCorrectiveActions(scorecardId: string, token?: string): Promise<CorrectiveActionItem[]> {
  const res = await api<CorrectiveActionsResponse>(
    withToken(`/field/scorecards/${scorecardId}/corrective-actions`, token),
  );
  return res.items;
}

/**
 * Submit a per-item response (comment + already-uploaded response-photo file ids). Marks the item resolved,
 * auto-closes the scorecard on the last open item. Returns the refreshed item list.
 */
export async function submitCorrectiveActionResponse(
  scorecardId: string,
  itemId: string,
  body: { comment: string; photoFileIds?: string[] },
  token?: string,
): Promise<CorrectiveActionItem[]> {
  // Omit photoFileIds entirely when absent so a comment-only response sends a minimal body.
  const json = body.photoFileIds && body.photoFileIds.length > 0
    ? { comment: body.comment, photoFileIds: body.photoFileIds }
    : { comment: body.comment };
  const res = await api<CorrectiveActionsResponse>(
    withToken(`/field/scorecards/${scorecardId}/corrective-actions/${itemId}`, token),
    { method: "POST", json, ...tokenFieldCsrf(token) },
  );
  return res.items;
}

export interface CorrectiveActionUploadUrl {
  uploadUrl: string;
  objectKey: string;
  uploadToken: string;
  expiresIn: number;
}

/** Step 1 (presign) of the token-scoped response-photo upload. */
export async function requestCorrectiveActionUploadUrl(
  scorecardId: string,
  body: { contentType: string; sizeBytes: number },
  token?: string,
): Promise<CorrectiveActionUploadUrl> {
  return api<CorrectiveActionUploadUrl>(
    withToken(`/field/scorecards/${scorecardId}/corrective-actions/upload/url`, token),
    { method: "POST", json: { contentType: body.contentType, sizeBytes: body.sizeBytes }, ...tokenFieldCsrf(token) },
  );
}

/** Step 2 (confirm) of the token-scoped response-photo upload — returns the fresh { fileId }. */
export async function confirmCorrectiveActionUpload(
  scorecardId: string,
  body: { uploadToken: string; objectKey: string },
  token?: string,
): Promise<{ fileId: string }> {
  return api<{ fileId: string }>(
    withToken(`/field/scorecards/${scorecardId}/corrective-actions/upload`, token),
    { method: "POST", json: { uploadToken: body.uploadToken, objectKey: body.objectKey }, ...tokenFieldCsrf(token) },
  );
}

/**
 * PUT the file to the presigned R2 URL between the presign + confirm steps. In dev the presign returns the
 * `/api/files/dev-upload` mock endpoint (same-origin); everything else is a plain R2 PUT.
 */
async function putToSignedUrl(file: File, uploadUrl: string, mimeType: string): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": mimeType },
    body: file,
  });
  if (!res.ok) {
    throw new Error(`Storage upload failed with status ${res.status}`);
  }
}

/**
 * Upload a response photo end-to-end: presign → PUT to R2 → confirm → { fileId }. The returned fileId is the
 * value to pass in submitCorrectiveActionResponse's photoFileIds. Passes the recipient token through when the
 * responder is email-only (no session).
 */
export async function uploadCorrectiveActionPhoto(
  scorecardId: string,
  file: File,
  token?: string,
): Promise<string> {
  const mimeType = file.type || "image/jpeg";
  const presign = await requestCorrectiveActionUploadUrl(
    scorecardId,
    { contentType: mimeType, sizeBytes: file.size },
    token,
  );
  await putToSignedUrl(file, presign.uploadUrl, mimeType);
  const { fileId } = await confirmCorrectiveActionUpload(
    scorecardId,
    { uploadToken: presign.uploadToken, objectKey: presign.objectKey },
    token,
  );
  return fileId;
}

export interface UseCorrectiveActions {
  items: CorrectiveActionItem[];
  loading: boolean;
  error: string | null;
  /**
   * The HTTP status of the load failure, when the error came from an ApiError (null otherwise — e.g. a
   * network failure or a non-JSON body). The responder page branches on this: ONLY a confirmed 401/403 is
   * a genuinely-expired/foreign link (show the ExpiredState); any other failure (network / 5xx / undefined
   * status) is retryable.
   */
  errorStatus: number | null;
  refetch: () => Promise<void>;
}

/**
 * Load a scorecard's corrective-action items. Works in BOTH modes: a CRM/field session (no token), or the
 * email-only web responder (pass the recipient-bound token). A 401/403 (invalid/expired/foreign token)
 * surfaces as `error` + `errorStatus` with an empty `items` so the responder page can show a clear "link
 * expired" state; other failures surface a null `errorStatus` so the page can offer a retry instead.
 */
export function useCorrectiveActions(scorecardId: string | undefined, token?: string): UseCorrectiveActions {
  const [items, setItems] = useState<CorrectiveActionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const requestIdRef = useRef(0);

  const refetch = useCallback(async () => {
    if (!scorecardId) return;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    setErrorStatus(null);
    try {
      const loaded = await getCorrectiveActions(scorecardId, token);
      if (requestId !== requestIdRef.current) return;
      setItems(loaded);
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      setError(e instanceof Error ? e.message : "Failed to load corrective actions");
      // Carry the HTTP status ONLY when it came from the api() wrapper's ApiError — a network/non-JSON
      // failure has no status and must stay retryable (null), not read as an expired link.
      setErrorStatus(isApiError(e) ? e.status : null);
      setItems([]);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [scorecardId, token]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { items, loading, error, errorStatus, refetch };
}
