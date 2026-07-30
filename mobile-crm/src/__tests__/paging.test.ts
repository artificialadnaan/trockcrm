import { refreshFailed, shouldLoadNextPage } from "../paging";

const state = (over: Partial<Parameters<typeof shouldLoadNextPage>[0]> = {}) => ({
  hasNextPage: true,
  isFetchingNextPage: false,
  isFetchNextPageError: false,
  ...over,
});

describe("when an infinite list may ask for its next page", () => {
  it("loads when there is a page, nothing is in flight and nothing has failed", () => {
    expect(shouldLoadNextPage(state())).toBe(true);
  });

  it("does not load past the end", () => {
    expect(shouldLoadNextPage(state({ hasNextPage: false }))).toBe(false);
  });

  it("does not stack a second request on the one already in flight", () => {
    expect(shouldLoadNextPage(state({ isFetchingNextPage: true }))).toBe(false);
  });

  it("does not re-fire after a page failed", () => {
    // The clause that was missing. TanStack keeps hasNextPage true (the cursor still exists) and clears
    // isFetchingNextPage (nothing is in flight), so both obvious guards pass and every subsequent scroll
    // re-hits an endpoint that just errored — silently, for as long as the user keeps moving.
    expect(shouldLoadNextPage(state({ isFetchNextPageError: true }))).toBe(false);
  });

  it("stays stopped while the failure is still on screen, however the user scrolls", () => {
    // The retry belongs to the footer's tap, not to the scroll position.
    for (let scrollEvent = 0; scrollEvent < 20; scrollEvent += 1) {
      expect(shouldLoadNextPage(state({ isFetchNextPageError: true }))).toBe(false);
    }
  });

  it("resumes once a retry clears the error", () => {
    // fetchNextPage() from the footer clears isFetchNextPageError on success, and the automatic path
    // has to come back — otherwise one bad page disables paging for the rest of the session.
    expect(shouldLoadNextPage(state({ isFetchNextPageError: false }))).toBe(true);
  });
});

describe("telling a failed refresh apart from a failed page", () => {
  const q = (over: Partial<Parameters<typeof refreshFailed>[0]> = {}) => ({
    data: { pages: [] },
    isError: false,
    isFetchNextPageError: false,
    ...over,
  });

  it("reports a refresh failure when the refresh is what failed", () => {
    expect(refreshFailed(q({ isError: true }))).toBe(true);
  });

  it("does NOT report one when a page failed", () => {
    // The bug: TanStack sets isError AND isFetchNextPageError for a failed page, so a header derived
    // from `data && isError` announced "the refresh failed" on a list nobody had refreshed — beside a
    // footer that was already telling the truth.
    expect(refreshFailed(q({ isError: true, isFetchNextPageError: true }))).toBe(false);
  });

  it("stays quiet while everything is working", () => {
    expect(refreshFailed(q())).toBe(false);
  });

  it("says nothing before there is anything to be stale", () => {
    // With no data the screen shows a full-page retry instead; an inline "showing the last copy"
    // notice would be claiming a last copy that does not exist.
    expect(refreshFailed(q({ data: undefined, isError: true }))).toBe(false);
  });

  it("never lets ONE page failure produce both messages", () => {
    // The property that actually matters, stated precisely. A failed page must silence the header AND
    // stop the automatic retry — the footer is the only thing allowed to speak for it.
    const isFetchNextPageError = true;
    expect(refreshFailed({ data: {}, isError: true, isFetchNextPageError })).toBe(false);
    expect(shouldLoadNextPage({ hasNextPage: true, isFetchingNextPage: false, isFetchNextPageError }))
      .toBe(false);
  });

  it("still allows a failed REFRESH beside a next page that is fine", () => {
    // Not a contradiction and not a bug: page one failed to reload while the cursor is still good, so
    // the header explains the stale list and paging keeps working. Asserting these are mutually
    // exclusive would be asserting something false about the app.
    expect(refreshFailed({ data: {}, isError: true, isFetchNextPageError: false })).toBe(true);
    expect(
      shouldLoadNextPage({ hasNextPage: true, isFetchingNextPage: false, isFetchNextPageError: false })
    ).toBe(true);
  });
});
