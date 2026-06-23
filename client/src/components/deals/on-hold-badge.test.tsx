// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OnHoldBadge } from "./on-hold-badge";

describe("OnHoldBadge", () => {
  it("renders nothing when the deal is not on hold", () => {
    expect(renderToStaticMarkup(<OnHoldBadge onHold={false} />)).toBe("");
    expect(renderToStaticMarkup(<OnHoldBadge onHold={undefined} />)).toBe("");
    expect(renderToStaticMarkup(<OnHoldBadge onHold={null} />)).toBe("");
  });

  it("renders the On Hold flag with a data hook + accessible label when onHold is true", () => {
    const html = renderToStaticMarkup(<OnHoldBadge onHold />);

    expect(html).toContain('data-on-hold="true"');
    expect(html).toContain("On Hold");
    expect(html).toContain('aria-label="On hold"');
    expect(html).toContain("title=");
  });

  it("keeps the On Hold label in compact form (only the tooltip shortens)", () => {
    const full = renderToStaticMarkup(<OnHoldBadge onHold />);
    const compact = renderToStaticMarkup(<OnHoldBadge onHold compact />);

    expect(compact).toContain('data-on-hold="true"');
    expect(compact).toContain("On Hold");
    // the compact tooltip is shorter than the full explanatory one
    expect(compact.length).toBeLessThan(full.length);
  });

  it("merges a caller className onto the badge", () => {
    const html = renderToStaticMarkup(<OnHoldBadge onHold className="ml-2" />);

    expect(html).toContain("ml-2");
  });

  // The badge is a DUMB boolean: the (won-aware) effective-hold computation lives in the card via
  // isDealValueEffectivelyOnHold, which passes the result as `onHold`. So a far-out OPEN deal renders the
  // badge because the card passes onHold={true}, NOT because the badge inspects a close date.
  it("renders whatever effective-held boolean the caller computed (onHold=true regardless of source)", () => {
    expect(renderToStaticMarkup(<OnHoldBadge onHold />)).toContain('data-on-hold="true"');
    expect(renderToStaticMarkup(<OnHoldBadge onHold={false} />)).toBe("");
  });
});
