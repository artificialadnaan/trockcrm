import { shouldLoadNextPage } from "../paging";

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
