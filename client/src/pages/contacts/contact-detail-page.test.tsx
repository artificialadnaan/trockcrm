// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContactDetailPage } from "./contact-detail-page";

const mocks = vi.hoisted(() => ({
  useContactDetailMock: vi.fn(),
  useAuthMock: vi.fn(),
  deleteContactMock: vi.fn(),
}));

vi.mock("@/hooks/use-contacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-contacts")>();
  return {
    ...actual,
    useContactDetail: mocks.useContactDetailMock,
    deleteContact: mocks.deleteContactMock,
  };
});

vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuthMock,
}));

vi.mock("@/components/contacts/contact-deals-tab", () => ({
  ContactDealsTab: () => <div>Deals tab content</div>,
}));

vi.mock("@/components/contacts/contact-email-tab", () => ({
  ContactEmailTab: () => <div>Email tab content</div>,
}));

vi.mock("@/components/contacts/contact-activity-tab", () => ({
  ContactActivityTab: () => <div>Activity tab content</div>,
}));

vi.mock("@/components/contacts/contact-file-tab", () => ({
  ContactFileTab: () => <div>Files tab content</div>,
}));

vi.mock("@/components/recordings/recording-list", () => ({
  RecordingList: () => <div>Recordings tab content</div>,
}));

vi.mock("@/components/tasks/task-create-dialog", () => ({
  TaskCreateDialog: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

function makeContact() {
  return {
    id: "contact-1",
    firstName: "Jane",
    lastName: "Smith",
    email: "jane@example.test",
    phone: "2145550100",
    normalizedPhone: "+12145550100",
    jobTitle: "Facilities Director",
    category: "owner",
    companyId: "company-1",
    companyName: "Acme Schools",
    address: "100 Main St",
    city: "Dallas",
    state: "TX",
    zip: "75201",
    notes: null,
    lastActivityAt: "2026-05-01T12:00:00.000Z",
    procoreContactId: "pc-123",
    hubspotContactId: "hs-456",
    createdAt: "2026-04-01T12:00:00.000Z",
    updatedAt: "2026-05-01T12:00:00.000Z",
  };
}

describe("ContactDetailPage", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;

    mocks.useAuthMock.mockReturnValue({
      user: { id: "user-1", role: "admin", displayName: "Admin User" },
    });
    mocks.useContactDetailMock.mockReturnValue({
      contact: makeContact(),
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mocks.deleteContactMock.mockResolvedValue(undefined);
  });

  function renderPage() {
    act(() => {
      root = createRoot(container);
      root.render(
        <MemoryRouter initialEntries={["/contacts/contact-1"]}>
          <Routes>
            <Route path="/contacts/:id" element={<ContactDetailPage />} />
          </Routes>
        </MemoryRouter>
      );
    });
  }

  it("renders the contact detail shell with contact data", () => {
    renderPage();

    expect(container.textContent).toContain("Jane Smith");
    expect(container.textContent).toContain("Acme Schools");
    expect(container.textContent).toContain("Facilities Director");
    expect(container.textContent).toContain("Deals tab content");
    expect(container.textContent).toContain("OWNER");

    act(() => root?.unmount());
  });

  it("switches tabs without changing the existing tab internals", () => {
    renderPage();

    const activityTab = container.querySelector('button[aria-label="Activity"]');
    expect(activityTab).not.toBeNull();

    act(() => {
      activityTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Activity tab content");

    act(() => root?.unmount());
  });

  it("renders right-rail contact metadata", () => {
    renderPage();

    expect(container.textContent).toContain("jane@example.test");
    expect(container.textContent).toContain("(214) 555-0100");
    expect(container.textContent).toContain("pc-123");
    expect(container.textContent).toContain("hs-456");
    expect(container.textContent).toContain("100 Main St");

    act(() => root?.unmount());
  });

  it("does not use placeholder copy for linked companies with unresolved names", () => {
    mocks.useContactDetailMock.mockReturnValue({
      contact: { ...makeContact(), companyName: null },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    renderPage();

    expect(container.querySelector('a[href="/companies/company-1"]')?.textContent).toContain("Unknown company");
    expect(container.textContent).not.toContain("Linked company");

    act(() => root?.unmount());
  });

  it("keeps the edit button wired to the contact edit route", () => {
    renderPage();

    const editLink = container.querySelector('a[href="/contacts/contact-1/edit"]');
    expect(editLink).not.toBeNull();
    expect(editLink?.textContent).toContain("Edit");

    act(() => root?.unmount());
  });
});
