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
  onTap,
}: {
  src: string;
  alt: string;
  onZoomedChange?: (zoomed: boolean) => void;
  /** Fired only for a CONFIRMED single tap (not double-tap, pinch, or pan) — e.g. toggle a details sheet. */
  onTap?: () => void;
}) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  // Single-tap disambiguation: a tap that doesn't move much and isn't the 2nd of a double-tap.
  const tapDown = useRef<{ x: number; y: number; t: number } | null>(null);
  const tapMoved = useRef(false);
  const singleTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinch = useRef<{ dist: number; scale: number; midX: number; midY: number; ox: number; oy: number } | null>(null);
  const pan = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const lastTap = useRef(0);
  // Mirror scale so the native wheel listener reads the latest value without re-binding.
  const scaleRef = useRef(scale);
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    reset();
  }, [src, reset]);

  // Cancel any pending single-tap timer on unmount.
  useEffect(() => () => {
    if (singleTapTimer.current) clearTimeout(singleTapTimer.current);
  }, []);

  useEffect(() => {
    onZoomedChange?.(scale > MIN_SCALE);
  }, [scale, onZoomedChange]);

  // Set scale + offset separately (no setOffset nested inside a setScale updater — that runs impurely,
  // twice under StrictMode).
  const zoom = useCallback((next: number) => {
    const c = clamp(next, MIN_SCALE, MAX_SCALE);
    setScale(c);
    if (c === MIN_SCALE) setOffset({ x: 0, y: 0 });
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
      // Start tracking a potential tap; classify it on pointerup.
      tapDown.current = { x: e.clientX, y: e.clientY, t: Date.now() };
      tapMoved.current = false;
      if (scale > MIN_SCALE) pan.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (tapDown.current && (Math.abs(e.clientX - tapDown.current.x) > 10 || Math.abs(e.clientY - tapDown.current.y) > 10)) {
      tapMoved.current = true; // a drag, not a tap
    }
    if (pinch.current && pointers.current.size === 2) {
      const dist = twoPointerDistance();
      const mid = twoPointerMid();
      zoom(pinch.current.scale * (dist / pinch.current.dist));
      setOffset({ x: pinch.current.ox + (mid.x - pinch.current.midX), y: pinch.current.oy + (mid.y - pinch.current.midY) });
    } else if (pan.current && pointers.current.size === 1) {
      setOffset({ x: pan.current.ox + (e.clientX - pan.current.x), y: pan.current.oy + (e.clientY - pan.current.y) });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const wasPinch = pinch.current !== null;
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) pan.current = null;
    // Classify the gesture as a tap only when it didn't move and wasn't a pinch.
    const isTap = !wasPinch && tapDown.current !== null && !tapMoved.current && Date.now() - tapDown.current.t < 250;
    tapDown.current = null;
    if (!isTap) return;
    const now = Date.now();
    if (now - lastTap.current < 300) {
      // Double tap → toggle zoom; cancel the pending single-tap.
      if (singleTapTimer.current) clearTimeout(singleTapTimer.current);
      singleTapTimer.current = null;
      zoom(scale > MIN_SCALE ? MIN_SCALE : 2.5);
      lastTap.current = 0;
    } else {
      // Defer the single-tap so a 2nd tap can upgrade it to a double-tap.
      lastTap.current = now;
      singleTapTimer.current = setTimeout(() => {
        singleTapTimer.current = null;
        onTap?.();
      }, 300);
    }
  };

  // Native, NON-passive wheel listener so preventDefault() actually stops page scroll (React's onWheel is
  // passive, so preventDefault there is a no-op + warning).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      zoom(scaleRef.current * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
      lastTap.current = 0;
    };
    el.addEventListener("wheel", onWheelNative, { passive: false });
    return () => el.removeEventListener("wheel", onWheelNative);
  }, [zoom]);

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
      <div
        ref={containerRef}
        className="flex h-full w-full touch-none items-center justify-center"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
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
