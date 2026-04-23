import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LeadQualificationPanel } from "./lead-qualification-panel";

const mocks = vi.hoisted(() => ({
  useLeadQualificationMock: vi.fn(),
  useProjectTypesMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { role: "rep" },
  }),
}));

vi.mock("@/hooks/use-leads", () => ({
  useLeadQualification: mocks.useLeadQualificationMock,
  updateLead: vi.fn(),
}));

vi.mock("@/hooks/use-pipeline-config", () => ({
  useProjectTypes: mocks.useProjectTypesMock,
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children }: { children: React.ReactNode }) => <label>{children}</label>,
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: ({ children, placeholder }: { children?: React.ReactNode; placeholder?: string }) => (
    <span>{children ?? placeholder}</span>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe("LeadQualificationPanel", () => {
  beforeEach(() => {
    mocks.useProjectTypesMock.mockReturnValue({
      projectTypes: [],
    });
    mocks.useLeadQualificationMock.mockReturnValue({
      loading: false,
      refetch: vi.fn(),
      qualification: {
        qualificationData: {
          projectType: "Legacy Roofing",
        },
      },
    });
  });

  it("keeps the legacy project type label visible when the lead does not have a canonical project type id yet", () => {
    const html = renderToStaticMarkup(<LeadQualificationPanel leadId="lead-1" />);

    expect(html).toContain("Legacy Roofing");
  });
});
