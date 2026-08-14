// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DetailPageShell } from "./detail-page-shell";

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

function renderShell(overrides: Partial<React.ComponentProps<typeof DetailPageShell>> = {}) {
  return (
    <MemoryRouter>
      <DetailPageShell
        parentLabel="Contacts"
        parentHref="/contacts"
        currentLabel="Jane Smith"
        iconSlot={<span>JS</span>}
        typeBadge={<span>Owner</span>}
        statusBadge={<span>Active</span>}
        title="Jane Smith"
        subtitleSlot={<span>Acme Roofing · Dallas, TX</span>}
        actionsSlot={<button>Edit</button>}
        kpis={[
          { eyebrow: "Deals", value: "12", captionLabel: "ACTIVE", captionContext: "pipeline" },
          { eyebrow: "Last Touch", value: "3d", captionContext: "since activity" },
          { eyebrow: "Risk", value: "2", accent: "red", captionContext: "open items" },
        ]}
        tabs={[
          { id: "deals", label: "Deals", icon: <span>D</span>, count: 3 },
          { id: "activity", label: "Activity", icon: <span>A</span> },
        ]}
        activeTabId="deals"
        onTabChange={() => undefined}
        rightRail={<div>Right rail metadata</div>}
        {...overrides}
      >
        <div>Tab body content</div>
      </DetailPageShell>
    </MemoryRouter>
  );
}

describe("DetailPageShell", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  it("renders breadcrumb, hero slots, kpis, tabs, body, and right rail", () => {
    const html = normalize(renderToStaticMarkup(renderShell()));

    expect(html).toContain("Contacts");
    expect(html).toContain("Jane Smith");
    expect(html).toContain("Acme Roofing");
    expect(html).toContain("Edit");
    expect(html).toContain("Deals");
    expect(html).toContain("Last Touch");
    expect(html).toContain("Right rail metadata");
    expect(html).toContain("Tab body content");
  });

  it("uses a link for breadcrumb navigation", () => {
    const html = normalize(renderToStaticMarkup(renderShell()));

    expect(html).toContain('href="/contacts"');
    expect(html).toContain("Contacts");
  });

  it("calls onTabChange when a tab is selected", () => {
    const onTabChange = vi.fn();

    act(() => {
      root = createRoot(container);
      root.render(renderShell({ activeTabId: "deals", onTabChange }) as ReactNode);
    });

    const activityTab = container.querySelector('button[aria-label="Activity"]');
    expect(activityTab).not.toBeNull();

    act(() => {
      activityTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onTabChange).toHaveBeenCalledWith("activity");

    act(() => root?.unmount());
  });

  it("renders each tab with an always-visible text label beside its icon (no hover-only tooltip)", () => {
    const html = normalize(renderToStaticMarkup(renderShell()));

    // Labels are rendered as visible text, not just an aria-label/hover tooltip, so users can read
    // each tab without hovering. (Regression: the tab strip was icon-only with a hover tooltip.)
    expect(html).toContain("<span>Deals</span>");
    expect(html).toContain("<span>Activity</span>");
    expect(html).not.toContain('role="tooltip"');
    expect(html).not.toContain("h-11 w-11");
    // aria-label is still present for assistive tech and event targeting.
    expect(html).toContain('aria-label="Deals"');
    // Count badges still render.
    expect(html).toContain(">3<");
  });

  it("renders red-accent KPI cards with the brand-red treatment", () => {
    const html = normalize(renderToStaticMarkup(renderShell()));

    expect(html).toContain("border-brand-red");
    expect(html).toContain("Risk");
  });
});
