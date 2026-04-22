// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PostConversionEnrichmentPanel } from "./post-conversion-enrichment-panel";

function clickButton(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text
  );
  expect(button).toBeTruthy();
  act(() => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("PostConversionEnrichmentPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.innerHTML = "";
    document.body.appendChild(container);
    // React 18 expects this flag in jsdom-based tests that call act().
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("shows progress, friendly labels, and routes actions to the matching callbacks", () => {
    const onDismiss = vi.fn();
    const onEditField = vi.fn();

    act(() => {
      root.render(
        <PostConversionEnrichmentPanel
          requiredFields={["projectTypeId", "regionId", "expectedCloseDate", "nextStep"]}
          missingFields={["projectTypeId", "expectedCloseDate", "nextStep"]}
          onDismiss={onDismiss}
          onEditField={onEditField}
        />
      );
    });

    expect(container.textContent).toContain("Complete Deal Setup");
    expect(container.textContent).toContain("1 of 4 complete");
    expect(container.textContent).toContain("Project Type");
    expect(container.textContent).toContain("Expected Close Date");
    expect(container.textContent).toContain("Next Step");

    clickButton(container, "Project Type");
    clickButton(container, "Expected Close Date");
    clickButton(container, "Next Step");
    clickButton(container, "Dismiss");

    expect(onEditField).toHaveBeenNthCalledWith(1, "projectTypeId");
    expect(onEditField).toHaveBeenNthCalledWith(2, "expectedCloseDate");
    expect(onEditField).toHaveBeenNthCalledWith(3, "nextStep");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
