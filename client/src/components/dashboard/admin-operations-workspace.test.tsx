import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { AdminOperationsWorkspace } from "./admin-operations-workspace";

describe("AdminOperationsWorkspace", () => {
  it("renders operation tiles and supporting labels", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AdminOperationsWorkspace
          tiles={[
            { key: "ai-actions", title: "AI Actions", valueLabel: "4", secondaryLabel: "Oldest 14m", href: "/admin/ai-actions" },
          ]}
        />
      </MemoryRouter>
    );

    expect(html).toContain("AI Actions");
    expect(html).toContain("Oldest 14m");
  });
});
