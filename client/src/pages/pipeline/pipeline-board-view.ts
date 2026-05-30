import type { PipelineScope } from "@/lib/pipeline-scope";

export interface PipelineBoardViewInput {
  /** Has a board EVER been successfully loaded (the columns state is seeded to [], so it cannot itself signal this). */
  hasLoaded: boolean;
  /** The scope the loaded board was fetched for (null before the first load). */
  loadedScope: PipelineScope | null;
  /** The Show-DD state the loaded board was fetched for -- affects which columns the API returns (null before the first load). */
  loadedShowDd: boolean | null;
  /** The currently-selected scope. */
  scope: PipelineScope;
  /** The currently-selected Show-DD state. */
  showDd: boolean;
  /** Whether a fetch is currently in flight. */
  loading: boolean;
  /** The current error, if the last fetch failed. */
  error: string | null;
}

export interface PipelineBoardView {
  /** True when the loaded board matches the CURRENT request identity (scope + Show-DD). */
  hasCurrentBoard: boolean;
  /** True when the page should render the skeleton instead of a board. */
  showSkeleton: boolean;
  /** True when a board is on screen but a same-identity refetch is in flight (show an "Updating..." hint). */
  isRefreshing: boolean;
}

/**
 * Decides what the pipeline page should render: skeleton, the live board, or the board with
 * an "Updating..." hint. Pure so the timing-sensitive cases can be tested directly.
 *
 * The board is kept visible (no blank) ONLY on a SAME-IDENTITY refetch (e.g. a Won/Lost
 * date-filter pinch). A scope OR Show-DD change is a different request identity (both change
 * which columns the API returns, and the board is interactive), so it must show the skeleton,
 * never a stale cross-identity board.
 *
 * CRUCIAL: `showSkeleton` is NOT gated on `loading`. The scope/Show-DD state updates one
 * render BEFORE the fetch effect runs `setLoading(true)`. On that intermediate render the
 * identity has already changed (`hasCurrentBoard` is false) but `loading` is still false, so a
 * `loading && !hasCurrentBoard` gate would fall through and paint the stale previous-identity
 * board for one frame -- the exact flash this guards against. Keying on `hasCurrentBoard` alone
 * (still deferring to a present error so the error UI stays reachable) closes that window.
 */
export function derivePipelineBoardView(input: PipelineBoardViewInput): PipelineBoardView {
  const hasCurrentBoard =
    input.hasLoaded && input.loadedScope === input.scope && input.loadedShowDd === input.showDd;
  const showSkeleton = !hasCurrentBoard && !input.error;
  const isRefreshing = input.loading && hasCurrentBoard;
  return { hasCurrentBoard, showSkeleton, isRefreshing };
}
