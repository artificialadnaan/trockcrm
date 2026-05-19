/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectsPage } from "./ProjectsPage";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/api", () => ({ api: apiMock }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  apiMock.mockReset();
});

function renderPage() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(<MemoryRouter><ProjectsPage /></MemoryRouter>);
  return container;
}

describe("ProjectsPage", () => {
  it("renders starred and active sections, searches, and optimistically toggles stars", async () => {
    apiMock
      .mockResolvedValueOnce({ projects: [
        { id: "deal-1", name: "Roof Repair", dealNumber: "TR-1", propertyName: "Roof Repair", propertyAddress: "123 Main", stage: "Contract", lastActivityAt: null, photoCount: 2, starred: true },
        { id: "deal-2", name: "Safety Walk", dealNumber: "TR-2", propertyName: "Safety Walk", propertyAddress: "456 Main", stage: "Estimating", lastActivityAt: null, photoCount: 0, starred: false },
      ] })
      .mockResolvedValueOnce({ projects: [
        { id: "deal-1", name: "Roof Repair", dealNumber: "TR-1", propertyName: "Roof Repair", propertyAddress: "123 Main", stage: "Contract", lastActivityAt: null, photoCount: 2, starred: true },
      ] })
      .mockResolvedValueOnce({ starred: false })
      .mockResolvedValueOnce({ projects: [
        { id: "deal-2", name: "Safety Walk", dealNumber: "TR-2", propertyName: "Safety Walk", propertyAddress: "456 Main", stage: "Estimating", lastActivityAt: null, photoCount: 0, starred: false },
      ] })
      .mockResolvedValueOnce({ projects: [] });

    const node = renderPage();

    await vi.waitFor(() => expect(node.textContent).toContain("STARRED"));
    expect(node.textContent).toContain("Roof Repair");
    expect(node.textContent).toContain("ALL ACTIVE");
    expect(node.textContent).toContain("Safety Walk");

    node.querySelector<HTMLButtonElement>('[aria-label="Unstar project"]')?.click();
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/field/projects/deal-1/star", { method: "DELETE" }));

    node.querySelector<HTMLButtonElement>('[aria-label="Search projects"]')?.click();
    await vi.waitFor(() => expect(node.querySelector('input[aria-label="Search projects"]')).not.toBeNull());
    const input = node.querySelector<HTMLInputElement>('input[aria-label="Search projects"]')!;
    input.value = "Safety";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "Safety" }));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith(expect.stringContaining("search=Safety")));
  });

  it("shows empty state when no active projects exist", async () => {
    apiMock.mockResolvedValueOnce({ projects: [] }).mockResolvedValueOnce({ projects: [] });
    const node = renderPage();
    await vi.waitFor(() => expect(node.textContent).toContain("No active projects yet."));
  });
});
