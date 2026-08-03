import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

/**
 * The AI-walk read for one deal: every glasses walk filed against it, each carrying whatever scope TROCK
 * Scope has extracted, or the reason it cannot be shown. Hand-rolled in the style of `useDealScorecards`,
 * because this app has no react-query — every deal-tab read in here is a `useState` + `useEffect` pair, and
 * introducing a second data-fetching model for one panel would be a worse cost than the duplication.
 *
 * WHY THE TYPES ARE DECLARED HERE rather than imported. The server's copies live in
 * `server/src/modules/walkthrough-capture/glasses-walkthrough-scope-service.ts`, which the client cannot
 * import — different workspace, server-only dependencies. `shared/` is where a single definition would
 * belong, and moving them there means editing the already-finished server half, so this mirrors the wire
 * shape instead, exactly as `FileRecord` and `Activity` do for their endpoints. The one rule that keeps the
 * duplication honest: this file describes the JSON, not the database, so it must change when and only when
 * `GET /api/deals/:id/glasses-walkthroughs` changes.
 */
export type GlassesWalkthroughState = "processing" | "ready" | "unavailable" | "missing" | "failed";

export interface GlassesWalkthroughScopeItem {
  id: string;
  /** The human work-type code (e.g. "PAINT-WALL"). NULL FOR EVERY ITEM TODAY: TROCK Scope's scope-items
   *  read returns `workTypeId` (a uuid FK into its catalog) and not the code, and the server deliberately
   *  refuses to fall back to the uuid rather than print one in a column labelled as a code. Rendered only
   *  when present, so the panel is already correct on the day that service starts sending it. */
  workTypeCode: string | null;
  description: string;
  trade: string | null;
  quantity: number | null;
  unit: string | null;
  /** 0–1, or null for "TROCK Scope did not score this item" — which is NOT the same as a low score. */
  confidence: number | null;
}

export interface GlassesWalkthrough {
  /** The CRM's own `glasses_walkthroughs.id`, not TROCK Scope's. Stable across polls; the list keys on it. */
  id: string;
  walkId: string;
  scopeWalkthroughId: string | null;
  capturedAt: string;
  capturedByUserId: string | null;
  /**
   * What the panel is allowed to claim about this walk:
   *   processing   the forward has not confirmed a remote walkthrough yet. No scope, and none was asked for.
   *   ready        TROCK Scope answered; `scope.items` is what it holds, legitimately possibly empty.
   *   unavailable  we could not read — outage, refused credential, timeout. Says NOTHING about whether a
   *                scope exists, which is why this state gets a retry and `missing` does not.
   *   missing      TROCK Scope answered 404 for this walkthrough. The one negative claim in the list.
   *   failed       TROCK Scope's extraction DIED. Terminal, but not a result — reported as ready-and-
   *                empty it would read as "processed, found nothing", and the scope that was in the
   *                narration would simply never be bid.
   */
  state: GlassesWalkthroughState;
  scope: { status: "ready"; items: GlassesWalkthroughScopeItem[] } | null;
}

export function useDealGlassesWalkthroughs(dealId: string) {
  /**
   * The walks AND the deal they belong to, stored as ONE value.
   *
   * Kept together rather than as a separate array and marker because the two drifting apart is the actual
   * defect, not a hypothetical one: with `walkthroughs` in its own state, nothing cleared it when `dealId`
   * changed, and the failure stamp below marked the new deal as loaded while the array still held the old
   * deal's walks. One click of "Try again" then cleared the error and met the panel's render condition —
   * deal A's site visit, dated and captioned, on deal B's scoping tab, under a heading that says "of this
   * project". Verified in a DOM probe against the real hook, not reasoned about.
   *
   * As one value the mismatch is unrepresentable: the array is only ever read back when the deal it was
   * fetched for is still the deal being asked about.
   */
  const [loaded, setLoaded] = useState<{ dealId: string; items: GlassesWalkthrough[] } | null>(null);
  /**
   * Belongs to THIS deal, or nothing at all.
   *
   * Deliberately not cleared on a refetch of the SAME deal — the panel keeps the walks an estimator is
   * reading visible while a retry is in flight, which has its own test.
   */
  const walkthroughs = loaded?.dealId === dealId ? loaded.items : [];
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /**
   * Which deal the state above actually describes.
   *
   * A plain `hasLoaded` boolean is not enough, and the difference is a cross-deal data leak rather than a
   * nicety. This hook is mounted by DealScopingWorkspace, which is NOT remounted when the user navigates
   * from one deal to another — only `dealId` changes. A boolean that has already been flipped stays flipped,
   * so between the navigation and the new response landing, the panel would render deal A's walks, dated and
   * captioned, on deal B's scoping tab. Nothing on screen would say they belonged to another project.
   *
   * Comparing against `dealId` makes the answer expire the instant the prop changes, so the panel goes back
   * to rendering nothing until deal B's own answer arrives.
   */
  const [loadedDealId, setLoadedDealId] = useState<string | null>(null);
  /**
   * The generation of the in-flight read, so a slow answer cannot overwrite a newer one.
   *
   * Two reads are genuinely in flight together whenever a user opens a deal and clicks away before it
   * answers, and the server's read has a 5s ceiling — long enough for that to be ordinary rather than
   * exotic. Without this, deal A's late response resolves after deal B's and wins, leaving deal B's panel
   * showing A's walks with `loadedDealId` claiming they are B's. Same guard, and same reason, as
   * `loadRequestIdRef` in deal-scoping-workspace.tsx.
   */
  const loadRequestIdRef = useRef(0);

  // Distinct from `!loading`, and the panel depends on the difference. `loading` goes true again on every
  // retry, and a panel keyed on it would blank out the walks the estimator is reading mid-refresh. This
  // answers the narrower question "has THIS deal's answer arrived yet", which is what decides whether the
  // panel may render nothing at all (the common case: most deals have no glasses walk).
  const hasLoaded = loadedDealId === dealId;

  const refetch = useCallback(async () => {
    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ walkthroughs: GlassesWalkthrough[] }>(`/deals/${dealId}/glasses-walkthroughs`);
      if (requestId !== loadRequestIdRef.current) return;
      setLoaded({ dealId, items: data.walkthroughs ?? [] });
    } catch (e) {
      if (requestId !== loadRequestIdRef.current) return;
      setError(e instanceof Error ? e.message : "Failed to load AI walks");
    } finally {
      if (requestId === loadRequestIdRef.current) {
        // Stamped even on failure: the request HAS resolved, and the panel needs to know that so it can
        // render its own error line. Leaving it unstamped would make a permanently failing endpoint
        // indistinguishable from a request still in flight, and the panel would stay silently absent forever.
        setLoadedDealId(dealId);
        setLoading(false);
      }
    }
  }, [dealId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { walkthroughs, loading, hasLoaded, error, refetch };
}
