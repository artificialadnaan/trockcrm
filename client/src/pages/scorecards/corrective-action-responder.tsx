import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { CheckCircle2, Loader2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  useCorrectiveActions,
  submitCorrectiveActionResponse,
  uploadCorrectiveActionPhoto,
  discardCorrectiveActionPhoto,
  type CorrectiveActionItem,
} from "@/hooks/use-corrective-actions";

// Public, token-authed responder page (spec §7.2). Reached from the corrective-action notification email as
// `/scorecards/:id/corrective-action?token=…`. NO session required — the recipient-bound token in the query
// authorizes every read/write. An email-only superintendent/PM documents the corrective action per flagged
// item (photos + comment); each submit resolves that item, auto-closing the scorecard on the last one.

interface PendingPhoto {
  fileId: string;
  previewUrl: string;
}

// The server rejects a response with more than this many photos (corrective-action-routes.ts parsePhotoFileIds:
// "At most 50 photos can be attached to a response"). Cap the COMBINED selection here BEFORE uploading so the
// recipient never uploads (potentially >1GB across) files + creates gallery rows only for the POST to 400.
const MAX_RESPONSE_PHOTOS = 50;

export default function CorrectiveActionResponderPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? undefined;

  const { items, loading, error, errorStatus, refetch } = useCorrectiveActions(id, token);

  const openCount = useMemo(() => items.filter((i) => i.status !== "resolved").length, [items]);
  const allResolved = items.length > 0 && openCount === 0;

  // A missing token is as unusable as an expired one — the server would 401 anyway; short-circuit with the
  // same clear message so the recipient knows to use the link from their email.
  if (!token) {
    return <ExpiredState />;
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-500">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading corrective actions…
      </div>
    );
  }

  // Distinguish an EXPIRED LINK from a transient LOAD FAILURE. Only a confirmed 401/403 (invalid / expired /
  // foreign token) means the link itself is unusable — show the "link expired" state with no retry. Any other
  // failure (network drop, 5xx, non-JSON body → null status) is transient, so offer a retry instead of a
  // misleading "expired" message.
  if (error) {
    if (errorStatus === 401 || errorStatus === 403) {
      return <ExpiredState detail={error} />;
    }
    return <LoadErrorState detail={error} onRetry={() => void refetch()} />;
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b border-slate-200 bg-white px-4 py-5 sm:px-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-red">T Rock · Corrective Action</p>
        <h1 className="mt-1 text-2xl font-semibold">Document the corrective actions</h1>
        <p className="mt-1 text-sm text-slate-600">
          Add a photo and a short note for each flagged item below. Once every item has a response, this
          scorecard is automatically marked resolved.
        </p>
        <p className="mt-2 text-sm font-medium text-slate-700">
          {items.length - openCount} of {items.length} resolved
        </p>
      </header>

      <div className="mx-auto max-w-2xl space-y-4 px-4 py-6 sm:px-6">
        {allResolved && (
          <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-800">
            <CheckCircle2 className="h-6 w-6 shrink-0" />
            <div>
              <p className="font-semibold">All corrective actions complete</p>
              <p className="text-sm">Thank you — this scorecard has been marked resolved.</p>
            </div>
          </div>
        )}

        {items.map((item) => (
          <ItemCard
            key={item.id}
            scorecardId={id!}
            token={token}
            item={item}
            onResolved={() => void refetch()}
          />
        ))}
      </div>
    </main>
  );
}

function ExpiredState({ detail }: { detail?: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6 text-center">
      <div>
        <p className="text-sm font-semibold uppercase tracking-wide text-red-700">Link unavailable</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-950">This corrective-action link has expired.</h1>
        <p className="mt-2 text-sm text-slate-600">
          {detail ?? "The link is invalid or has expired. Please contact T Rock for a new link."}
        </p>
      </div>
    </div>
  );
}

// A transient load failure (network / 5xx) — NOT an expired link. Offer a retry so the recipient isn't
// misled into thinking a valid link has expired.
function LoadErrorState({ detail, onRetry }: { detail?: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6 text-center">
      <div>
        <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">Couldn’t load</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-950">We couldn’t load the corrective actions.</h1>
        <p className="mt-2 text-sm text-slate-600">
          {detail ?? "Something went wrong. Check your connection and try again."}
        </p>
        <Button className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  );
}

