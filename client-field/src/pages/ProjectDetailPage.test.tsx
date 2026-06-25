/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectDetailPage } from "./ProjectDetailPage";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/api", () => ({ api: apiMock, getActiveOfficeId: () => "office-1" }));
vi.mock("../lib/auth", () => ({
  useAuth: () => ({
    user: {
      id: "field-1",
      email: "field@example.com",
      firstName: "Field",
      lastName: "User",
    },
  }),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  apiMock.mockReset();
});

function photo(id: string, category: string, uploader = "uploader-1") {
  return {
    id,
    category: "photo",
    photoCategory: category,
    subcategory: null,
    displayName: `${category} photo`,
    mimeType: "image/jpeg",
    fileSizeBytes: 1000,
    fileExtension: ".jpg",
    dealId: "deal-1",
    description: `${category} caption`,
    tags: category === "damage" ? ["roofing", "urgent"] : ["safety"],
    takenAt: "2026-05-05T12:00:00.000Z",
    createdAt: "2026-05-05T12:00:00.000Z",
    uploadedBy: uploader,
    uploaderName: uploader === "uploader-1" ? "Field User" : "Other User",
    uploaderAvatarUrl: null,
    latitude: "35.1234567",
    longitude: "-97.1234567",
    address: "123 Main",
    addressSource: "exif",
    geocodedAt: null,
    procoreSyncStatus: null,
    deletedAt: null,
    imageUrl: "https://example.com/photo.jpg",
  };
}

function renderPage() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    <MemoryRouter initialEntries={["/projects/deal-1"]}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route path="/capture" element={<div>Capture route</div>} />
      </Routes>
    </MemoryRouter>
  );
  return container;
}

