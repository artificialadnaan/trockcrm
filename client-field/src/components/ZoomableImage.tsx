import { useCallback, useEffect, useRef, useState } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";

const MIN_SCALE = 1;
const MAX_SCALE = 5;

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

/**
 * Touch-first zoomable/pannable image for the field photo viewer (no external dependency):
 *  - pinch (two fingers) to zoom, one-finger drag to pan while zoomed
 *  - double-tap toggles 1x↔2.5x; wheel/trackpad zooms on desktop
 *  - on-screen +/−/reset controls
 * Calls `onZoomedChange(scale > 1)` so the parent can suppress its swipe-to-navigate while zoomed.
 * Resets when `src` changes (navigating photos).
 */
export function ZoomableImage({
  src,
  alt,
  onZoomedChange,
}: {
  src: string;
  alt: string;
  onZoomedChange?: (zoomed: boolean) => void;
}) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; scale: number; midX: number; midY: number; ox: number; oy: number } | null>(null);
  const pan = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const lastTap = useRef(0);

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    reset();
  }, [src, reset]);

  useEffect(() => {
    onZoomedChange?.(scale > MIN_SCALE);
  }, [scale, onZoomedChange]);

  const zoom = useCallback((next: number) => {
    setScale((prev) => {
      const c = clamp(next, MIN_SCALE, MAX_SCALE);
      if (c === MIN_SCALE) setOffset({ x: 0, y: 0 });
      return c;
    });
  }, []);

  const twoPointerDistance = () => {
    const [a, b] = Array.from(pointers.current.values());
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const twoPointerMid = () => {
    const [a, b] = Array.from(pointers.current.values());
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const mid = twoPointerMid();
      pinch.current = { dist: twoPointerDistance(), scale, midX: mid.x, midY: mid.y, ox: offset.x, oy: offset.y };
      pan.current = null;
    } else if (pointers.current.size === 1) {
      // Double-tap detection.
      const now = Date.now();
      if (now - lastTap.current < 300) {
        zoom(scale > MIN_SCALE ? MIN_SCALE : 2.5);
        lastTap.current = 0;
      } else {
        lastTap.current = now;
      }
      if (scale > MIN_SCALE) pan.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size === 2) {
      const dist = twoPointerDistance();
      const mid = twoPointerMid();
      zoom(pinch.current.scale * (dist / pinch.current.dist));
      setOffset({ x: pinch.current.ox + (mid.x - pinch.current.midX), y: pinch.current.oy + (mid.y - pinch.current.midY) });
      lastTap.current = 0;
    } else if (pan.current && pointers.current.size === 1) {
      setOffset({ x: pan.current.ox + (e.clientX - pan.current.x), y: pan.current.oy + (e.clientY - pan.current.y) });
      lastTap.current = 0;
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) pan.current = null;
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    zoom(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    lastTap.current = 0;
  };

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
      <div
        className="flex h-full w-full touch-none items-center justify-center"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="max-h-full max-w-full select-none object-contain"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`, transition: pinch.current || pan.current ? "none" : "transform 0.12s ease-out" }}
        />
      </div>
      {/* stopPropagation so a tap on a control doesn't bubble to the viewer's "tap image to toggle details". */}
      <div className="absolute bottom-4 right-4 z-10 flex items-center gap-1 rounded-full bg-black/60 p-1" onClick={(e) => e.stopPropagation()}>
        <button type="button" aria-label="Zoom out" className="rounded-full p-2 text-white active:bg-white/20" onClick={(e) => { e.stopPropagation(); zoom(scale / 1.4); }}>
          <Minus className="h-5 w-5" />
        </button>
        <span className="min-w-[3.5ch] text-center text-xs font-semibold text-white">{Math.round(scale * 100)}%</span>
        <button type="button" aria-label="Zoom in" className="rounded-full p-2 text-white active:bg-white/20" onClick={(e) => { e.stopPropagation(); zoom(scale * 1.4); }}>
          <Plus className="h-5 w-5" />
        </button>
        <button type="button" aria-label="Reset zoom" className="rounded-full p-2 text-white active:bg-white/20 disabled:opacity-40" disabled={scale === MIN_SCALE && offset.x === 0 && offset.y === 0} onClick={(e) => { e.stopPropagation(); reset(); }}>
          <RotateCcw className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
