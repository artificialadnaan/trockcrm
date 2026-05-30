import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DEFAULT_SEARCH_DEBOUNCE_MS, useDebouncedValue } from "@/hooks/use-debounced-value";

export interface SearchInputProps {
  /** The committed/external value (e.g. from URL or page state). The field stays smooth locally while debounced changes flow up. */
  value: string;
  /** Called with the DEBOUNCED value (default 300ms) -- safe to feed straight into a server-keyed query without a refetch-per-keystroke storm. */
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  debounceMs?: number;
  autoFocus?: boolean;
  "aria-label"?: string;
}

/**
 * Shared debounced search box (PR 1 of the no-blank UX work). Renders an icon +
 * clearable input; typing updates the field instantly (smooth, no remount) and emits
 * the debounced value upward via onChange, so the consuming page's server query is
 * only re-keyed after the user pauses. Built on useDebouncedValue + the existing
 * ui/input + ui/button, modeled on the proven file-search-bar.tsx pattern.
 *
 * Not wired into any page yet -- the undebounced list searches (leads/companies/
 * contacts) adopt this in later PRs.
 */
export function SearchInput({
  value,
  onChange,
  placeholder = "Search...",
  className,
  inputClassName,
  debounceMs = DEFAULT_SEARCH_DEBOUNCE_MS,
  autoFocus,
  "aria-label": ariaLabel,
}: SearchInputProps) {
  const [draft, setDraft] = useState(value);
  const lastEmittedRef = useRef(value);
  const onChangeRef = useRef(onChange);

  // Hold the latest onChange in a ref so the emit effect below depends ONLY on the
  // debounced value -- never on the callback's identity. An inline parent callback
  // (the URL/filter adoption pattern) changes identity every render; if the emit effect
  // depended on it, it would re-fire with stale text and revert programmatic clears /
  // URL navigation.
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // Sync the local field when the controlled value changes from outside (programmatic
  // clear / URL navigation). Mark it as already-emitted so we don't echo it back.
  useEffect(() => {
    setDraft(value);
    lastEmittedRef.current = value;
  }, [value]);

  const debounced = useDebouncedValue(draft, debounceMs);

  // Emit ONLY when the debounced value actually changes, and never re-emit a value we
  // already reported.
  useEffect(() => {
    if (debounced !== lastEmittedRef.current) {
      lastEmittedRef.current = debounced;
      onChangeRef.current(debounced);
    }
  }, [debounced]);

  // Commit the pending value immediately when the field loses focus. A one-shot action
  // that reads the committed value (e.g. clicking an Export button, which blurs the input
  // first) must see the latest term, not one still inside the debounce window. The
  // lastEmittedRef guard makes this idempotent with the debounced emit above (no double-fire).
  const flushPending = () => {
    if (draft !== lastEmittedRef.current) {
      lastEmittedRef.current = draft;
      onChangeRef.current(draft);
    }
  };

  return (
    <div className={cn("relative", className)}>
      <Search
        className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        type="search"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={flushPending}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        autoFocus={autoFocus}
        className={cn("pl-8", draft ? "pr-8" : undefined, inputClassName)}
      />
      {draft ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Clear search"
          onClick={() => setDraft("")}
          className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 text-muted-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
