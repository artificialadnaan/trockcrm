/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceOpportunityNewPage } from "./service-opportunity-new-page";
import dealListPageSource from "./deal-list-page.tsx?raw";

const mocks = vi.hoisted(() => ({
  formProps: {
    value: null as { initialValues?: Record<string, string>; officeId?: string | null } | null,
  },
}));

// The form has its own suite; here we only care WHICH prefill and office reach it.
vi.mock("@/components/deals/service-opportunity-form", () => ({
  ServiceOpportunityForm: (props: { initialValues?: Record<string, string>; officeId?: string | null }) => {
    mocks.formProps.value = props;
    return <div data-testid="service-opportunity-form" />;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Destination() {
  const location = useLocation();
  return <div data-testid="destination">{`${location.pathname}${location.search}`}</div>;
}

// A single-entry history: nothing to go BACK to, exactly like a fresh tab, a hard refresh, or a link
// someone pasted into Teams. The Back control has to work anyway.
function renderPage(entry: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/deals/service-opportunity/new" element={<ServiceOpportunityNewPage />} />
          <Route path="*" element={<Destination />} />
        </Routes>
      </MemoryRouter>
    );
  });

  return { container, root };
}

describe("ServiceOpportunityNewPage", () => {
  let roots: Root[] = [];
  let containers: HTMLElement[] = [];

  afterEach(() => {
    for (const root of roots) {
      act(() => root.unmount());
    }
    for (const container of containers) {
      container.remove();
    }
    roots = [];
    containers = [];
    mocks.formProps.value = null;
  });

  function backLink(container: HTMLElement) {
    return container.querySelector("a") as HTMLAnchorElement | null;
  }

  it("passes the URL prefill straight into the form", () => {
    const { container, root } = renderPage(
      "/deals/service-opportunity/new?propertyId=property-1&companyId=company-1&name=Building+A+opportunity&returnPropertyId=property-1"
    );
    containers.push(container);
    roots.push(root);

    expect(mocks.formProps.value?.initialValues).toEqual({
      companyId: "company-1",
      propertyId: "property-1",
      name: "Building A opportunity",
    });
  });

  it("hands the office to the FORM, not just to the back link", () => {
    // The form sends its own x-office-id, which overrides lib/api's ?officeId fallback. If it kept using the
    // rep's home office, a cross-office rep would resolve the prefilled property in the wrong schema and
    // create the deal there — so the URL office has to reach the form itself.
    const { container, root } = renderPage(
      "/deals/service-opportunity/new?propertyId=property-1&companyId=company-1&returnPropertyId=property-1&officeId=office-atlanta"
    );
    containers.push(container);
    roots.push(root);

    expect(mocks.formProps.value?.officeId).toBe("office-atlanta");
  });

  it("leaves the form on its home office when the URL carries none", () => {
    const { container, root } = renderPage("/deals/service-opportunity/new");
    containers.push(container);
    roots.push(root);

    // null, not "" — the form treats only a real id as an override.
    expect(mocks.formProps.value?.officeId).toBeNull();
  });

  it("sends Back to the originating property, carrying office context", () => {
    const { container, root } = renderPage(
      "/deals/service-opportunity/new?propertyId=property-1&returnPropertyId=property-1&officeId=office-atlanta"
    );
    containers.push(container);
    roots.push(root);

    const link = backLink(container);
    expect(link?.getAttribute("href")).toBe("/properties/property-1?officeId=office-atlanta");
    expect(link?.textContent).toContain("Property");
  });

  it("actually lands on the property with no history to pop", () => {
    const { container, root } = renderPage(
      "/deals/service-opportunity/new?propertyId=property-1&returnPropertyId=property-1&officeId=office-atlanta"
    );
    containers.push(container);
    roots.push(root);

    act(() => {
      backLink(container)?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });

    expect(container.querySelector('[data-testid="destination"]')?.textContent).toBe(
      "/properties/property-1?officeId=office-atlanta"
    );
  });

  it("falls back to the deals list when no property sent the rep here", () => {
    const { container, root } = renderPage("/deals/service-opportunity/new");
    containers.push(container);
    roots.push(root);

    const link = backLink(container);
    expect(link?.getAttribute("href")).toBe("/deals");
    expect(link?.textContent).toContain("Deals");
    // Arriving with no params must still hand the form an empty prefill, not undefined ids.
    expect(mocks.formProps.value?.initialValues).toEqual({ companyId: "", propertyId: "", name: "" });
  });

  it("leaves the existing deals-list entry point exactly as it was", () => {
    // The deals page still navigates to the bare route — no prefill, no return target, no office param — so
    // that path behaves identically to before this feature.
    expect(dealListPageSource).toContain('navigate("/deals/service-opportunity/new")');
  });
});
