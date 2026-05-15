// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import ReactDOMServer from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ActivityFeedEntryRecord } from "./activity-feed-entry";
import { ActivityFeedEntry } from "./activity-feed-entry";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ActivityFeedEntry", () => {
  it("renders a field change entry in plain English", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <ActivityFeedEntry
        entry={{
          id: 1,
          actorLabel: "Adnaan Iqbal",
          actorType: "user",
          action: "update",
          entityType: "deal",
          entityName: "Tides at Timberglen",
          entitySecondaryId: "DFW-4-11426-AF",
          occurredAt: "2026-05-14T19:42:08.000Z",
          summary: null,
          fieldChanges: [
            {
              key: "budget",
              label: "Budget",
              fromDisplay: "$20,000",
              toDisplay: "$35,000",
              transition: "changed",
              masked: false,
            },
          ],
          visibilityScope: "internal",
        }}
      />
    );

    expect(html).toContain("Adnaan Iqbal changed Budget from $20,000 to $35,000 on Tides at Timberglen (DFW-4-11426-AF)");
  });

  it("renders a stage move entry", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <ActivityFeedEntry
        entry={{
          id: 2,
          actorLabel: "Takashi Yamashita",
          actorType: "user",
          action: "stage_transition",
          entityType: "deal",
          entityName: "Hidden Ridge Apartments",
          entitySecondaryId: "DFW-1-09726-AA",
          occurredAt: "2026-05-14T19:42:08.000Z",
          summary: null,
          fieldChanges: [
            {
              key: "stageId",
              label: "Stage",
              fromDisplay: "Estimating",
              toDisplay: "Internal Review",
              transition: "changed",
              masked: false,
            },
          ],
          visibilityScope: "internal",
        }}
      />
    );

    expect(html).toContain("Takashi Yamashita moved Hidden Ridge Apartments (DFW-1-09726-AA) from Estimating to Internal Review");
  });

  it("renders a system-process entry without the bare system label", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <ActivityFeedEntry
        entry={{
          id: 3,
          actorLabel: "HubSpot Sync",
          actorType: "system",
          action: "update",
          entityType: "deal",
          entityName: "Cottages at Bedford",
          entitySecondaryId: "DFW-1-12626-AA",
          occurredAt: "2026-05-14T19:42:08.000Z",
          summary: null,
          fieldChanges: [
            {
              key: "awardedAmount",
              label: "Amount",
              fromDisplay: "$1,250,000",
              toDisplay: "$1,275,000",
              transition: "changed",
              masked: false,
            },
          ],
          visibilityScope: "internal",
        }}
      />
    );

    expect(html).toContain("HubSpot Sync updated Amount from $1,250,000 to $1,275,000 on Cottages at Bedford (DFW-1-12626-AA)");
    expect(html).not.toContain(">System<");
  });

  it("renders a collapsed system-process group with counts", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <ActivityFeedEntry entry={makeGroupEntry()} />
    );

    expect(html).toContain("Bid Board Sync");
    expect(html).toContain("352 deals updated");
    expect(html).toContain("Expand");
    expect(html).toContain("aria-label=\"Expand Bid Board Sync batch\"");
  });

  it("expands and collapses loaded child entries", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => {
      root.render(
        <ActivityFeedEntry
          entry={{
            ...makeGroupEntry(),
            id: "batch:hubspot-refresh",
            processName: "HubSpot Refresh",
            totalCount: 6,
            distinctEntityCount: 6,
            previewEntities: [],
            childEntries: [makeSingleEntry()],
          }}
        />
      );
    });

    const expand = container.querySelector("button")!;
    act(() => {
      expand.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("HubSpot Refresh updated Cottages at Bedford");

    const collapse = container.querySelector("button")!;
    act(() => {
      collapse.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).not.toContain("HubSpot Refresh updated Cottages at Bedford");

    act(() => {
      root.unmount();
    });
  });

  it("fetches full child entries when an expanded group only has a preview", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const children: ActivityFeedEntryRecord[] = [
      {
        type: "single",
        id: 501,
        actorLabel: "Bid Board Sync",
        actorType: "system",
        action: "update",
        entityType: "deal",
        entityName: "Harper Grove",
        entitySecondaryId: "ATL-4-11126-aa",
        occurredAt: "2026-05-15T16:03:01.000Z",
        summary: null,
        fieldChanges: [],
        visibilityScope: "internal",
      },
    ];
    const loadGroupChildren = vi.fn().mockResolvedValue({ rows: children, total: 1 });

    act(() => {
      root.render(
        <ActivityFeedEntry
          entry={{ ...makeGroupEntry(), childEntries: [] }}
          onLoadGroupChildren={loadGroupChildren}
        />
      );
    });

    await act(async () => {
      container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(loadGroupChildren).toHaveBeenCalledWith("batch:bid-board-sync", 1, 100);
    expect(container.textContent).toContain("Bid Board Sync updated Harper Grove");

    act(() => {
      root.unmount();
    });
  });

  it("loads additional child pages for large groups", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const firstPage = [makeSingleEntry()];
    const secondPage: ActivityFeedEntryRecord[] = [
      { ...makeSingleEntry(), id: 402, entityName: "Gateway East", entitySecondaryId: "ASGELIGHTS" },
    ];
    const loadGroupChildren = vi.fn()
      .mockResolvedValueOnce({ rows: firstPage, total: 2 })
      .mockResolvedValueOnce({ rows: secondPage, total: 2 });

    act(() => {
      root.render(
        <ActivityFeedEntry
          entry={{ ...makeGroupEntry(), totalCount: 2, childEntries: [] }}
          onLoadGroupChildren={loadGroupChildren}
        />
      );
    });

    await act(async () => {
      container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("Showing 1 of 2 entries");

    const loadMore = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Load more")!;
    await act(async () => {
      loadMore.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(loadGroupChildren).toHaveBeenNthCalledWith(2, "batch:bid-board-sync", 2, 100);
    expect(container.textContent).toContain("Gateway East");
    expect(container.textContent).not.toContain("Load more");

    act(() => {
      root.unmount();
    });
  });
});

function makeGroupEntry() {
  return {
    type: "group" as const,
    id: "batch:bid-board-sync",
    processName: "Bid Board Sync",
    startTime: "2026-05-15T16:03:00.000Z",
    endTime: "2026-05-15T16:03:52.000Z",
    totalCount: 352,
    distinctEntityCount: 176,
    entityType: "deal",
    action: "update",
    previewEntities: [
      { name: "Harper Grove", snapshot: "ATL-4-11126-aa" },
      { name: "Gateway East", snapshot: "ASGELIGHTS" },
    ],
    childEntries: [],
  };
}

function makeSingleEntry(): ActivityFeedEntryRecord {
  return {
    type: "single",
    id: 401,
    actorLabel: "HubSpot Refresh",
    actorType: "system",
    action: "update",
    entityType: "deal",
    entityName: "Cottages at Bedford",
    entitySecondaryId: "DFW-1-12626-AA",
    occurredAt: "2026-05-15T16:03:01.000Z",
    summary: null,
    fieldChanges: [],
    visibilityScope: "internal",
  };
}
