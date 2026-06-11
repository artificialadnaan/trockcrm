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

// Controlled input — the parent owns `value` (typing -> onChange -> parent state -> value prop -> this
// effect). /api/address/suggest is office-agnostic (a stateless Mapbox proxy, no tenant data), so this
// takes no officeId. The server's MAPBOX_REQUEST_TIMEOUT_MS bounds latency; the reqId guard drops a
// superseded response so a slow reply can't clobber a newer keystroke. Degrade-WITHOUT-latch: a failed
// or empty fetch clears suggestions for THAT attempt only — the next `value` change re-runs this effect
// and retries (no session-wide disable flag).
export function AddressAutocomplete({ value, onChange, onSelect, id, placeholder, required, ...rest }: AddressAutocompleteProps) {
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    const q = value.trim();
    if (q.length < MIN_QUERY_LENGTH) { setSuggestions([]); setOpen(false); return; }
    const myReq = ++reqId.current;
    const handle = setTimeout(async () => {
      try {
        const res = await api<{ suggestions: AddressSuggestion[] }>(`/address/suggest?q=${encodeURIComponent(q)}`);
        if (myReq !== reqId.current) return; // superseded by a newer keystroke
        setSuggestions(res.suggestions ?? []);
        setOpen((res.suggestions ?? []).length > 0);
      } catch {
        if (myReq !== reqId.current) return;
        setSuggestions([]); // degrade this attempt only; next value change retries
        setOpen(false);
      }
    }, INPUT_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [value]);

  return (
    <div className="relative">
      <Input
        id={id}
        aria-label={rest["aria-label"]}
        placeholder={placeholder}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
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
