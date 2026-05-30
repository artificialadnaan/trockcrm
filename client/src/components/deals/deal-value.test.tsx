// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DealValue } from "./deal-value";

describe("DealValue", () => {
  it("renders a plain amount for active deals -- no Lost bid tag, className preserved", () => {
    const html = renderToStaticMarkup(
      <DealValue
        deal={{ stageSlug: "estimating" }}
        value={65600}
        compact
        className="font-black text-slate-950"
      />
    );
    expect(html).toContain("65.6K");
    expect(html).not.toContain("Lost bid");
    expect(html).toContain("font-black");
  });

  it("greys the amount and tags 'Lost bid' for lost deals without hiding the value", () => {
    const html = renderToStaticMarkup(
      <DealValue
        deal={{ stageSlug: "lost" }}
        value={65600}
        compact
        className="font-black text-slate-950"
      />
    );
    // The preserved bid is still shown...
    expect(html).toContain("65.6K");
    // ...but labeled and greyed so it never reads as live/won value.
    expect(html).toContain("Lost bid");
    expect(html).toContain("text-muted-foreground");
  });

  it("classifies lost-stage aliases (closed_lost) as lost", () => {
    const html = renderToStaticMarkup(
      <DealValue deal={{ stageSlug: "closed_lost" }} value={42000} compact />
    );
    expect(html).toContain("Lost bid");
  });

  it("does not grey or tag won deals", () => {
    const html = renderToStaticMarkup(
      <DealValue deal={{ stageSlug: "won", workflowRoute: "normal" }} value={925000} compact />
    );
    expect(html).not.toContain("Lost bid");
  });
});
