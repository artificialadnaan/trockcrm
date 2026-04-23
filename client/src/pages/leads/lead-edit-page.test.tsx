import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { LeadEditPage } from "./lead-edit-page";

const mocks = vi.hoisted(() => ({
  useLeadDetailMock: vi.fn(),
}));

let capturedOnSaved: (() => void) | undefined;

vi.mock("@/hooks/use-leads", () => ({
  useLeadDetail: mocks.useLeadDetailMock,
  formatLeadPropertyLine: () => "Dallas, TX",
}));

vi.mock("@/components/leads/lead-form", () => ({
  LeadForm: ({ onSaved }: { onSaved?: () => void }) => {
    capturedOnSaved = onSaved;
    return <div>Lead Form</div>;
  },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));

describe("LeadEditPage", () => {
  beforeEach(() => {
    capturedOnSaved = undefined;
    mocks.useLeadDetailMock.mockReturnValue({
      lead: {
        id: "lead-1",
        name: "Lead One",
        companyName: "Acme",
        stageId: "stage-new",
        propertyId: "property-1",
        property: null,
        source: "Referral",
        description: "",
        projectTypeId: null,
        projectType: null,
        qualificationPayload: {},
        projectTypeQuestionPayload: { projectTypeId: null, answers: {} },
        stageEnteredAt: "2026-04-22T00:00:00.000Z",
        convertedDealId: null,
        convertedDealNumber: null,
      },
      loading: false,
      error: null,
    });
  });

  it("passes an onSaved handler so successful edits return to the lead detail page", () => {
    renderToStaticMarkup(
      <MemoryRouter initialEntries={["/leads/lead-1/edit"]}>
        <LeadEditPage />
      </MemoryRouter>
    );

    expect(capturedOnSaved).toEqual(expect.any(Function));
  });
});
