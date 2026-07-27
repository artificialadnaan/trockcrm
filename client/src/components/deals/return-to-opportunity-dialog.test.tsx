/**
 * @vitest-environment jsdom
 *
 * The dialog is part of the safety mechanism, not decoration. These cover the three things that must
 * never regress: it NAMES the commission it will destroy, it ECHOES that exact figure back so a stale
 * dialog cannot delete an amount nobody agreed to, and it states — unmissably — that the operator has
 * to delete the project from Bid Board by hand, because the CRM cannot.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getReturnToOpportunityPreview: vi.fn(),
  returnDealToOpportunity: vi.fn(),
  onSuccess: vi.fn(),
  onOpenChange: vi.fn(),
}));

vi.mock("@/hooks/use-deals", () => ({
  getReturnToOpportunityPreview: mocks.getReturnToOpportunityPreview,
  returnDealToOpportunity: mocks.returnDealToOpportunity,
}));

// Render inline when open so the form can be exercised without the portal/pointer setup.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { ReturnToOpportunityDialog } from "./return-to-opportunity-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const wonPreview = {
  dealId: "deal-1",
  dealName: "Palm Villas",
  currentStageSlug: "won",
  currentStageName: "Won",
  allowed: true,
  blockCode: null,
  blockReason: null,
  voidsCommission: true,
  commissionRowCount: 2,
  commissionTotal: "26250.00",
  isWonFamily: true,
  requiredRole: "admin" as const,
  isBidBoardLinked: true,
  bidBoardDetachedAt: null,
  procoreCompanyId: "99000",
  procoreBidId: "887766",
  effectiveContractSignedDate: "2026-03-01",
};

async function renderDialog(open = true) {
  await act(async () => {
    root.render(
      <ReturnToOpportunityDialog
        dealId="deal-1"
        dealName="Palm Villas"
        open={open}
        onOpenChange={mocks.onOpenChange}
        onSuccess={mocks.onSuccess}
      />
    );
  });
}

function setTextarea(value: string) {
  const el = container.querySelector("textarea") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonByText(text: string) {
  return Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(text)
  ) as HTMLButtonElement | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.getReturnToOpportunityPreview.mockResolvedValue(wonPreview);
  mocks.returnDealToOpportunity.mockResolvedValue({
    commissionRowsVoided: 2,
    commissionTotalVoided: "26250.00",
    contractSignedDateCleared: "2026-03-01",
    wasBidBoardLinked: true,
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("ReturnToOpportunityDialog", () => {
  it("names the exact commission amount and row count that will be destroyed", async () => {
    await renderDialog();

    const warning = container.querySelector('[data-testid="return-to-opportunity-commission-warning"]');
    expect(warning).toBeTruthy();
    expect(warning!.textContent).toContain("$26,250.00");
    expect(warning!.textContent).toContain("2 rows");
    expect(warning!.textContent).toContain("permanently deleted");
    expect(warning!.textContent).toContain("2026-03-01");
  });

  it("states the manual Bid Board deletion instruction and deep-links to the project", async () => {
    await renderDialog();

    expect(container.textContent).toContain("You must delete this project from Bid Board yourself");
    expect(container.textContent).toContain("The CRM cannot delete it for you");
    const link = container.querySelector('a[href*="bid-board"]') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.href).toContain("/companies/99000/tools/bid-board/project/887766/details");
  });

  it("omits the Bid Board block entirely for a deal that was never linked", async () => {
    mocks.getReturnToOpportunityPreview.mockResolvedValue({
      ...wonPreview,
      isBidBoardLinked: false,
      procoreCompanyId: null,
      procoreBidId: null,
    });
    await renderDialog();

    // A CRM-only deal has no Bid Board project to delete; telling the operator to go delete one sends
    // them hunting for something that does not exist.
    expect(container.textContent).not.toContain("You must delete this project from Bid Board yourself");
    expect(container.querySelector('a[href*="bid-board"]')).toBeNull();
    // The commission warning is independent of the Bid Board block and must still be there.
    expect(container.querySelector('[data-testid="return-to-opportunity-commission-warning"]')).toBeTruthy();
  });

  it("hands the caller the server's wasBidBoardLinked so the success toast can match the dialog", async () => {
    mocks.returnDealToOpportunity.mockResolvedValue({
      commissionRowsVoided: 0,
      commissionTotalVoided: "0",
      contractSignedDateCleared: null,
      wasBidBoardLinked: false,
    });
    await renderDialog();
    await act(async () => setTextarea("Never linked"));
    await act(async () => {
      buttonByText("Move back to Opportunity")!.click();
    });

    expect(mocks.onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ wasBidBoardLinked: false })
    );
  });

  it("keeps submit disabled until a reason is typed", async () => {
    await renderDialog();
    expect(buttonByText("Move back to Opportunity")!.disabled).toBe(true);

    await act(async () => setTextarea("Client pulled the scope"));
    expect(buttonByText("Move back to Opportunity")!.disabled).toBe(false);
  });

  it("echoes back the exact total it displayed, so a stale dialog cannot void a different amount", async () => {
    await renderDialog();
    await act(async () => setTextarea("Award rescinded"));
    await act(async () => {
      buttonByText("Move back to Opportunity")!.click();
    });

    expect(mocks.returnDealToOpportunity).toHaveBeenCalledWith("deal-1", {
      reason: "Award rescinded",
      acknowledgedCommissionTotal: "26250.00",
    });
    expect(mocks.onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ commissionRowsVoided: 2 })
    );
    expect(mocks.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("sends no acknowledgement for an ordinary pre-Won move (nothing to acknowledge)", async () => {
    mocks.getReturnToOpportunityPreview.mockResolvedValue({
      ...wonPreview,
      currentStageSlug: "estimating",
      voidsCommission: false,
      isWonFamily: false,
      commissionRowCount: 0,
      commissionTotal: "0",
      effectiveContractSignedDate: null,
      requiredRole: "director" as const,
    });
    await renderDialog();

    expect(container.querySelector('[data-testid="return-to-opportunity-commission-warning"]')).toBeNull();

    await act(async () => setTextarea("Needs re-scoping"));
    await act(async () => {
      buttonByText("Move back to Opportunity")!.click();
    });

    expect(mocks.returnDealToOpportunity).toHaveBeenCalledWith("deal-1", {
      reason: "Needs re-scoping",
      acknowledgedCommissionTotal: undefined,
    });
  });

  it("shows the server's block reason and refuses to submit when the action is not allowed", async () => {
    mocks.getReturnToOpportunityPreview.mockResolvedValue({
      ...wonPreview,
      allowed: false,
      blockCode: "COMMISSION_ROLE_NOT_ALLOWED",
      blockReason: "This deal has booked commission or a signed contract, so only an admin can move it back to Opportunity.",
    });
    await renderDialog();

    expect(container.textContent).toContain("only an admin can move it back to Opportunity");
    await act(async () => setTextarea("try anyway"));
    expect(buttonByText("Move back to Opportunity")!.disabled).toBe(true);
  });

  it("surfaces a failed move as an error and does NOT report success", async () => {
    mocks.returnDealToOpportunity.mockRejectedValue(new Error("This deal changed while the move was being confirmed"));
    await renderDialog();
    await act(async () => setTextarea("Award rescinded"));
    await act(async () => {
      buttonByText("Move back to Opportunity")!.click();
    });

    expect(container.textContent).toContain("This deal changed while the move was being confirmed");
    expect(mocks.onSuccess).not.toHaveBeenCalled();
    expect(mocks.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("does not fetch the preview while closed (the amount must be live, fetched on open)", async () => {
    await renderDialog(false);
    expect(mocks.getReturnToOpportunityPreview).not.toHaveBeenCalled();
  });
});
