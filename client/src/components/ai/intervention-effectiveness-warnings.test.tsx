import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { InterventionEffectivenessWarnings } from "./intervention-effectiveness-warnings";

describe("InterventionEffectivenessWarnings", () => {
  it("renders a warning row and an empty state", () => {
    const populated = renderToStaticMarkup(
      <MemoryRouter>
        <InterventionEffectivenessWarnings
          warnings={[
            {
              kind: "snooze_reopen_risk",
              key: "waiting_on_customer",
              label: "waiting on customer",
              volume: 3,
              rate: 0.66,
              queueLink: "/admin/interventions?view=repeat",
            },
          ]}
        />
      </MemoryRouter>
    );
    const empty = renderToStaticMarkup(
      <MemoryRouter>
        <InterventionEffectivenessWarnings warnings={[]} />
      </MemoryRouter>
    );

    expect(populated).toContain("Operational Warnings");
    expect(populated).toContain("waiting on customer");
    expect(populated).toContain("66%");
    expect(empty).toContain("No high-risk conclusion patterns are active");
  });
});
