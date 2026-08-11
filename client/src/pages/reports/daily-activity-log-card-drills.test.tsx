// @vitest-environment jsdom
//
// The five KPI cards above the Daily Activity Log are filters. This file pins the three properties
// that make that safe rather than merely clickable:
//
//   1. A card cannot rewrite its own number. The server computes `kpis` over the WINDOW scope and
//      `pagination.total` over the narrowed one; the page must render the former on the cards. The
//      mock below is NARROWING-AWARE precisely so this is testable -- it shrinks the rows and
//      `pagination.total` exactly as the server does while holding `kpis` still, so a page that
//      wired the cards to the narrowed number would fail here instead of passing by accident.
//   2. Whatever a card applies is visible in the chip row, so it can be seen and cleared there too.
//   3. The two distinct-count cards are inert -- and inert all the way down: not buttons, not
//      focusable, no hover, no pointer. A dead control a keyboard user can Tab onto is worse than no
//      control at all.

import { describe, expect, it, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The page is gated on the DAILY_ACTIVITY_LOG_VIEWER_EMAILS allowlist and renders a denial instead of the
// report for anyone the server did not flag. These cases exercise the REPORT, so they run as a flagged
// viewer; the gate itself is covered by daily-activity-log-access.runtime.test.tsx.
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", email: "viewer@trockgc.com", canViewDailyActivityLog: true } }),
}));

vi.mock("@/components/reports/report-filter-bar", () => ({
  ReportFilterBar: () => <div>Report Filters</div>,
  useReportFilters: () => ({
    filters: { dateFrom: "2026-06-01", dateTo: "2026-06-30", office: "all", ownerNames: [] },
    query: { dateFrom: "2026-06-01", dateTo: "2026-06-30", office: "all", ownerIds: [], ownerNames: [] },
  }),
}));

type Row = {
  id: string;
  type: string;
  occurredDate: string;
  loggedDate: string;
  responsibleName: string;
  subject: string;
};

// Four entries over two days: 2 notes / 1 call / 1 meeting, and 2 of the 4 logged on another day.
// Every window KPI is therefore a DIFFERENT number from every narrowed count, so a card wired to the
// wrong one cannot coincidentally show the right value.
const ROWS: Row[] = [
  { id: "r-note-same", type: "note", occurredDate: "2026-06-02", loggedDate: "2026-06-02", responsibleName: "Alice Rep", subject: "Same-day note" },
  { id: "r-note-late", type: "note", occurredDate: "2026-06-02", loggedDate: "2026-06-05", responsibleName: "Alice Rep", subject: "Late note" },
  { id: "r-call-same", type: "call", occurredDate: "2026-06-01", loggedDate: "2026-06-01", responsibleName: "Bob Rep", subject: "Same-day call" },
  { id: "r-meet-late", type: "meeting", occurredDate: "2026-06-01", loggedDate: "2026-06-04", responsibleName: "Bob Rep", subject: "Late meeting" },
];

// WINDOW-scoped, exactly as the server returns them: fixed regardless of the narrowing.
const WINDOW_KPIS = { totalEntries: 4, notes: 2, daysCovered: 2, repsLogging: 2, offDayLogged: 2 };

function buildEntry(row: Row) {
  const diff = Math.round(
    (Date.parse(`${row.loggedDate}T00:00:00Z`) - Date.parse(`${row.occurredDate}T00:00:00Z`)) / 86_400_000
  );
  return {
    id: row.id,
    type: row.type,
    typeLabel: row.type.replace(/\b\w/g, (c) => c.toUpperCase()),
    occurredAt: `${row.occurredDate}T15:00:00.000Z`,
    occurredDate: row.occurredDate,
    loggedAt: `${row.loggedDate}T15:00:00.000Z`,
    loggedDate: row.loggedDate,
    loggedSameDay: diff === 0,
    loggedDaysDiff: diff,
    responsibleUserId: row.responsibleName,
    responsibleName: row.responsibleName,
    performedByName: null,
    subject: row.subject,
    body: null,
    outcome: null,
    nextStep: null,
    nextStepDueAt: null,
    contentRestricted: false,
    durationMinutes: null,
    targetType: null,
    targetName: null,
    dealId: null,
    dealName: null,
    dealNumber: null,
  };
}

