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
  /** Gives the real scroll region an accessible name and makes it reachable by keyboard. */
  bodyLabel?: string;
}

export function ScrollSyncX({ children, className, bodyClassName = "overflow-auto", bodyLabel }: ScrollSyncXProps) {
  const topRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // For the top rail to scroll in lockstep with the body, their scroll RANGES (scrollWidth − clientWidth)
  // must match. The spacer width = body.scrollWidth gives the rail the same scrollWidth; the rail width is
  // pinned to body.clientWidth so the rail's clientWidth matches too — otherwise, when the body shows a
  // classic (non-overlay) vertical scrollbar, body.clientWidth is narrower than the full-width rail and the
  // rail can't reach the rightmost columns. Both are 0 until measured (and in jsdom, where there is no layout).
  const [contentWidth, setContentWidth] = useState(0);
  const [railWidth, setRailWidth] = useState(0);

  // Attach the bi-directional scroll mirror ONCE — the refs are stable, so this must not re-run per render.
  // `lock` prevents the programmatic scrollLeft assignment from ping-ponging back via the other element's
  // scroll event (released on the next frame).
  useEffect(() => {
    const top = topRef.current;
    const body = bodyRef.current;
    if (!top || !body) return;
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
    return () => {
      top.removeEventListener("scroll", onTop);
      body.removeEventListener("scroll", onBody);
    };
  }, []);

  // Keep the top rail's spacer width equal to the body's scrollable content width — re-measure when the
  // content (or its size) changes — so the top scrollbar's thumb matches the body's.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => {
      setContentWidth(body.scrollWidth);
      setRailWidth(body.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(body);
    if (body.firstElementChild) ro.observe(body.firstElementChild);
    return () => ro.disconnect();
  }, [children]);

  return (
    <div className={className}>
      <div
        ref={topRef}
        data-testid="scrollsync-top"
        aria-hidden="true"
        className="scrollbar-top-rail shrink-0 overflow-x-auto overflow-y-hidden"
        style={{ width: railWidth || undefined }}
      >
        <div style={{ width: contentWidth || undefined, height: 1 }} />
      </div>
      <div
        ref={bodyRef}
        data-testid="scrollsync-body"
        className={bodyClassName}
        role={bodyLabel ? "region" : undefined}
        aria-label={bodyLabel}
        tabIndex={bodyLabel ? 0 : undefined}
      >
        {children}
      </div>
    </div>
  );
}
