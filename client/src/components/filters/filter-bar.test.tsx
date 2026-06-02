// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilterBar, statusPatch, sortPatch, type FilterBarOptions, type FilterDimension } from "./filter-bar";
import type { FilterBarValue } from "./filterbar-params";

describe("statusPatch", () => {
  it("maps the All choice (undefined) to the omitted 'any' state, never isActive", () => {
    expect(statusPatch(undefined)).toEqual({ status: "any" });
  });
  it("passes a real status through verbatim", () => {
    expect(statusPatch("on_hold")).toEqual({ status: "on_hold" });
    expect(statusPatch("active")).toEqual({ status: "active" });
  });
});

describe("sortPatch", () => {
  const options = [
    { label: "Newest", sortBy: "created_at", sortDir: "desc" as const },
    { label: "Value", sortBy: "awarded_amount", sortDir: "desc" as const },
  ];
  it("maps the option index to {sortBy, sortDir}", () => {
    expect(sortPatch("1", options)).toEqual({ sortBy: "awarded_amount", sortDir: "desc" });
  });
  it("clears both when Default (undefined) is picked", () => {
    expect(sortPatch(undefined, options)).toEqual({ sortBy: undefined, sortDir: undefined });
  });
});

const OPTIONS: FilterBarOptions = {
  reps: [{ value: "rep-1", label: "Kevin Scott" }],
  stages: [
    { value: "opportunity", label: "Opportunity" },
    { value: "won", label: "Won" },
  ],
  sortOptions: [{ label: "Newest", sortBy: "created_at", sortDir: "desc" }],
};

