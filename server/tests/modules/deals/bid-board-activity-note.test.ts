import { describe, expect, it } from "vitest";
import {
  ACTIVITY_BODY_SQL_CHAR_LIMIT,
  MAX_ACTOR_CHARS,
  MAX_BODY_CHARS,
  MAX_ENTRIES,
  MAX_LABEL_CHARS,
  MAX_NOTE_CHARS,
  MAX_OUTCOME_CHARS,
  formatBidBoardActivityNote,
  type ActivityNoteEntry,
} from "../../../src/modules/deals/bid-board-activity-note.js";

/**
 * The pure half of the Bid Board activity note. This block is what an estimator opening a
 * CRM-created Bid Board project in Procore reads instead of "no sales history at all", and its FIRST
 * LINE is the marker SyncHub matches on to avoid stacking four copies of the same note on a retry —
 * so the heading shape is a contract, not cosmetics.
 */

const GENERATED_AT = new Date("2026-08-17T15:00:00Z"); // 10:00 CDT on Aug 17

function entry(overrides: Partial<ActivityNoteEntry> = {}): ActivityNoteEntry {
  return {
    type: "note",
    occurredAt: "2026-08-14T16:00:00Z",
    subject: null,
    body: "Some body",
    outcome: null,
    durationMinutes: null,
    actorName: "Jane Rep",
    ...overrides,
  };
}

