// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhotoFeedPage } from "./photo-feed-page";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ api: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: mocks.api }));

const ME = "user-me";
const SOMEONE_ELSE = "user-other";

function projectStat(input: { dealId: string; dealName: string; photoCount: number; assignedRepId: string | null }) {
  return {
    dealNumber: `TR-${input.dealId}`,
    propertyCity: "Dallas",
    propertyState: "TX",
    lastPhotoAt: "2026-07-01T00:00:00.000Z",
    recentUploaders: [],
    recentPhotoIds: [],
    recentPhotos: [],
    ...input,
  };
}

const PROJECTS = [
  projectStat({ dealId: "d1", dealName: "Mine Alpha", photoCount: 900, assignedRepId: ME }),
  projectStat({ dealId: "d2", dealName: "Theirs Beta", photoCount: 12, assignedRepId: SOMEONE_ELSE }),
];

/** Records the query string of every project-stats request so we can assert what the SERVER was asked. */
let projectStatsCalls: string[] = [];

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  projectStatsCalls = [];
  mocks.api.mockImplementation(async (path: string) => {
    if (path.startsWith("/files/photos/project-stats")) {
      projectStatsCalls.push(path);
      return { projects: PROJECTS, pagination: { limit: 100, total: PROJECTS.length, nextCursor: null } };
    }
    if (path.startsWith("/files/photos/feed/facets")) {
      return {
        uploaders: [{ id: "u1", name: "Alice Uploader" }],
        photoCategories: ["construction"],
        projects: [{ id: "d1", name: "Mine Alpha" }, { id: "d2", name: "Theirs Beta" }],
      };
    }
    if (path.startsWith("/files/photos/feed/count")) return { count: 0 };
    if (path.startsWith("/files/photos/feed")) {
      return { photos: [], pagination: { page: 1, limit: 40, total: 0, totalPages: 0 } };
    }
    return {};
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.clearAllMocks();
});

async function renderPage() {
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <PhotoFeedPage />
      </MemoryRouter>
    );
  });
  await act(async () => { await Promise.resolve(); });
}

function selectByLabel(label: string): HTMLSelectElement {
  const field = Array.from(container.querySelectorAll("label")).find((el) => el.textContent?.trim() === label);
  const select = field?.parentElement?.querySelector("select");
  if (!select) throw new Error(`No <select> found for label "${label}"`);
  return select as HTMLSelectElement;
}

async function changeSelect(select: HTMLSelectElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => { await Promise.resolve(); });
}

describe("PhotoFeedPage — Projects tab sorting", () => {
  it("sends the sort to the SERVER rather than reordering the rows it already has", async () => {
    await renderPage();
    await changeSelect(selectByLabel("Sort By"), "most_photos");

    // The load-bearing assertion. The endpoint pages, so a client-side sort would only reorder the page
    // the server already chose — "most photos" would silently mean "most-photographed of the most
    // recent page". Refetching is what makes the answer correct.
    expect(projectStatsCalls.some((path) => path.includes("sort=most_photos"))).toBe(true);
  });

  it("offers exactly the three sorts the data supports", async () => {
    await renderPage();
    const options = Array.from(selectByLabel("Sort By").options).map((option) => option.value);
    expect(options).toEqual(["recent", "most_photos", "least_photos"]);
  });

  it("defaults to most-recent, preserving the tab's previous behaviour", async () => {
    await renderPage();
    expect(selectByLabel("Sort By").value).toBe("recent");
    expect(projectStatsCalls[0]).toContain("sort=recent");
  });
});

