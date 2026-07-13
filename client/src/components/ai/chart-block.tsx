import { useEffect, useRef } from "react";
import vegaEmbed from "vega-embed";

/**
 * Renders a server-validated Vega-Lite spec (its data.values were injected server-side from verbatim
 * tool output). This component does ZERO data work — it never fetches, computes, parses tool output,
 * or reads assistant text; it only embeds the spec it's handed. Lazy-loaded so the vega bundle is
 * only paid for on a chart turn (default export for React.lazy).
 */
export default function ChartBlock({ spec }: { spec: unknown }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let finalize: (() => void) | undefined;
    let cancelled = false;
    void vegaEmbed(el, spec as Parameters<typeof vegaEmbed>[1], { actions: false, renderer: "svg" })
      .then((result) => {
        if (cancelled) result.finalize();
        else finalize = result.finalize;
      })
      .catch(() => {
        /* a malformed spec just renders nothing — never throws into the chat */
      });
    return () => {
      cancelled = true;
      finalize?.();
    };
  }, [spec]);

  return (
    <div className="lt-chart">
      <div ref={ref} className="lt-chart-canvas" />
    </div>
  );
}
