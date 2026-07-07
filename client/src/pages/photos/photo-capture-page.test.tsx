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

// Shared render-target lifecycle for BOTH suites: a fresh container each test, unmounted + removed after
// (resetting root so a non-rendering test never re-unmounts a prior test's tree). Top-level hooks run
// before/after each describe's own beforeEach — the mock setup below stays per-suite.
let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = undefined;
  }
  container.remove();
});

describe("photo capture upload targets", () => {
  beforeEach(() => {
    mocks.searchPhotoUploadTargets.mockReset();
    mocks.uploadFile.mockReset();
    mocks.useAuth.mockReturnValue({ user: { activeOfficeId: "office-atl" } });
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

describe("photo capture per-photo notes", () => {
  function setInputValue(el: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function addFiles(files: File[]) {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: files, configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  // Each queued photo's note now carries a UNIQUE aria-label ("Note for photo 1", "2", …). Match the prefix
  // so the helper returns them in DOM (queue) order — index 0 is "Note for photo 1", etc.
  function noteInputs() {
    return Array.from(container.querySelectorAll<HTMLInputElement>('input[aria-label^="Note for photo "]'));
  }

  beforeEach(() => {
    mocks.searchPhotoUploadTargets.mockReset();
    mocks.searchPhotoUploadTargets.mockResolvedValue([]);
    mocks.uploadFile.mockReset();
    mocks.uploadFile.mockResolvedValue(undefined);
    mocks.useAuth.mockReturnValue({ user: { activeOfficeId: "office-atl" } });
    (globalThis.URL.createObjectURL as unknown) = vi.fn(() => "blob:preview");
    (globalThis.URL.revokeObjectURL as unknown) = vi.fn();
  });

  async function renderWithDeal() {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <MemoryRouter initialEntries={["/photos/capture?dealId=deal-1&dealName=Deal%20One"]}>
          <PhotoCapturePage />
        </MemoryRouter>
      );
    });
  }

  it("gives every queued photo its OWN note field — editing one never touches the others", async () => {
    await renderWithDeal();
    await addFiles([
      new File(["a"], "a.jpg", { type: "image/jpeg" }),
      new File(["b"], "b.jpg", { type: "image/jpeg" }),
    ]);

    const inputs = noteInputs();
    expect(inputs).toHaveLength(2);
    // Each note input has its OWN unique aria-label (a11y: no two inputs share a name).
    expect(inputs.map((el) => el.getAttribute("aria-label"))).toEqual(["Note for photo 1", "Note for photo 2"]);

    await act(async () => {
      setInputValue(inputs[0], "north wall crack");
    });

    const after = noteInputs();
    expect(after[0].value).toBe("north wall crack");
    // The sibling photo's note stays blank — no apply-to-all.
    expect(after[1].value).toBe("");
  });

  it("uploads each photo with ITS OWN note; a blank note sends no description", async () => {
    await renderWithDeal();
    await addFiles([
      new File(["a"], "a.jpg", { type: "image/jpeg" }),
      new File(["b"], "b.jpg", { type: "image/jpeg" }),
    ]);

    await act(async () => {
      setInputValue(noteInputs()[0], "north wall crack");
    });

    const uploadButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((b) => b.textContent?.includes("Upload"));
    expect(uploadButton).toBeTruthy();
    await act(async () => {
      uploadButton!.click();
    });

    await vi.waitFor(() => expect(mocks.uploadFile).toHaveBeenCalledTimes(2));

    const byName = (name: string) =>
      mocks.uploadFile.mock.calls.map((c) => c[0]).find((arg) => (arg.file as File).name === name);
    expect(byName("a.jpg")?.description).toBe("north wall crack");
    // Blank note → no description at all (not "" and not a sibling's note).
    expect(byName("b.jpg")?.description).toBeUndefined();
  });
});
