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
      return { projects: PROJECTS, pagination: { page: 1, limit: 100, total: PROJECTS.length, totalPages: 1 } };
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
        const isPage2 = path.includes("page=2");
        return {
          projects: isPage2 ? page2 : page1,
          pagination: { page: isPage2 ? 2 : 1, limit: 100, total: 2, totalPages: 2 },
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
