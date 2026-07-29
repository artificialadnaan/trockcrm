// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Sparkline } from "./evidence-kit";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container.remove();
});

async function renderSparkline(node: React.ReactElement) {
  await act(async () => {
    root = createRoot(container);
    root.render(node);
  });
  const chart = container.querySelector("[data-testid='sparkline']")!;
  return { chart, bars: Array.from(chart.querySelectorAll<HTMLElement>("div[title]")) };
}

/**
 * The shared Sparkline is used by the Region report (8-week won trend), Forecast Confidence ("Won —
 * last 8 weeks (actuals)") and the Monday showcase department tiles. All three plot Won actuals, and a
 * deductive change order (a Won child deal with a NEGATIVE awarded_amount) can net a WEEK negative.
 */
describe("Sparkline", () => {
  it("is inert for all-positive data: bars stay bottom-anchored and max-scaled with the 3px floor", async () => {
    // The majority case must look EXACTLY as it did before the signed rendering landed: bar height =
    // max(3, (v / max) * height), sitting on the bottom of the track, no baseline rule, no offset.
    const { chart, bars } = await renderSparkline(<Sparkline values={[0, 10, 40]} height={48} />);

    expect(bars.map((b) => b.style.height)).toEqual(["3px", "12px", "48px"]);
    // No zero-line offset and no baseline element are introduced when nothing is negative.
    expect(bars.map((b) => b.style.marginBottom)).toEqual(["", "", ""]);
    expect(chart.className).toBe("flex items-end gap-1");
    expect(chart.children.length).toBe(3);
    expect(bars.every((b) => b.className.includes("rounded-t"))).toBe(true);
  });

  it("plots a negative week below a zero baseline instead of the same 3px stub as a zero week", async () => {
    // values [40, -20, 0] over 48px: the scale spans -20..40 (60), so the zero line sits 16px up.
    // Positive 40 -> 32px above the line; -20 -> 16px BELOW it; 0 -> the 3px floor stub ON the line.
    // Before the fix, -20 and 0 were both a 3px upward stub — magnitude AND direction were hidden.
    const { chart, bars } = await renderSparkline(<Sparkline values={[40, -20, 0]} height={48} />);

    const [positive, negative, zero] = bars;
    expect(positive.style.height).toBe("32px");
    expect(positive.style.marginBottom).toBe("16px"); // sits ON the zero line, not the floor
    expect(zero.style.height).toBe("3px");
    expect(zero.style.marginBottom).toBe("16px");

    // The negative bar carries real magnitude and hangs DOWN from the line (offset 0 = track floor).
    expect(negative.style.height).toBe("16px");
    expect(negative.style.marginBottom).toBe("0px");
    expect(negative.style.height).not.toBe(zero.style.height);
    // ...and is legible as a deduction: the down tone + a bottom-rounded cap, not the series colour.
    expect(negative.className).toContain("bg-rose-500");
    expect(negative.className).toContain("rounded-b");
    expect(negative.className).not.toContain("rounded-t");

    // A hairline marks the zero line so the two directions are readable against it.
    const baseline = chart.querySelector<HTMLElement>("[data-testid='sparkline-baseline']");
    expect(baseline).not.toBeNull();
    expect(baseline!.style.bottom).toBe("16px");
  });

  it("keeps an all-negative series readable rather than collapsing it onto the floor", async () => {
    // A run of deduction-only weeks: the whole track is below the line, scaled to the deepest week.
    const { bars } = await renderSparkline(<Sparkline values={[-10, -40]} height={48} />);

    expect(bars.map((b) => b.style.height)).toEqual(["12px", "48px"]);
    expect(bars.map((b) => b.style.marginBottom)).toEqual(["36px", "0px"]);
    expect(bars.every((b) => b.className.includes("bg-rose-500"))).toBe(true);
  });
});
