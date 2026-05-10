import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

interface KanbanScrollColumnProps {
  header: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  fadeFromClassName?: string;
  fadeToClassName?: string;
  /**
   * Triggers re-measurement of overflow fades when this number changes
   * (typically pass the count of cards rendered as children).
   */
  childCount?: number;
}

export const KanbanScrollColumn = forwardRef<HTMLDivElement, KanbanScrollColumnProps>(
  function KanbanScrollColumn(
    {
      header,
      children,
      className,
      bodyClassName,
      fadeFromClassName = "from-gray-50",
      fadeToClassName = "to-gray-50",
      childCount,
    },
    forwardedRef
  ) {
    const cardsRef = useRef<HTMLDivElement>(null);
    const [overflowState, setOverflowState] = useState<{
      showTopFade: boolean;
      showBottomFade: boolean;
    }>({ showTopFade: false, showBottomFade: false });

    const recomputeOverflow = useCallback(() => {
      const el = cardsRef.current;
      if (!el) {
        setOverflowState({ showTopFade: false, showBottomFade: false });
        return;
      }
      const overflow = el.scrollHeight > el.clientHeight + 1;
      if (!overflow) {
        setOverflowState({ showTopFade: false, showBottomFade: false });
        return;
      }
      const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
      setOverflowState({
        showTopFade: el.scrollTop > 1,
        showBottomFade: distanceFromBottom > 1,
      });
    }, []);

    useLayoutEffect(() => {
      const el = cardsRef.current;
      if (!el) return;
      recomputeOverflow();
      const observer = new ResizeObserver(recomputeOverflow);
      observer.observe(el);
      for (const child of Array.from(el.children)) {
        observer.observe(child);
      }
      return () => observer.disconnect();
    }, [childCount, recomputeOverflow]);

    return (
      <div
        ref={forwardedRef}
        className={cn(
          "flex h-full w-80 flex-shrink-0 flex-col border border-gray-200 bg-gray-50/60",
          className
        )}
      >
        <div className="sticky top-0 z-10 border-b border-gray-200 bg-gray-50/95 px-3 pt-3 pb-2 backdrop-blur-sm">
          {header}
        </div>
        <div className="relative min-h-0 flex-1">
          <div
            ref={cardsRef}
            onScroll={recomputeOverflow}
            data-testid="kanban-scroll-column-body"
            className={cn(
              "absolute inset-0 space-y-2 overflow-y-auto px-2 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              bodyClassName
            )}
          >
            {children}
          </div>

          {overflowState.showTopFade && (
            <div
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute inset-x-0 top-0 h-4 bg-gradient-to-b to-transparent",
                fadeFromClassName
              )}
            />
          )}
          {overflowState.showBottomFade && (
            <div
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-transparent",
                fadeToClassName
              )}
            />
          )}
        </div>
      </div>
    );
  }
);
