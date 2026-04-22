import { useDeferredValue, useEffect, useState } from "react";
import { ChevronsUpDown, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { formatPropertyLabel, useProperties } from "@/hooks/use-properties";
import { PropertyCreateDialog } from "./property-create-dialog";

interface PropertySelectorProps {
  companyId: string | null;
  value: string | null;
  onChange: (propertyId: string) => void;
  required?: boolean;
}

export async function resolveSelectedPropertyLabel(
  propertyId: string,
  properties: Array<Parameters<typeof formatPropertyLabel>[0] & { id: string }>
) {
  const match = properties.find((property) => property.id === propertyId);
  if (match) {
    return formatPropertyLabel(match);
  }

  const data = await api<{
    property: Parameters<typeof formatPropertyLabel>[0] & { id: string };
  }>(`/properties/${propertyId}`);
  return formatPropertyLabel(data.property);
}

export function PropertySelector({ companyId, value, onChange, required }: PropertySelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query.trim());
  const { properties, loading, refetch } = useProperties({
    companyId: companyId || undefined,
    search: deferredQuery || undefined,
    limit: 25,
  });

  useEffect(() => {
    if (!value) {
      setSelectedLabel(null);
      return;
    }
    let cancelled = false;

    void resolveSelectedPropertyLabel(value, properties)
      .then((label) => {
        if (!cancelled) {
          setSelectedLabel(label);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [properties, value]);

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        className="w-full justify-between font-normal"
        onClick={() => setOpen((prev) => !prev)}
        disabled={!companyId}
      >
        <span className={selectedLabel ? "text-foreground" : "text-muted-foreground"}>
          {selectedLabel ?? (!companyId ? "Select company first" : required ? "Select property *" : "Select property")}
        </span>
        <ChevronsUpDown className="h-4 w-4 opacity-50" />
      </Button>

      {open && companyId && (
        <div className="space-y-2 rounded-md border bg-background p-2 shadow-sm">
          <Input
            autoFocus
            placeholder="Search properties..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading properties...
              </div>
            ) : properties.length === 0 ? (
              <p className="px-2 py-2 text-sm text-muted-foreground">No properties found.</p>
            ) : (
              properties.map((property) => (
                <button
                  key={property.id}
                  type="button"
                  className="w-full rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    setSelectedLabel(formatPropertyLabel(property));
                    onChange(property.id);
                    setOpen(false);
                    setQuery("");
                  }}
                >
                  {formatPropertyLabel(property)}
                </button>
              ))
            )}
          </div>
          <PropertyCreateDialog
            initialCompanyId={companyId}
            companyLocked
            triggerLabel="Add New Property"
            onCreated={(property) => {
              setSelectedLabel(formatPropertyLabel(property));
              onChange(property.id);
              void refetch();
              setOpen(false);
              setQuery("");
            }}
          />
        </div>
      )}
    </div>
  );
}