/**
 * Stands in for the server: narrows the ROWS (and `pagination.total`, and the per-day counters) while
 * `kpis` stays on the window. That asymmetry is the contract under test.
 */
vi.mock("@/hooks/use-reports", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/use-reports")>("@/hooks/use-reports");
  return {
    ...actual,
    useDailyActivityLogReport: (options: { types?: string[]; loggedOffDay?: boolean } = {}) => {
      const types = options.types ?? [];
      const matching = ROWS.filter(
        (row) =>
          (types.length === 0 || types.includes(row.type)) &&
          (!options.loggedOffDay || row.loggedDate !== row.occurredDate)
      );

      const byDay = new Map<string, Row[]>();
      // Newest day first, stable within a day (a comparator that returns -1 for EQUAL keys silently
      // reverses same-day rows, which is how a fixture starts disagreeing with the server's order).
      const ordered = [...matching].sort((a, b) => b.occurredDate.localeCompare(a.occurredDate));
      for (const row of ordered) {
        byDay.set(row.occurredDate, [...(byDay.get(row.occurredDate) ?? []), row]);
      }

      return {
        loading: false,
        error: null,
        data: {
          kpis: WINDOW_KPIS,
          days: [...byDay.entries()].map(([date, rows]) => ({
            date,
            entryCount: rows.length,
            noteCount: rows.filter((r) => r.type === "note").length,
            repCount: new Set(rows.map((r) => r.responsibleName)).size,
            offDayLoggedCount: rows.filter((r) => r.loggedDate !== r.occurredDate).length,
            entries: rows.map(buildEntry),
          })),
          pagination: {
            page: 1,
            limit: 200,
            total: matching.length,
            returned: matching.length,
            totalPages: matching.length === 0 ? 0 : 1,
            hasMore: false,
          },
          appliedTypes: types,
          appliedLoggedOffDay: Boolean(options.loggedOffDay),
        },
      };
    },
  };
});

const { DailyActivityLogPage } = await import("./daily-activity-log-page");

const CARD_LABELS = ["Entries", "Notes", "Days With Activity", "Reps Logging", "Logged Off-Day"] as const;

const mounted: Array<() => void> = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
});