describe("ProjectDetailPage", () => {
  it("renders project photos, filters by category, opens drawer, and shows read-only viewer metadata", async () => {
    apiMock
      .mockResolvedValueOnce({ projects: [
        { id: "deal-1", name: "Roof Repair", dealNumber: "TR-1", projectNumber: "TR-1", propertyName: "Roof Repair", propertyAddress: "123 Main", stage: "Contract", lastActivityAt: null, photoCount: 2, starred: false, officeId: "office-1", officeSlug: "dallas" },
      ] })
      .mockResolvedValueOnce({ photos: [photo("photo-1", "damage"), photo("photo-2", "safety", "uploader-2")] })
      .mockResolvedValueOnce({ reports: [] });

    const node = renderPage();

    await vi.waitFor(() => expect(node.textContent).toContain("Roof Repair"));
    expect(node.querySelector("header")?.textContent).toContain("Project # TR-1");
    expect(node.querySelector('img[alt="T Rock Construction reports"]')).toBeTruthy();
    expect(node.textContent).toContain("damage caption");
    expect(node.textContent).toContain("safety caption");
    expect(node.textContent).toContain("#roofing");

    // "damage" is a retired legacy category surfaced as "Damage (legacy)" because a
    // loaded photo still carries it, keeping historical photos filterable.
    Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Damage (legacy)")?.click();
    await vi.waitFor(() => expect(node.textContent).toContain("damage caption"));
    expect(node.textContent).not.toContain("safety caption");

    node.querySelector<HTMLButtonElement>('[aria-label="Open filters"]')?.click();
    await vi.waitFor(() => expect(node.textContent).toContain("Filters"));
    expect(node.textContent).toContain("Other User");

    node.querySelector<HTMLButtonElement>('[aria-label="Close filters"]')?.click();
    await vi.waitFor(() => expect(node.textContent).not.toContain("Filters"));

    node.querySelector<HTMLButtonElement>('[aria-label="Open damage photo"]')?.click();
    await vi.waitFor(() => expect(node.textContent).toContain("Coordinates"));
    expect(node.textContent).toContain("From photo");
    expect(node.textContent).toContain("#urgent");
    expect(node.textContent).not.toContain("Delete");
    expect(node.textContent).not.toContain("Download");
  });

  it("filters photos by tag pills", async () => {
    apiMock
      .mockResolvedValueOnce({ projects: [
        { id: "deal-1", name: "Roof Repair", dealNumber: "TR-1", projectNumber: "TR-1", propertyName: "Roof Repair", propertyAddress: "123 Main", stage: "Contract", lastActivityAt: null, photoCount: 2, starred: false, officeId: "office-1", officeSlug: "dallas" },
      ] })
      .mockResolvedValueOnce({ photos: [photo("photo-1", "damage"), photo("photo-2", "safety", "uploader-2")] })
      .mockResolvedValueOnce({ reports: [] });

    const node = renderPage();

    await vi.waitFor(() => expect(node.textContent).toContain("safety caption"));
    Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "#roofing")?.click();

    await vi.waitFor(() => expect(node.textContent).toContain("damage caption"));
    expect(node.textContent).not.toContain("safety caption");
  });

  it("cycles grouping with the grouping pill", async () => {
    apiMock
      .mockResolvedValueOnce({ projects: [
        { id: "deal-1", name: "Roof Repair", dealNumber: "TR-1", projectNumber: "TR-1", propertyName: "Roof Repair", propertyAddress: "123 Main", stage: "Contract", lastActivityAt: null, photoCount: 2, starred: false, officeId: "office-1", officeSlug: "dallas" },
      ] })
      .mockResolvedValueOnce({ photos: [photo("photo-1", "damage")] })
      .mockResolvedValueOnce({ reports: [] });

    const node = renderPage();
    await vi.waitFor(() => expect(node.textContent).toContain("Roof Repair"));

    Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Date")?.click();
    await vi.waitFor(() => expect(node.textContent).toContain("Damage"));
  });

  it("routes to capture with the current project from the Add photos action", async () => {
    apiMock
      .mockResolvedValueOnce({ projects: [
        { id: "deal-1", name: "Roof Repair", dealNumber: "TR-1", projectNumber: "TR-1", propertyName: "Roof Repair", propertyAddress: "123 Main", stage: "Contract", lastActivityAt: null, photoCount: 0, starred: false, officeId: "office-1", officeSlug: "dallas" },
      ] })
      .mockResolvedValueOnce({ photos: [] })
      .mockResolvedValueOnce({ reports: [] });

    const node = renderPage();
    await vi.waitFor(() => expect(node.textContent).toContain("No photos in this project yet."));

    node.querySelector<HTMLButtonElement>('[aria-label="Add photos"]')?.click();

    await vi.waitFor(() => expect(node.textContent).toContain("Capture route"));
  });

  it("keeps the photo gallery available when reports fail to load", async () => {
    apiMock
      .mockResolvedValueOnce({ projects: [
        { id: "deal-1", name: "Roof Repair", dealNumber: "TR-1", projectNumber: "TR-1", propertyName: "Roof Repair", propertyAddress: "123 Main", stage: "Contract", lastActivityAt: null, photoCount: 1, starred: false, officeId: "office-1", officeSlug: "dallas" },
      ] })
      .mockResolvedValueOnce({ photos: [photo("photo-1", "damage")] })
      .mockRejectedValueOnce(new Error("reports unavailable"));

    const node = renderPage();

    await vi.waitFor(() => expect(node.textContent).toContain("Roof Repair"));
    expect(node.textContent).toContain("damage caption");
    expect(node.textContent).toContain("No reports yet.");
  });

  it("toggles star optimistically and rolls back when the API fails", async () => {
    apiMock
      .mockResolvedValueOnce({ projects: [
        { id: "deal-1", name: "Roof Repair", dealNumber: "TR-1", projectNumber: "TR-1", propertyName: "Roof Repair", propertyAddress: "123 Main", stage: "Contract", lastActivityAt: null, photoCount: 1, starred: false, officeId: "office-1", officeSlug: "dallas" },
      ] })
      .mockResolvedValueOnce({ photos: [photo("photo-1", "damage")] })
      .mockResolvedValueOnce({ reports: [] })
      .mockRejectedValueOnce(new Error("star failed"));

    const node = renderPage();
    await vi.waitFor(() => expect(node.textContent).toContain("Roof Repair"));

    node.querySelector<HTMLButtonElement>('[aria-label="Star project"]')?.click();

    await vi.waitFor(() => expect(node.textContent).toContain("star failed"));
    expect(apiMock).toHaveBeenLastCalledWith("/field/projects/deal-1/star", { method: "POST" });
  });

  it("applies advanced uploader filters and clears them from the drawer", async () => {
    apiMock
      .mockResolvedValueOnce({ projects: [
        { id: "deal-1", name: "Roof Repair", dealNumber: "TR-1", projectNumber: "TR-1", propertyName: "Roof Repair", propertyAddress: "123 Main", stage: "Contract", lastActivityAt: null, photoCount: 2, starred: false, officeId: "office-1", officeSlug: "dallas" },
      ] })
      .mockResolvedValueOnce({ photos: [photo("photo-1", "damage"), photo("photo-2", "safety", "uploader-2")] })
      .mockResolvedValueOnce({ reports: [] });

    const node = renderPage();
    await vi.waitFor(() => expect(node.textContent).toContain("safety caption"));

    node.querySelector<HTMLButtonElement>('[aria-label="Open filters"]')?.click();
    await vi.waitFor(() => expect(node.textContent).toContain("Other User"));
    const otherUserCheckbox = Array.from(node.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((input) => input.parentElement?.textContent?.includes("Other User"))!;
    otherUserCheckbox.click();
    Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Apply")?.click();

    await vi.waitFor(() => expect(node.textContent).toContain("safety caption"));
    expect(node.textContent).not.toContain("damage caption");

    node.querySelector<HTMLButtonElement>('[aria-label="Open filters"]')?.click();
    await vi.waitFor(() => expect(node.textContent).toContain("Clear all"));
    Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Clear all")?.click();

    await vi.waitFor(() => expect(node.textContent).toContain("damage caption"));
    expect(node.textContent).toContain("safety caption");
  });
});
