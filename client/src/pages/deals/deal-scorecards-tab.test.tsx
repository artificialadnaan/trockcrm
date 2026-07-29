// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { CorrectiveActionItemView, FieldScorecardDetail } from "@trock-crm/shared/types";
import { isRenderableSignatureDataUrl, typedSignatureFallback } from "@trock-crm/shared/types";
const approveMock = vi.fn();
const rejectMock = vi.fn();
vi.mock("@/hooks/use-corrective-actions", () => ({
  approveCorrectiveActions: (...args: unknown[]) => approveMock(...args),
  rejectCorrectiveAction: (...args: unknown[]) => rejectMock(...args),
}));

import { ApiError } from "@/lib/api";
import {
  buildCorrectiveActionLookup,
  correctiveActionStatusBadge,
  isRejectionCommentValid,
  ScorecardDetailView,
  shouldShowApprovalControls,
  shouldShowApproveAll,
} from "./deal-scorecards-tab";

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("correctiveActionStatusBadge", () => {
  it("returns an Open badge for corrective_action_open", () => {
    expect(correctiveActionStatusBadge("corrective_action_open")?.label).toBe("Corrective Action Open");
  });
  it("returns an APPROVED badge for corrective_action_closed", () => {
    // The stored value keeps its name (renaming it would churn the QC dashboard, reports, and every
    // fixture), but under the approval gate it now means the approver accepted the fix — so the LABEL says
    // approved. "Closed" would imply the card finished the moment the responder answered, which is exactly
    // the claim the gate exists to deny.
    expect(correctiveActionStatusBadge("corrective_action_closed")?.label).toBe("Corrective Action Approved");
  });

  it("returns an Awaiting Approval badge for the middle state", () => {
    const badge = correctiveActionStatusBadge("corrective_action_submitted");
    expect(badge?.label).toBe("Awaiting Approval");
    // Amber, not green: work has been documented but nobody has accepted it yet.
    expect(badge?.className).toContain("amber");
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
          status: "approved",
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
          status: "approved",
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
    // The header summary counts APPROVED, not merely answered — the gate exists to distinguish them.
    expect(html).toContain("2 / 2 approved");

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
          status: "approved",
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
    expect(html).toContain("0 / 1 approved");
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
          status: "approved",
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

describe("ScorecardDetailView signatures", () => {
  const PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  it("renders a handwritten signature as an image, never as raw base64 text", async () => {
    // Reported bug: the tab printed the data URL as a text node under the SIGNATURES heading.
    const html = await renderDetail({
      ...BASE_DETAIL,
      formVersion: 2,
      superintendentSignature: PNG,
      pmSignature: PNG,
    });

    expect(html).toContain(`alt="Superintendent signature"`);
    expect(html).toContain(`alt="Project manager signature"`);
    // The data URL may appear ONLY inside an img src, never as a text node.
    expect(stripTags(html)).not.toContain("data:image/png;base64");
  });

  it("renders a legacy typed signature as text", async () => {
    const html = await renderDetail({
      ...BASE_DETAIL,
      formVersion: 2,
      superintendentSignature: "Sam Super",
      pmSignature: null,
    });

    expect(stripTags(html)).toContain("Sam Super");
    expect(html).not.toContain("alt=\"Superintendent signature\"");
  });

  it("renders an em dash for a missing or unsupported signature", async () => {
    const html = await renderDetail({
      ...BASE_DETAIL,
      formVersion: 2,
      superintendentSignature: null,
      // An unsupported image type must fall back to the em dash, NOT be printed verbatim.
      pmSignature: "data:image/svg+xml;base64,PHN2Zz4=",
    });

    expect(html).not.toContain("<img");
    expect(stripTags(html)).not.toContain("data:image/svg+xml");
    expect(html.split("—").length - 1).toBeGreaterThanOrEqual(2);
  });
});

/** Text content only — used to prove a data URL never reaches the DOM as a text node. */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

describe("ScorecardDetailView signature decode failure", () => {
  // The shared predicate validates the media type and the base64 ALPHABET but cannot prove the payload
  // decodes to a real image. The PDF catches that at draw time; the web must too, or the two surfaces
  // disagree on exactly the input the shared module exists to keep them agreeing on.
  const UNDECODABLE = "data:image/png;base64,====";

  it("classifies an undecodable-but-well-formed payload as renderable (so the runtime fallback matters)", () => {
    expect(isRenderableSignatureDataUrl(UNDECODABLE)).toBe(true);
    expect(typedSignatureFallback(UNDECODABLE)).toBeNull();
  });

  it("renders it as an image with an error fallback rather than raw text", async () => {
    const html = await renderDetail({
      ...BASE_DETAIL,
      formVersion: 2,
      superintendentSignature: UNDECODABLE,
      pmSignature: null,
    });

    // It starts as an <img> (we cannot know it is bad until the browser tries), but the payload must never
    // reach the DOM as a text node, and the element must carry an error handler to fall back.
    expect(html).toContain('alt="Superintendent signature"');
    expect(stripTags(html)).not.toContain("data:image/png;base64");
  });
});

describe("removed-item history", () => {
  it("REGRESSION: renders events whose item an edit removed, rather than silently dropping them", async () => {
    // The server preserves these (ON DELETE SET NULL) precisely so the record survives an edit. Emitting them
    // and never rendering them preserves nothing a user can see — which is the shape of bug this feature line
    // has produced repeatedly: the data lands, no consumer reads it, and every test still passes.
    const detail = {
      ...BASE_DETAIL,
      correctiveActions: [],
      removedItemEvents: [
        {
          id: "e1",
          eventType: "rejected",
          actorName: "James Helms",
          actorEmail: null,
          comment: "Torque values were not documented.",
          createdAt: "2026-07-28T12:00:00.000Z",
          photos: [],
        },
      ],
    } as unknown as FieldScorecardDetail;

    const html = await renderDetail(detail);
    expect(html).toContain("Removed by a later edit");
    expect(html).toContain("James Helms");
    expect(html).toContain("Torque values were not documented.");
  });
});

describe("approval controls", () => {
  const item = (status: string) => ({ status }) as { status: string };

  it("shows the controls only for an approver, and only on items awaiting approval", () => {
    // The control is UX; the route's 403 is the guarantee. But a button that always 403s trains people to
    // ignore errors, and one on an already-approved item invites a no-op that reads as a bug.
    expect(shouldShowApprovalControls(item("submitted"), true)).toBe(true);
    expect(shouldShowApprovalControls(item("submitted"), false)).toBe(false);
    expect(shouldShowApprovalControls(item("approved"), true)).toBe(false);
    expect(shouldShowApprovalControls(item("rejected"), true)).toBe(false);
    // `open` means the responder has not answered yet — there is nothing to approve.
    expect(shouldShowApprovalControls(item("open"), true)).toBe(false);
  });

  it("offers Approve all only when MORE THAN ONE item is waiting", () => {
    // With a single item the per-item button already does it; a second control would just be noise.
    expect(shouldShowApproveAll([item("submitted"), item("submitted")], true)).toBe(true);
    expect(shouldShowApproveAll([item("submitted"), item("approved")], true)).toBe(false);
    expect(shouldShowApproveAll([item("submitted"), item("submitted")], false)).toBe(false);
    expect(shouldShowApproveAll([], true)).toBe(false);
  });

  it("refuses an empty rejection comment before it reaches the server", () => {
    // Telling the responder what to fix IS the rejection. A blank one wastes a round trip on both sides and
    // the server rejects it anyway — this just fails faster and says why.
    expect(isRejectionCommentValid("   ")).toBe(false);
    expect(isRejectionCommentValid("")).toBe(false);
    expect(isRejectionCommentValid("Re-torque and log the values.")).toBe(true);
  });
});

describe("ScorecardDetailView supersession conflicts", () => {
  it("REFETCHES the card when a verdict is refused as superseded, so the retry is not the same 409", async () => {
    // The guards tell the reviewer to refresh and, until this, nothing did: collapsing and reopening the row
    // re-fetches only when `detail` is null, so the reviewer stayed on the same stale generation and every
    // retry produced the same 409 until they reloaded the page. A guard whose only escape hatch does not
    // work reads as the feature being broken, which is how guards get removed.
    approveMock.mockRejectedValueOnce(
      new ApiError(409, {
        message: "This scorecard changed after you opened it. Refresh to review the current version.",
        code: "CORRECTIVE_ACTION_CARD_SUPERSEDED",
      }),
    );
    const onApprovalChange = vi.fn();
    const detail: FieldScorecardDetail = {
      ...BASE_DETAIL,
      status: "corrective_action_submitted",
      updatedAt: "2026-06-30T12:00:00.000Z",
      canApproveCorrectiveActions: true,
      actionItems: ["Re-torque the anchors"],
      correctiveActions: [
        {
          id: "ca-1",
          itemType: "action_item",
          itemRef: "0",
          itemLabel: "Re-torque the anchors",
          status: "submitted",
          responseComment: "Done.",
          respondedByUserId: null,
          responderName: "Pat Manager",
          responderEmail: null,
          respondedAt: "2026-06-30T13:00:00.000Z",
          photos: [],
        } satisfies CorrectiveActionItemView,
      ],
    };

    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ScorecardDetailView detail={detail} dealId="deal-1" onApprovalChange={onApprovalChange} />,
      );
      await flush();
    });

    const approveButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Approve",
    );
    expect(approveButton).toBeTruthy();
    await act(async () => {
      approveButton!.click();
      await flush();
    });

    // The refresh fired...
    expect(onApprovalChange).toHaveBeenCalled();
    // ...AND the reviewer is told, because their verdict did not land and has to be re-formed against what
    // they can now see. Silently refreshing would look like the click worked.
    expect(container.innerHTML).toContain("Refresh to review the current version");

    await act(async () => {
      root.unmount();
      await flush();
    });
  });

  it("does NOT refetch on an unrelated failure — that would hide the error behind a reload", async () => {
    approveMock.mockRejectedValueOnce(new ApiError(500, { message: "Something went wrong" }));
    const onApprovalChange = vi.fn();
    const detail: FieldScorecardDetail = {
      ...BASE_DETAIL,
      status: "corrective_action_submitted",
      canApproveCorrectiveActions: true,
      actionItems: ["Re-torque the anchors"],
      correctiveActions: [
        {
          id: "ca-1",
          itemType: "action_item",
          itemRef: "0",
          itemLabel: "Re-torque the anchors",
          status: "submitted",
          responseComment: "Done.",
          respondedByUserId: null,
          responderName: "Pat Manager",
          responderEmail: null,
          respondedAt: "2026-06-30T13:00:00.000Z",
          photos: [],
        } satisfies CorrectiveActionItemView,
      ],
    };

    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ScorecardDetailView detail={detail} dealId="deal-1" onApprovalChange={onApprovalChange} />,
      );
      await flush();
    });
    const approveButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Approve",
    );
    await act(async () => {
      approveButton!.click();
      await flush();
    });

    expect(onApprovalChange).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
      await flush();
    });
  });
});
