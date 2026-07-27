import { resolveListState } from "../list-state";

/**
 * The state machine behind both list screens. This decision has been got wrong FOUR times in this app,
 * always in a way that LOOKED like success — which is why it now lives in one pure function with tests
 * rather than being re-derived inline on each screen.
 */
const base = {
  isLoading: false,
  data: undefined as unknown,
  error: undefined as unknown,
  rowCount: 0,
  isFetchNextPageError: false,
};

describe("resolveListState", () => {
  it("reports loading before anything resolves", () => {
    expect(resolveListState({ ...base, isLoading: true })).toEqual({ kind: "loading" });
  });

  it("blocks the screen only when nothing ever loaded", () => {
    expect(resolveListState({ ...base, error: new Error("offline") })).toEqual({
      kind: "blocking-error",
    });
  });

  it("does NOT block when a load succeeded and a later fetch failed", () => {
    // Bug #1: a failed refresh replaced a list the user was reading with a full-screen error.
    const state = resolveListState({ ...base, data: { pages: [] }, rowCount: 12, error: new Error("5xx") });
    expect(state.kind).toBe("loaded");
  });

  it("treats a loaded EMPTY result as loaded, not as never-loaded", () => {
    // Bug #2: keying on rowCount made "loaded, and empty" indistinguishable from "no data", so a failed
    // refresh on a legitimately empty scope replaced the real empty state with a blocking error.
    const state = resolveListState({ ...base, data: { pages: [] }, rowCount: 0, error: new Error("5xx") });
    expect(state).toEqual({ kind: "loaded", isEmpty: true, refreshFailed: true, pageFailed: false });
  });

  it("reports a refresh failure even with ZERO rows", () => {
    // Bug #3: the inline retry was gated on rowCount, so an empty result reported the failure NOWHERE —
    // no notice, no retry, just an empty message that looked authoritative.
    const state = resolveListState({ ...base, data: { pages: [] }, rowCount: 0, error: new Error("5xx") });
    expect(state.kind === "loaded" && state.refreshFailed).toBe(true);
  });

  it("separates a load-more failure from a refresh failure", () => {
    // Bug #4: both rendered in the footer, so a failed pull-to-refresh sat off-screen below a full page
    // and the refresh appeared to have worked. They need different placements, so they need to be
    // different facts.
    const page = resolveListState({
      ...base,
      data: { pages: [] },
      rowCount: 50,
      error: new Error("5xx"),
      isFetchNextPageError: true,
    });
    expect(page).toEqual({ kind: "loaded", isEmpty: false, refreshFailed: false, pageFailed: true });

    const refresh = resolveListState({
      ...base,
      data: { pages: [] },
      rowCount: 50,
      error: new Error("5xx"),
      isFetchNextPageError: false,
    });
    expect(refresh).toEqual({ kind: "loaded", isEmpty: false, refreshFailed: true, pageFailed: false });
  });

  it("reports neither failure on a clean loaded list", () => {
    expect(resolveListState({ ...base, data: { pages: [] }, rowCount: 3 })).toEqual({
      kind: "loaded",
      isEmpty: false,
      refreshFailed: false,
      pageFailed: false,
    });
  });

  it("prefers loading over everything, so a refetch spinner never flashes an error", () => {
    expect(resolveListState({ ...base, isLoading: true, error: new Error("x") })).toEqual({
      kind: "loading",
    });
  });

  it("treats an empty ARRAY as loaded — the distinction is undefined, not falsiness", () => {
    // `data: []` is falsy-adjacent enough to invite a truthiness check, which would reintroduce bug #2.
    const state = resolveListState({ ...base, data: [], rowCount: 0, error: new Error("5xx") });
    expect(state.kind).toBe("loaded");
  });
});