describe("PhotoFeedPage — filters", () => {
  it("threads a filter to the project aggregate, not just the photo list", async () => {
    await renderPage();
    await changeSelect(selectByLabel("Uploaded By"), "u1");

    // Filter/count parity: if the uploader filter reached only the Photos tab, a project row would keep
    // claiming its unfiltered total (900) beside a filtered photo list showing a handful.
    expect(projectStatsCalls.some((path) => path.includes("uploadedBy=u1"))).toBe(true);
  });

  it("builds the uploader dropdown from the server facet, not from the loaded rows", async () => {
    await renderPage();
    // The rows carry no uploaders at all here. Deriving options from them (as the old dead
    // `allUploaders` memo did) would leave the dropdown empty.
    const options = Array.from(selectByLabel("Uploaded By").options).map((option) => option.textContent);
    expect(options).toContain("Alice Uploader");
  });

  it("offers Uncategorized, because most photos carry no phase", async () => {
    await renderPage();
    const options = Array.from(selectByLabel("Phase").options).map((option) => option.value);
    expect(options).toContain("uncategorized");
    expect(options).toContain("construction");
  });

  it("exposes source as a fixed two-value dimension", async () => {
    await renderPage();
    const options = Array.from(selectByLabel("Source").options).map((option) => option.value);
    expect(options).toEqual(["", "companycam", "trock"]);
  });
});

describe("PhotoFeedPage — 'My Projects' pill", () => {
  it("asks the SERVER for the caller's projects instead of narrowing the loaded page", async () => {
    await renderPage();
    expect(projectStatsCalls.some((path) => path.includes("mine=1"))).toBe(false);

    const pill = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "My Projects");
    await act(async () => { pill!.click(); });
    await act(async () => { await Promise.resolve(); });

    // This pill was DEAD: `projectFilter` sat in the useMemo dependency array but was never applied in
    // the body, and the server returned no owner column to compare against. Filtering the loaded page
    // client-side would also have meant "the rep's projects among the top 100 by the current sort",
    // beside a header counting a different set.
    expect(projectStatsCalls.some((path) => path.includes("mine=1"))).toBe(true);
  });
});

describe("PhotoFeedPage — project paging", () => {
  it("appends the next page without duplicating a project that shifted across the boundary", async () => {
    const page1 = [projectStat({ dealId: "d1", dealName: "Alpha", photoCount: 9, assignedRepId: ME })];
    // OFFSET paging over a live aggregate: a photo uploaded between requests pushes Alpha into page 2
    // as well. A duplicate React key crashes the render, so the append has to dedupe.
    const page2 = [
      projectStat({ dealId: "d1", dealName: "Alpha", photoCount: 9, assignedRepId: ME }),
      projectStat({ dealId: "d2", dealName: "Beta", photoCount: 4, assignedRepId: ME }),
    ];
    mocks.api.mockImplementation(async (path: string) => {
      if (path.startsWith("/files/photos/project-stats")) {
        projectStatsCalls.push(path);
        const isPage2 = path.includes("cursor=");
        return {
          projects: isPage2 ? page2 : page1,
          pagination: { limit: 100, total: 2, nextCursor: isPage2 ? null : "CURSOR-1" },
        };
      }
      if (path.startsWith("/files/photos/feed/facets")) return { uploaders: [], photoCategories: [], projects: [] };
      if (path.startsWith("/files/photos/feed/count")) return { count: 0 };
      return { photos: [], pagination: { page: 1, limit: 40, total: 0, totalPages: 0 } };
    });

    await renderPage();
    const loadMore = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Load more projects")
    );
    await act(async () => { loadMore!.click(); });
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelectorAll('[data-testid="project-row"]').length || container.textContent!.split("Alpha").length - 1).toBe(1);
  });
});

/**
 * These are one root cause — OFFSET pagination over a set that changes while it is read — which is why
 * the fix is the pagination MODEL (a keyset cursor, server-side) rather than another client-side guard.
 * The ordering keys here are `count(*)` and `max(taken_at)`, i.e. exactly the values every photo upload
 * changes, and the client cannot tell "the window drifted" from "the list ended".
 */
