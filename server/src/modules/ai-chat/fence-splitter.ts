/**
 * Fence splitter — quarantines the model's `trock-chart` blocks from prose in the streamed text
 * (docs/specs/mcp-chart-seam.md §5). It feeds on `text_delta` chunks and emits an ordered sequence
 * of events: prose `text`, a raw `chart` block (the JSON between the fences, handed to the chart
 * seam), or `chart_dropped` for an unclosed fence at end-of-turn.
 *
 * SECURITY: chart JSON is NEVER emitted as `text`, and a partial opening sentinel split across two
 * deltas (e.g. "```troc" then "k-chart") is withheld until it resolves — so a half-typed fence can
 * never leak into the user-facing transcript, and chart numbers can never arrive on the text channel.
 */
const OPEN = "```trock-chart";
const CLOSE = "```";

export type FenceEvent =
  | { type: "text"; text: string }
  | { type: "chart"; raw: string }
  | { type: "chart_dropped"; reason: "unclosed_fence" };

/** Longest suffix of `s` that is a (proper) prefix of `sentinel` — the tail to withhold. */
function longestSuffixThatIsPrefix(s: string, sentinel: string): number {
  const max = Math.min(s.length, sentinel.length - 1);
  for (let k = max; k > 0; k -= 1) {
    if (s.slice(s.length - k) === sentinel.slice(0, k)) return k;
  }
  return 0;
}

export class FenceSplitter {
  private mode: "normal" | "chart" = "normal";
  private buf = "";

  /** Feed a text delta; returns the events it resolves (text/chart), in order. */
  push(delta: string): FenceEvent[] {
    this.buf += delta;
    const events: FenceEvent[] = [];
    // Loop because one delta can complete a chart AND start new prose (or vice-versa).
    for (;;) {
      if (this.mode === "normal") {
        const idx = this.buf.indexOf(OPEN);
        if (idx === -1) {
          // No full sentinel yet — emit everything except a trailing tail that could BE the start
          // of the sentinel; keep that tail buffered until the next delta disambiguates it.
          const keep = longestSuffixThatIsPrefix(this.buf, OPEN);
          const emitLen = this.buf.length - keep;
          if (emitLen > 0) {
            events.push({ type: "text", text: this.buf.slice(0, emitLen) });
            this.buf = this.buf.slice(emitLen);
          }
          break;
        }
        if (idx > 0) events.push({ type: "text", text: this.buf.slice(0, idx) });
        this.buf = this.buf.slice(idx + OPEN.length);
        this.mode = "chart";
        // fall through the loop to look for the closing fence in the remainder
      } else {
        const idx = this.buf.indexOf(CLOSE);
        if (idx === -1) break; // accumulate chart body; never emit as text
        events.push({ type: "chart", raw: this.buf.slice(0, idx) });
        this.buf = this.buf.slice(idx + CLOSE.length);
        this.mode = "normal";
        // fall through to keep processing any remaining prose
      }
    }
    return events;
  }

  /** End of turn: flush any safe pending prose; an unclosed chart fence is dropped, never emitted. */
  end(): FenceEvent[] {
    if (this.mode === "chart") {
      this.buf = "";
      return [{ type: "chart_dropped", reason: "unclosed_fence" }];
    }
    const events: FenceEvent[] = [];
    if (this.buf.length > 0) {
      // The leftover was a withheld partial sentinel that never completed — it's just text now.
      events.push({ type: "text", text: this.buf });
      this.buf = "";
    }
    return events;
  }
}
