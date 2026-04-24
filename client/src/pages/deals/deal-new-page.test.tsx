import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { DealNewPage } from "./deal-new-page";

const mocks = vi.hoisted(() => ({
  dealFormMock: vi.fn(),
}));

vi.mock("@/components/deals/deal-form", () => ({
  DealForm: (props: unknown) => {
    mocks.dealFormMock(props);
    return <div>Deal Form</div>;
  },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

function renderPage(url: string) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/deals/new" element={<DealNewPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("DealNewPage", () => {
  it("passes contact-origin query params into the create form", () => {
    mocks.dealFormMock.mockReset();

    renderPage(
      "/deals/new?companyId=company-1&primaryContactId=contact-1&name=Demo%20Opportunity&source=Contact%20relationship&description=QA%20Tester&projectTypeId=project-type-1"
    );

    expect(mocks.dealFormMock).toHaveBeenCalledWith(
      expect.objectContaining({
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
