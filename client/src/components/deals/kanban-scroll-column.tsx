import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";

const DEFAULT_ESTIMATE_ITEM_SIZE = 120;
const DEFAULT_OVERSCAN_ROWS = 6;
// Assumed viewport height before the scroll element is measured (SSR + first
// paint) so the initial render produces a full window of cards rather than an
// empty list until the ResizeObserver fires.
const INITIAL_VIRTUAL_VIEWPORT_HEIGHT = 720;

interface KanbanScrollColumnProps {
  header: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  fadeFromClassName?: string;
  fadeToClassName?: string;
  /**
   * Triggers re-measurement of overflow fades when this number changes
   * (typically pass the count of cards rendered as children / items).
   */
  childCount?: number;
  /**
   * Opt-in virtualization. When `renderItem` is provided and `itemCount` > 0
   * the column windows its rows with @tanstack/react-virtual (variable-height,
   * measured), mounting only the viewport-visible rows so a single column can
   * hold hundreds of cards and scroll smoothly. When omitted (or itemCount is
   * 0) the column renders `children` exactly as before — existing callers that
   * pass `children` are unaffected.
   */
  itemCount?: number;
  renderItem?: (index: number) => ReactNode;
  estimateItemSize?: number;
  overscan?: number;
  getItemKey?: (index: number) => string | number;
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
      itemCount,
      renderItem,
      estimateItemSize = DEFAULT_ESTIMATE_ITEM_SIZE,
      overscan = DEFAULT_OVERSCAN_ROWS,
      getItemKey,
    },
    forwardedRef
  ) {
    const cardsRef = useRef<HTMLDivElement>(null);
    const [overflowState, setOverflowState] = useState<{
      showTopFade: boolean;
      showBottomFade: boolean;
    }>({ showTopFade: false, showBottomFade: false });

    const virtualize = renderItem != null && (itemCount ?? 0) > 0;

    // Always called (rules of hooks); inert when not virtualizing because
    // getScrollElement returns null and count is 0, so no observers attach and
    // getVirtualItems() is empty — children-mode callers see no behavior change.
    const virtualizer = useVirtualizer({
      count: itemCount ?? 0,
      getScrollElement: () => (virtualize ? cardsRef.current : null),
      estimateSize: () => estimateItemSize,
      overscan,
      getItemKey,
      initialRect: { width: 0, height: INITIAL_VIRTUAL_VIEWPORT_HEIGHT },
    });

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
      // In virtualized mode `el`'s only child is the spacer (whose height grows
      // as rows are measured); observing it keeps the fades accurate.
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
            data-virtualized-card-count={virtualize ? itemCount : undefined}
            className={cn(
              "absolute inset-0 overflow-y-auto px-2 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              virtualize ? null : "space-y-2",
              bodyClassName
            )}
          >
            {virtualize ? (
              <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((virtualItem) => (
                  <div
                    key={virtualItem.key}
                    data-index={virtualItem.index}
                    ref={virtualizer.measureElement}
                    className="absolute inset-x-0 top-0 pb-2"
                    style={{ transform: `translateY(${virtualItem.start}px)` }}
                  >
                    {renderItem!(virtualItem.index)}
                  </div>
                ))}
              </div>
            ) : (
              children
            )}
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
