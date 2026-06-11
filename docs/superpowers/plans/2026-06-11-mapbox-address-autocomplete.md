# Mapbox Address Autocomplete — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Mapbox-powered street-address autocomplete (via a server proxy) to the two editable property-address surfaces, auto-filling street/city/state/ZIP on select while keeping the existing 6-field completeness gate authoritative.

**Architecture:** Server proxy `GET /api/address/suggest` holds `MAPBOX_TOKEN`, calls Mapbox Geocoding v6 forward (stateless), returns trimmed `{label,address,city,state,zip}[]`. A shared client `<AddressAutocomplete>` (debounced, min-3-chars, silent-degrade, retry-not-latch) renders suggestions and emits `onSelect`. Wired into `PropertyCreateDialog` and the `PropertySelector` repair editor. Selecting fills 4/6 fields; year/units stay required.

**Tech Stack:** Express + TypeScript (server module, vitest), React + Vite + TypeScript (client component, vitest + jsdom), Mapbox Geocoding API v6.

**Spec:** `docs/superpowers/specs/2026-06-11-mapbox-address-autocomplete-design.md`

---

## File Structure

- **Create** `server/src/modules/address/service.ts` — Mapbox v6 call + response parser + degrade logic. Exports `AddressSuggestion`, `parseMapboxFeatures`, `suggestAddresses`, and the named constants.
- **Create** `server/src/modules/address/routes.ts` — `GET /suggest` Express router.
- **Modify** `server/src/app.ts` — mount `app.use("/api/address", authMiddleware, requireCrmUser, addressRoutes)`.
- **Create** `server/tests/modules/address/service.test.ts` — parser + degrade unit tests (mock `fetch`).
- **Create** `client/src/components/properties/address-autocomplete.tsx` — shared component + `AddressSuggestion` client type.
- **Create** `client/src/components/properties/address-autocomplete.test.tsx` — debounce / min-chars / degrade+retry / select→onSelect.
- **Modify** `client/src/components/properties/property-create-dialog.tsx` — replace Address `<Input>` with `<AddressAutocomplete>`.
- **Modify** `client/src/components/properties/property-selector.tsx` — replace repair street `<Input>` with `<AddressAutocomplete>`.
- **Modify** `client/src/components/properties/property-selector.test.tsx` — add the invariant test (select fills address, year/units still gated).

**Env (ops, not code):** set `MAPBOX_TOKEN` (fresh URL-restricted `pk.*`) on the API service in Railway. Document in the PR description; do not commit the token.

---

## Task 1: Server — address suggest service (parser + degrade)

