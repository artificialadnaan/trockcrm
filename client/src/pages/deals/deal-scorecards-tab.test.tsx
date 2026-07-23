// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { CorrectiveActionItemView, FieldScorecardDetail } from "@trock-crm/shared/types";
import {
  buildCorrectiveActionLookup,
  correctiveActionStatusBadge,
  ScorecardDetailView,
} from "./deal-scorecards-tab";

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

describe("buildCorrectiveActionLookup", () => {
  it("keys deficiencies by ref and buckets duplicate action labels in order (multiset)", () => {
    const items: CorrectiveActionItemView[] = [
      makeCA({ id: "d1", itemType: "critical_deficiency", itemRef: "failed_inspection", itemLabel: "Failed inspection" }),
      makeCA({ id: "a1", itemType: "action_item", itemRef: "0", itemLabel: "Fix rebar" }),
      makeCA({ id: "a2", itemType: "action_item", itemRef: "1", itemLabel: "Fix rebar" }),
    ];
    const { deficiencyByKey, actionByLabel } = buildCorrectiveActionLookup(items);
    expect(deficiencyByKey.get("failed_inspection")?.id).toBe("d1");
    expect(actionByLabel.get("Fix rebar")?.map((i) => i.id)).toEqual(["a1", "a2"]);
  });
  it("returns empty lookups for undefined", () => {
    const { deficiencyByKey, actionByLabel } = buildCorrectiveActionLookup(undefined);
    expect(deficiencyByKey.size).toBe(0);
    expect(actionByLabel.size).toBe(0);
  });
});

function makeCA(over: Partial<CorrectiveActionItemView> & Pick<CorrectiveActionItemView, "id" | "itemType" | "itemRef" | "itemLabel">): CorrectiveActionItemView {
  return {
    status: "open",
    responseComment: null,
    respondedByUserId: null,
    responderName: null,
    responderEmail: null,
    respondedAt: null,
    photos: [],
    ...over,
  };
}

const BASE_DETAIL: FieldScorecardDetail = {
  id: "sc1",
  dealId: "deal1",
  weekOf: "2026-06-29",
  totalScore: 55,
  formVersion: 1,
  rating: "corrective_action",
  ratingLabel: "Corrective Action Required",
  superintendentName: "Sam Super",
  pmName: "Pat PM",
  projectNumber: "TR-100",
  criticalDeficiencyCount: 1,
  submittedByName: "Sam Super",
  submittedAt: "2026-06-30T12:00:00Z",
  hasPdf: true,
  status: "corrective_action_open",
  items: [],
  criticalDeficiencies: [],
  actionItems: [],
  photos: [],
};

async function renderDetail(detail: FieldScorecardDetail) {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(<ScorecardDetailView detail={detail} />);
    await flush();
  });
  const html = container.innerHTML;
  await act(async () => {
    root.unmount();
    await flush();
  });
  return html;
}

describe("ScorecardDetailView corrective-action threading", () => {
  it("threads each response beneath its original item without duplicating the flagged label", async () => {
    const detail: FieldScorecardDetail = {
      ...BASE_DETAIL,
      criticalDeficiencies: ["failed_inspection"],
      actionItems: ["Re-pour slab"],
      correctiveActions: [
        makeCA({
          id: "d1",
          itemType: "critical_deficiency",
          itemRef: "failed_inspection",
          itemLabel: "Failed inspection",
          status: "resolved",
          responseComment: "Re-inspected and passed",
          responderName: "Dana Director",
          respondedAt: "2026-07-02T12:00:00Z",
          photos: [{ id: "cp1", fileId: "cf1", url: "https://img/def.jpg", caption: "Passed placard" }],
        }),
        makeCA({
          id: "a1",
          itemType: "action_item",
          itemRef: "0",
          itemLabel: "Re-pour slab",
          status: "resolved",
          responseComment: "Slab re-poured and cured",
          responderName: "Sam Super",
          respondedAt: "2026-07-03T12:00:00Z",
          photos: [{ id: "cp2", fileId: "cf2", url: "https://img/slab.jpg", caption: "After pour" }],
        }),
      ],
    };
    const html = await renderDetail(detail);

    // The response comments + responders render.
    expect(html).toContain("Re-inspected and passed");
    expect(html).toContain("Dana Director");
    expect(html).toContain("Slab re-poured and cured");
    expect(html).toContain("Sam Super");
    // The header summary reflects 2 / 2 resolved (closed reads).
    expect(html).toContain("2 / 2 resolved");

    // No separate duplicated "Corrective Actions" item list: each flagged label appears exactly once.
    expect(html.split("Re-pour slab").length - 1).toBe(1);
    expect(html.split("Failed inspection").length - 1).toBe(1);
  });

  it("renders response photo captions visually (not only in the img alt)", async () => {
    const detail: FieldScorecardDetail = {
      ...BASE_DETAIL,
      actionItems: ["Re-pour slab"],
      correctiveActions: [
        makeCA({
          id: "a1",
          itemType: "action_item",
          itemRef: "0",
          itemLabel: "Re-pour slab",
          status: "resolved",
          responseComment: "done",
          responderName: "Sam Super",
          respondedAt: "2026-07-03T12:00:00Z",
          photos: [{ id: "cp2", fileId: "cf2", url: "https://img/slab.jpg", caption: "Fresh pour caption" }],
        }),
      ],
    };
    const html = await renderDetail(detail);
    // The caption must appear in a visible text node (a <p>), not just alt="".
    expect(html).toContain(">Fresh pour caption<");
  });

  it("shows an awaiting hint under an original item whose response is still open", async () => {
    const detail: FieldScorecardDetail = {
      ...BASE_DETAIL,
      criticalDeficiencies: ["failed_inspection"],
      correctiveActions: [
        makeCA({
          id: "d1",
          itemType: "critical_deficiency",
          itemRef: "failed_inspection",
          itemLabel: "Failed inspection",
          status: "open",
        }),
      ],
    };
    const html = await renderDetail(detail);
    expect(html).toContain("Failed inspection");
    expect(html).toContain("Awaiting corrective-action response");
    expect(html).toContain("0 / 1 resolved");
  });

  it("threads duplicate action labels under distinct occurrences", async () => {
    const detail: FieldScorecardDetail = {
      ...BASE_DETAIL,
      actionItems: ["Fix rebar", "Fix rebar"],
      correctiveActions: [
        makeCA({
          id: "a1",
          itemType: "action_item",
          itemRef: "0",
          itemLabel: "Fix rebar",
          status: "resolved",
          responseComment: "First fix done",
          responderName: "Sam Super",
          respondedAt: "2026-07-03T12:00:00Z",
        }),
        makeCA({
          id: "a2",
          itemType: "action_item",
          itemRef: "1",
          itemLabel: "Fix rebar",
          status: "open",
        }),
      ],
    };
    const html = await renderDetail(detail);
    // Both occurrences render (label appears twice), the first resolved comment and the second's awaiting hint.
    expect(html.split("Fix rebar").length - 1).toBe(2);
    expect(html).toContain("First fix done");
    expect(html).toContain("Awaiting corrective-action response");
  });
});
