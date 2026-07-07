/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileEditModal } from "./file-edit-modal";
import type { FileRecord } from "@/hooks/use-files";

const mocks = vi.hoisted(() => ({
  updateFileMetadata: vi.fn(),
  onSaved: vi.fn(),
  onClose: vi.fn(),
}));

vi.mock("@/hooks/use-files", () => ({ updateFileMetadata: mocks.updateFileMetadata }));

// Render the dialog inline when open so the form is exercisable without Radix's portal/pointer setup.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// Replace Radix Select with a native <select> so onValueChange is deterministically drivable in jsdom.
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: ReactNode }) => (
    <select value={value} data-testid="select" onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  mocks.updateFileMetadata.mockReset();
  mocks.onSaved.mockReset();
  mocks.onClose.mockReset();
});

const baseFile = {
  id: "file-1",
  displayName: "Old Name",
  description: "old desc",
  category: "estimate",
  subcategory: "DD Estimate",
  tags: ["warranty"],
} as unknown as FileRecord;

function render(file: FileRecord | null) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<FileEditModal file={file} onClose={mocks.onClose} onSaved={mocks.onSaved} />);
  });
  return container;
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  act(() => el.dispatchEvent(new Event("input", { bubbles: true })));
}

function setSelect(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  setter.call(el, value);
  act(() => el.dispatchEvent(new Event("change", { bubbles: true })));
}

function saveBtn(c: HTMLElement): HTMLButtonElement {
  const btn = Array.from(c.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith("Save"));
  if (!btn) throw new Error("Save button not found");
  return btn as HTMLButtonElement;
}

describe("FileEditModal", () => {
  it("saves name/description/category/subcategory/tags and NEVER a folderPath", async () => {
    mocks.updateFileMetadata.mockResolvedValueOnce({});
    const c = render(baseFile);

    setValue(c.querySelector<HTMLInputElement>("#file-edit-name")!, "New Name");
    setValue(c.querySelector<HTMLTextAreaElement>("#file-edit-desc")!, "New desc");
    setValue(c.querySelector<HTMLInputElement>("#file-edit-tags")!, "a, b ,");

    await act(async () => {
      saveBtn(c).click();
    });

    expect(mocks.updateFileMetadata).toHaveBeenCalledTimes(1);
    const [id, payload] = mocks.updateFileMetadata.mock.calls[0];
    expect(id).toBe("file-1");
    expect(payload).toEqual({
      displayName: "New Name",
      description: "New desc",
      category: "estimate",
      subcategory: "DD Estimate",
      tags: ["a", "b"],
    });
    expect(payload).not.toHaveProperty("folderPath");
    expect(mocks.onSaved).toHaveBeenCalledTimes(1);
    expect(mocks.onClose).toHaveBeenCalledTimes(1);
  });

  it("clearing to an empty name blocks the save with an error", async () => {
    const c = render(baseFile);
    setValue(c.querySelector<HTMLInputElement>("#file-edit-name")!, "   ");
    await act(async () => {
      saveBtn(c).click();
    });
    expect(mocks.updateFileMetadata).not.toHaveBeenCalled();
    expect(c.textContent).toContain("Name is required.");
  });

  it("changing category to one without subcategories clears the subcategory (sends null)", async () => {
    mocks.updateFileMetadata.mockResolvedValueOnce({});
    const c = render(baseFile);

    // First select is the category select.
    const categorySelect = c.querySelectorAll<HTMLSelectElement>('[data-testid="select"]')[0];
    setSelect(categorySelect, "contract"); // contract offers no subcategory options

    await act(async () => {
      saveBtn(c).click();
    });

    const [, payload] = mocks.updateFileMetadata.mock.calls[0];
    expect(payload.category).toBe("contract");
    expect(payload.subcategory).toBeNull();
  });
});