**Files:**
- Create: `server/src/modules/address/service.ts`
- Test: `server/tests/modules/address/service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/modules/address/service.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMapboxFeatures, suggestAddresses, MIN_QUERY_LENGTH } from "../../../src/modules/address/service.js";

const SAMPLE = {
  features: [
    {
      id: "addr.1",
      properties: {
        full_address: "2711 North Haskell Ave, Dallas, TX 75204, United States",
        name: "2711 North Haskell Ave",
        context: {
          place: { name: "Dallas" },
          region: { region_code: "TX", name: "Texas" },
          postcode: { name: "75204" },
        },
      },
    },
  ],
};

describe("parseMapboxFeatures", () => {
  it("maps a v6 feature to a trimmed AddressSuggestion", () => {
    expect(parseMapboxFeatures(SAMPLE)).toEqual([
      { id: "addr.1", label: "2711 North Haskell Ave, Dallas, TX 75204, United States",
        address: "2711 North Haskell Ave", city: "Dallas", state: "TX", zip: "75204" },
    ]);
  });

  it("tolerates partial context (missing postcode/region)", () => {
    const partial = { features: [{ id: "a", properties: { name: "1 Main St", context: { place: { name: "Austin" } } } }] };
    expect(parseMapboxFeatures(partial)).toEqual([
      { id: "a", label: "1 Main St", address: "1 Main St", city: "Austin", state: "", zip: "" },
    ]);
  });

  it("returns [] for empty/malformed input", () => {
    expect(parseMapboxFeatures({})).toEqual([]);
    expect(parseMapboxFeatures({ features: null } as never)).toEqual([]);
  });
});

describe("suggestAddresses (degrade)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; vi.unstubAllEnvs(); });

  it("returns [] when MAPBOX_TOKEN is unset (no network call)", async () => {
    vi.stubEnv("MAPBOX_TOKEN", "");
    const spy = vi.fn();
    globalThis.fetch = spy as never;
    expect(await suggestAddresses("2711 Haskell")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns [] when query is shorter than MIN_QUERY_LENGTH", async () => {
    vi.stubEnv("MAPBOX_TOKEN", "pk.test");
    const spy = vi.fn();
    globalThis.fetch = spy as never;
    expect(await suggestAddresses("ab".slice(0, MIN_QUERY_LENGTH - 1))).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns [] on non-2xx from Mapbox", async () => {
    vi.stubEnv("MAPBOX_TOKEN", "pk.test");
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 429 })) as never;
    expect(await suggestAddresses("2711 Haskell")).toEqual([]);
  });

  it("parses suggestions on 2xx", async () => {
    vi.stubEnv("MAPBOX_TOKEN", "pk.test");
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => SAMPLE })) as never;
    const out = await suggestAddresses("2711 Haskell");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ address: "2711 North Haskell Ave", city: "Dallas", state: "TX", zip: "75204" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/modules/address/service.test.ts`
Expected: FAIL — cannot find module `../../../src/modules/address/service.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/modules/address/service.ts
export const ADDRESS_AUTOCOMPLETE_COUNTRY = "us"; // US-only by config; revisit if non-US properties are onboarded.
export const MAPBOX_REQUEST_TIMEOUT_MS = 3000;    // distinct from the client's 250ms input debounce.
export const SUGGEST_LIMIT = 5;
export const MIN_QUERY_LENGTH = 3;

const MAPBOX_V6_FORWARD = "https://api.mapbox.com/search/geocode/v6/forward";

export interface AddressSuggestion {
  id: string;
  label: string;
  address: string;
  city: string;
  state: string;
  zip: string;
}

interface MapboxFeature {
  id?: string;
  properties?: {
    full_address?: string;
    name?: string;
    context?: {
      place?: { name?: string };
      region?: { region_code?: string; name?: string };
      postcode?: { name?: string };
    };
  };
}

export function parseMapboxFeatures(data: unknown): AddressSuggestion[] {
  const features = (data as { features?: unknown })?.features;
  if (!Array.isArray(features)) return [];
  return features.map((raw: MapboxFeature) => {
    const p = raw?.properties ?? {};
    const address = (p.name ?? "").trim();
    return {
      id: String(raw?.id ?? address),
      label: (p.full_address ?? p.name ?? "").trim(),
      address,
      city: (p.context?.place?.name ?? "").trim(),
      state: (p.context?.region?.region_code ?? "").trim().toUpperCase(),
      zip: (p.context?.postcode?.name ?? "").trim(),
    };
  });
}

export async function suggestAddresses(query: string): Promise<AddressSuggestion[]> {
  const token = process.env.MAPBOX_TOKEN?.trim();
  const q = query.trim();
  if (!token) return [];                       // degrade: no token
  if (q.length < MIN_QUERY_LENGTH) return [];  // degrade: too short (no network call)
  const params = new URLSearchParams({
    q,
    autocomplete: "true",
    types: "address",
    country: ADDRESS_AUTOCOMPLETE_COUNTRY,
    limit: String(SUGGEST_LIMIT),
    access_token: token,
  });
  try {
    const response = await fetch(`${MAPBOX_V6_FORWARD}?${params.toString()}`, {
      signal: AbortSignal.timeout(MAPBOX_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return [];               // degrade: non-2xx
    return parseMapboxFeatures(await response.json());
  } catch {
    return [];                                 // degrade: timeout / network error
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/modules/address/service.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/address/service.ts server/tests/modules/address/service.test.ts
git commit -m "feat(address): Mapbox v6 suggest service with parser + silent-degrade"
```

