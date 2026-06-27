import { useState } from "react";
import type { DebugEvent } from "./ai-chat-protocol";

/**
 * Diagnostic "grounding" strip — on a completed Little T turn, shows that the answer was backed by
 * real tool calls (the demo's trust story: point here to prove the numbers came from SQL). Collapsed
 * by default. It only lists debug metadata — it has NO path to the chart renderer and shows no raw
 * tool rows.
 */
export function ToolDebugStrip({ debug }: { debug: DebugEvent[] }) {
  const [open, setOpen] = useState(false);
  const toolCalls = debug.filter((e) => e.kind === "tool" && e.detail.kind === "tool_use").length;
  if (debug.length === 0) return null;
  return (
    <div className="lt-grounding">
      <button className="lt-grounding-toggle" onClick={() => setOpen((o) => !o)}>
        <span className="lt-grounding-badge">SQL</span>
        Grounded in {toolCalls} tool {toolCalls === 1 ? "call" : "calls"}
        <span className="lt-grounding-caret">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="lt-grounding-list">
          {debug.map((e, i) => (
            <div key={i} className="lt-grounding-row">
              <span className="lt-grounding-kind">{(e.detail.kind as string) ?? e.kind}</span>
              {(e.detail.name as string) ?? (e.detail.reason as string) ?? ""}
              {e.detail.rowCount != null && <span className="lt-grounding-rows"> · {String(e.detail.rowCount)} rows</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
