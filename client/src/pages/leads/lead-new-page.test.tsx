import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { LeadNewPage } from "./lead-new-page";

const mocks = vi.hoisted(() => ({
  leadFormMock: vi.fn(),
}));

vi.mock("@/components/leads/lead-form", () => ({
  LeadForm: (props: unknown) => {
    mocks.leadFormMock(props);
    return <div>Lead Form</div>;
  },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

function renderPage(url: string) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/leads/new" element={<LeadNewPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("LeadNewPage", () => {
  it("passes contact-origin query params into the create form", () => {
    mocks.leadFormMock.mockReset();

    renderPage(
      "/leads/new?companyId=company-1&primaryContactId=contact-1&name=Demo%20Opportunity&source=Contact%20relationship&description=QA%20Tester&projectTypeId=project-type-1"
    );

    expect(mocks.leadFormMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "create",
        initialValues: expect.objectContaining({
          companyId: "company-1",
          primaryContactId: "contact-1",
          name: "Demo Opportunity",
          source: "Contact relationship",
          description: "QA Tester",
          projectTypeId: "project-type-1",
        }),
      })
    );
  });
});
