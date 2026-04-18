import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { InterventionEffectivenessReasonTable } from "./intervention-effectiveness-reason-table";

describe("InterventionEffectivenessReasonTable", () => {
  it("renders row metrics and n/a values safely", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InterventionEffectivenessReasonTable
          title="Resolve Reason Performance"
          rows={[
            {
              key: "owner_assigned_and_confirmed",
              label: "owner assigned and confirmed",
              volume: 4,
              reopenRate: 0.25,
              durableCloseRate: 0.75,
              medianDaysToReopen: 2,
              averageDaysToDurableClose: null,
              queueLink: "/admin/interventions?view=repeat",
            },
          ]}
        />
      </MemoryRouter>
    );

    expect(html).toContain("Resolve Reason Performance");
    expect(html).toContain("owner assigned and confirmed");
    expect(html).toContain("75%");
    expect(html).toContain("25%");
    expect(html).toContain("n/a");
  });
});
