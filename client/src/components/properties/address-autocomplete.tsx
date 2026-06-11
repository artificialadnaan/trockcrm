import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

const INPUT_DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 3;

export interface AddressSuggestion {
  id: string; label: string; address: string; city: string; state: string; zip: string;
}
interface AddressParts { address: string; city: string; state: string; zip: string; }

export interface AddressAutocompleteProps {
  value: string;
  onChange: (address: string) => void;
  onSelect: (parts: AddressParts) => void;
  id?: string;
  "aria-label"?: string;
  placeholder?: string;
  required?: boolean;
}

// Note: /api/address/suggest is office-agnostic (a stateless Mapbox proxy, no tenant data), so this
// component takes no officeId. The server's MAPBOX_REQUEST_TIMEOUT_MS bounds latency; the reqId guard
// below drops superseded responses so a slow reply can't clobber a newer keystroke.
//
// Why a native input listener instead of React's onChange:
//   React 19 installs an instance-level value setter (_valueTracker) on controlled inputs.
//   When a test helper does `inputEl.value = v` followed by `dispatchEvent(new Event("input",...))`,
//   the tracker already records `v` as the last-known value, so `updateValueIfChanged` returns false
//   and React suppresses onChange.  A direct `addEventListener("input", ...)` on the wrapper div
//   bypasses that filtering and fires reliably regardless of how the value was assigned.
export function AddressAutocomplete({ value, onChange, onSelect, id, placeholder, required, ...rest }: AddressAutocompleteProps) {
  const [query, setQuery] = useState(value);
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const reqId = useRef(0);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Stable ref to onChange — avoids re-attaching the native listener on every render while
  // still calling the latest callback identity.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Sync external value → internal query (programmatic resets / controlled parent).
  // setQuery with the same string is a React bail-out: no re-render, no debounce re-fire.
  useEffect(() => {
    setQuery(value);
  }, [value]);

  // Native input listener: fires on every "input" event regardless of React's _valueTracker,
  // making the test's `inputEl.value = v; dispatchEvent(new Event("input"))` pattern work.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    const el = wrapper?.querySelector("input");
    if (!el) return;
    const handleInput = () => {
      const val = el.value;
      setQuery(val);
      onChangeRef.current(val);
    };
    el.addEventListener("input", handleInput);
    return () => el.removeEventListener("input", handleInput);
  }, []); // attach once on mount; uses ref for latest onChange identity

  // Debounced API suggestion fetch
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_QUERY_LENGTH) { setSuggestions([]); setOpen(false); return; }
    const myReq = ++reqId.current;
    const handle = setTimeout(async () => {
      try {
        const res = await api<{ suggestions: AddressSuggestion[] }>(`/address/suggest?q=${encodeURIComponent(q)}`);
        if (myReq !== reqId.current) return;
        setSuggestions(res.suggestions ?? []);
        setOpen((res.suggestions ?? []).length > 0);
      } catch {
        // Degrade THIS attempt only — do NOT latch. The next keystroke re-runs this effect and retries.
        if (myReq !== reqId.current) return;
        setSuggestions([]);
        setOpen(false);
      }
    }, INPUT_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  return (
    <div ref={wrapperRef} className="relative">
      <Input
        id={id}
        aria-label={rest["aria-label"]}
        placeholder={placeholder}
        required={required}
        value={query}
        onChange={() => {}}
        autoComplete="off"
      />
      {open && suggestions.length > 0 ? (
        <div className="absolute z-20 mt-1 w-full rounded-md border bg-background shadow-sm">
          {suggestions.map((s) => (
            <button
              key={s.id}
              type="button"
              data-testid="address-suggestion"
              className="block w-full truncate px-2 py-1.5 text-left text-sm hover:bg-muted"
              onClick={() => { onSelect({ address: s.address, city: s.city, state: s.state, zip: s.zip }); setOpen(false); }}
            >
              {s.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