function mountLog(initialEntry = "/reports/performance/daily-activity-log") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  function LocationProbe() {
    const location = useLocation();
    return <span data-testid="search">{location.search}</span>;
  }
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <DailyActivityLogPage />
        <LocationProbe />
      </MemoryRouter>
    );
  });
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  /** The element the card's label sits directly inside: a <button> for a drill, a <div> otherwise. */
  function cardFor(label: string): HTMLElement {
    const node = Array.from(container.querySelectorAll("p")).find((p) => p.textContent?.trim() === label);
    if (!node?.parentElement) throw new Error(`KPI card not found: ${label}`);
    return node.parentElement;
  }

  return {
    container,
    cardFor,
    search: () => container.querySelector("[data-testid='search']")?.textContent ?? "",
    /** Every card's headline number, keyed by label. */
    cardValues() {
      return Object.fromEntries(
        CARD_LABELS.map((label) => [label, cardFor(label).querySelectorAll("p")[1]?.textContent ?? ""])
      );
    },
    clickCard(label: string) {
      const card = cardFor(label);
      act(() => {
        card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    chip(label: string) {
      const found = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === label
      );
      if (!found) throw new Error(`chip not found: ${label}`);
      return found;
    },
    rowSubjects() {
      return Array.from(container.querySelectorAll("li p")).map((p) => p.textContent?.trim());
    },
  };
}

describe("Daily Activity Log KPI cards — which ones are controls", () => {
  it("renders the three drills as real buttons and the two distinct-count cards as inert", () => {
    const page = mountLog();

    for (const label of ["Entries", "Notes", "Logged Off-Day"]) {
      const card = page.cardFor(label);
      // A native <button> is what makes Enter and Space activate it -- the browser's own activation
      // behaviour, not a keydown handler this page would have to get right (and jsdom would not run).
      expect(card.tagName).toBe("BUTTON");
      expect(card.getAttribute("type")).toBe("button");
      expect(card.getAttribute("aria-pressed")).toMatch(/^(true|false)$/);
    }

    // Days With Activity and Reps Logging are COUNT(DISTINCT) numbers. "Filter to days that have
    // activity" is a no-op on every row, so they are not controls -- and must not look or behave
    // like one.
    for (const label of ["Days With Activity", "Reps Logging"]) {
      const card = page.cardFor(label);
      expect(card.tagName).not.toBe("BUTTON");
      expect(card.closest("button")).toBeNull();
      expect(card.getAttribute("tabindex")).toBeNull();
      expect(card.className).not.toContain("cursor-pointer");
      expect(card.className).not.toContain("hover:");
    }
  });

  it("keeps the inert cards out of the tab order and the drills in it", () => {
    const page = mountLog();

    const focusable = Array.from(
      page.container.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")
    ).filter((el) => el.getAttribute("tabindex") !== "-1" && !el.hasAttribute("disabled"));

    for (const label of ["Entries", "Notes", "Logged Off-Day"]) {
      expect(focusable).toContain(page.cardFor(label));
    }
    for (const label of ["Days With Activity", "Reps Logging"]) {
      const card = page.cardFor(label);
      expect(focusable).not.toContain(card);
      // And it genuinely cannot take focus, not merely "is not in my query".
      card.focus();
      expect(document.activeElement).not.toBe(card);
    }
  });

  it("gives a focused drill card a visible focus ring rather than relying on the cursor", () => {
    const page = mountLog();
    const card = page.cardFor("Notes");

    card.focus();
    expect(document.activeElement).toBe(card);
    expect(card.className).toContain("focus-visible:ring-2");
    expect(card.className).toContain("focus-visible:ring-brand-red");
  });

  it("activates a focused drill card the same way a keyboard does", () => {
    // Enter/Space on a focused <button> dispatch a click through the element's activation behaviour.
    // jsdom does not implement that translation, so the honest test is: the element IS a native
    // button (asserted above), it can hold focus, and its activation runs the handler.
    const page = mountLog();
    const card = page.cardFor("Notes");

    card.focus();
    expect(document.activeElement).toBe(card);
    act(() => {
      (document.activeElement as HTMLElement).click();
    });

    expect(page.search()).toContain("types=note");
  });
});

describe("Daily Activity Log KPI cards — the counts never move", () => {
  it("holds every card number still while the log narrows underneath them", () => {
    const page = mountLog();
    const before = page.cardValues();
    expect(before).toEqual({
      Entries: "4",
      Notes: "2",
      "Days With Activity": "2",
      "Reps Logging": "2",
      "Logged Off-Day": "2",
    });
    expect(page.rowSubjects()).toHaveLength(4);

    page.clickCard("Notes");
    // The click really narrowed something -- otherwise "the counts did not change" is vacuous.
    expect(page.rowSubjects()).toEqual(["Same-day note", "Late note"]);
    expect(page.cardValues()).toEqual(before);

    page.clickCard("Logged Off-Day");
    expect(page.rowSubjects()).toEqual(["Late note"]);
    expect(page.cardValues()).toEqual(before);

    page.clickCard("Entries");
    expect(page.rowSubjects()).toHaveLength(4);
    expect(page.cardValues()).toEqual(before);
  });

  it("states the narrowed count next to the window count instead of replacing it", () => {
    const page = mountLog();
    page.clickCard("Logged Off-Day");

    // Asserted as ONE contiguous string, not as three separate toContain calls: "2", "of" and
    // "entries" each match in a dozen places on this page (the Notes card value is literally 2), so
    // checking them individually would pass even if the caption printed the same number twice.
    // 2 matched (narrowed) out of 4 in the window.
    const text = (page.container.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("Log narrowed to Logged off-day — 2 of 4 entries in this window");
  });
});

describe("Daily Activity Log KPI cards — toggling and the chip row", () => {
  it("narrows to notes, lights the Note chip and clears on a second click", () => {
    const page = mountLog();

    expect(page.cardFor("Notes").getAttribute("aria-pressed")).toBe("false");
    page.clickCard("Notes");

    expect(page.search()).toContain("types=note");
    expect(page.cardFor("Notes").getAttribute("aria-pressed")).toBe("true");
    // The narrowing is visible in the existing filter UI, not only on the card.
    expect(page.chip("Note").className).toContain("bg-brand-red");

    page.clickCard("Notes");
    expect(page.search()).not.toContain("types=");
    expect(page.cardFor("Notes").getAttribute("aria-pressed")).toBe("false");
    expect(page.chip("Note").className).not.toContain("bg-brand-red");
  });

  it("narrows to off-day entries, lights the Logging chip and clears on a second click", () => {
    const page = mountLog();

    page.clickCard("Logged Off-Day");
    expect(page.search()).toContain("loggedOffDay=1");
    expect(page.cardFor("Logged Off-Day").getAttribute("aria-pressed")).toBe("true");
    expect(page.chip("Logged off-day only").getAttribute("aria-pressed")).toBe("true");
    expect(page.chip("Logged off-day only").className).toContain("bg-brand-red");
    // Exactly the rows the card counts -- both directions of "off-day", late and dated-ahead.
    expect(page.rowSubjects()).toEqual(["Late note", "Late meeting"]);

    page.clickCard("Logged Off-Day");
    expect(page.search()).not.toContain("loggedOffDay");
    expect(page.cardFor("Logged Off-Day").getAttribute("aria-pressed")).toBe("false");
  });

  it("clears BOTH narrowings from the Entries card in one click", () => {
    const page = mountLog("/reports/performance/daily-activity-log?types=note&loggedOffDay=1&page=3");

    expect(page.cardFor("Entries").getAttribute("aria-pressed")).toBe("false");
    page.clickCard("Entries");

    expect(page.search()).not.toContain("types=");
    expect(page.search()).not.toContain("loggedOffDay");
    // A page offset from the narrowed result set does not survive the change of result set.
    expect(page.search()).not.toContain("page=");
    expect(page.cardFor("Entries").getAttribute("aria-pressed")).toBe("true");
  });

  it("does nothing at all when the lit Entries card is clicked", () => {
    // It reads "Showing every entry" -- so it must not quietly reset the page offset underneath a
    // reader who is three pages into an unnarrowed log.
    const page = mountLog("/reports/performance/daily-activity-log?page=3&dateFrom=2026-06-01");

    expect(page.cardFor("Entries").getAttribute("aria-pressed")).toBe("true");
    page.clickCard("Entries");

    expect(page.search()).toContain("page=3");
    expect(page.search()).toContain("dateFrom=2026-06-01");
  });

  it("lights Entries whenever nothing is narrowed, including via the chip row", () => {
    const page = mountLog("/reports/performance/daily-activity-log?types=call");

    expect(page.cardFor("Entries").getAttribute("aria-pressed")).toBe("false");
    // Clearing through the CHIP must relight the card: the two controls read one source of truth.
    act(() => {
      page.chip("All types").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(page.cardFor("Entries").getAttribute("aria-pressed")).toBe("true");
  });

  it("does not light the Notes card for a multi-type selection that merely includes notes", () => {
    // types=note,call is not "the log is showing notes", so the card must not claim it is.
    const page = mountLog("/reports/performance/daily-activity-log?types=note,call");
    expect(page.cardFor("Notes").getAttribute("aria-pressed")).toBe("false");
    expect(page.cardFor("Entries").getAttribute("aria-pressed")).toBe("false");
  });

  it("drops the redaction footnote when no row on the page is restricted", () => {
    // What an admin or a director now sees. The server sets contentRestricted=false on every row for
    // them, so the standing "email you do not own is not shown" note must not appear -- a note about
    // a redaction that is not happening misleads exactly as much as a missing one. The opposite case
    // (flag set -> row labelled, note shown) is pinned in daily-activity-log-page.test.tsx.
    const page = mountLog();
    const text = page.container.textContent ?? "";

    expect(text).not.toContain("Content private");
    expect(text).not.toContain("Email entries you do not own are counted");
    // The content itself renders.
    expect(text).toContain("Same-day note");
  });

  it("explains an empty result as a narrowing rather than as an empty window", () => {
    // A call logged on another day does not exist in this fixture. The log is empty while the
    // Entries card above it still reads 4 -- so the empty state has to say which one it is.
    const page = mountLog("/reports/performance/daily-activity-log?types=call&loggedOffDay=1");

    expect(page.rowSubjects()).toHaveLength(0);
    const text = page.container.textContent ?? "";
    expect(text).toContain("match the current narrowing");
    expect(text).not.toContain("No notes or updates were logged in this window.");
  });
});
