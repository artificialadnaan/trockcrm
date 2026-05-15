// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildUnifiedCaptureHref, groupPhotoUploadTargets, PhotoCapturePage } from "./photo-capture-page";
import type { PhotoUploadTarget } from "@/hooks/use-files";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  searchPhotoUploadTargets: vi.fn(),
  uploadFile: vi.fn(),
  useAuth: vi.fn(),
}));

vi.mock("@/hooks/use-files", () => ({
  searchPhotoUploadTargets: mocks.searchPhotoUploadTargets,
  uploadFile: mocks.uploadFile,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuth,
}));

vi.mock("@/lib/field-app", () => ({
  buildFieldCaptureUrl: (search = "") => `https://field.example.com/capture${search}`,
}));

function target(input: Partial<PhotoUploadTarget> & Pick<PhotoUploadTarget, "id" | "type">): PhotoUploadTarget {
  return {
    name: input.name ?? input.id,
    recordNumber: input.recordNumber ?? null,
    stageName: input.stageName ?? null,
    companyName: input.companyName ?? null,
    lastUpdatedAt: input.lastUpdatedAt ?? "2026-04-27T00:00:00.000Z",
    ...input,
  };
}

describe("photo capture upload targets", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.searchPhotoUploadTargets.mockReset();
    mocks.uploadFile.mockReset();
    mocks.useAuth.mockReturnValue({ user: { activeOfficeId: "office-atl" } });
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container.remove();
  });

  it("groups searchable upload targets by record lifecycle section", () => {
    const grouped = groupPhotoUploadTargets([
      target({ id: "lead-1", type: "lead" }),
      target({ id: "opp-1", type: "opportunity" }),
      target({ id: "deal-1", type: "deal" }),
      target({ id: "lead-2", type: "lead" }),
    ]);

    expect(grouped.lead.map((entry) => entry.id)).toEqual(["lead-1", "lead-2"]);
    expect(grouped.opportunity.map((entry) => entry.id)).toEqual(["opp-1"]);
    expect(grouped.deal.map((entry) => entry.id)).toEqual(["deal-1"]);
  });

  it("builds the unified capture link from the selected target instead of stale search params", () => {
    const href = buildUnifiedCaptureHref(
      new URLSearchParams("dealId=old-deal&dealName=Old%20Deal"),
      target({ id: "lead-1", type: "lead", name: "Lead One" }),
      "office-atl"
    );

    const url = new URL(href!);
    expect(url.searchParams.get("leadId")).toBe("lead-1");
    expect(url.searchParams.get("targetName")).toBe("Lead One");
    expect(url.searchParams.get("officeId")).toBe("office-atl");
    expect(url.searchParams.get("dealId")).toBeNull();
  });

  it("updates the unified capture link when the selected target changes", async () => {
    mocks.searchPhotoUploadTargets.mockResolvedValue([
      target({ id: "lead-1", type: "lead", name: "Lead One" }),
    ]);

    await act(async () => {
      root = createRoot(container);
      root.render(
        <MemoryRouter initialEntries={["/photos/capture?dealId=old-deal&dealName=Old%20Deal"]}>
          <PhotoCapturePage />
        </MemoryRouter>
      );
    });

    const linkBefore = Array.from(container.querySelectorAll<HTMLAnchorElement>("a"))
      .find((link) => link.textContent?.includes("Open unified capture"));
    expect(linkBefore?.href).toContain("dealId=old-deal");

    const clearButton = container.querySelector<HTMLButtonElement>('[aria-label="Clear selected project"]');
    expect(clearButton).toBeTruthy();
    await act(async () => {
      clearButton!.click();
    });

    await vi.waitFor(() => expect(container.textContent).toContain("Lead One"));
    const leadButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Lead One"));
    expect(leadButton).toBeTruthy();

    await act(async () => {
      leadButton!.click();
    });

    const linkAfter = Array.from(container.querySelectorAll<HTMLAnchorElement>("a"))
      .find((link) => link.textContent?.includes("Open unified capture"));
    expect(linkAfter?.href).toContain("leadId=lead-1");
    expect(linkAfter?.href).not.toContain("dealId=old-deal");
  });
});
