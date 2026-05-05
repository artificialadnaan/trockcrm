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
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/capture-upload", async () => {
  const actual = await vi.importActual<typeof import("@/lib/capture-upload")>("@/lib/capture-upload");
  return {
    ...actual,
    fileToDataUrl: captureMocks.fileToDataUrl,
    uploadSessionPhoto: captureMocks.uploadSessionPhoto,
  };
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  apiMock.mockReset();
  captureMocks.fileToDataUrl.mockReset();
  captureMocks.uploadSessionPhoto.mockReset();
  captureMocks.fileToDataUrl.mockResolvedValue("data:image/jpeg;base64,preview");
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
  apiMock
    .mockResolvedValueOnce({ projects: [
      { id: "deal-1", name: "Roof Repair", dealNumber: "TR-1", propertyName: "Roof Repair", propertyAddress: "123 Main", stage: "Contract", lastActivityAt: null, photoCount: 2, starred: true },
      { id: "deal-2", name: "Safety Walk", dealNumber: "TR-2", propertyName: "Safety Walk", propertyAddress: "456 Main", stage: "Estimating", lastActivityAt: null, photoCount: 0, starred: false },
    ] })
    .mockResolvedValueOnce({ projects: [
      { id: "deal-1", name: "Roof Repair", dealNumber: "TR-1", propertyName: "Roof Repair", propertyAddress: "123 Main", stage: "Contract", lastActivityAt: null, photoCount: 2, starred: true },
    ] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/capture" element={<CapturePage />} />
        <Route path="/projects/:id" element={<div>Project detail</div>} />
      </Routes>
    </MemoryRouter>
  );
  return container;
}

describe("CapturePage", () => {
  it("renders the gallery picker as a multi-image input without camera capture", async () => {
    const node = renderPage("/capture?dealId=deal-1");
    await vi.waitFor(() => expect(node.textContent).toContain("Roof Repair"));

    const input = node.querySelector<HTMLInputElement>('input[aria-label="Gallery photo picker"]')!;
    expect(input).toBeTruthy();
    expect(input.type).toBe("file");
    expect(input.accept).toBe("image/*");
    expect(input.multiple).toBe(true);
    expect(input.hasAttribute("capture")).toBe(false);
  });

  it("opens the project picker, searches, selects a project, and single-selects category", async () => {
    const node = renderPage();

    await vi.waitFor(() => expect(node.textContent).toContain("Choose project"));
    node.querySelector<HTMLButtonElement>('[aria-label="Choose project"]')?.click();
    await vi.waitFor(() => expect(node.textContent).toContain("Roof Repair"));

    const search = node.querySelector<HTMLInputElement>('input[aria-label="Search projects"]')!;
    search.value = "Safety";
    search.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "Safety" }));
    await vi.waitFor(() => expect(node.textContent).toContain("Safety Walk"));

    Array.from(node.querySelectorAll("button")).find((button) => button.textContent?.includes("Safety Walk"))?.click();
    await vi.waitFor(() => expect(node.textContent).toContain("Safety Walk"));
    Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Damage")?.click();
    await vi.waitFor(() => expect(node.querySelector('[aria-pressed="true"]')?.textContent).toBe("Damage"));
  });

  it("adds gallery photos to the session, removes thumbnails, and uploads remaining photos", async () => {
    const node = renderPage("/capture?dealId=deal-1");
    await vi.waitFor(() => expect(node.textContent).toContain("Roof Repair"));

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
      dealId: "deal-1",
      category: null,
      file: fileB,
    }));
  });

  it("captures a camera frame into the session", async () => {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as any;
    HTMLCanvasElement.prototype.toBlob = vi.fn((callback: BlobCallback) => callback(new Blob(["photo"], { type: "image/jpeg" }))) as any;
    const node = renderPage("/capture?dealId=deal-1");
    await vi.waitFor(() => expect(node.textContent).toContain("Roof Repair"));

    node.querySelector<HTMLButtonElement>('[aria-label="Capture photo"]')?.click();

    await vi.waitFor(() => expect(node.textContent).toContain("1 photo in this session"));
    expect(captureMocks.fileToDataUrl).toHaveBeenCalledWith(expect.objectContaining({ type: "image/jpeg" }));
  });

  it("keeps upload disabled when no project is selected", async () => {
    const node = renderPage();
    await vi.waitFor(() => expect(node.textContent).toContain("Choose project"));

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
    const node = renderPage("/capture?dealId=deal-1");
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
