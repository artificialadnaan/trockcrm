import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * ScrollSyncX — wraps wide, horizontally-scrolling content (a table) and adds a SECOND horizontal
 * scrollbar at the TOP of the scroll area, kept in sync with the body's own scroll. The native bottom
 * scrollbar can be off-screen (or, on macOS, an overlay that only appears mid-scroll), so right-edge
 * columns (e.g. "Expected close date") get cut off with no visible way to reach them. The top rail is
 * styled always-visible (see `.scrollbar-top-rail` in globals.css) so the extra columns are discoverable.
 *
 * The top rail is a redundant visual control (aria-hidden) — the body remains the real, keyboard-scrollable
 * region. Purely additive: it does not change the content, its columns, or its data.
 */
interface ScrollSyncXProps {
  children: ReactNode;
  /** wrapper around both the top rail and the scrollable body. */
  className?: string;
  /** the scrollable body's classes — the caller controls its height/overflow (e.g. `min-h-0 flex-1 overflow-auto`). */
  bodyClassName?: string;
  ariaLabel?: string;
}

export function ScrollSyncX({
  children,
  className,
  bodyClassName = "overflow-auto",
  ariaLabel = "Scroll table horizontally",
}: ScrollSyncXProps) {
  const topRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // width of the spacer inside the top rail = the body's scrollable content width, so the top scrollbar's
  // thumb mirrors the body's. 0 until measured (and in jsdom, where there is no layout).
  const [contentWidth, setContentWidth] = useState(0);

  useEffect(() => {
    const top = topRef.current;
    const body = bodyRef.current;
    if (!top || !body) return;

    // Bi-directional scroll mirror. `lock` prevents the programmatic scrollLeft assignment from
    // ping-ponging back via the other element's scroll event (released on the next frame).
    let lock = false;
    const mirror = (from: HTMLDivElement, to: HTMLDivElement) => {
      if (lock) return;
      lock = true;
      to.scrollLeft = from.scrollLeft;
      requestAnimationFrame(() => {
        lock = false;
      });
    };
    const onTop = () => mirror(top, body);
    const onBody = () => mirror(body, top);
    top.addEventListener("scroll", onTop, { passive: true });
    body.addEventListener("scroll", onBody, { passive: true });

    const measure = () => setContentWidth(body.scrollWidth);
    measure();
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      ro.observe(body);
      if (body.firstElementChild) ro.observe(body.firstElementChild);
    }

    return () => {
      top.removeEventListener("scroll", onTop);
      body.removeEventListener("scroll", onBody);
      ro?.disconnect();
    };
  }, [children]);

  return (
    <div className={className}>
      <div
        ref={topRef}
        data-testid="scrollsync-top"
        aria-hidden="true"
        aria-label={ariaLabel}
        className="scrollbar-top-rail shrink-0 overflow-x-auto overflow-y-hidden"
      >
        <div style={{ width: contentWidth || undefined, height: 1 }} />
      </div>
      <div ref={bodyRef} data-testid="scrollsync-body" className={bodyClassName}>
        {children}
      </div>
    </div>
  );
}
