// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { CorrectiveActionItemView } from "@trock-crm/shared/types";
import { correctiveActionStatusBadge, CorrectiveActionThread } from "./deal-scorecards-tab";

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("correctiveActionStatusBadge", () => {
  it("returns an Open badge for corrective_action_open", () => {
    expect(correctiveActionStatusBadge("corrective_action_open")?.label).toBe("Corrective Action Open");
  });
  it("returns a Closed badge for corrective_action_closed", () => {
    expect(correctiveActionStatusBadge("corrective_action_closed")?.label).toBe("Corrective Action Closed");
  });
  it("returns null for a plain submitted card", () => {
    expect(correctiveActionStatusBadge("submitted")).toBeNull();
    expect(correctiveActionStatusBadge(undefined)).toBeNull();
  });
});

const items: CorrectiveActionItemView[] = [
  {
    id: "i1",
    itemType: "action_item",
    itemRef: "0",
    itemLabel: "Re-pour slab",
    status: "resolved",
    responseComment: "Slab re-poured and cured",
    respondedByUserId: "u1",
    responderName: "Sam Super",
    responderEmail: null,
    respondedAt: "2026-07-02T12:00:00Z",
    photos: [{ id: "p1", fileId: "f1", url: "https://img/1.jpg", caption: "After" }],
  },
  {
    id: "i2",
    itemType: "critical_deficiency",
    itemRef: "failed_inspection",
    itemLabel: "Failed inspection",
    status: "open",
    responseComment: null,
    respondedByUserId: null,
    responderName: null,
    responderEmail: null,
    respondedAt: null,
    photos: [],
  },
];

async function renderThread(status?: string) {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(<CorrectiveActionThread items={items} status={status} />);
    await flush();
  });
  const html = container.innerHTML;
  await act(async () => {
    root.unmount();
    await flush();
  });
  return html;
}

describe("CorrectiveActionThread", () => {
  it("threads each item's label, response comment, responder, and photo", async () => {
    const html = await renderThread("corrective_action_open");
    expect(html).toContain("Re-pour slab");
    expect(html).toContain("Slab re-poured and cured");
    expect(html).toContain("Sam Super");
    expect(html).toContain("https://img/1.jpg");
    // Open item shows the awaiting hint, no response comment.
    expect(html).toContain("Failed inspection");
    expect(html).toContain("Awaiting corrective-action response");
  });

  it("shows the resolved count and a Resolved/Open pill per item", async () => {
    const html = await renderThread("corrective_action_open");
    expect(html).toContain("1 / 2 resolved");
    expect(html).toContain("Resolved");
    expect(html).toContain("Open");
  });
});
