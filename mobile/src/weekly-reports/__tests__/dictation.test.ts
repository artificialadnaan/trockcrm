// What happens to a dictated transcript between the recorder and the draft.
//
// The rule this file exists to hold: A DICTATED TRANSCRIPT IS NEVER LOST. The audio is gone the moment the
// recorder stops and the words exist nowhere else, so every failure — offline, timeout, 500, a server that
// answers with nothing — has to come back with the on-device split rather than an error or an empty
// string. Each of those cases is therefore paired with a CONTROL showing the server path genuinely returns
// the SERVER's text: a fallback tested only for failure passes even if it falls back every single time.
//
// The port stubs reject the way `apiFetch` rejects — an `ApiError` carrying `status` (0 for a transport
// failure, 408 for a timeout, the HTTP status otherwise). It does not resolve with an error envelope, and
// a stub that pretended otherwise would verify nothing.

import { ApiError } from "../../api/client";
import { weeklyReportDictationText, type WeeklyReportDictationPort } from "../dictation";
import {
  MAX_WEEKLY_REPORT_SECTION_CHARS,
  createWeeklyReportDraft,
  weeklyReportDraftReducer,
} from "../draft";

/** A transcript as whisper actually returns one: a single unbroken paragraph. */
const TRANSCRIPT = "Poured the north slab. Balcony mock up is complete. Framing starts Monday.";
/** What the on-device split makes of it — the floor under every failure below. */
const LOCAL_SPLIT = "- Poured the north slab\n- Balcony mock up is complete\n- Framing starts Monday";
/** What a working server pass returns: cleaner, and DIFFERENT, so "it fell back" is always detectable. */
const SERVER_TEXT = "- Poured the north slab\n- Balcony mock-up is complete\n- Framing starts Monday";

const serverPort: WeeklyReportDictationPort = async () => ({ text: SERVER_TEXT, source: "model" });