describe("formatBidBoardActivityNote", () => {
  it("renders the exact block the design spec specifies", () => {
    const note = formatBidBoardActivityNote({
      projectLabel: "TR-26-0412",
      generatedAt: GENERATED_AT,
      olderCount: 12,
      entries: [
        entry({
          type: "call",
          occurredAt: "2026-08-14T16:00:00Z",
          outcome: "connected",
          durationMinutes: 15,
          actorName: "Jane Rep",
          body: "Owner confirmed scope; wants alternates priced.",
        }),
        entry({
          type: "site_visit",
          occurredAt: "2026-08-12T16:00:00Z",
          actorName: "Bob Estimator",
          body: "Roof access via north stair only.",
        }),
        entry({
          type: "note",
          occurredAt: "2026-08-08T16:00:00Z",
          actorName: "Jane Rep",
          body: "Referred by the GC on the Maple job.",
        }),
      ],
    });

    expect(note).toBe(
      [
        "CRM Activity Log — TR-26-0412 (as of Aug 17, 2026)",
        "",
        "Aug 14, 2026 · Call (connected, 15 min) · Jane Rep",
        "  Owner confirmed scope; wants alternates priced.",
        "Aug 12, 2026 · Site Visit · Bob Estimator",
        "  Roof access via north stair only.",
        "Aug 08, 2026 · Note · Jane Rep",
        "  Referred by the GC on the Maple job.",
        "… 12 older entries not shown (open the deal in the CRM)",
      ].join("\n")
    );
  });

  it("returns null for a deal with no activity (so SyncHub posts no note at all)", () => {
    expect(
      formatBidBoardActivityNote({ projectLabel: "TR-26-0001", generatedAt: GENERATED_AT, entries: [] })
    ).toBeNull();
  });

  it("starts with the idempotency marker SyncHub matches on", () => {
    const note = formatBidBoardActivityNote({
      projectLabel: "TR-26-0412",
      generatedAt: GENERATED_AT,
      entries: [entry()],
    });
    // SyncHub's guard tests `startsWith("CRM Activity Log — <projectNumber>")` — the project label must
    // therefore appear on the first line, before the "as of" date, and nothing may precede it.
    expect(note!.startsWith("CRM Activity Log — TR-26-0412")).toBe(true);
  });

  it("omits no entry and adds no trailing line when the whole history fits", () => {
    const note = formatBidBoardActivityNote({
      projectLabel: "TR-26-0412",
      generatedAt: GENERATED_AT,
      olderCount: 0,
      entries: [entry({ body: "One" }), entry({ body: "Two" })],
    });
    expect(note).not.toContain("older entries not shown");
    expect(note).toContain("  One");
    expect(note).toContain("  Two");
  });

  describe("ordering", () => {
    it("preserves the caller's newest-first order verbatim (the loader's ORDER BY is authoritative)", () => {
      const note = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries: [
          entry({ occurredAt: "2026-08-14T16:00:00Z", body: "newest" }),
          entry({ occurredAt: "2026-08-12T16:00:00Z", body: "middle" }),
          entry({ occurredAt: "2026-08-08T16:00:00Z", body: "oldest" }),
        ],
      });
      expect(note!.indexOf("newest")).toBeLessThan(note!.indexOf("middle"));
      expect(note!.indexOf("middle")).toBeLessThan(note!.indexOf("oldest"));
    });

    it("keeps the NEWEST entries when a cap binds, never a tail slice", () => {
      const entries = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) =>
        entry({ body: `entry-${String(i).padStart(3, "0")}` })
      );
      const note = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries,
      });
      expect(note).toContain("entry-000");
      expect(note).toContain(`entry-${String(MAX_ENTRIES - 1).padStart(3, "0")}`);
      expect(note).not.toContain(`entry-${String(MAX_ENTRIES).padStart(3, "0")}`);
    });
  });

  describe("caps", () => {
    it("emits at most MAX_ENTRIES and reports the rest on the trailing line", () => {
      // Short bodies, so the ENTRY cap is what binds rather than the char cap.
      const entries = Array.from({ length: 50 }, (_, i) => entry({ body: `n${i}` }));
      const note = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries,
      });

      const emitted = note!.split("\n").filter((line) => line.startsWith("Aug ")).length;
      expect(emitted).toBe(MAX_ENTRIES);
      expect(note).toContain(`… ${50 - MAX_ENTRIES} older entries not shown (open the deal in the CRM)`);
    });

    it("keeps the SQL transfer bound strictly above the formatter's own limit", () => {
      // Not a style preference — a load-bearing invariant. The formatter decides "was this clamped?"
      // by `length <= MAX_BODY_CHARS`, so a SQL bound OF exactly MAX_BODY_CHARS would deliver a
      // 401-char body as 400 and render it as though it were complete, silently losing a character
      // and its `…`. Anything at or below MAX_BODY_CHARS here is a correctness bug, not a tuning one.
      expect(ACTIVITY_BODY_SQL_CHAR_LIMIT).toBeGreaterThan(MAX_BODY_CHARS);
    });

    it("clamps each body to MAX_BODY_CHARS with a … marker", () => {
      const note = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries: [entry({ body: "L".repeat(MAX_BODY_CHARS + 500) })],
      });

      const bodyLine = note!.split("\n").find((line) => line.startsWith("  L"))!;
      // Two spaces of indent plus a body clamped so the body itself (marker included) is MAX_BODY_CHARS.
      expect(bodyLine).toHaveLength(MAX_BODY_CHARS + 2);
      expect(bodyLine.endsWith("…")).toBe(true);
      expect(note).not.toContain("L".repeat(MAX_BODY_CHARS + 1));
    });

    it("lets the CHAR cap bind before the entry cap, counting the char-dropped entries into N", () => {
      // 30 maximal bodies cannot fit in MAX_NOTE_CHARS, so fewer than 30 (and fewer than MAX_ENTRIES)
      // are emitted — MAX_ENTRIES is a ceiling, not a target.
      const entries = Array.from({ length: 30 }, (_, i) =>
        entry({ body: `${String(i).padStart(3, "0")}${"X".repeat(MAX_BODY_CHARS + 200)}` })
      );
      const note = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries,
      });

      const emitted = note!.split("\n").filter((line) => line.startsWith("Aug ")).length;
      expect(emitted).toBeGreaterThan(0);
      expect(emitted).toBeLessThan(30);
      expect(emitted).toBeLessThan(MAX_ENTRIES);
      // N counts everything not emitted, whether the entry cap or the char cap dropped it.
      expect(note).toContain(`… ${30 - emitted} older entries not shown`);
      expect(note!.length).toBeLessThanOrEqual(MAX_NOTE_CHARS);
    });

    it("never exceeds MAX_NOTE_CHARS even for a pathological history", () => {
      const entries = Array.from({ length: 500 }, () => entry({ body: "Z".repeat(5_000) }));
      const note = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries,
      });
      expect(note!.length).toBeLessThanOrEqual(MAX_NOTE_CHARS);
    });

    it("clamps a pathological project label so the HEADING alone cannot blow the cap", () => {
      // projectLabel falls back to `deals.name`, an unbounded text column. Before the clamp the heading
      // was added to the running total but never bounded itself, so the cap was not an invariant.
      const note = formatBidBoardActivityNote({
        projectLabel: "L".repeat(50_000),
        generatedAt: GENERATED_AT,
        entries: [entry()],
      });

      const heading = note!.split("\n")[0];
      expect(heading.startsWith("CRM Activity Log — ")).toBe(true);
      expect(heading.length).toBeLessThan(MAX_LABEL_CHARS + 80);
      expect(note!.length).toBeLessThanOrEqual(MAX_NOTE_CHARS);
    });

    it("holds the cap for a SINGLE pathological entry", () => {
      // The actor name is `users.display_name`, also unbounded text. One entry carrying 50k of it used
      // to sail past the cap: the shed loop stopped with one entry left and never re-checked.
      const note = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries: [entry({ actorName: "N".repeat(50_000), body: "B".repeat(50_000) })],
        olderCount: 3,
      });

      expect(note!.length).toBeLessThanOrEqual(MAX_NOTE_CHARS);
      expect(note!.split("\n")[0].startsWith("CRM Activity Log — TR-26-0412")).toBe(true);
      // Clamped, not dropped — the entry is still readable.
      expect(note).toContain("N".repeat(MAX_ACTOR_CHARS - 1) + "…");
    });

    it("holds the cap when EVERY unbounded input is pathological at once", () => {
      const note = formatBidBoardActivityNote({
        projectLabel: "L".repeat(50_000),
        generatedAt: GENERATED_AT,
        entries: Array.from({ length: 200 }, () =>
          entry({
            actorName: "N".repeat(50_000),
            body: "B".repeat(50_000),
            subject: "S".repeat(50_000),
            outcome: "O".repeat(50_000),
          })
        ),
        olderCount: 99,
      });

      expect(note!.length).toBeLessThanOrEqual(MAX_NOTE_CHARS);
    });

    it("adds the loader's known-older count to the entries it dropped itself", () => {
      const entries = Array.from({ length: 45 }, (_, i) => entry({ body: `n${i}` }));
      const note = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries,
        olderCount: 7,
      });
      // 45 - 40 emitted = 5 dropped here, plus the 7 the loader already knew about.
      expect(note).toContain("… 12 older entries not shown");
    });

    it("says 'older entry' when exactly one is hidden", () => {
      // An estimator reads this line in Procore; "1 older entries not shown" is a typo in production.
      const note = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries: Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => entry({ body: `n${i}` })),
      });
      expect(note).toContain("… 1 older entry not shown (open the deal in the CRM)");
      expect(note).not.toContain("1 older entries");
    });

    it("keeps the plural for a floor of one (1+ means at least one, possibly many)", () => {
      const note = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries: [entry()],
        olderCount: 1,
        olderCountIsFloor: true,
      });
      expect(note).toContain("… 1+ older entries not shown");
    });

    it("marks the count as a floor when the loader's window filled up", () => {
      const note = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries: Array.from({ length: 45 }, (_, i) => entry({ body: `n${i}` })),
        olderCount: 1,
        olderCountIsFloor: true,
      });
      // "6+" rather than "6": the loader only knows there is AT LEAST one more, so a bare number
      // would be a quiet undercount.
      expect(note).toContain("… 6+ older entries not shown");
    });
  });

  describe("astral characters are never split by a clamp", () => {
    /**
     * Finds a lone surrogate: a high surrogate not followed by a low one, or a low not preceded by a
     * high. Such a string has no valid UTF-8 encoding — JSON.stringify emits a bare "\ud83d" escape and
     * the job_queue INSERT fails with `invalid input syntax for type json`.
     *
     * That INSERT sits OUTSIDE loadCrmActivityLog's savepoint, so this does not degrade to a null note:
     * it 500s the RFP trigger route and aborts the tenant transaction. Hence a hard test, not a nicety.
     */
    const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const EMOJI = "🚧"; // U+1F6A7 — a surrogate PAIR in UTF-16, i.e. .length === 2

    /** `n` single-unit chars, then an emoji whose HIGH surrogate sits at index `n`, then filler. */
    const emojiAt = (n: number) => "x".repeat(n) + EMOJI + "tail".repeat(200);

    function assertWellFormed(note: string | null, label: string) {
      expect(note, label).not.toBeNull();
      expect(LONE_SURROGATE.test(note!), `lone surrogate with ${label}`).toBe(false);
      // The real consequence, asserted directly rather than by proxy.
      expect(() => JSON.parse(JSON.stringify({ crmActivityLog: note })), label).not.toThrow();
      expect(JSON.stringify(note), label).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
    }

    /**
     * Sweeps the emoji ACROSS a clamp boundary rather than hard-coding which index splits it.
     *
     * clampTo cuts at `max - 1` (one unit is reserved for the `…`), so the pair is split only when the
     * HIGH surrogate lands at `max - 2`. That is an easy off-by-one, and getting it wrong makes the
     * test pass vacuously against a broken implementation — which is exactly what happened on the
     * first draft of this suite. Sweeping the neighbourhood removes the trap.
     */
    function sweepBoundary(boundary: number, build: (emojiIndex: number) => string | null) {
      for (const offset of [-3, -2, -1, 0, 1]) {
        const index = boundary + offset;
        assertWellFormed(build(index), `emoji at index ${index} (boundary ${boundary} ${offset})`);
      }
    }

    it("does not split a pair across the BODY clamp", () => {
      sweepBoundary(MAX_BODY_CHARS, (i) =>
        formatBidBoardActivityNote({
          projectLabel: "TR-26-0412",
          generatedAt: GENERATED_AT,
          entries: [entry({ body: emojiAt(i) })],
        })
      );
    });

    it("does not split a pair across the SUBJECT clamp", () => {
      sweepBoundary(MAX_BODY_CHARS, (i) =>
        formatBidBoardActivityNote({
          projectLabel: "TR-26-0412",
          generatedAt: GENERATED_AT,
          entries: [entry({ subject: emojiAt(i), body: "plain" })],
        })
      );
    });

    it("does not split a pair across the ACTOR clamp", () => {
      // users.display_name > 80 chars ending mid-emoji at index 79 — entirely realistic.
      sweepBoundary(MAX_ACTOR_CHARS, (i) =>
        formatBidBoardActivityNote({
          projectLabel: "TR-26-0412",
          generatedAt: GENERATED_AT,
          entries: [entry({ actorName: emojiAt(i) })],
        })
      );
    });

    it("does not split a pair across the OUTCOME clamp", () => {
      sweepBoundary(MAX_OUTCOME_CHARS, (i) =>
        formatBidBoardActivityNote({
          projectLabel: "TR-26-0412",
          generatedAt: GENERATED_AT,
          entries: [entry({ type: "call", outcome: emojiAt(i) })],
        })
      );
    });

    it("does not split a pair across the LABEL clamp", () => {
      // projectLabel falls back to deals.name, so a long emoji-bearing deal name reaches this.
      sweepBoundary(MAX_LABEL_CHARS, (i) =>
        formatBidBoardActivityNote({
          projectLabel: emojiAt(i),
          generatedAt: GENERATED_AT,
          entries: [entry()],
        })
      );
    });

    it("does not split a pair at the whole-note backstop", () => {
      // Drive the note past MAX_NOTE_CHARS with astral content everywhere, so the FINAL slice — not a
      // per-field clamp — is what can land inside a pair.
      sweepBoundary(MAX_BODY_CHARS, (i) => {
        const note = formatBidBoardActivityNote({
          projectLabel: emojiAt(i),
          generatedAt: GENERATED_AT,
          entries: Array.from({ length: 300 }, () =>
            entry({ actorName: emojiAt(i), subject: emojiAt(i), body: emojiAt(i) })
          ),
          olderCount: 12,
        });
        expect(note!.length).toBeLessThanOrEqual(MAX_NOTE_CHARS);
        return note;
      });
    });

    it("keeps the emoji whole when it fits, rather than defensively dropping it", () => {
      const note = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries: [entry({ body: `Roof hatch blocked ${EMOJI} — need access` })],
      });
      expect(note).toContain(`Roof hatch blocked ${EMOJI} — need access`);
      assertWellFormed(note, "emoji well within the cap");
    });
  });
  describe("America/Chicago date rendering", () => {
    it("renders the CT calendar day, not the UTC one, for a late-evening CT timestamp", () => {
      // 02:00Z on Aug 15 is 21:00 CDT on Aug 14 — a rep writing up the day's calls. A UTC render would
      // date this activity a day late.
      const note = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries: [entry({ occurredAt: "2026-08-15T02:00:00Z", body: "late write-up" })],
      });
      expect(note).toContain("Aug 14, 2026 · Note · Jane Rep");
      expect(note).not.toContain("Aug 15, 2026");
    });

    it("keeps a late-UTC-evening timestamp on its own CT day", () => {
      // 22:00Z is 17:00 CDT the SAME day — the guard against an over-eager offset in the other direction.
      const note = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries: [entry({ occurredAt: "2026-08-14T22:00:00Z", body: "afternoon" })],
      });
      expect(note).toContain("Aug 14, 2026");
    });

    it("respects the DST boundary in both directions (CST -6 vs CDT -5)", () => {
      // Same wall-clock UTC instant either side of the boundary. A hand-rolled fixed offset gets exactly
      // one of these two wrong, whichever offset it hard-codes.
      const winter = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries: [entry({ occurredAt: "2026-01-15T05:30:00Z", body: "winter" })],
      });
      const summer = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries: [entry({ occurredAt: "2026-07-15T05:30:00Z", body: "summer" })],
      });

      expect(winter).toContain("Jan 14, 2026"); // 23:30 CST on the 14th
      expect(summer).toContain("Jul 15, 2026"); // 00:30 CDT on the 15th
    });

    it("renders the header's 'as of' date in CT too", () => {
      const note = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        // 03:00Z on Aug 18 is 22:00 CDT on Aug 17.
        generatedAt: new Date("2026-08-18T03:00:00Z"),
        entries: [entry()],
      });
      expect(note!.split("\n")[0]).toBe("CRM Activity Log — TR-26-0412 (as of Aug 17, 2026)");
    });

    it("drops the date segment rather than printing Invalid Date for an unparseable occurred_at", () => {
      const note = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries: [entry({ occurredAt: "not a date", body: "orphan" })],
      });
      expect(note).toContain("Note · Jane Rep");
      expect(note).not.toContain("Invalid Date");
      expect(note).toContain("  orphan");
    });
  });

  describe("entry rendering", () => {
    it("emits outcome and duration together, and each alone", () => {
      const render = (overrides: Partial<ActivityNoteEntry>) =>
        formatBidBoardActivityNote({
          projectLabel: "TR-26-0412",
          generatedAt: GENERATED_AT,
          entries: [entry({ type: "call", ...overrides })],
        })!;

      expect(render({ outcome: "left_voicemail", durationMinutes: 3 })).toContain(
        "Call (left_voicemail, 3 min)"
      );
      expect(render({ outcome: "no_answer", durationMinutes: null })).toContain("Call (no_answer)");
      expect(render({ outcome: null, durationMinutes: 45 })).toContain("Call (45 min)");
      expect(render({ outcome: null, durationMinutes: null })).toContain("· Call ·");
    });

    it("keeps a 0-minute duration (it is a real logged value, not 'missing')", () => {
      const note = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries: [entry({ type: "call", durationMinutes: 0 })],
      });
      expect(note).toContain("Call (0 min)");
    });

    it("includes a subject that adds information, above the body", () => {
      const note = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries: [entry({ subject: "Alternates pricing", body: "Owner wants three options." })],
      });
      const lines = note!.split("\n");
      expect(lines[3]).toBe("  Alternates pricing");
      expect(lines[4]).toBe("  Owner wants three options.");
    });

    it("does not print the subject twice when it duplicates the body", () => {
      const note = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries: [entry({ subject: "Called the owner", body: "Called the owner" })],
      });
      expect(note!.split("Called the owner").length - 1).toBe(1);
    });

    it("renders a subject-only entry", () => {
      const note = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries: [entry({ subject: "Voicemail left", body: null })],
      });
      expect(note).toContain("  Voicemail left");
    });

    it("drops the actor segment entirely when no name resolved", () => {
      const note = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries: [entry({ actorName: null, body: "orphaned entry" })],
      });
      expect(note).toContain("Aug 14, 2026 · Note");
      // No dangling separator and no "null" leaking into a note a customer-facing estimator reads.
      expect(note).not.toContain("· null");
      expect(note).not.toMatch(/· *\n/);
    });

    it("indents every line of a multi-line body", () => {
      const note = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries: [entry({ body: "Line one\nLine two\r\nLine three" })],
      });
      const lines = note!.split("\n");
      expect(lines.slice(3)).toEqual(["  Line one", "  Line two", "  Line three"]);
    });

    it("leaves a blank line inside a body genuinely blank (no trailing indent whitespace)", () => {
      const note = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries: [entry({ body: "Para one\n\nPara two" })],
      });
      expect(note!.split("\n").slice(3)).toEqual(["  Para one", "", "  Para two"]);
    });

    it("labels every activity type — mapped labels, then a title-cased fallback", () => {
      const label = (type: string) =>
        formatBidBoardActivityNote({
          projectLabel: "TR-26-0412",
          generatedAt: GENERATED_AT,
          entries: [entry({ type, body: "b" })],
        })!.split("\n")[2];

      // Mirrors client/src/components/activities/entity-activity-tab.tsx.
      expect(label("call")).toContain("· Call ·");
      expect(label("site_visit")).toContain("· Site Visit ·");
      expect(label("proposal_sent")).toContain("· Proposal Sent ·");
      expect(label("task_completed")).toContain("· Task Completed ·");
      // Types with no client label still render readably rather than as a raw enum value.
      expect(label("redline_review")).toContain("· Redline Review ·");
      expect(label("go_no_go")).toContain("· Go No Go ·");
      expect(label("support_request")).toContain("· Support Request ·");
    });

    it("includes an entry with no body or subject at all", () => {
      const note = formatBidBoardActivityNote({
        projectLabel: "TR-26-0412",
        generatedAt: GENERATED_AT,
        entries: [entry({ subject: null, body: null })],
      });
      // The estimator wants the whole history: a bodyless "Lunch" is still a touchpoint.
      expect(note!.split("\n")[2]).toBe("Aug 14, 2026 · Note · Jane Rep");
    });
  });
});