describe("PhotoFeedPage — Projects tab paging", () => {
  function mockProjectStats(handler: (path: string) => unknown) {
    mocks.api.mockImplementation(async (path: string) => {
      if (path.startsWith("/files/photos/project-stats")) {
        projectStatsCalls.push(path);
        return handler(path);
      }
      if (path.startsWith("/files/photos/feed/facets")) return { uploaders: [], photoCategories: [], projects: [] };
      if (path.startsWith("/files/photos/feed/count")) return { count: 0 };
      return { photos: [], pagination: { page: 1, limit: 40, total: 0, totalPages: 0 } };
    });
  }

  const loadMoreButton = () =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Load more projects"));

  /**
   * The end of the list is the SERVER's `nextCursor`, not `loaded < total`. Those two disagree the
   * moment the ordering drifts (every photo upload changes a project's count and recency), and the count
   * can never close its gap — which is what kept "Load more" visible forever, fetching pages that do not
   * exist.
   */
  it("stops offering Load more when the server returns no cursor, even though the count says more", async () => {
    mockProjectStats(() => ({
      projects: [projectStat({ dealId: "d1", dealName: "Alpha", photoCount: 5, assignedRepId: ME })],
      // The header legitimately reports 9 matching projects; this response is simply the last of them.
      pagination: { limit: 100, total: 9, nextCursor: null },
    }));

    await renderPage();
    expect(container.textContent).toContain("Alpha");
    expect(loadMoreButton()).toBeUndefined();
    expect(projectStatsCalls.length).toBe(1);
  });

  it("pages by cursor, sending the server's position rather than a page number", async () => {
    mockProjectStats((path) => {
      const resuming = path.includes("cursor=");
      return {
        projects: [
          projectStat({
            dealId: resuming ? "d2" : "d1",
            dealName: resuming ? "Beta" : "Alpha",
            photoCount: 5,
            assignedRepId: ME,
          }),
        ],
        pagination: { limit: 100, total: 2, nextCursor: resuming ? null : "CURSOR-1" },
      };
    });

    await renderPage();
    await act(async () => { loadMoreButton()!.click(); });
    await act(async () => { await Promise.resolve(); });

    expect(projectStatsCalls[1]).toContain("cursor=CURSOR-1");
    expect(projectStatsCalls[1]).not.toContain("page=");
    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).toContain("Beta");
    // Cursor exhausted -> the control is gone, with no count-based guessing involved.
    expect(loadMoreButton()).toBeUndefined();
  });

  // A first-page request is a REPLACEMENT. If it fails, the previous query's rows answer a different
  // question, and the retained cursor belongs to the OLD ordering — so a later Load more would append
  // the new query's page onto the old list.
  it("drops stale rows and the stale cursor when a filter change fails", async () => {
    let failNext = false;
    mockProjectStats(() => {
      if (failNext) throw new Error("boom");
      return { projects: PROJECTS, pagination: { limit: 100, total: 2, nextCursor: "CURSOR-1" } };
    });

    await renderPage();
    expect(container.textContent).toContain("Mine Alpha");

    failNext = true;
    await changeSelect(selectByLabel("Sort By"), "most_photos");
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).not.toContain("Mine Alpha");
    expect(container.textContent).toContain("Couldn't load projects");
    expect(loadMoreButton()).toBeUndefined();
  });

  // The pair to the stop above: a transient failure must stay retryable, or the never-ending-list bug is
  // simply traded for a silent truncation.
  it("keeps a failed Load more retryable — a transient error is not the end of the list", async () => {
    let failNext = true;
    mockProjectStats((path) => {
      const resuming = path.includes("cursor=");
      if (resuming && failNext) throw new Error("blip");
      return {
        projects: [
          projectStat({
            dealId: resuming ? "d2" : "d1",
            dealName: resuming ? "Beta" : "Alpha",
            photoCount: 5,
            assignedRepId: ME,
          }),
        ],
        pagination: { limit: 100, total: 2, nextCursor: resuming ? null : "CURSOR-1" },
      };
    });

    await renderPage();
    await act(async () => { loadMoreButton()!.click(); });
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).toContain("Couldn't load more projects");
    const retry = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Try again"));
    expect(retry).toBeDefined();

    failNext = false;
    await act(async () => { retry!.click(); });
    await act(async () => { await Promise.resolve(); });
    // Resumed from the SAME position — the cursor was not advanced by the failure.
    expect(projectStatsCalls[projectStatsCalls.length - 1]).toContain("cursor=CURSOR-1");
    expect(container.textContent).toContain("Beta");
  });
});

