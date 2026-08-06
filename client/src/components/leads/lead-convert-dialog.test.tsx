// @vitest-environment jsdom
//
// The convert dialog is the ONLY point in the lead→deal flow where the rep is asked anything, and until
// now it asked nothing at all — a bare confirm. That is why every lead-converted deal landed with
// scope_title NULL: not because the field was rejected, but because no client could send it.
//
// The title is captured here rather than derived from the lead. leads.description is the same notes
// field the whole feature exists to replace — across the 180 live leads that have one it runs to a p90
// of 200 characters and a max of 2658, with real values like "fsad", "summary" and
// "[Archived 2026-07-14 — test data]". A derived title from that is worse than a blank one: it looks
// authoritative. (Contrast the change-order seed, where the census showed the description already IS a
// title 97% of the time.)
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEAL_SCOPE_TITLE_MAX_LENGTH } from "@trock-crm/shared/types";
import type { LeadRecord } from "@/hooks/use-leads";

const mocks = vi.hoisted(() => ({ convertLeadToOpportunity: vi.fn() }));

vi.mock("@/hooks/use-leads", () => ({
  convertLeadToOpportunity: mocks.convertLeadToOpportunity,
}));

const { LeadConvertDialog } = await import("./lead-convert-dialog");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LEAD = { id: "lead-1", name: "Palm Villas repaint" } as unknown as LeadRecord;

let roots: Root[] = [];
let containers: HTMLElement[] = [];

async function renderDialog() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <LeadConvertDialog lead={LEAD} open onOpenChange={vi.fn()} onSuccess={vi.fn()} />
    );
  });
  roots.push(root);
  containers.push(container);
  // The dialog portals its content, so query the whole document rather than the mount node.
  return document.body;
}

async function type(value: string) {
  const input = document.querySelector<HTMLInputElement>("#convertScopeTitle");
  if (!input) throw new Error("scope title input not rendered");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function convert() {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Convert to Opportunity"
  );
  if (!button) throw new Error("convert button not rendered");
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  mocks.convertLeadToOpportunity.mockResolvedValue({ lead: LEAD, deal: { id: "deal-1" } });
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  for (const container of containers) container.remove();
  roots = [];
  containers = [];
  document.body.innerHTML = "";
});

describe("LeadConvertDialog — scope title", () => {
  it("offers a labelled, optional scope-title input carrying the accounting examples", async () => {
    const body = await renderDialog();

    const input = body.querySelector<HTMLInputElement>("#convertScopeTitle");
    expect(input).not.toBeNull();
    const label = body.querySelector('label[for="convertScopeTitle"]');
    expect(label?.textContent).toContain("Scope Title");
    expect(label?.textContent).toContain("optional");
    expect(input!.placeholder).toContain("Unit Build Back");
    expect(input!.placeholder).toContain("Balcony Repair");
    // NOT prefilled — deriving one from the lead's notes is what the census refuted.
    expect(input!.value).toBe("");
  });

  it("sends the typed title, trimmed, with the conversion", async () => {
    await renderDialog();
    await type("  Exterior Renovation  ");
    await convert();

    expect(mocks.convertLeadToOpportunity).toHaveBeenCalledWith("lead-1", {
      scopeTitle: "Exterior Renovation",
    });
  });

  it("sends null when left blank, so the bare-confirm flow is unchanged", async () => {
    await renderDialog();
    await convert();

    expect(mocks.convertLeadToOpportunity).toHaveBeenCalledWith("lead-1", { scopeTitle: null });
  });

  it(`blocks the conversion at ${DEAL_SCOPE_TITLE_MAX_LENGTH + 1} characters and never calls the API`, async () => {
    // A conversion is not undoable from this dialog, so the cap has to stop it BEFORE the lead is
    // converted — not surface as a server error after the deal exists.
    const body = await renderDialog();
    await type("A".repeat(DEAL_SCOPE_TITLE_MAX_LENGTH + 1));
    await convert();

    expect(mocks.convertLeadToOpportunity).not.toHaveBeenCalled();
    expect(body.textContent).toContain(
      `Scope title must be ${DEAL_SCOPE_TITLE_MAX_LENGTH} characters or fewer`
    );
  });

  it(`converts with exactly ${DEAL_SCOPE_TITLE_MAX_LENGTH} characters`, async () => {
    const atLimit = "A".repeat(DEAL_SCOPE_TITLE_MAX_LENGTH);
    await renderDialog();
    await type(atLimit);
    await convert();

    expect(mocks.convertLeadToOpportunity).toHaveBeenCalledWith("lead-1", { scopeTitle: atLimit });
  });
});
