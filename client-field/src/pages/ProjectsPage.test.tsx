/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectsPage } from "./ProjectsPage";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/api", () => ({ api: apiMock, getActiveOfficeId: () => "office-1" }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "field-1", tenantId: "office-1" } }) }));

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
        { id: "deal-1", name: "Roof Repair", dealNumber: "TR-1", projectNumber: "TR-1", propertyName: "Roof Repair", propertyAddress: "123 Main", stage: "Contract", lastActivityAt: null, photoCount: 2, starred: true, officeId: "office-1", officeSlug: "dallas" },
        { id: "deal-2", name: "Safety Walk", dealNumber: "TR-2", projectNumber: "TR-2", propertyName: "Safety Walk", propertyAddress: "456 Main", stage: "Estimating", lastActivityAt: null, photoCount: 0, starred: false, officeId: "office-1", officeSlug: "dallas" },
      ] })
      .mockResolvedValueOnce({ projects: [
        { id: "deal-1", name: "Roof Repair", dealNumber: "TR-1", projectNumber: "TR-1", propertyName: "Roof Repair", propertyAddress: "123 Main", stage: "Contract", lastActivityAt: null, photoCount: 2, starred: true, officeId: "office-1", officeSlug: "dallas" },
      ] })
      .mockResolvedValueOnce({ starred: false, officeId: "office-1", officeSlug: "dallas" })
      .mockResolvedValueOnce({ projects: [
        { id: "deal-2", name: "Safety Walk", dealNumber: "TR-2", projectNumber: "TR-2", propertyName: "Safety Walk", propertyAddress: "456 Main", stage: "Estimating", lastActivityAt: null, photoCount: 0, starred: false, officeId: "office-1", officeSlug: "dallas" },
      ] })
      .mockResolvedValueOnce({ projects: [] });

    const node = renderPage();

    await vi.waitFor(() => expect(node.textContent).toContain("STARRED"));
    expect(node.textContent).toContain("Roof Repair");
    expect(node.textContent).toContain("ALL ACTIVE");
    expect(node.textContent).toContain("Safety Walk");
    expect(node.querySelector('a[aria-label="Open Roof Repair (TR-1)"]')?.textContent).toContain("Project # TR-1");
    expect(node.querySelector('a[aria-label="Open Safety Walk (TR-2)"]')?.textContent).toContain("Project # TR-2");

    node.querySelector<HTMLButtonElement>('[aria-label="Unstar project"]')?.click();
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/field/projects/deal-1/star", { method: "DELETE" }));

    node.querySelector<HTMLButtonElement>('[aria-label="Search projects"]')?.click();
    await vi.waitFor(() => expect(node.querySelector('input[aria-label="Search projects"]')).not.toBeNull());
    const input = node.querySelector<HTMLInputElement>('input[aria-label="Search projects"]')!;
    input.value = "Safety";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "Safety" }));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith(expect.stringContaining("search=Safety")));
  });

  it("shows the canonical project number for HubSpot-imported deals — never the HS- id — and keeps duplicate names distinct", async () => {
    apiMock
      .mockResolvedValueOnce({ projects: [
        { id: "deal-1", name: "Steeplechase", dealNumber: "HS-320839598785", projectNumber: "DFW-4-15026-aa", propertyName: "Steeplechase", propertyAddress: "123 Main", stage: "Estimate Sent to Client", lastActivityAt: null, photoCount: 54, starred: false, officeId: "office-1", officeSlug: "dallas" },
        { id: "deal-2", name: "Steeplechase", dealNumber: "HS-324283495135", projectNumber: "DFW-4-15026-ab", propertyName: "Steeplechase", propertyAddress: "No address on file", stage: "Due Diligence", lastActivityAt: null, photoCount: 0, starred: false, officeId: "office-1", officeSlug: "dallas" },
      ] })
      .mockResolvedValueOnce({ projects: [] });

    const node = renderPage();

    await vi.waitFor(() => expect(node.textContent).toContain("Steeplechase"));
    expect(node.querySelector('a[aria-label="Open Steeplechase (DFW-4-15026-aa)"]')?.textContent).toContain("Project # DFW-4-15026-aa");
    expect(node.querySelector('a[aria-label="Open Steeplechase (DFW-4-15026-ab)"]')?.textContent).toContain("Project # DFW-4-15026-ab");
    // The meaningless HubSpot id must never be rendered.
    expect(node.textContent).not.toContain("HS-320839598785");
    expect(node.textContent).not.toContain("HS-324283495135");
  });

  it("shows 'Project pending' (not the HS- id) when there is no canonical project number", async () => {
    apiMock
      .mockResolvedValueOnce({ projects: [
        { id: "deal-3", name: "Park West", dealNumber: "HS-303033014984", projectNumber: null, propertyName: "Park West", propertyAddress: "789 Main", stage: "Estimating", lastActivityAt: null, photoCount: 1, starred: false, officeId: "office-1", officeSlug: "dallas" },
      ] })
      .mockResolvedValueOnce({ projects: [] });

    const node = renderPage();

    await vi.waitFor(() => expect(node.textContent).toContain("Park West"));
    expect(node.textContent).toContain("Project pending");
    expect(node.textContent).not.toContain("HS-303033014984");
  });

  it("shows empty state when no active projects exist", async () => {
    apiMock.mockResolvedValueOnce({ projects: [] }).mockResolvedValueOnce({ projects: [] });
    const node = renderPage();
    await vi.waitFor(() => expect(node.textContent).toContain("No active projects yet."));
  });
});
