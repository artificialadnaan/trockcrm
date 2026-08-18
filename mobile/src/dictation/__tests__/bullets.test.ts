import { formatDictationAsBullets } from "../bullets";

describe("formatDictationAsBullets", () => {
  it("splits a dictated paragraph into dash bullets", () => {
    // What whisper actually returns: one unpunctuated-into-lines paragraph. The report is a bullet list.
    expect(
      formatDictationAsBullets("Poured the north slab. Balcony mock up is complete. Framing starts Monday."),
    ).toBe("- Poured the north slab\n- Balcony mock up is complete\n- Framing starts Monday");
  });

  it("keeps question and exclamation marks, which carry meaning", () => {
    expect(formatDictationAsBullets("Is the permit in? Waiting on the city!")).toBe(
      "- Is the permit in?\n- Waiting on the city!",
    );
  });

  it("bullets a single sentence", () => {
    expect(formatDictationAsBullets("Slab poured")).toBe("- Slab poured");
  });

  it("returns empty for empty or whitespace-only input", () => {
    expect(formatDictationAsBullets("")).toBe("");
    expect(formatDictationAsBullets("   \n ")).toBe("");
  });

  it("leaves an already-bulleted list alone", () => {
    // The user pasted or typed their own list; re-splitting it would double the dashes.
    const existing = "- Slab poured\n- Framing starts Monday";
    expect(formatDictationAsBullets(existing)).toBe(existing);
  });

  it("normalises other bullet glyphs to dashes", () => {
    expect(formatDictationAsBullets("• Slab poured\n* Framing Monday\nCity inspection Thursday")).toBe(
      "- Slab poured\n- Framing Monday\n- City inspection Thursday",
    );
  });

  it("does not split on an initial, which reads as a two-word transcription failure", () => {
    expect(formatDictationAsBullets("Met with R. Smith about the schedule.")).toBe(
      "- Met with R. Smith about the schedule",
    );
  });

  it("bullets line by line when the speaker already broke it up", () => {
    expect(formatDictationAsBullets("Slab poured\nFraming Monday")).toBe("- Slab poured\n- Framing Monday");
  });

  it("hands back punctuation-only input rather than swallowing it", () => {
    // Better to show what was heard than an empty box that looks like the recording failed.
    expect(formatDictationAsBullets("...")).toBe("...");
  });

  it("collapses the whitespace a dictation pause leaves behind", () => {
    expect(formatDictationAsBullets("  Slab poured.   Framing Monday.  ")).toBe(
      "- Slab poured\n- Framing Monday",
    );
  });
});