---

## Task 2: Server — `GET /api/address/suggest` route + mount

**Files:**
- Create: `server/src/modules/address/routes.ts`
- Modify: `server/src/app.ts` (add import + one `app.use` line near the other authed routes, e.g. just after the `/api/offices` mount ~line 213)

- [ ] **Step 1: Write the route**

```ts
// server/src/modules/address/routes.ts
import { Router } from "express";
import { suggestAddresses } from "./service.js";

const router = Router();

// GET /api/address/suggest?q=<text> — proxied Mapbox address autocomplete.
// suggestAddresses never throws (it degrades to []), so this returns 200 { suggestions } always.
router.get("/suggest", async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    res.json({ suggestions: await suggestAddresses(q) });
  } catch (err) {
    next(err);
  }
});

export default router;
```

- [ ] **Step 2: Mount in app.ts**

Add the import alongside the other route imports:
```ts
import addressRoutes from "./modules/address/routes.js";
```
Add the mount next to the other authed-no-tenant routes (mirrors `/api/offices`):
```ts
app.use("/api/address", authMiddleware, requireCrmUser, addressRoutes);
```

- [ ] **Step 3: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: clean (no new errors).

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/address/routes.ts server/src/app.ts
git commit -m "feat(address): mount GET /api/address/suggest (authed)"
```

---

## Task 3: Client — `<AddressAutocomplete>` component

**Files:**
- Create: `client/src/components/properties/address-autocomplete.tsx`
- Test: `client/src/components/properties/address-autocomplete.test.tsx`

- [ ] **Step 1: Write the failing test** (harness mirrors `lead-form.test.tsx`: `createRoot` + `act` + `dispatchEvent`, jsdom; mock `@/lib/api`)

```tsx
/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: apiMock }));