function ItemCard({
  scorecardId,
  token,
  item,
  onResolved,
}: {
  scorecardId: string;
  token: string;
  item: CorrectiveActionItem;
  onResolved: () => void;
}) {
  const [comment, setComment] = useState("");
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Track every object URL we allocate so each is revoked EXACTLY once — on removal or on unmount. A blob URL
  // that outlives its <img> leaks memory until the tab closes; the responder page can accumulate many.
  const previewUrlsRef = useRef<Set<string>>(new Set());
  // Track fileIds that were uploaded (a persistent files row was created on the deal) but NOT yet submitted
  // as a response. Selecting a photo eagerly uploads+confirms, so a removed-before-submit or abandoned photo
  // must be discarded server-side or it becomes a permanent, unattached file in the project gallery. Cleared
  // on a successful submit (those photos are now legitimate response evidence — never delete them).
  const pendingFileIdsRef = useRef<Set<string>>(new Set());
  // Keep the latest scorecardId/token available to the unmount-only cleanup effect (empty deps) so it can
  // discard still-pending uploads without re-subscribing on every prop identity change.
  const discardArgsRef = useRef({ scorecardId, token });
  discardArgsRef.current = { scorecardId, token };

  const isResolved = item.status === "resolved";

  const onPickFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      // Cap the COMBINED selection (already-selected + newly-picked) at the server limit BEFORE uploading —
      // the multi-file picker is unrestricted, so without this a 51+ selection uploads every file (and
      // creates a gallery row per file) only for the response POST to be rejected. Truncate the overflow and
      // tell the recipient rather than silently dropping or wasting the upload.
      const remaining = MAX_RESPONSE_PHOTOS - photos.length;
      if (remaining <= 0) {
        setSubmitError(`You can attach at most ${MAX_RESPONSE_PHOTOS} photos to a response.`);
        return;
      }
      const picked = Array.from(files);
      const accepted = picked.slice(0, remaining);
      const overflow = picked.length - accepted.length;
      setUploading(true);
      setSubmitError(
        overflow > 0
          ? `Only ${accepted.length} of the ${picked.length} selected photos were added — a response can hold at most ${MAX_RESPONSE_PHOTOS}.`
          : null,
      );
      try {
        for (const file of accepted) {
          const fileId = await uploadCorrectiveActionPhoto(scorecardId, file, token);
          // Mark it pending-discard-on-cleanup the instant it's confirmed (a persistent files row now exists).
          pendingFileIdsRef.current.add(fileId);
          const previewUrl = URL.createObjectURL(file);
          previewUrlsRef.current.add(previewUrl);
          setPhotos((prev) => [...prev, { fileId, previewUrl }]);
        }
      } catch (e) {
        setSubmitError(e instanceof Error ? e.message : "Photo upload failed. Please try again.");
      } finally {
        setUploading(false);
      }
    },
    [scorecardId, token, photos.length],
  );

  const removePhoto = useCallback(
    (fileId: string) => {
      // Best-effort server-side discard of the orphaned upload (a persistent files row was created on select).
      // Fire-and-forget: the UI drops the photo immediately regardless of the delete outcome (an already-
      // submitted photo would 409/404, but a pending one never has been submitted here).
      if (pendingFileIdsRef.current.delete(fileId)) {
        void discardCorrectiveActionPhoto(scorecardId, fileId, token).catch(() => {});
      }
      setPhotos((prev) => {
        const removed = prev.find((p) => p.fileId === fileId);
        if (removed && previewUrlsRef.current.delete(removed.previewUrl)) {
          URL.revokeObjectURL(removed.previewUrl);
        }
        return prev.filter((p) => p.fileId !== fileId);
      });
    },
    [scorecardId, token],
  );

  // On unmount (page nav / abandon / refresh via component teardown): revoke any still-allocated preview URLs
  // AND best-effort discard any uploaded-but-un-submitted photos so an abandoned upload doesn't linger as a
  // permanent, unattached file in the project gallery. Runs once on unmount; per-photo removals already
  // revoke + discard eagerly above, and a successful submit clears the pending set (never discard submitted
  // evidence). Note: an item resolving re-renders under the SAME key (no unmount), so submit clears the set
  // itself — this teardown only fires on a real unmount.
  useEffect(() => {
    const urls = previewUrlsRef.current;
    const pending = pendingFileIdsRef.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
      const { scorecardId: sid, token: tok } = discardArgsRef.current;
      for (const fileId of pending) {
        void discardCorrectiveActionPhoto(sid, fileId, tok).catch(() => {});
      }
      pending.clear();
    };
  }, []);

  const submit = useCallback(async () => {
    if (!comment.trim()) {
      setSubmitError("A short note is required.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await submitCorrectiveActionResponse(
        scorecardId,
        item.id,
        { comment: comment.trim(), photoFileIds: photos.map((p) => p.fileId) },
        token,
      );
      // Revoke every pending preview URL NOW, on success. onResolved() refetches THIS item under the same
      // React key, so the card re-renders into its resolved (read-only) branch WITHOUT unmounting — the
      // unmount cleanup below never runs, and each blob URL would stay pinned until the tab closes. Clearing
      // the Set here also means that cleanup can't double-revoke if the card later does unmount.
      for (const url of previewUrlsRef.current) URL.revokeObjectURL(url);
      previewUrlsRef.current.clear();
      // These photos are now legitimate response evidence — drop them from the pending-discard set so the
      // unmount cleanup (and any later remove) never deletes a submitted photo.
      pendingFileIdsRef.current.clear();
      setPhotos([]);
      onResolved();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Couldn’t submit the response. Please try again.");
      setSubmitting(false);
    }
  }, [comment, photos, scorecardId, item.id, token, onResolved]);

  const atCap = photos.length >= MAX_RESPONSE_PHOTOS;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
            {item.itemType === "critical_deficiency" ? "Critical deficiency" : "Action item"}
          </p>
          <p className="mt-0.5 text-sm font-semibold text-slate-900">{item.itemLabel}</p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
            isResolved
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-amber-200 bg-amber-50 text-amber-700"
          }`}
        >
          {isResolved ? "Resolved" : "Open"}
        </span>
      </div>

      {isResolved ? (
        <div className="mt-3 border-l-2 border-slate-200 pl-3">
          <p className="text-xs text-slate-500">
            {item.responderName ?? item.responderEmail ?? "Responder"}
            {item.respondedAt ? ` · ${new Date(item.respondedAt).toLocaleDateString()}` : ""}
          </p>
          {item.responseComment && <p className="mt-1 text-sm text-slate-900">{item.responseComment}</p>}
          {item.photos.length > 0 && (
            <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {item.photos.map((p) =>
                p.url ? (
                  <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer">
                    <img
                      src={p.url}
                      alt="Corrective action"
                      className="aspect-square w-full rounded-md object-cover ring-1 ring-slate-200"
                    />
                  </a>
                ) : null,
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Describe the corrective action taken…"
            rows={3}
          />

          {photos.length > 0 && (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {photos.map((p) => (
                <div key={p.fileId} className="relative">
                  <img
                    src={p.previewUrl}
                    alt="Selected"
                    className="aspect-square w-full rounded-md object-cover ring-1 ring-slate-200"
                  />
                  <button
                    type="button"
                    onClick={() => removePhoto(p.fileId)}
                    aria-label="Remove photo"
                    className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <label
              className={`inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-[13px] font-semibold text-slate-700 ${
                atCap || uploading || submitting
                  ? "cursor-not-allowed opacity-50"
                  : "cursor-pointer hover:border-slate-300"
              }`}
            >
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {atCap ? `Photo limit reached (${MAX_RESPONSE_PHOTOS})` : "Add photo"}
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                disabled={uploading || submitting || atCap}
                onChange={(e) => void onPickFiles(e.target.files)}
              />
            </label>
            <Button onClick={() => void submit()} disabled={submitting || uploading}>
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Submit response
            </Button>
          </div>

          {submitError && <p className="text-sm text-brand-red">{submitError}</p>}
        </div>
      )}
    </div>
  );
}
