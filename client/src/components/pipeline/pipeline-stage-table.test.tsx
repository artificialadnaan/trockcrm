import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PipelineStageTable } from "./pipeline-stage-table";

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
  });
});
