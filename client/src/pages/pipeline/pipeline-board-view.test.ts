import { describe, expect, it } from "vitest";

import { derivePipelineBoardView } from "./pipeline-board-view";

// A board successfully loaded for scope "mine" with Show-DD off.
const LOADED = { hasLoaded: true, loadedScope: "mine", loadedShowDd: false } as const;

describe("derivePipelineBoardView", () => {
  it("shows the skeleton on first load (nothing loaded yet)", () => {
    const v = derivePipelineBoardView({
      hasLoaded: false,
      loadedScope: null,
      loadedShowDd: null,
      scope: "mine",
      showDd: false,
      loading: true,
      error: null,
    });
    expect(v.hasCurrentBoard).toBe(false);
    expect(v.showSkeleton).toBe(true);
    expect(v.isRefreshing).toBe(false);
  });

  it("shows the board (no skeleton, not refreshing) once the current-identity board is loaded", () => {
    const v = derivePipelineBoardView({ ...LOADED, scope: "mine", showDd: false, loading: false, error: null });
    expect(v.hasCurrentBoard).toBe(true);
    expect(v.showSkeleton).toBe(false);
    expect(v.isRefreshing).toBe(false);
  });

  it("keeps the board with an Updating hint on a SAME-identity refetch (date pinch), never a skeleton", () => {
    const v = derivePipelineBoardView({ ...LOADED, scope: "mine", showDd: false, loading: true, error: null });
    expect(v.hasCurrentBoard).toBe(true);
    expect(v.showSkeleton).toBe(false); // board stays -- no blank
    expect(v.isRefreshing).toBe(true); // "Updating..."
  });

  // The Codex-flagged gap: the intermediate render right after a Show-DD toggle, BEFORE the
  // fetch effect has run setLoading(true). The old gate (loading && !hasCurrentBoard) was
  // false here, so the stale old-DD board painted for one frame under the new Show-DD state.
  it("shows the skeleton on a Show-DD change even before loading flips (no stale-board flash)", () => {
    const v = derivePipelineBoardView({
      ...LOADED,
      scope: "mine",
      showDd: true, // toggled on
      loading: false, // fetch effect has NOT run yet -- the pre-loading intermediate render
      error: null,
    });
    expect(v.hasCurrentBoard).toBe(false); // loadedShowDd (false) !== showDd (true)
    expect(v.showSkeleton).toBe(true); // was false on the buggy gate -> stale board
    expect(v.isRefreshing).toBe(false);
  });

  it("shows the skeleton on a scope change even before loading flips (same pre-loading window)", () => {
    const v = derivePipelineBoardView({
      ...LOADED,
      scope: "all", // toggled
      showDd: false,
      loading: false, // pre-loading intermediate render
      error: null,
    });
    expect(v.hasCurrentBoard).toBe(false);
    expect(v.showSkeleton).toBe(true);
    expect(v.isRefreshing).toBe(false);
  });

  it("does NOT show the skeleton when a first load FAILED (so the error UI stays reachable)", () => {
    const v = derivePipelineBoardView({
      hasLoaded: false,
      loadedScope: null,
      loadedShowDd: null,
      scope: "mine",
      showDd: false,
      loading: false,
      error: "Failed to load pipeline data. Please try again.",
    });
    expect(v.hasCurrentBoard).toBe(false);
    expect(v.showSkeleton).toBe(false); // falls through to the error UI, not a permanent skeleton
    expect(v.isRefreshing).toBe(false);
  });

  it("does NOT show the skeleton when a refetch fails with a board already loaded", () => {
    const v = derivePipelineBoardView({ ...LOADED, scope: "mine", showDd: false, loading: false, error: "boom" });
    expect(v.hasCurrentBoard).toBe(true);
    expect(v.showSkeleton).toBe(false);
    expect(v.isRefreshing).toBe(false);
  });
});
