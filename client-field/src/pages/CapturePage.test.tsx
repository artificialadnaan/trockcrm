/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapturePage } from "./CapturePage";

const apiMock = vi.hoisted(() => vi.fn());
const captureMocks = vi.hoisted(() => ({
  fileToDataUrl: vi.fn(),
  uploadSessionPhoto: vi.fn(),
  extractPhotoMetadata: vi.fn(),
  getLiveGps: vi.fn(),
}));

vi.mock("../lib/api", () => ({ api: apiMock }));
vi.mock("../lib/capture-upload", async () => {
  const actual = await vi.importActual<typeof import("../lib/capture-upload")>("../lib/capture-upload");
  return {
    ...actual,
    fileToDataUrl: captureMocks.fileToDataUrl,
    uploadSessionPhoto: captureMocks.uploadSessionPhoto,
    extractPhotoMetadata: captureMocks.extractPhotoMetadata,
    getLiveGps: captureMocks.getLiveGps,
  };
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const TARGETS = [
  { id: "lead-1", type: "lead", name: "Lead One", recordNumber: null, stageName: "New", companyName: "Acme", lastUpdatedAt: "2026-05-15T10:00:00.000Z" },
  { id: "deal-2", type: "opportunity", name: "Safety Walk", recordNumber: "TR-2", stageName: "Opportunity", companyName: "Bravo", lastUpdatedAt: "2026-05-15T09:00:00.000Z" },
  { id: "deal-1", type: "deal", name: "Roof Repair", recordNumber: "TR-1", stageName: "Contract", companyName: "Acme", lastUpdatedAt: "2026-05-15T08:00:00.000Z" },
];

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    const url = new URL(path, "https://example.test");
    if (url.pathname === "/field/photo-targets/validate") {
      const leadId = url.searchParams.get("leadId");
      const opportunityId = url.searchParams.get("opportunityId");
      const dealId = url.searchParams.get("dealId");
      const target = TARGETS.find((entry) =>
        (leadId && entry.type === "lead" && entry.id === leadId) ||
        (opportunityId && entry.type === "opportunity" && entry.id === opportunityId) ||
        (dealId && entry.type === "deal" && entry.id === dealId)
      );
      if (!target) throw new Error("Capture target not found");
      return { target };
    }
    const search = (url.searchParams.get("search") ?? "").toLowerCase();
    const filtered = TARGETS.filter((target) => !search || target.name.toLowerCase().includes(search));
    return { targets: filtered };
  });
  captureMocks.fileToDataUrl.mockReset();
  captureMocks.uploadSessionPhoto.mockReset();
  captureMocks.extractPhotoMetadata.mockReset();
  captureMocks.getLiveGps.mockReset();
  captureMocks.fileToDataUrl.mockResolvedValue("data:image/jpeg;base64,preview");
  captureMocks.extractPhotoMetadata.mockResolvedValue({});
  captureMocks.getLiveGps.mockResolvedValue({ latitude: 35, longitude: -97, addressSource: "live_gps", takenAt: "2026-05-15T12:00:00.000Z" });
  captureMocks.uploadSessionPhoto.mockResolvedValue({ photo: { id: "photo-1" } });
  HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    value: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [{ stop: vi.fn() }],
      })),
    },
    configurable: true,
  });
  Object.defineProperty(globalThis.navigator, "geolocation", {
    value: {
      getCurrentPosition: vi.fn((success) => success({ coords: { latitude: 35, longitude: -97 } })),
    },
    configurable: true,
  });
});

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

function renderPage(path = "/capture") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/capture" element={<CapturePage />} />
        <Route path="/projects/:id" element={<div>Project detail</div>} />
        <Route path="/projects" element={<div>Projects page</div>} />
      </Routes>
    </MemoryRouter>
  );
  return container;
}

