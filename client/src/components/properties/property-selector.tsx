import { useDeferredValue, useEffect, useState } from "react";
import { AlertTriangle, ChevronsUpDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { getOfficeRequestOptions } from "@/lib/office-selection";
import { formatPropertyLabel, updateProperty, useProperties, type PropertySurface } from "@/hooks/use-properties";
import { PropertyCreateDialog } from "./property-create-dialog";

type PropertySelectorRecord = Pick<
  PropertySurface,
  "id" | "companyId" | "name" | "address" | "city" | "state" | "zip" | "companyName"
> & Partial<PropertySurface>;
type PropertyAddressField = "address" | "city" | "state" | "zip";

interface PropertySelectorProps {
  companyId: string | null;
  value: string | null;
  onChange: (propertyId: string) => void;
  required?: boolean;
  requireLeadCreateFields?: boolean;
  disabled?: boolean;
  officeId?: string | null;
  repairIncompleteAddressOnSelect?: boolean;
  onPropertyRepaired?: (property: PropertySurface) => void;
}

function clean(value: string | null | undefined) {
  return value?.trim() ?? "";
}

export function getMissingPropertyAddressFields(
  property: Pick<PropertySelectorRecord, "address" | "city" | "state" | "zip">
): PropertyAddressField[] {
  const missing: PropertyAddressField[] = [];
  if (!clean(property.address)) missing.push("address");
  if (!clean(property.city)) missing.push("city");
  if (!/^[A-Z]{2}$/.test(clean(property.state).toUpperCase())) missing.push("state");
  if (!/^\d{5}(-\d{4})?$/.test(clean(property.zip))) missing.push("zip");
  return missing;
}

function hasIncompletePropertyAddress(property: Pick<PropertySelectorRecord, "address" | "city" | "state" | "zip">) {
  return getMissingPropertyAddressFields(property).length > 0;
}

function propertyLocation(property: Pick<PropertySelectorRecord, "city" | "state" | "zip">) {
  return [[property.city, property.state].filter(Boolean).join(", "), property.zip].filter(Boolean).join(" ");
}

export function getPropertySelectorLabel(property: PropertySelectorRecord) {
  if (!hasIncompletePropertyAddress(property)) {
    return formatPropertyLabel(property);
  }

  const parts = [
    clean(property.companyName),
    clean(property.name),
    propertyLocation(property),
  ].filter(Boolean);

  return `${parts.join(" - ") || "Unassigned Property"} (incomplete address)`;
}

export function sortPropertiesForSelection<T extends Pick<PropertySelectorRecord, "address" | "city" | "state" | "zip" | "name">>(
  properties: T[]
) {
  return [...properties].sort((left, right) => {
    const leftIncomplete = hasIncompletePropertyAddress(left);
    const rightIncomplete = hasIncompletePropertyAddress(right);
    if (leftIncomplete !== rightIncomplete) {
      return leftIncomplete ? 1 : -1;
    }
    return clean(left.name).localeCompare(clean(right.name));
  });
}

export async function resolveSelectedPropertyLabel(
  propertyId: string,
  properties: Array<Parameters<typeof formatPropertyLabel>[0] & { id: string }>,
  officeId?: string | null
) {
  const match = properties.find((property) => property.id === propertyId);
  if (match) {
    return getPropertySelectorLabel(match as PropertySelectorRecord);
  }

  const data = await api<{
    property: Parameters<typeof formatPropertyLabel>[0] & { id: string };
  }>(`/properties/${propertyId}`, getOfficeRequestOptions(officeId));
  return getPropertySelectorLabel(data.property as PropertySelectorRecord);
}

export function PropertySelector({
  companyId,
  value,
  onChange,
  required,
  requireLeadCreateFields,
  disabled = false,
  officeId,
  repairIncompleteAddressOnSelect,
  onPropertyRepaired,
}: PropertySelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const [repairTarget, setRepairTarget] = useState<PropertySurface | null>(null);
  const [repairDraft, setRepairDraft] = useState<Record<PropertyAddressField, string>>({
    address: "",
    city: "",
    state: "",
    zip: "",
  });
  const [repairError, setRepairError] = useState<string | null>(null);
  const [repairSaving, setRepairSaving] = useState(false);
  const deferredQuery = useDeferredValue(query.trim());
  const { properties, loading, refetch } = useProperties(
    {
      companyId: companyId || undefined,
      search: deferredQuery || undefined,
      limit: 25,
    },
    { officeId }
  );
  const sortedProperties = sortPropertiesForSelection(properties);
  const shouldRepairIncompleteAddress = Boolean(requireLeadCreateFields || repairIncompleteAddressOnSelect);

  useEffect(() => {
    if (!value) {
      setSelectedLabel(null);
      return;
    }
    let cancelled = false;

    void resolveSelectedPropertyLabel(value, properties, officeId)
      .then((label) => {
        if (!cancelled) {
          setSelectedLabel(label);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [officeId, properties, value]);

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        className="w-full justify-between gap-2 font-normal"
        onClick={() => setOpen((prev) => !prev)}
        disabled={disabled || !companyId}
        title={selectedLabel ?? undefined}
      >
        <span className={`min-w-0 flex-1 truncate text-left ${selectedLabel ? "text-foreground" : "text-muted-foreground"}`}>
          {selectedLabel ?? (!companyId ? "Select company first" : required ? "Select property *" : "Select property")}
        </span>
        <ChevronsUpDown className="h-4 w-4 opacity-50" />
      </Button>

      {open && companyId && !disabled && (
        <div className="space-y-2 rounded-md border bg-background p-2 shadow-sm">
          <Input
            autoFocus
            placeholder="Search properties..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {repairTarget ? (
            <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50 p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-700" />
                <div>
                  <p className="text-sm font-medium text-amber-900">Complete this property address</p>
                  <p className="text-xs text-amber-800">
                    Add the missing address fields before selecting this property.
                  </p>
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {getMissingPropertyAddressFields(repairTarget).includes("address") ? (
                  <Input
                    aria-label="Property street address"
                    placeholder="Street address"
                    value={repairDraft.address}
                    onChange={(event) => setRepairDraft((current) => ({ ...current, address: event.target.value }))}
                  />
                ) : null}
                {getMissingPropertyAddressFields(repairTarget).includes("city") ? (
                  <Input
                    aria-label="Property city"
                    placeholder="City"
                    value={repairDraft.city}
                    onChange={(event) => setRepairDraft((current) => ({ ...current, city: event.target.value }))}
                  />
                ) : null}
                {getMissingPropertyAddressFields(repairTarget).includes("state") ? (
                  <Input
                    aria-label="Property state"
                    placeholder="State"
                    maxLength={2}
                    value={repairDraft.state}
                    onChange={(event) => setRepairDraft((current) => ({ ...current, state: event.target.value.toUpperCase() }))}
                  />
                ) : null}
                {getMissingPropertyAddressFields(repairTarget).includes("zip") ? (
                  <Input
                    aria-label="Property ZIP"
                    placeholder="ZIP"
                    value={repairDraft.zip}
                    onChange={(event) => setRepairDraft((current) => ({ ...current, zip: event.target.value }))}
                  />
                ) : null}
              </div>
              {repairError ? <p className="text-xs text-red-600">{repairError}</p> : null}
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={async () => {
                    const patch = {
                      address: repairDraft.address.trim() || repairTarget.address || null,
                      city: repairDraft.city.trim() || repairTarget.city || null,
                      state: (repairDraft.state.trim() || repairTarget.state || "").toUpperCase() || null,
                      zip: repairDraft.zip.trim() || repairTarget.zip || null,
                    };
                    const missing = getMissingPropertyAddressFields(patch);
                    if (missing.length > 0) {
                      setRepairError(`Complete missing fields: ${missing.join(", ")}`);
                      return;
                    }
                    setRepairSaving(true);
                    setRepairError(null);
                    try {
                      const result = await updateProperty(repairTarget.id, patch, { officeId });
                      onPropertyRepaired?.(result.property);
                      setSelectedLabel(getPropertySelectorLabel(result.property));
                      onChange(result.property.id);
                      void refetch();
                      setRepairTarget(null);
                      setOpen(false);
                      setQuery("");
                    } catch (err) {
                      setRepairError(err instanceof Error ? err.message : "Failed to update property");
                    } finally {
                      setRepairSaving(false);
                    }
                  }}
                  disabled={repairSaving}
                >
                  {repairSaving ? "Saving..." : "Save address"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setRepairTarget(null);
                    setRepairError(null);
                  }}
                  disabled={repairSaving}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading properties...
              </div>
            ) : properties.length === 0 ? (
              <p className="px-2 py-2 text-sm text-muted-foreground">No properties found.</p>
            ) : (
              sortedProperties.map((property) => {
                const incomplete = hasIncompletePropertyAddress(property);
                const label = getPropertySelectorLabel(property);
                return (
                <button
                  key={property.id}
                  type="button"
                  className="w-full rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    if (incomplete && shouldRepairIncompleteAddress) {
                      setRepairTarget(property);
                      setRepairDraft({
                        address: property.address ?? "",
                        city: property.city ?? "",
                        state: property.state ?? "",
                        zip: property.zip ?? "",
                      });
                      setRepairError(null);
                      return;
                    }
                    setSelectedLabel(label);
                    onChange(property.id);
                    setOpen(false);
                    setQuery("");
                  }}
                  title={label}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {incomplete ? <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" /> : null}
                    <span className="block truncate">{label}</span>
                  </span>
                </button>
              );
              })
            )}
          </div>
          <PropertyCreateDialog
            initialCompanyId={companyId}
            companyLocked
            requireLeadCreateFields={requireLeadCreateFields}
            officeId={officeId}
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
