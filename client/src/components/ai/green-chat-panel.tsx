import { Suspense, lazy, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { useAiChatStream } from "./use-ai-chat-stream";
import { ToolDebugStrip } from "./tool-debug-strip";
import type { ChatSegment } from "./ai-chat-protocol";

// Lazy so the vega bundle only loads when a chart actually renders.
const ChartBlock = lazy(() => import("./chart-block"));

function Segment({ segment }: { segment: ChatSegment }) {
  if (segment.type === "text") {
    // Rendered as plain prose — NEVER parsed for charts (charts come only from `chart` segments).
    return <div className="whitespace-pre-wrap">{segment.text}</div>;
  }
  return (
    <Suspense fallback={<div className="my-2 text-xs text-muted-foreground">Rendering chart…</div>}>
      <ChartBlock spec={segment.spec} />
    </Suspense>
  );
}

/** The T Rock AI chat surface: a transcript of interleaved prose + charts, and a composer. */
export function GreenChatPanel() {
  const { turns, streaming, sendMessage } = useAiChatStream();
  const [input, setInput] = useState("");

  const submit = () => {
    const text = input;
    setInput("");
    void sendMessage(text);
  };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 p-4">
      <div className="flex-1 space-y-4 overflow-y-auto">
        {turns.length === 0 && (
          <p className="text-center text-sm text-muted-foreground">
            Ask about the Dallas pipeline — e.g. “How do our Won, Active, and Stalled deals compare
            this year?”, “Which reps have the biggest bid-to-award variance?”, or “List our largest
            deals by value”.
          </p>
        )}
        {turns.map((turn, i) =>
          turn.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-primary-foreground whitespace-pre-wrap">
                {turn.text}
              </div>
            </div>
          ) : (
            <Card key={i} className="px-4 py-3">
              {turn.state.segments.map((seg, j) => (
                <Segment key={j} segment={seg} />
              ))}
              {turn.state.error && <div className="text-sm text-destructive">{turn.state.error}</div>}
              <ToolDebugStrip debug={turn.state.debug} />
            </Card>
          )
        )}
      </div>

      <div className="flex items-end gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Ask about the Dallas pipeline…"
          rows={2}
          disabled={streaming}
        />
        <Button onClick={submit} disabled={streaming || input.trim().length === 0}>
          {streaming ? "…" : "Send"}
        </Button>
      </div>
    </div>
  );
}
