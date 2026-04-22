import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InterventionManagerBrief } from "./intervention-manager-brief";

const brief = {
  headline: "Intervention pressure is concentrated in 2 overdue, 1 escalated-open cases.",
  summaryWindowLabel: "Compared with the prior 7 days",
  whatChanged: [
    {
      key: "escalations_up",
      tone: "worsened" as const,
      text: "Escalations rose to 2 in the last 7 days from 1 in the prior 7 days.",
      queueLink: "/admin/interventions?view=escalated",
    },
    {
      key: "plain_text",
      tone: "watch" as const,
      text: "No drill-in is available for this advisory line.",
      queueLink: null,
    },
  ],
  focusNow: [
    {
      key: "focus_overdue",
      priority: "high" as const,
      text: "Clear 2 overdue cases before they roll into more escalations.",
      queueLink: "/admin/interventions?view=overdue",
    },
  ],
  emergingPatterns: [
    {
      key: "pattern_1",
      title: "Resolve outcomes are reopening",
      summary: "50% of recent resolve conclusions reopened inside the 30-day window.",
      confidence: "high" as const,
      queueLink: "/admin/intervention-analytics#outcome-effectiveness",
    },
  ],
  groundingNote:
    "Grounded in current intervention analytics, recent intervention history, queue pressure, and outcome-effectiveness trends.",
  error: null,
};

describe("InterventionManagerBrief", () => {
  it("renders the brief sections and preserves clickable vs plain advisory items", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InterventionManagerBrief brief={brief} searchParams={new URLSearchParams()} />
      </MemoryRouter>
    );

    expect(html).toContain("Manager Brief");
    expect(html).toContain("What Changed");
    expect(html).toContain("Focus Now");
    expect(html).toContain("Emerging Patterns");
    expect(html).toContain('href="/admin/interventions?view=escalated"');
    expect(html).toContain("No drill-in is available for this advisory line.");
  });

  it("renders a local fallback state when the brief is unavailable", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InterventionManagerBrief
          brief={{
            headline: "No strong manager brief is available yet.",
            summaryWindowLabel: "Compared with the prior 7 days",
            whatChanged: [],
            focusNow: [],
            emergingPatterns: [],
            groundingNote: "Manager brief unavailable. Continue monitoring queue health and outcome trends.",
            error: "Failed to build manager brief",
          }}
          searchParams={new URLSearchParams()}
        />
      </MemoryRouter>
    );

    expect(html).toContain("Manager brief unavailable. Continue monitoring queue health and outcome trends.");
    expect(html).toContain("No strong manager brief is available yet.");
  });
});
