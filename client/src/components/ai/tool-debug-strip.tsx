import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { DebugEvent } from "./ai-chat-protocol";

/**
 * Purely-diagnostic strip of tool_use / tool_result / chart_dropped events. OFF by default; a plain
 * Button toggles it (no collapsible primitive). It only ever lists debug metadata — it has NO path
 * to the chart renderer and shows no raw tool rows.
 */
export function ToolDebugStrip({ debug }: { debug: DebugEvent[] }) {
  const [open, setOpen] = useState(false);
  if (debug.length === 0) return null;
  return (
    <div className="mt-2 text-xs">
      <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>
        {open ? "Hide" : "Show"} tool activity ({debug.length})
      </Button>
      {open && (
        <div className="mt-1 max-h-48 overflow-y-auto rounded border p-2 font-mono text-muted-foreground">
          {debug.map((e, i) => (
            <div key={i} className="truncate">
              <span className="font-semibold">{e.kind}</span>: {JSON.stringify(e.detail)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
