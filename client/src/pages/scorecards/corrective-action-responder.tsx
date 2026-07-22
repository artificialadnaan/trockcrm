import { useCallback, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { CheckCircle2, Loader2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  useCorrectiveActions,
  submitCorrectiveActionResponse,
  uploadCorrectiveActionPhoto,
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

export default function CorrectiveActionResponderPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? undefined;

  const { items, loading, error, refetch } = useCorrectiveActions(id, token);

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

  // A 401/403 (invalid / expired / foreign token) surfaces as an error with empty items — show the clear
  // "link expired" state rather than an empty form.
  if (error) {
    return <ExpiredState detail={error} />;
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

  const isResolved = item.status === "resolved";

  const onPickFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setUploading(true);
      setSubmitError(null);
      try {
        for (const file of Array.from(files)) {
          const fileId = await uploadCorrectiveActionPhoto(scorecardId, file, token);
          setPhotos((prev) => [...prev, { fileId, previewUrl: URL.createObjectURL(file) }]);
        }
      } catch (e) {
        setSubmitError(e instanceof Error ? e.message : "Photo upload failed. Please try again.");
      } finally {
        setUploading(false);
      }
    },
    [scorecardId, token],
  );

  const removePhoto = useCallback((fileId: string) => {
    setPhotos((prev) => prev.filter((p) => p.fileId !== fileId));
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
      onResolved();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Couldn’t submit the response. Please try again.");
      setSubmitting(false);
    }
  }, [comment, photos, scorecardId, item.id, token, onResolved]);

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
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-[13px] font-semibold text-slate-700 hover:border-slate-300">
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Add photo
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                disabled={uploading || submitting}
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