describe("FilterBar", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.innerHTML = "";
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container.remove();
  });

  function render(
    dimensions: FilterDimension[],
    extra: Partial<{
      value: FilterBarValue;
      onChange: (p: Partial<FilterBarValue>) => void;
      onReset: () => void;
      stageEntryDateEnabled: boolean;
      options: FilterBarOptions;
      dateControl: {
        ariaLabel: string;
        value: string;
        options: { value: string; label: string }[];
        onChange: (v: string) => void;
      };
    }> = {}
  ) {
    act(() => {
      root?.render(
        <FilterBar
          dimensions={dimensions}
          value={extra.value ?? {}}
          onChange={extra.onChange ?? (() => {})}
          onReset={extra.onReset ?? (() => {})}
          options={extra.options ?? OPTIONS}
          stageEntryDateEnabled={extra.stageEntryDateEnabled}
          dateControl={extra.dateControl}
        />
      );
    });
  }
  const optionLabels = () =>
    Array.from(document.querySelectorAll('[role="option"]')).map((el) => el.textContent?.trim());
  const q = (sel: string) => container.querySelector<HTMLElement>(sel);

  it("renders only the configured dimensions", () => {
    render(["search", "status", "date", "stage"]);
    expect(q('input[aria-label="Search"]')).not.toBeNull();
    expect(q('button[aria-label="Status filter"]')).not.toBeNull();
    expect(q('button[aria-label="Date date filter"]')).not.toBeNull();
    expect(q('button[aria-label="Stage filter"]')).not.toBeNull();
    expect(q('button[aria-label="Rep filter"]')).toBeNull();
    expect(q('button[aria-label="Region filter"]')).toBeNull();
  });

  it("labels the date filter honestly as Won/Lost + activity when stage-entry dates are off", () => {
    render(["date"]);
    expect(q('[data-testid="date-scope-note"]')?.textContent).toContain("current state");
  });

  it("drops the honest note once stage-entry dates are enabled", () => {
    render(["date"], { stageEntryDateEnabled: true });
    expect(q('[data-testid="date-scope-note"]')).toBeNull();
  });

  it("emits an outcome-aware date window when a preset is chosen", () => {
    const onChange = vi.fn();
    render(["date"], { onChange });
    act(() => q('button[aria-label="Date date filter"]')?.click());
    // Select the preset by its stable aria-label (not free text, which also matches the chip).
    const mtd = document.querySelector<HTMLButtonElement>('button[aria-label="Show Date deals month to date"]');
    act(() => mtd?.click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ datePreset: "mtd" }));
  });

  it("renders a host-owned date control (PresetSelect) instead of the generic date filter when dateControl is provided", () => {
    const onDateChange = vi.fn();
    render(["date"], {
      dateControl: {
        ariaLabel: "Date range",
        value: "wtd",
        options: [
          { value: "dashboard", label: "Dashboard (YTD)" },
          { value: "wtd", label: "WTD" },
        ],
        onChange: onDateChange,
      },
    });
    // The custom control renders and shows the selected listRange label…
    const trigger = q('button[aria-label="Date range"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain("WTD");
    // …and the generic outcome-aware date filter (and its honesty note) are NOT rendered on this surface.
    expect(q('button[aria-label="Date date filter"]')).toBeNull();
    expect(q('[data-testid="date-scope-note"]')).toBeNull();
  });

  it("renders the host-owned date control even when 'date' is not a dimension (the host owns the date axis)", () => {
    render([], {
      dateControl: {
        ariaLabel: "Date range",
        value: "dashboard",
        options: [{ value: "dashboard", label: "Dashboard (YTD)" }],
        onChange: () => {},
      },
    });
    expect(q('button[aria-label="Date range"]')).not.toBeNull();
  });

  it("gates the stalled (days-in-stage) dimension on stage-entry dates being enabled", () => {
    render(["stalled"]);
    expect(q('button[aria-label="Stalled filter"]')).toBeNull();
    render(["stalled"], { stageEntryDateEnabled: true });
    expect(q('button[aria-label="Stalled filter"]')).not.toBeNull();
  });

  it("clears stale stalled params from the URL when the stage-entry gate is off", () => {
    const onChange = vi.fn();
    render(["status"], { onChange, value: { minAgeDays: 30 }, stageEntryDateEnabled: false });
    expect(onChange).toHaveBeenCalledWith({ minAgeDays: undefined, maxAgeDays: undefined });
  });

  it("does NOT clear stalled params when the gate is on", () => {
    const onChange = vi.fn();
    render(["stalled"], { onChange, value: { minAgeDays: 30 }, stageEntryDateEnabled: true });
    expect(onChange).not.toHaveBeenCalledWith({ minAgeDays: undefined, maxAgeDays: undefined });
  });

  it("toggles a stage selection", () => {
    const onChange = vi.fn();
    render(["stage"], { onChange });
    act(() => q('button[aria-label="Stage filter"]')?.click());
    const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"][value="won"]');
    act(() => checkbox?.click());
    expect(onChange).toHaveBeenCalledWith({ stageIds: ["won"] });
  });

  it("offers an Unassigned option on Rep by default (deals — nullable FK)", () => {
    render(["rep"]);
    act(() => q('button[aria-label="Rep filter"]')?.click());
    expect(optionLabels()).toContain("Unassigned");
  });

  it("omits the Unassigned option on Rep when allowUnassigned is false (leads — non-null FK; Codex #577)", () => {
    render(["rep"], { options: { ...OPTIONS, allowUnassigned: false } });
    act(() => q('button[aria-label="Rep filter"]')?.click());
    const labels = optionLabels();
    expect(labels).not.toContain("Unassigned");
    expect(labels).toContain("Kevin Scott"); // real reps still offered
  });

  it("labels the Rep dimension 'Owner' when repLabel is set (Companies owner variant); default stays 'Rep'", () => {
    // Default: the trigger is "Rep" (byte-identical to today's deals/pipeline/leads mounts).
    render(["rep"]);
    expect(q('button[aria-label="Rep filter"]')).not.toBeNull();
    expect(q('button[aria-label="Owner filter"]')).toBeNull();
    // Opt-in repLabel relabels the dimension for surfaces that use owner_id (e.g. Companies, #582).
    render(["rep"], { options: { ...OPTIONS, repLabel: "Owner" } });
    expect(q('button[aria-label="Owner filter"]')).not.toBeNull();
    expect(q('button[aria-label="Rep filter"]')).toBeNull();
  });

  it("derives the Rep 'All' option label from repLabel (All reps -> All owners)", () => {
    render(["rep"], { options: { ...OPTIONS, repLabel: "Owner" } });
    act(() => q('button[aria-label="Owner filter"]')?.click());
    expect(optionLabels()).toContain("All owners");
  });

  it("renders an arbitrary statusOptions set (Companies verification statuses) and replaces the deal defaults", () => {
    const COMPANY_STATUS = [
      { value: "pending", label: "Pending" },
      { value: "verified", label: "Verified" },
      { value: "rejected", label: "Rejected" },
      { value: "not_required", label: "Not required" },
    ];
    render(["status"], { options: { ...OPTIONS, statusOptions: COMPANY_STATUS } });
    act(() => q('button[aria-label="Status filter"]')?.click());
    const labels = optionLabels();
    expect(labels).toContain("Verified");
    expect(labels).toContain("Not required");
    expect(labels).not.toContain("On hold"); // deal defaults are replaced, not merged in
  });

  it("calls onReset from the Clear button", () => {
    const onReset = vi.fn();
    render(["search"], { onReset });
    act(() => q('button[aria-label="Clear filters"]')?.click());
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
