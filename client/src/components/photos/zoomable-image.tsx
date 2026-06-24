import { useCallback, useEffect, useRef, useState } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";

const MIN_SCALE = 1;
const MAX_SCALE = 5;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * A zoomable/pannable image for the photo viewer. No external dependency: wheel (or trackpad pinch) zooms
 * toward the cursor, drag pans while zoomed, double-click toggles 1x↔2.5x, and the on-screen controls
 * zoom in/out/reset. Zoom resets whenever `src` changes (i.e. navigating to the next photo).
 */
export function ZoomableImage({ src, alt }: { src: string; alt: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // New photo → back to fit.
  useEffect(() => {
    reset();
  }, [src, reset]);

  const zoomTo = useCallback((nextScale: number, pivot?: { x: number; y: number }) => {
    const clamped = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    setScale((prev) => {
      if (clamped === MIN_SCALE) {
        setOffset({ x: 0, y: 0 });
        return MIN_SCALE;
      }
      // Keep the point under the cursor stationary while zooming.
      if (pivot && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const cx = pivot.x - rect.left - rect.width / 2;
        const cy = pivot.y - rect.top - rect.height / 2;
        const ratio = clamped / prev;
        setOffset((o) => ({ x: cx - (cx - o.x) * ratio, y: cy - (cy - o.y) * ratio }));
      }
      return clamped;
    });
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      zoomTo(scale * factor, { x: e.clientX, y: e.clientY });
    },
    [scale, zoomTo],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (scale <= MIN_SCALE) return;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      drag.current = { startX: e.clientX, startY: e.clientY, originX: offset.x, originY: offset.y };
    },
    [scale, offset],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!drag.current) return;
    setOffset({
      x: drag.current.originX + (e.clientX - drag.current.startX),
      y: drag.current.originY + (e.clientY - drag.current.startY),
    });
  }, []);

  const endDrag = useCallback(() => {
    drag.current = null;
  }, []);

  return (
    <div className="group relative flex h-full w-full items-center justify-center overflow-hidden">
      <div
        ref={containerRef}
        className="flex h-full w-full touch-none items-center justify-center"
        onWheel={onWheel}
        onDoubleClick={(e) => zoomTo(scale > MIN_SCALE ? MIN_SCALE : 2.5, { x: e.clientX, y: e.clientY })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        style={{ cursor: scale > MIN_SCALE ? (drag.current ? "grabbing" : "grab") : "zoom-in" }}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="max-h-[78vh] max-w-full select-none object-contain"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`, transition: drag.current ? "none" : "transform 0.1s ease-out" }}
        />
      </div>
      {/* Zoom controls (always visible on touch; hover-revealed on desktop). */}
      <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-full bg-black/60 p-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
        <button type="button" aria-label="Zoom out" className="rounded-full p-1.5 text-white hover:bg-white/20" onClick={() => zoomTo(scale / 1.4)}>
          <Minus className="h-4 w-4" />
        </button>
        <span className="min-w-[3ch] text-center text-xs font-medium text-white">{Math.round(scale * 100)}%</span>
        <button type="button" aria-label="Zoom in" className="rounded-full p-1.5 text-white hover:bg-white/20" onClick={() => zoomTo(scale * 1.4)}>
          <Plus className="h-4 w-4" />
        </button>
        <button type="button" aria-label="Reset zoom" className="rounded-full p-1.5 text-white hover:bg-white/20 disabled:opacity-40" onClick={reset} disabled={scale === MIN_SCALE && offset.x === 0 && offset.y === 0}>
          <RotateCcw className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
