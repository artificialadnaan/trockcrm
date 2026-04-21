import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { AdminOperationsWorkspace } from "./admin-operations-workspace";

describe("AdminOperationsWorkspace", () => {
  it("renders ordered operational tiles with direct links", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/"]}>
        <AdminOperationsWorkspace
          items={[
            { key: "ai-actions", label: "AI Actions", value: "6", detail: "Open AI queue items", href: "/admin/ai-actions" },
            { key: "interventions", label: "Interventions", value: "4", detail: "Open intervention cases", href: "/admin/interventions" },
          ]}
        />
      </MemoryRouter>
    );

    expect(html).toContain("AI Actions");
    expect(html).toContain("/admin/ai-actions");
    expect(html).toContain("Interventions");
  });
});
