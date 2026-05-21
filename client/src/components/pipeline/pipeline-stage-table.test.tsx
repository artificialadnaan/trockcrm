// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { PipelineStageTable } from "./pipeline-stage-table";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function renderTableDom(page: number, totalPages: number) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <PipelineStageTable
        rows={[{ name: "North Campus", owner: "Alice" }]}
        columns={[
          { key: "name", header: "Name", render: (row) => row.name },
          { key: "owner", header: "Owner", render: (row) => row.owner },
        ]}
        pagination={{ page, pageSize: 25, total: 30, totalPages }}
        onPageChange={vi.fn()}
      />
    );
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("PipelineStageTable", () => {
  it("renders rows and pagination controls", () => {
    const html = renderToStaticMarkup(
      <PipelineStageTable
        rows={[{ name: "North Campus", owner: "Alice" }]}
        columns={[
          { key: "name", header: "Name", render: (row) => row.name },
          { key: "owner", header: "Owner", render: (row) => row.owner },
        ]}
        pagination={{ page: 2, pageSize: 25, total: 30, totalPages: 2 }}
        onPageChange={vi.fn()}
      />
    );

    expect(html).toContain("North Campus");
    expect(html).toContain("Page 2 of 2");
    expect(html).toContain("30 total records");
    expect(html).toContain("text-primary");
    expect(html).toContain("disabled:bg-muted");
    expect(html).toContain("disabled:text-muted-foreground");
  });

  it("keeps the next button visibly disabled on the last page", async () => {
    const { container, cleanup } = await renderTableDom(2, 2);
    try {
      const buttons = Array.from(container.querySelectorAll("button"));
      const nextButton = buttons[1];

      expect(nextButton).toBeDefined();
      expect(nextButton.disabled).toBe(true);
      expect(nextButton.className).toContain("text-primary");
      expect(nextButton.className).toContain("disabled:bg-muted");
      expect(nextButton.className).toContain("disabled:text-muted-foreground");
    } finally {
      await cleanup();
    }
  });
});
