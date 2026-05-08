import { X, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { Button, FieldLabel, TextInput } from "./ui";

export type PickerOption = {
  id: string;
  display_name: string;
  subtitle?: string | null;
  meta?: string | null;
};

export function EntityPicker({
  label,
  entity,
  value,
  onChange,
  allowCreate,
  onCreate,
}: {
  label: string;
  entity: "contacts" | "companies" | "properties";
  value?: string;
  onChange: (id: string) => void;
  allowCreate?: boolean;
  onCreate?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<PickerOption[]>([]);
  const [selected, setSelected] = useState<PickerOption | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const lastSearch = useRef("");

  useEffect(() => {
    if (!value) {
      setSelected(null);
      return;
    }
    let cancelled = false;
    api.search(entity, value).then((rows) => {
      if (!cancelled) setSelected(rows.find((row) => row.id === value) ?? null);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [entity, value]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setOptions([]);
      return;
    }
    const handle = window.setTimeout(() => {
      setLoading(true);
      lastSearch.current = trimmed;
      api.search(entity, trimmed)
        .then((rows) => {
          if (lastSearch.current === trimmed) setOptions(rows);
        })
        .finally(() => setLoading(false));
    }, 180);
    return () => window.clearTimeout(handle);
  }, [entity, query]);

  const display = useMemo(() => selected?.display_name ?? (value ? value : ""), [selected, value]);

  return (
    <div className="relative space-y-2">
      <FieldLabel>{label}</FieldLabel>
      {value ? (
        <div className="flex min-h-11 items-center justify-between gap-2 rounded-md border border-stone-300 bg-stone-50 px-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-stone-950">{display}</p>
            {selected?.subtitle || selected?.meta ? <p className="truncate text-xs text-stone-600">{[selected.subtitle, selected.meta].filter(Boolean).join(" · ")}</p> : null}
          </div>
          <button className="grid h-9 w-9 shrink-0 place-items-center rounded hover:bg-stone-200" onClick={() => { onChange(""); setSelected(null); setQuery(""); }} type="button" aria-label={`Clear ${label}`}>
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <TextInput
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          placeholder={`Search ${label.toLowerCase()}`}
        />
      )}
      {open && !value ? (
        <div className="absolute z-30 max-h-80 w-full overflow-auto rounded-md border border-stone-300 bg-stone-50 shadow-xl">
          {allowCreate ? (
            <button className="flex min-h-11 w-full items-center gap-2 border-b border-stone-200 px-3 text-left text-sm font-semibold text-red-800 hover:bg-red-50" type="button" onClick={() => { setOpen(false); onCreate?.(); }}>
              <Plus className="h-4 w-4" />
              Create new property
            </button>
          ) : null}
          {loading ? <div className="px-3 py-3 text-sm text-stone-600">Searching...</div> : null}
          {!loading && options.length === 0 ? <div className="px-3 py-3 text-sm text-stone-600">Type at least two characters to search.</div> : null}
          {options.map((option) => (
            <button
              key={option.id}
              className="block min-h-11 w-full border-b border-stone-100 px-3 py-2 text-left last:border-0 hover:bg-stone-100"
              type="button"
              onClick={() => {
                setSelected(option);
                onChange(option.id);
                setQuery("");
                setOpen(false);
              }}
            >
              <span className="block text-sm font-semibold text-stone-950">{option.display_name}</span>
              <span className="block text-xs text-stone-600">{[option.subtitle, option.meta].filter(Boolean).join(" · ") || option.id}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function PropertyCreateModal({
  open,
  companyId,
  onClose,
  onCreated,
}: {
  open: boolean;
  companyId?: string;
  onClose: () => void;
  onCreated: (option: PickerOption) => void;
}) {
  const [form, setForm] = useState({ name: "", address: "", city: "", state: "", zip: "" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) return null;

  const update = (field: keyof typeof form, value: string) => setForm((current) => ({ ...current, [field]: value }));

  return (
    <div className="fixed inset-0 z-50 grid place-items-end bg-stone-950/50 p-0 sm:place-items-center sm:p-6">
      <div className="w-full max-w-lg rounded-t-lg border border-stone-300 bg-stone-50 p-5 shadow-2xl sm:rounded-lg">
        <h2 className="text-xl font-black">Create property</h2>
        <p className="mt-1 text-sm text-stone-600">Create a property for this lead, then it will be selected automatically.</p>
        {error ? <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <FieldLabel>Name</FieldLabel>
            <TextInput value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="Optional property name" />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <FieldLabel>Address line 1</FieldLabel>
            <TextInput value={form.address} onChange={(event) => update("address", event.target.value)} />
          </div>
          <div className="space-y-2">
            <FieldLabel>City</FieldLabel>
            <TextInput value={form.city} onChange={(event) => update("city", event.target.value)} />
          </div>
          <div className="space-y-2">
            <FieldLabel>State</FieldLabel>
            <TextInput value={form.state} onChange={(event) => update("state", event.target.value)} />
          </div>
          <div className="space-y-2">
            <FieldLabel>Zip</FieldLabel>
            <TextInput value={form.zip} onChange={(event) => update("zip", event.target.value)} />
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="secondary" disabled={pending} onClick={onClose}>Cancel</Button>
          <Button
            disabled={pending || !companyId || !form.address.trim()}
            onClick={() => {
              if (!companyId) {
                setError("Select a company before creating a property.");
                return;
              }
              setPending(true);
              setError(null);
              api.createProperty({ company_id: companyId, ...form })
                .then((created) => {
                  onCreated(created);
                  setForm({ name: "", address: "", city: "", state: "", zip: "" });
                })
                .catch((err) => setError(err instanceof Error ? err.message : "Property creation failed"))
                .finally(() => setPending(false));
            }}
          >
            Create property
          </Button>
        </div>
      </div>
    </div>
  );
}