describe("CapturePage", () => {
  it("renders the gallery picker as a multi-image input without camera capture", async () => {
    const node = renderPage("/capture?dealId=deal-1&targetName=Roof Repair");
    await vi.waitFor(() => expect(node.textContent).toContain("Roof Repair"));

    const input = node.querySelector<HTMLInputElement>('input[aria-label="Gallery photo picker"]')!;
    expect(input.type).toBe("file");
    expect(input.accept).toBe("image/*");
    expect(input.multiple).toBe(true);
    expect(input.hasAttribute("capture")).toBe(false);
  });

  it("keeps capture disabled while validating a URL-selected target", async () => {
    apiMock.mockImplementation((path: string) => {
      const url = new URL(path, "https://example.test");
      if (url.pathname === "/field/photo-targets/validate") {
        return new Promise(() => undefined);
      }
      return Promise.resolve({ targets: TARGETS });
    });

    const node = renderPage("/capture?dealId=deal-1&targetName=Roof%20Repair");

    await vi.waitFor(() => expect(node.textContent).toContain("Validating target..."));
    expect(node.querySelector<HTMLButtonElement>('[aria-label="Capture photo"]')?.disabled).toBe(true);
  });

  it("opens the target picker, searches, selects a target, and single-selects category", async () => {
    const node = renderPage();

    await vi.waitFor(() => expect(node.textContent).toContain("Choose target"));
    node.querySelector<HTMLButtonElement>('[aria-label="Choose target"]')?.click();
    await vi.waitFor(() => expect(node.textContent).toContain("Roof Repair"));

    const search = node.querySelector<HTMLInputElement>('input[aria-label="Search targets"]')!;
    search.value = "Safety";
    search.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "Safety" }));
    await vi.waitFor(() => expect(node.textContent).toContain("Safety Walk"));

    Array.from(node.querySelectorAll("button")).find((button) => button.textContent?.includes("Safety Walk"))?.click();
    await vi.waitFor(() => expect(node.textContent).toContain("Safety Walk"));

    Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Damage")?.click();
    await vi.waitFor(() => expect(node.querySelector('[aria-pressed="true"]')?.textContent).toBe("Damage"));
  });

  it("uploads lead-target photos, clears the session, and returns to projects", async () => {
    const node = renderPage("/capture?leadId=lead-1&targetName=Lead%20One");
    await vi.waitFor(() => expect(node.textContent).toContain("Lead One"));

    const input = node.querySelector<HTMLInputElement>('input[type="file"]')!;
    const fileA = new File(["a"], "a.jpg", { type: "image/jpeg" });
    const fileB = new File(["b"], "b.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [fileA, fileB], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(node.textContent).toContain("2 photos in this session"));
    node.querySelector<HTMLButtonElement>('[aria-label="Remove a.jpg"]')?.click();
    await vi.waitFor(() => expect(node.textContent).toContain("1 photo in this session"));

    Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Upload")?.click();
    await vi.waitFor(() => expect(captureMocks.uploadSessionPhoto).toHaveBeenCalledTimes(1));
    expect(captureMocks.uploadSessionPhoto).toHaveBeenCalledWith(expect.objectContaining({
      dealId: undefined,
      leadId: "lead-1",
      category: null,
      file: fileB,
    }));
    await vi.waitFor(() => expect(node.textContent).toContain("Projects page"));
    expect(node.textContent).not.toContain("1 photo in this session");
    expect(Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Upload")).toBeUndefined();
  });

  it("uploads opportunity-target photos with opportunityId and navigates to project detail", async () => {
    const node = renderPage("/capture?opportunityId=deal-2&targetName=Safety%20Walk");
    await vi.waitFor(() => expect(node.textContent).toContain("Safety Walk"));

    const input = node.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["b"], "b.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(node.textContent).toContain("1 photo in this session"));
    Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Upload")?.click();

    await vi.waitFor(() => expect(captureMocks.uploadSessionPhoto).toHaveBeenCalledTimes(1));
    expect(captureMocks.uploadSessionPhoto).toHaveBeenCalledWith(expect.objectContaining({
      dealId: undefined,
      leadId: undefined,
      opportunityId: "deal-2",
      file,
    }));
    await vi.waitFor(() => expect(node.textContent).toContain("Project detail"));
  });

  it("captures a camera frame into the session", async () => {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as any;
    HTMLCanvasElement.prototype.toBlob = vi.fn((callback: BlobCallback) => callback(new Blob(["photo"], { type: "image/jpeg" }))) as any;
    const node = renderPage("/capture?dealId=deal-1&targetName=Roof Repair");
    await vi.waitFor(() => expect(node.textContent).toContain("Roof Repair"));

    node.querySelector<HTMLButtonElement>('[aria-label="Capture photo"]')?.click();

    await vi.waitFor(() => expect(node.textContent).toContain("1 photo in this session"));
    expect(captureMocks.fileToDataUrl).toHaveBeenCalledWith(expect.objectContaining({ type: "image/jpeg" }));
  });

  it("keeps upload disabled when no target is selected", async () => {
    const node = renderPage();
    await vi.waitFor(() => expect(node.textContent).toContain("Choose target"));

    const input = node.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [new File(["a"], "a.jpg", { type: "image/jpeg" })], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(node.textContent).toContain("1 photo in this session"));

    expect(Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Upload")?.disabled).toBe(true);
  });

  it("renders camera permission denied guidance", async () => {
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      value: { getUserMedia: vi.fn(async () => { throw new DOMException("denied", "NotAllowedError"); }) },
      configurable: true,
    });
    const node = renderPage();

    await vi.waitFor(() => expect(node.textContent).toContain("Camera access is blocked"));
  });

  it("marks failed uploads and allows retry", async () => {
    captureMocks.uploadSessionPhoto
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ photo: { id: "photo-2" } });
    const node = renderPage("/capture?dealId=deal-1&targetName=Roof Repair");
    await vi.waitFor(() => expect(node.textContent).toContain("Roof Repair"));

    const input = node.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["a"], "a.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(node.textContent).toContain("1 photo in this session"));

    Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Upload")?.click();
    await vi.waitFor(() => expect(node.textContent).toContain("network"));
    Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Retry failed")?.click();
    await vi.waitFor(() => expect(captureMocks.uploadSessionPhoto).toHaveBeenCalledTimes(2));
  });
});
