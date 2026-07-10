import { useEffect, useRef, useState } from "react";

/**
 * A grid thumbnail that only mounts its <img> once it scrolls near the viewport, via IntersectionObserver.
 *
 * Why not native loading="lazy": inside the report-builder modal the photo grid lives in a nested
 * `overflow-y-auto` scroll container within a `fixed` element. The browser's native lazy-load computes
 * intersection against the wrong root there and never fetches the thumbnails, so the grid renders blank
 * (the page-level project gallery works because it scrolls with the document). Eager-loading every
 * thumbnail instead floods the connection pool on large projects (thousands of photos), which was the
 * original failure. IntersectionObserver fires correctly in nested/modal scrollers AND lets us defer
 * off-screen thumbnails — fixing both the blank grid and the flood.
 *
 * Falls back to eager loading where IntersectionObserver is unavailable (older engines / jsdom).
 */
export function LazyThumb({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    if (visible) return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect(); // one-shot: once loaded it never needs to unload
        }
      },
      // Preload a little before it scrolls in so there's no visible pop-in as the user scrolls the grid.
      { rootMargin: "300px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  return (
    <span ref={ref} className={className ?? "block h-full w-full"}>
      {visible ? <img src={src} alt={alt} decoding="async" className="h-full w-full object-cover" /> : null}
    </span>
  );
}