import { AddressAutocomplete } from "./address-autocomplete";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AddressAutocomplete", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => { apiMock.mockReset(); container = document.createElement("div"); document.body.appendChild(container); });
  afterEach(async () => { if (root) { const r = root; await act(async () => r.unmount()); } root = null; container.remove(); vi.useRealTimers(); });

  function render(props: Partial<Parameters<typeof AddressAutocomplete>[0]> = {}) {
    const onChange = props.onChange ?? vi.fn();
    const onSelect = props.onSelect ?? vi.fn();
    act(() => { root = createRoot(container); root.render(
      <AddressAutocomplete value={props.value ?? ""} onChange={onChange} onSelect={onSelect} aria-label="Street" />
    ); });
    return { onChange, onSelect };
  }
  const input = () => container.querySelector<HTMLInputElement>('input[aria-label="Street"]')!;
  async function type(v: string) {
    await act(async () => { input().value = v; input().dispatchEvent(new Event("input", { bubbles: true })); });
  }
  async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

  it("does not query below MIN_QUERY_LENGTH (3)", async () => {
    vi.useFakeTimers();
    render({ value: "12" });
    await tick(300);
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("debounces and fires one request, renders suggestions", async () => {
    vi.useFakeTimers();
    apiMock.mockResolvedValue({ suggestions: [{ id: "1", label: "2711 N Haskell Ave, Dallas, TX 75204", address: "2711 N Haskell Ave", city: "Dallas", state: "TX", zip: "75204" }] });
    const { } = render({ value: "2711 Haskell" });
    await tick(250);
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock).toHaveBeenCalledWith(expect.stringContaining("/address/suggest?q="));
    expect(container.textContent).toContain("2711 N Haskell Ave, Dallas, TX 75204");
  });

  it("calls onSelect with parsed parts on suggestion click", async () => {
    vi.useFakeTimers();
    apiMock.mockResolvedValue({ suggestions: [{ id: "1", label: "L", address: "2711 N Haskell Ave", city: "Dallas", state: "TX", zip: "75204" }] });
    const { onSelect } = render({ value: "2711 Haskell" });
    await tick(250);
    const option = container.querySelector<HTMLButtonElement>('[data-testid="address-suggestion"]')!;
    await act(async () => option.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSelect).toHaveBeenCalledWith({ address: "2711 N Haskell Ave", city: "Dallas", state: "TX", zip: "75204" });
  });

  it("degrades on error and RETRIES on the next keystroke (no latch)", async () => {
    vi.useFakeTimers();
    apiMock.mockRejectedValueOnce(new Error("boom"));
    render({ value: "2711 Haskel" });
    await tick(250);
    expect(container.querySelector('[data-testid="address-suggestion"]')).toBeNull(); // degraded this attempt
    apiMock.mockResolvedValueOnce({ suggestions: [{ id: "1", label: "L", address: "2711 N Haskell Ave", city: "Dallas", state: "TX", zip: "75204" }] });
    await type("2711 Haskell"); // next keystroke
    await tick(250);
    expect(apiMock).toHaveBeenCalledTimes(2); // retried, not latched
    expect(container.querySelector('[data-testid="address-suggestion"]')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/components/properties/address-autocomplete.test.tsx`
Expected: FAIL — cannot resolve `./address-autocomplete`.

- [ ] **Step 3: Write the component**

```tsx
// client/src/components/properties/address-autocomplete.tsx
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
export function AddressAutocomplete({ value, onChange, onSelect, id, placeholder, required, ...rest }: AddressAutocompleteProps) {
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  // Monotonic request id so a stale in-flight response can't overwrite a newer keystroke's result.
  const reqId = useRef(0);

  useEffect(() => {
    const q = value.trim();
    if (q.length < MIN_QUERY_LENGTH) { setSuggestions([]); setOpen(false); return; }
    const myReq = ++reqId.current;
    const handle = setTimeout(async () => {
      try {
        const res = await api<{ suggestions: AddressSuggestion[] }>(`/address/suggest?q=${encodeURIComponent(q)}`);
        if (myReq !== reqId.current) return; // superseded
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
              onClick={() => {
                onSelect({ address: s.address, city: s.city, state: s.state, zip: s.zip });
                setOpen(false);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx vitest run src/components/properties/address-autocomplete.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/properties/address-autocomplete.tsx client/src/components/properties/address-autocomplete.test.tsx
git commit -m "feat(address): shared AddressAutocomplete (debounce, min-chars, degrade-not-latch)"
```

---

## Task 4: Wire into PropertyCreateDialog

**Files:**
- Modify: `client/src/components/properties/property-create-dialog.tsx` (the `Address` field block, currently `<Input id="property-address" value={formData.address} onChange=... placeholder="123 Main St" />`)

- [ ] **Step 1: Add the import**

```tsx
import { AddressAutocomplete } from "./address-autocomplete";
```

- [ ] **Step 2: Replace the Address Input with AddressAutocomplete**

Replace the existing Address `<Input>` (keep the surrounding `<Label htmlFor="property-address">Address *</Label>` and layout) with:
```tsx
<AddressAutocomplete
  id="property-address"
  aria-label="Property street address"
  placeholder="123 Main St"
  required
  value={formData.address}
  onChange={(address) => setFormData((prev) => ({ ...prev, address }))}
  onSelect={({ address, city, state, zip }) =>
    setFormData((prev) => ({ ...prev, address, city, state, zip }))
  }
/>
```

- [ ] **Step 3: Typecheck + existing tests**

Run: `cd client && npx tsc --noEmit` (clean except pre-existing `@tanstack/react-virtual`) and `npx vitest run src/components/properties/property-create-dialog.test.tsx` if present (else skip).
Expected: clean / pass.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/properties/property-create-dialog.tsx
git commit -m "feat(address): autocomplete in Create Property dialog (fills city/state/zip on select)"
```

---

## Task 5: Wire into PropertySelector repair editor + invariant test

**Files:**
- Modify: `client/src/components/properties/property-selector.tsx` (the repair editor's street `<Input>`, gated by `repairMissing.includes("address")`)
- Modify: `client/src/components/properties/property-selector.test.tsx` (add the invariant test)

> **DECISION (approved): set-only-missing — do NOT full-canonicalize.** `onSelect` must set ONLY the address fields that were **missing when the editor opened**, never overwriting a city/state/zip that is already present. Rationale: silently rewriting present fields (e.g. Mapbox normalizing "Ave"→"Avenue" or "West Lafayette"→"Lafayette") is exactly what manufactures the formatting-drift duplicates already in prod (the 2711 North Haskell pair); a user filling one blank must not have three other fields rewritten under them. Full re-canonicalization, if ever wanted, is a deliberate clear-then-select act, not a side effect.
>
> **Freeze the missing-set at editor-open.** The set of fields `onSelect` may touch is `getMissingPropertyFields(repairTarget, { requireLeadCreate: requireLeadFields })` — which derives from `repairTarget` (set once at open, unchanged while the editor is open), so it is frozen by construction. Do NOT re-derive "missing" from `repairDraft` (the live draft), or it would recompute per keystroke and produce partial states. The `repairMissing` const already computed in the editor's render scope is exactly this frozen set; `onSelect` reuses it.

- [ ] **Step 1: Add the import**

```tsx
import { AddressAutocomplete } from "./address-autocomplete";
```

- [ ] **Step 2: Replace the repair street Input**

Replace the `repairMissing.includes("address")` `<Input ... aria-label="Property street address" ...>` block with:
```tsx
{repairMissing.includes("address") ? (
  <AddressAutocomplete
    aria-label="Property street address"
    placeholder="Street address"
    value={repairDraft.address}
    onChange={(address) => setRepairDraft((current) => ({ ...current, address }))}
    onSelect={(parts) =>
      setRepairDraft((current) => ({
        ...current,
        // Set-only-missing: only fill fields that were missing at editor-open (frozen via repairMissing,
        // which derives from the stable repairTarget). NEVER overwrite a present city/state/zip.
        ...(repairMissing.includes("address") ? { address: parts.address } : {}),
        ...(repairMissing.includes("city") ? { city: parts.city } : {}),
        ...(repairMissing.includes("state") ? { state: parts.state } : {}),
        ...(repairMissing.includes("zip") ? { zip: parts.zip } : {}),
      }))
    }
  />
) : null}
```

- [ ] **Step 3: Add the invariant test** (in `property-selector.test.tsx`, inside the existing interactive `describe`; mock `@/lib/api` is already present, and AddressAutocomplete will call it — return `{ suggestions: [...] }`)

```tsx
it("selecting an address suggestion fills the street but leaves the property gated on year/units", async () => {
  // incomplete on ALL fields so the address autocomplete + year/units inputs all render
  const incomplete = incompleteLeadCreateProperty({ id: "pAC", name: "AC", address: null, city: null, state: null, zip: null });
  propertyHook.list = [incomplete];
  apiMock.mockResolvedValue({ suggestions: [{ id: "s1", label: "9 Oak St, Dallas, TX 75201", address: "9 Oak St", city: "Dallas", state: "TX", zip: "75201" }] });

  renderSelector("pAC");
  await flush();
  expect(editorOpen()).toBe(true);

  // type into the address autocomplete, wait debounce, click the suggestion
  const street = container.querySelector<HTMLInputElement>('input[aria-label="Property street address"]')!;
  await act(async () => { street.value = "9 Oak"; street.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
  const option = container.querySelector<HTMLButtonElement>('[data-testid="address-suggestion"]')!;
  await clickButton(option);
  await flush();

  // address is filled, but year/units inputs are still present (still gated), editor still open, no auto-close
  expect(street.value).toBe("9 Oak St");
  expect(yearBuiltInput()).toBeTruthy();
  expect(unitCountInput()).toBeTruthy();
  expect(editorOpen()).toBe(true);
});

it("selecting a suggestion does NOT overwrite a present field (set-only-missing guard)", async () => {
  // Only the STREET is missing; city/state/zip + year/units are already present and authoritative.
  const onlyStreetMissing = buildProperty({ id: "pSOM", name: "SOM", address: null, city: "Plano", state: "TX", zip: "75024" });
  propertyHook.list = [onlyStreetMissing];
  propertyHook.updateProperty.mockResolvedValue({ property: { ...onlyStreetMissing, address: "9 Oak St" } });
  // The suggestion carries a DIFFERENT city ("Dallas") — it must NOT be written, since city wasn't missing at open.
  apiMock.mockResolvedValue({ suggestions: [{ id: "s1", label: "9 Oak St, Dallas, TX 75201", address: "9 Oak St", city: "Dallas", state: "TX", zip: "75201" }] });

  renderSelector("pSOM");
  await flush();
  expect(editorOpen()).toBe(true);

  const street = container.querySelector<HTMLInputElement>('input[aria-label="Property street address"]')!;
  await act(async () => { street.value = "9 Oak"; street.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
  await clickButton(container.querySelector<HTMLButtonElement>('[data-testid="address-suggestion"]')!);
  await flush();

  await clickButton(findButtonByText("Complete property")!);
  await flush();

  // The saved patch keeps the ORIGINAL city "Plano"; the suggestion's "Dallas" was NOT written.
  expect(propertyHook.updateProperty).toHaveBeenCalledTimes(1);
  const [, patch] = propertyHook.updateProperty.mock.calls[0];
  expect(patch.address).toBe("9 Oak St");
  expect(patch.city).toBe("Plano");
});
```

> Note: this test uses real timers for the 250ms debounce (the existing interactive tests don't fake timers). If timing is flaky, switch the debounce wait to `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(250)` scoped to this test, mirroring Task 3.

- [ ] **Step 4: Run tests**

Run: `cd client && npx vitest run src/components/properties/property-selector.test.tsx` (run 3× for flakiness) and `npx tsc --noEmit`.
Expected: all pass, 3× identical.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/properties/property-selector.tsx client/src/components/properties/property-selector.test.tsx
git commit -m "feat(address): autocomplete in repair editor; invariant test (select fills street, year/units stay gated)"
```

---

## Task 6: Full verification + PR

- [ ] **Step 1:** `cd server && npx vitest run tests/modules/address/` → PASS; `npx tsc --noEmit` → clean.
- [ ] **Step 2:** `cd client && npx vitest run src/components/properties/` → PASS; `npx tsc --noEmit` → clean except pre-existing `@tanstack/react-virtual`.
- [ ] **Step 3:** Confirm `MAPBOX_TOKEN` is set on the API Railway service (ops). Without it, suggest returns `[]` and the fields degrade to plain inputs — verify that degrade path manually if the token isn't ready.
- [ ] **Step 4:** Open PR off `main`; PR body documents the `MAPBOX_TOKEN` env requirement and the out-of-scope follow-ups (dedup-on-create, Haskell cleanup). Trigger `@codex review` + `@coderabbitai review`; green on exact tip; `gh pr merge {N} --merge`.

---

## Pre-branch gate (do this at execution time, before the branch goes up)

Re-confirm disjoint surfaces — `main` has moved since the last check. Verify no live/open-PR lane touches `client/src/components/properties/property-selector.tsx`, `property-create-dialog.tsx`, or introduces `server/src/modules/address/`:

```bash
gh pr list --state open --json number,headRefName,files --jq \
 '.[]|select(.files[].path|test("property-selector|property-create-dialog|modules/address"))|{number,headRefName}'
```
Expected: empty. If not empty, coordinate before branching.
```