describe("weeklyReportDictationText", () => {
  // ── The control ─────────────────────────────────────────────────────────────────────────────────

  it("uses the server's text when the pass answers", async () => {
    // THE CONTROL for every fallback case below. Without it a function that always fell back would pass
    // all of them, and "degrades to the split" would be an untested claim.
    const port = jest.fn(serverPort);
    const outcome = await weeklyReportDictationText(
      { transcript: TRANSCRIPT, existingChars: 0 },
      port,
    );
    expect(outcome).toEqual({ text: SERVER_TEXT, source: "server" });
    expect(outcome.text).not.toBe(LOCAL_SPLIT);
    expect(port).toHaveBeenCalledWith({ transcript: TRANSCRIPT, existingChars: 0 });
  });

  it("sends a character count, never the section's text", async () => {
    // The property that makes appending safe: the server is never given the prose it could rewrite.
    const existing = "Typed by hand on the drive over: the crane is booked for the 14th.";
    const port = jest.fn(serverPort);
    await weeklyReportDictationText(
      { transcript: TRANSCRIPT, existingChars: existing.length },
      port,
    );
    const sent = JSON.stringify(port.mock.calls[0][0]);
    expect(sent).not.toContain("crane");
    expect(sent).toContain(TRANSCRIPT);
    expect(port.mock.calls[0][0].existingChars).toBe(existing.length);
  });

  // ── Offline and every other failure ─────────────────────────────────────────────────────────────

  it("falls back to the on-device split when the phone is offline, keeping every word", async () => {
    // ApiError(0) is exactly what apiFetch throws for a transport failure — offline, DNS, refused.
    const port = jest.fn(async () => {
      throw new ApiError("Network request failed", 0);
    });
    const outcome = await weeklyReportDictationText(
      { transcript: TRANSCRIPT, existingChars: 0 },
      port,
    );
    expect(outcome).toEqual({ text: LOCAL_SPLIT, source: "local" });
    // Named individually, because "it returned something" is not the promise being kept here.
    expect(outcome.text).toContain("Poured the north slab");
    expect(outcome.text).toContain("Balcony mock up is complete");
    expect(outcome.text).toContain("Framing starts Monday");
  });

  it("falls back on a timeout, a server error, and a rejected request alike", async () => {
    for (const status of [408, 500, 502, 403, 400]) {
      const outcome = await weeklyReportDictationText(
        { transcript: TRANSCRIPT, existingChars: 0 },
        async () => {
          throw new ApiError(`Request failed (${status})`, status);
        },
      );
      expect(outcome).toEqual({ text: LOCAL_SPLIT, source: "local" });
    }
  });

  it("falls back when the port throws something that is not an ApiError at all", async () => {
    // Belt and braces: this function's contract is that it never throws, whatever reaches it.
    const outcome = await weeklyReportDictationText(
      { transcript: TRANSCRIPT, existingChars: 0 },
      () => {
        throw new TypeError("undefined is not a function");
      },
    );
    expect(outcome).toEqual({ text: LOCAL_SPLIT, source: "local" });
  });

  it("falls back when the server answers 200 with nothing usable", async () => {
    // "" is the worst answer available here: a silent no-op for a paragraph somebody just spoke. A naive
    // `response.text ?? ""` produces exactly that on any of these payloads.
    const payloads = [{ text: "" }, { text: "   " }, {}, { text: null }, { text: 42 }];
    for (const payload of payloads) {
      const outcome = await weeklyReportDictationText(
        { transcript: TRANSCRIPT, existingChars: 0 },
        async () => payload as { text?: unknown },
      );
      expect(outcome).toEqual({ text: LOCAL_SPLIT, source: "local" });
    }
  });

  it("falls back when there is no port at all", async () => {
    const outcome = await weeklyReportDictationText(
      { transcript: TRANSCRIPT, existingChars: 0 },
      null,
    );
    expect(outcome).toEqual({ text: LOCAL_SPLIT, source: "local" });
  });

  it("returns nothing for an empty transcript, without calling the server", async () => {
    const port = jest.fn(serverPort);
    expect(await weeklyReportDictationText({ transcript: "  \n ", existingChars: 0 }, port)).toEqual({
      text: "",
      source: "local",
    });
    expect(port).not.toHaveBeenCalled();
  });

  // ── The cap. Absolute fixtures only ─────────────────────────────────────────────────────────────

  it("caps the addition at 20000 characters however long the server's answer is", async () => {
    const outcome = await weeklyReportDictationText(
      { transcript: TRANSCRIPT, existingChars: 0 },
      async () => ({ text: `- ${"A".repeat(30_000)}` }),
    );
    // Literal, not MAX_WEEKLY_REPORT_SECTION_CHARS: a fixture derived from the constant it tests can
    // never detect that constant changing.
    expect(outcome.text.length).toBe(20000);
  });

  it("counts what the section already holds, so the two together stay inside the cap", async () => {
    const outcome = await weeklyReportDictationText(
      { transcript: TRANSCRIPT, existingChars: 19_990 },
      async () => ({ text: `- ${"A".repeat(500)}` }),
    );
    expect(outcome.text).toBe("- AAAAAAAA");
    expect(outcome.text.length).toBe(10);
  });

  it("caps the local fallback too, which is the path an offline phone takes", async () => {
    const outcome = await weeklyReportDictationText(
      { transcript: "Abcd. ".repeat(2_858), existingChars: 0 },
      async () => {
        throw new ApiError("Network request failed", 0);
      },
    );
    expect(outcome.source).toBe("local");
    expect(outcome.text.length).toBe(20000);
  });

  it("mirrors the server's ceiling exactly", () => {
    // The two copies are a mirror, not two independent limits: a client that capped lower would silently
    // drop text the API would have accepted, and one that capped higher would 400 the whole submit.
    expect(MAX_WEEKLY_REPORT_SECTION_CHARS).toBe(20000);
  });

  // ── Append, never replace ───────────────────────────────────────────────────────────────────────

  it("appends to what the superintendent typed rather than replacing it", async () => {
    // Driven through the REAL reducer, because "it appends" is a claim about what lands in the draft, not
    // about the shape of an outcome object.
    const typed = "Crane is booked for the 14th.";
    const draft = weeklyReportDraftReducer(
      createWeeklyReportDraft({
        id: "d1",
        clientSubmissionId: "s1",
        weeklyReportProjectId: "p1",
        dealId: "deal1",
        projectName: "North Tower",
        weekOf: "2026-08-13",
        now: 0,
      }),
      { type: "setSection", key: "workCompleted", value: typed },
    );
    expect(draft.workCompleted).toBe(typed);

    const outcome = await weeklyReportDictationText(
      { transcript: TRANSCRIPT, existingChars: draft.workCompleted.length },
      serverPort,
    );
    const after = weeklyReportDraftReducer(draft, {
      type: "appendSection",
      key: "workCompleted",
      text: outcome.text,
    });

    // Hand-typed text survives verbatim...
    expect(after.workCompleted.startsWith(typed)).toBe(true);
    expect(after.workCompleted).toContain("Crane is booked for the 14th.");
    // ...AND the dictation actually landed. This half is the control: a reducer that dropped the addition
    // entirely would satisfy "nothing was destroyed" perfectly.
    expect(after.workCompleted).toContain("Framing starts Monday");
    expect(after.workCompleted).toBe(`${typed}\n${SERVER_TEXT}`);
    expect(after.workCompleted.length).toBeGreaterThan(typed.length);
  });

  it("appends the FALLBACK text too, so a lost signal still does not lose the paragraph", async () => {
    const typed = "Crane is booked for the 14th.";
    const draft = weeklyReportDraftReducer(
      createWeeklyReportDraft({
        id: "d1",
        clientSubmissionId: "s1",
        weeklyReportProjectId: "p1",
        dealId: "deal1",
        projectName: "North Tower",
        weekOf: "2026-08-13",
        now: 0,
      }),
      { type: "setSection", key: "workCompleted", value: typed },
    );
    const outcome = await weeklyReportDictationText(
      { transcript: TRANSCRIPT, existingChars: draft.workCompleted.length },
      async () => {
        throw new ApiError("Network request failed", 0);
      },
    );
    const after = weeklyReportDraftReducer(draft, {
      type: "appendSection",
      key: "workCompleted",
      text: outcome.text,
    });
    expect(after.workCompleted).toBe(`${typed}\n${LOCAL_SPLIT}`);
  });
});
