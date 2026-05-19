// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContactDealsTab } from "./contact-deals-tab";

const mocks = vi.hoisted(() => ({
  useContactDealsMock: vi.fn(),
  removeContactDealAssociationMock: vi.fn(),
}));

vi.mock("@/hooks/use-contacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-contacts")>();
  return {
    ...actual,
    useContactDeals: mocks.useContactDealsMock,
    removeContactDealAssociation: mocks.removeContactDealAssociationMock,
  };
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

describe("ContactDealsTab", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;

    mocks.useContactDealsMock.mockReset();
    mocks.removeContactDealAssociationMock.mockReset();
    mocks.useContactDealsMock.mockReturnValue({
      associations: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  function renderTab() {
    act(() => {
      root = createRoot(container);
      root.render(
        <MemoryRouter initialEntries={["/contacts/contact-1"]}>
          <ContactDealsTab
            contactId="contact-1"
            contact={{
              id: "contact-1",
              firstName: "Jane",
              lastName: "Smith",
              companyId: "company-1",
              companyName: "Acme Schools",
              jobTitle: "Facilities Director",
            }}
          />
          <LocationProbe />
        </MemoryRouter>
      );
    });
  }

  it("shows a Create Lead CTA and routes to a seeded lead form", () => {
    renderTab();

    expect(container.textContent).toContain("No deals associated with this contact.");
    expect(container.textContent).toContain("Create Lead");
    expect(container.textContent).not.toContain("Create Deal");

    const button = Array.from(container.querySelectorAll("button")).find((element) => element.textContent?.includes("Create Lead"));
    expect(button).not.toBeUndefined();

    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const locationText = container.querySelector('[data-testid="location"]')?.textContent;
    const location = new URL(`https://example.test${locationText}`);

    expect(location.pathname).toBe("/leads/new");
    expect(location.searchParams.get("primaryContactId")).toBe("contact-1");
    expect(location.searchParams.get("companyId")).toBe("company-1");
    expect(location.searchParams.get("source")).toBe("Contact relationship");
  });
});
