// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DateRangeToggle } from "./date-range-toggle";

function pressedByLabel(html: string): Record<string, string | null> {
  const container = document.createElement("div");
  container.innerHTML = html;
  const map: Record<string, string | null> = {};
  container.querySelectorAll("button").forEach((button) => {
    map[button.textContent?.trim() ?? ""] = button.getAttribute("aria-pressed");
  });
  return map;
}

describe("DateRangeToggle", () => {
  it("exposes aria-pressed reflecting the active preset (D-1)", () => {
    const map = pressedByLabel(
      renderToStaticMarkup(<DateRangeToggle value="qtd" onChange={vi.fn()} />)
    );

    // The active preset button is pressed; the others are explicitly not pressed
    // (never null), matching the shared ScopeToggle accessibility contract.
    expect(map["QTD"]).toBe("true");
    expect(map["MTD"]).toBe("false");
    expect(map["YTD"]).toBe("false");
  });
});
