// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ReactDOMServer from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let reviewState: any;
let authUser: any;
let currentDealId = "deal-1";

const applyOptimisticMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-rfp-review", () => ({
  useRfpReview: () => ({ review: reviewState, loading: false, error: null, refetch: vi.fn(), applyOptimistic: applyOptimisticMock }),
  approveRfpOverride: vi.fn(),
  reconfirmRfpDecline: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: authUser }) }));
vi.mock("react-router-dom", () => ({
  useParams: () => ({ dealId: currentDealId }),
  useSearchParams: () => [new URLSearchParams("officeId=o1"), vi.fn()],
  Link: ({ children }: any) => children,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { RfpReviewPage } from "./rfp-review-page";
import { approveRfpOverride } from "@/hooks/use-rfp-review";

function baseReview(overrides: Record<string, unknown> = {}) {
  return {
    dealId: "deal-1",
    dealName: "Acme",
    dealNumber: "TR-1",
    projectNumber: "P-9",
    rfpApprovalStatus: "declined",
    rfpApprovalRequestId: 77,
    requestedAt: null,
    requestedById: null,
    requestedByName: "Rep One",
    requestedByEmail: "rep@x.com",
    declinedReason: "Margins too thin",
    declinedAt: null,
    reviewedAt: null,
    reviewedById: null,
    reviewedByName: null,
    reviewDecision: null,
    reviewNote: null,
    overrideState: null,
    overrideError: null,
    actionable: true,
    ...overrides,
  };
}

const render = () => ReactDOMServer.renderToStaticMarkup(<RfpReviewPage />);

describe("RfpReviewPage states", () => {
  it("restricts a non-reviewer", () => {
    authUser = { isRfpReviewer: false };
    reviewState = baseReview();
    expect(render()).toContain("Review access restricted");
  });

  it("a fresh declined RFP shows Approve (create Bid Board project) + Re-confirm", () => {
    authUser = { isRfpReviewer: true };
    reviewState = baseReview();
    const html = render();
    expect(html).toContain("Approve override (create Bid Board project)");
    expect(html).toContain("Re-confirm denial");
  });

  it("an in-flight override shows the creating-project panel, hides re-approve, but offers the duplicate-safe denial escape", () => {
    authUser = { isRfpReviewer: true };
    reviewState = baseReview({ actionable: false, overrideState: "approving", reviewedByName: "Takashi" });
    const html = render();
    expect(html).toContain("Creating the Bid Board project");
    // re-approve is NOT offered while approving (it could race a possibly-in-flight attempt into a duplicate)
    expect(html).not.toContain("Approve override (create Bid Board project)");
    // ...but a stuck 'approving' is escapable: upholding the denial creates no project, so it's always safe
    expect(html).toContain("Uphold the denial instead");
  });

  it("a failed override warns about a possible duplicate Procore project and gates the re-attempt behind verification", () => {
    authUser = { isRfpReviewer: true };
    reviewState = baseReview({ overrideState: "failed", overrideError: "Procore form timed out", actionable: true });
    const html = render();
    expect(html).toContain("couldn"); // "couldn't be confirmed"
    expect(html).toContain("Procore form timed out");
    // the duplicate-project risk is explicit, and the reviewer is told to check Procore BEFORE re-attempting
    expect(html).toContain("duplicate project");
    expect(html).toContain("Open Procore");
    // re-attempt is gated behind a verification acknowledgment — NOT a one-click blind "Retry"
    expect(html).toContain("confirmed that no Bid Board project was created");
    expect(html).toContain("Confirmed no project — re-attempt");
    expect(html).not.toContain("Retry override approval");
    expect(html).toContain("Re-confirm denial"); // can still uphold the denial
    // on first render (acknowledgment unchecked) the re-attempt button is disabled
    expect(html).toContain("disabled");
  });

  it("an approved deal shows the success outcome (linked + advanced to Estimating)", () => {
    authUser = { isRfpReviewer: true };
    reviewState = baseReview({ rfpApprovalStatus: "approved", actionable: false });
    const html = render();
    expect(html).toContain("Approved");
    expect(html).toContain("advanced to Estimating");
    expect(html).not.toContain("Approve override (create Bid Board project)");
  });

  it("a re-confirmed denial is terminal", () => {
    authUser = { isRfpReviewer: true };
    reviewState = baseReview({ actionable: false, reviewDecision: "denial_reconfirmed", reviewedByName: "Adam" });
    const html = render();
    expect(html).toContain("re-confirmed");
    expect(html).not.toContain("Approve override (create Bid Board project)");
  });
});

describe("RfpReviewPage — per-deal Procore-check confirmation reset", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    currentDealId = "deal-1";
  });

  function mount() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<RfpReviewPage />);
    });
  }
  const reattemptBtn = () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Confirmed no project")) as
      | HTMLButtonElement
      | undefined;

  it("clears the confirmation when navigating to a different failed deal (no carried-over one-click re-attempt)", () => {
    authUser = { isRfpReviewer: true };
    reviewState = baseReview({ overrideState: "failed", overrideError: "x", actionable: true });
    currentDealId = "deal-1";
    mount();

    // unverified → re-attempt disabled
    expect(reattemptBtn()?.disabled).toBe(true);

    // tick the Procore-check confirmation → enabled
    act(() => {
      (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    });
    expect(reattemptBtn()?.disabled).toBe(false);

    // navigate to a DIFFERENT failed deal → the confirmation must reset → disabled again
    currentDealId = "deal-2";
    act(() => {
      root.render(<RfpReviewPage />);
    });
    expect(reattemptBtn()?.disabled).toBe(true);
  });
});

describe("RfpReviewPage — approve override result handling (optimistic state)", () => {
  let container: HTMLDivElement;
  let root: Root;
  const approveMock = approveRfpOverride as unknown as ReturnType<typeof vi.fn>;

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    applyOptimisticMock.mockClear();
    approveMock.mockReset();
  });

  function mount() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<RfpReviewPage />);
    });
  }
  const approveBtn = () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Approve override")) as
      | HTMLButtonElement
      | undefined;

  it("an unconfirmed timeout still optimistically enters 'approving' (kept non-retryable, not failed)", async () => {
    authUser = { isRfpReviewer: true };
    reviewState = baseReview(); // fresh + actionable
    approveMock.mockResolvedValue({ success: true, status: "approving", requestId: 77, unconfirmed: true });
    mount();

    await act(async () => {
      approveBtn()!.click();
    });

    // a timeout keeps the deal 'approving' server-side (re-approve blocked); the page must reflect that, NOT flip
    // to a retryable 'failed' panel (which would let a fast re-attempt race a possibly-in-flight first attempt)
    expect(applyOptimisticMock).toHaveBeenCalledWith(expect.objectContaining({ overrideState: "approving", actionable: false }));
    expect(applyOptimisticMock).not.toHaveBeenCalledWith(expect.objectContaining({ overrideState: "failed" }));
  });

  it("a confirmed acceptance (status 'approving') optimistically enters the creating-project panel", async () => {
    authUser = { isRfpReviewer: true };
    reviewState = baseReview();
    approveMock.mockResolvedValue({ success: true, status: "approving", requestId: 77, unconfirmed: false });
    mount();

    await act(async () => {
      approveBtn()!.click();
    });

    expect(applyOptimisticMock).toHaveBeenCalledWith(expect.objectContaining({ overrideState: "approving", actionable: false }));
  });
});
