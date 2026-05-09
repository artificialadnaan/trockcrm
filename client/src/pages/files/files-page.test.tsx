// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { FilesPage } from "./files-page";
import type { FileRecord } from "@/hooks/use-files";

const mocks = vi.hoisted(() => ({
  useFilesMock: vi.fn(),
  downloadFileMock: vi.fn(),
  deleteFileRecordMock: vi.fn(),
  useDealsMock: vi.fn(),
  useContactsMock: vi.fn(),
  useAuthMock: vi.fn(),
  fileUploadZoneMock: vi.fn(),
}));

vi.mock("@/hooks/use-files", () => ({
  useFiles: mocks.useFilesMock,
  downloadFile: mocks.downloadFileMock,
  deleteFileRecord: mocks.deleteFileRecordMock,
}));

vi.mock("@/hooks/use-deals", () => ({
  useDeals: mocks.useDealsMock,
}));

vi.mock("@/hooks/use-contacts", () => ({
  useContacts: mocks.useContactsMock,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuthMock,
}));

vi.mock("@/components/files/file-upload-zone", () => ({
  FileUploadZone: (props: Record<string, unknown>) => {
    mocks.fileUploadZoneMock(props);
    return <div data-testid="upload-zone">Upload Dropzone</div>;
  },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type,
    className,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
    className?: string;
  }) => (
    <button type={type ?? "button"} disabled={disabled} onClick={onClick} className={className}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children, className }: { children: ReactNode; className?: string }) => <div className={className}>{children}</div>,
  CardContent: ({ children, className }: { children: ReactNode; className?: string }) => <div className={className}>{children}</div>,
  CardHeader: ({ children, className }: { children: ReactNode; className?: string }) => <div className={className}>{children}</div>,
  CardTitle: ({ children, className }: { children: ReactNode; className?: string }) => <h2 className={className}>{children}</h2>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: ReactNode;
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <div data-select-value={value} data-testid={`select-${value}`}>
      <button type="button" onClick={() => onValueChange(value === "desc" ? "asc" : "desc")}>
        {children}
      </button>
    </div>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => <span data-value={value}>{children}</span>,
  SelectTrigger: ({ children, className }: { children: ReactNode; className?: string }) => <span className={className}>{children}</span>,
  SelectValue: () => <span>Select value</span>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

function makeFile(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: "file-1",
    category: "photo",
    subcategory: null,
    folderPath: null,
    tags: [],
    displayName: "Roof photo",
    systemFilename: "roof-photo.jpg",
    originalFilename: "roof-photo.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: 2400 * 1024,
    fileExtension: ".jpg",
    r2Key: "files/roof-photo.jpg",
    r2Bucket: "bucket",
    dealId: "deal-1",
    leadId: null,
    contactId: null,
    procoreProjectId: null,
    changeOrderId: null,
    description: null,
    notes: null,
    version: 1,
    parentFileId: null,
    takenAt: null,
    geoLat: null,
    geoLng: null,
    uploadedBy: "Brett Rios",
    isActive: true,
    createdAt: "2026-05-06T12:00:00.000Z",
    updatedAt: "2026-05-06T12:00:00.000Z",
    ...overrides,
  };
}

function setupFiles(files: FileRecord[]) {
  mocks.useFilesMock.mockReturnValue({
    files,
    pagination: { page: 1, limit: 200, total: files.length, totalPages: 1 },
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
}

function mountPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;

  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={["/files"]}>
        <FilesPage />
      </MemoryRouter>
    );
  });

  return {
    container,
    unmount() {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

describe("FilesPage", () => {
  let mounted: ReturnType<typeof mountPage> | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mounted?.unmount();
    mounted = null;
    vi.clearAllMocks();
    mocks.useAuthMock.mockReturnValue({ user: { id: "user-1", role: "admin" } });
    mocks.useDealsMock.mockReturnValue({
      deals: [
        {
          id: "deal-1",
          dealNumber: "TR-100",
          name: "Dallas ISD Roof Replacement",
          propertyAddress: "100 Main St",
          propertyCity: "Dallas",
          propertyState: "TX",
          projectTypeId: "reroof",
        },
      ],
    });
    mocks.useContactsMock.mockReturnValue({ contacts: [] });
    setupFiles([
      makeFile(),
      makeFile({
        id: "file-2",
        category: "contract",
        displayName: "Signed contract",
        originalFilename: "signed-contract.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: 1024 * 1024,
        fileExtension: ".pdf",
        uploadedBy: "Marcus Holloway",
        createdAt: "2026-05-07T12:00:00.000Z",
      }),
    ]);
  });

  it("renders files in grid layout", () => {
    mounted = mountPage();

    expect(mounted.container.textContent).toContain("Files");
    expect(mounted.container.textContent).toContain("Roof photo");
    expect(mounted.container.textContent).toContain("Signed contract");
    expect(mounted.container.querySelector('[data-view="grid"]')).not.toBeNull();
  });

  it("filter chips switch the visible files", () => {
    mounted = mountPage();

    act(() => {
      mounted?.container.querySelector<HTMLButtonElement>('[data-filter-tab="photos"]')?.click();
    });

    expect(mocks.useFilesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: "photo" }),
      expect.objectContaining({ enabled: true })
    );
  });

  it("search filters files", () => {
    mounted = mountPage();
    const input = mounted.container.querySelector<HTMLInputElement>('input[placeholder="Search files"]');

    act(() => {
      input!.value = "contract";
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(mocks.useFilesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: "contract" }),
      expect.objectContaining({ enabled: true })
    );
  });

  it("upload button triggers upload flow", () => {
    mounted = mountPage();

    act(() => {
      Array.from(mounted!.container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Upload"))!
        .click();
    });

    expect(mounted.container.textContent).toContain("Upload Dropzone");
    expect(mocks.fileUploadZoneMock).toHaveBeenCalledWith(expect.objectContaining({ category: "other" }));
  });

  it("file card shows correct metadata", () => {
    mounted = mountPage();

    expect(mounted.container.textContent).toContain("Roof photo");
    expect(mounted.container.textContent).toContain("2.3 MB");
    expect(mounted.container.textContent).toContain("Brett Rios");
    expect(mounted.container.textContent).toContain("Photo");
  });

  it("file-type filter narrows the list", () => {
    mounted = mountPage();

    act(() => {
      mounted?.container.querySelector<HTMLButtonElement>('[data-type-filter="contract"]')?.click();
    });

    expect(mocks.useFilesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: "contract" }),
      expect.objectContaining({ enabled: true })
    );
  });

  it("sort button cycles the API sort field", () => {
    mounted = mountPage();

    act(() => {
      mounted?.container.querySelector<HTMLButtonElement>("[data-sort-button]")?.click();
    });

    expect(mocks.useFilesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: "display_name" }),
      expect.objectContaining({ enabled: true })
    );
  });

  it("photo card delete action uses the existing delete flow", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.deleteFileRecordMock.mockResolvedValueOnce(undefined);
    const refetch = vi.fn();
    mocks.useFilesMock.mockReturnValue({
      files: [makeFile()],
      pagination: { page: 1, limit: 200, total: 1, totalPages: 1 },
      loading: false,
      error: null,
      refetch,
    });
    mounted = mountPage();

    await act(async () => {
      mounted?.container.querySelector<HTMLButtonElement>('button[aria-label="Delete Roof photo.jpg"]')?.click();
    });

    expect(confirmSpy).toHaveBeenCalledWith("Delete this file?");
    expect(mocks.deleteFileRecordMock).toHaveBeenCalledWith("file-1");
    expect(refetch).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