describe("PhotoFeedPage — filter option freshness", () => {
  /**
   * The facets are deliberately NOT refetched per filter change — they describe the whole library, and
   * narrowing them to the current result set would let the option a user just picked vanish from its own
   * dropdown. But they DO have to follow the library when it changes: assigning rescued photos onto a
   * deal that had none makes that deal newly eligible (the facet scope requires a non-null dealId), and
   * fetched once per MOUNT the dropdowns stayed stale until a full page reload. The effect is now keyed
   * on the same `feedRefreshToken` that a successful assignment bumps.
   *
   * Honest limit: driving a real assignment end-to-end means the Radix deal-search popover inside the
   * Unassigned tab, which does not render usefully in jsdom. What is asserted here is the caching
   * contract that motivated "once per mount" in the first place — that ordinary interaction does not
   * refetch — so a future change that swaps the token dependency for an unconditional refetch fails.
   */
  it("does not refetch facets for tab switches or filter changes", async () => {
    const facetCalls = () =>
      mocks.api.mock.calls.filter((call) => String(call[0]).startsWith("/files/photos/feed/facets")).length;

    await renderPage();
    expect(facetCalls()).toBe(1);

    await changeSelect(selectByLabel("Sort By"), "most_photos");
    expect(facetCalls()).toBe(1);

    const tab = (label: string) =>
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith(label));
    await act(async () => { tab("Photos")!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(facetCalls()).toBe(1);

    await changeSelect(selectByLabel("Uploaded By"), "u1");
    expect(facetCalls()).toBe(1);
  });
});

describe("PhotoFeedPage — date filters", () => {
  // `new Date("YYYY-MM-DD")` is UTC midnight; `setHours` mutates in LOCAL time. Pairing them made a
  // same-day selection cover a few hours of the PREVIOUS local evening, so the counts came back empty
  // for a day that plainly has photos.
  it("sends the user's whole local calendar day for a same-day range", async () => {
    await renderPage();

    const startInput = Array.from(container.querySelectorAll('input[type="date"]'))[0] as HTMLInputElement;
    const endInput = Array.from(container.querySelectorAll('input[type="date"]'))[1] as HTMLInputElement;
    const setValue = (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };

    await act(async () => { setValue(startInput, "2026-07-27"); });
    await act(async () => { setValue(endInput, "2026-07-27"); });
    await act(async () => { await Promise.resolve(); });

    const withRange = projectStatsCalls.filter((p) => p.includes("dateFrom") && p.includes("dateTo")).pop();
    expect(withRange).toBeDefined();
    const params = new URLSearchParams(withRange!.split("?")[1]);
    const from = new Date(params.get("dateFrom")!);
    const to = new Date(params.get("dateTo")!);

    // Both bounds land on the picked day in the USER's timezone, spanning it end to end.
    expect(from.getFullYear()).toBe(2026);
    expect(from.getMonth()).toBe(6);
    expect(from.getDate()).toBe(27);
    expect(from.getHours()).toBe(0);
    expect(to.getDate()).toBe(27);
    expect(to.getHours()).toBe(23);
    // The old UTC/local mix produced a window of a few hours; a real day is far longer.
    expect(to.getTime() - from.getTime()).toBeGreaterThan(20 * 60 * 60 * 1000);
  });
});
