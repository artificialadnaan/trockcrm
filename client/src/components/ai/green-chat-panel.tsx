import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { useAiChatStream, type ChatTurn } from "./use-ai-chat-stream";
import { ToolDebugStrip } from "./tool-debug-strip";
import { LittleTAvatar } from "./little-t-avatar";
import type { ChatSegment, ChatTurnState, DebugEvent } from "./ai-chat-protocol";

// Lazy so the vega bundle only loads when a chart actually renders.
const ChartBlock = lazy(() => import("./chart-block"));

const SUGGESTIONS = [
  "How do our Won, Active, and Stalled deals compare this year?",
  "Which reps have the biggest bid-to-award variance?",
  "List our largest deals by value",
];

// Friendly, human narration for what each tool is doing (the "make it obvious" ask).
const TOOL_DOING: Record<string, string> = {
  get_pipeline_summary: "Checking the Dallas pipeline",
  list_deals: "Pulling up deals",
  get_bid_award_variance: "Crunching bid-vs-award numbers",
  describe_capabilities: "Checking what I can answer",
};
const TOOL_SHORT: Record<string, string> = {
  get_pipeline_summary: "pipeline summary",
  list_deals: "deals",
  get_bid_award_variance: "bid-vs-award variance",
  describe_capabilities: "capabilities",
};
const doing = (name?: string) => (name && TOOL_DOING[name]) || "Querying the data";
const short = (name?: string) => (name && TOOL_SHORT[name]) || "the data";

function Segment({ segment }: { segment: ChatSegment }) {
  if (segment.type === "text") {
    // Plain prose — NEVER parsed for charts (charts come only from validated `chart` segments).
    return <div className="lt-prose">{segment.text}</div>;
  }
  return (
    <Suspense fallback={<div className="lt-prose" style={{ color: "var(--lt-muted)", fontSize: 13 }}>Rendering chart…</div>}>
      <ChartBlock spec={segment.spec} />
    </Suspense>
  );
}

/** Live "Little T is working…" card built from the streamed tool_use / tool_result debug events. */
function WorkingIndicator({ state }: { state: ChatTurnState }) {
  const steps: { name?: string; rowCount?: number; isError?: boolean }[] = [];
  let current: string | undefined;
  for (const e of state.debug as DebugEvent[]) {
    if (e.kind !== "tool") continue;
    const name = e.detail.name as string | undefined;
    if (e.detail.kind === "tool_use") current = name;
    else if (e.detail.kind === "tool_result") {
      steps.push({ name, rowCount: e.detail.rowCount as number | undefined, isError: e.detail.isError as boolean | undefined });
      current = undefined;
    }
  }
  const hasText = state.segments.some((s) => s.type === "text");
  const now = current ? doing(current) : hasText ? "Writing the answer" : "Thinking";

  return (
    <div className="lt-working is-working">
      <LittleTAvatar size="sm" />
      <div className="lt-working-body">
        <div className="lt-working-now">
          <span className="lt-spinner" />
          <span>{now}…</span>
        </div>
        {steps.length > 0 && (
          <div className="lt-steps">
            {steps.map((s, i) => (
              <div className="lt-step" key={i}>
                <span className="lt-check">✓</span>
                {s.isError ? `${short(s.name)} — no matching data` : `Read ${s.rowCount ?? 0} rows from ${short(s.name)}`}
              </div>
            ))}
          </div>
        )}
        <div className="lt-shimmer" />
      </div>
    </div>
  );
}

function BotTurn({ state, working }: { state: ChatTurnState; working: boolean }) {
  return (
    <div className={`lt-bot lt-row${working ? " is-working" : ""}`}>
      <LittleTAvatar size="sm" />
      <div className="lt-bot-body">
        {state.segments.map((seg, j) => (
          <Segment key={j} segment={seg} />
        ))}
        {state.error && <div className="lt-error">⚠ {state.error}</div>}
        {!working && <ToolDebugStrip debug={state.debug} />}
      </div>
    </div>
  );
}

/** Little T — the T Rock assistant: a branded transcript of prose + charts with live work narration. */
export function GreenChatPanel() {
  const { turns, streaming, sendMessage } = useAiChatStream();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, streaming]);

  const submit = (text: string) => {
    const t = text.trim();
    if (!t) return;
    setInput("");
    void sendMessage(t);
  };

  const lastIdx = turns.length - 1;

  return (
    <div className="lt-shell">
      <header className="lt-header">
        <LittleTAvatar size="lg" />
        <div className="lt-brand">
          <span className="lt-name">Little&nbsp;<span className="lt-dot-red">T</span></span>
          <span className="lt-tag">The T Rock Assistant</span>
        </div>
        <span className={`lt-status${streaming ? " is-working" : ""}`}>
          <span className="lt-status-dot" />
          {streaming ? "Working" : "Online"}
        </span>
      </header>

      <div className="lt-transcript" ref={scrollRef}>
        {turns.length === 0 && (
          <div className="lt-empty">
            <LittleTAvatar size="lg" />
            <h1>Hey, I'm Little T</h1>
            <p>
              Your read-only analyst for the T Rock <strong>Dallas</strong> pipeline. Every number I
              give you is computed by SQL on live data — never made up. Try one of these:
            </p>
            <div className="lt-suggest">
              {SUGGESTIONS.map((s) => (
                <button className="lt-chip" key={s} onClick={() => submit(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn: ChatTurn, i) => {
          if (turn.role === "user") {
            return (
              <div className="lt-row is-user" key={i}>
                <div className="lt-bubble-user">{turn.text}</div>
              </div>
            );
          }
          const isActive = streaming && i === lastIdx && !turn.state.done;
          return (
            <div key={i}>
              <BotTurn state={turn.state} working={isActive} />
              {isActive && <WorkingIndicator state={turn.state} />}
            </div>
          );
        })}
      </div>

      <div className="lt-composer">
        <div className="lt-composer-row">
          <textarea
            className="lt-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(input);
              }
            }}
            placeholder="Ask Little T about the Dallas pipeline…"
            rows={1}
            disabled={streaming}
          />
          <button className="lt-send" onClick={() => submit(input)} disabled={streaming || input.trim().length === 0} aria-label="Send">
            {streaming ? (
              <span className="lt-spinner-sm" />
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            )}
          </button>
        </div>
        <div className="lt-hint">Little T answers from live Dallas CRM data via read-only SQL tools.</div>
      </div>
    </div>
  );
}
