import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createProperty } from "@/hooks/use-properties";
import { CompanySelector } from "@/components/companies/company-selector";
import { useCompanyDetail } from "@/hooks/use-companies";
import type { PropertySurface } from "@/hooks/use-properties";

interface PropertyCreateDialogProps {
  onCreated?: (property: PropertySurface) => void;
  initialCompanyId?: string | null;
  companyLocked?: boolean;
  triggerLabel?: string;
}

export function PropertyCreateDialog({
  onCreated,
  initialCompanyId,
  companyLocked = false,
  triggerLabel = "New Property",
}: PropertyCreateDialogProps) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    companyId: initialCompanyId ?? "",
    name: "",
    address: "",
    city: "",
    state: "",
    zip: "",
    notes: "",
  });
  const { company } = useCompanyDetail(formData.companyId || undefined);

  useEffect(() => {
    if (open) {
      setFormData({
        companyId: initialCompanyId ?? "",
        name: "",
        address: "",
        city: "",
        state: "",
        zip: "",
        notes: "",
      });
      setError(null);
    }
  }, [initialCompanyId, open]);

  const derivedName = useMemo(() => {
    if (formData.name.trim()) return formData.name.trim();
    if (!formData.address.trim()) return "";
    return [company?.name, formData.address.trim()].filter(Boolean).join(" - ");
  }, [company?.name, formData.address, formData.name]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!formData.companyId) {
      setError("Company is required");
      return;
    }
    if (!derivedName) {
      setError("Property name or address is required");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await createProperty({
        companyId: formData.companyId,
        name: derivedName,
        address: formData.address.trim() || null,
        city: formData.city.trim() || null,
        state: formData.state.trim() || null,
        zip: formData.zip.trim() || null,
        notes: formData.notes.trim() || null,
      });
      setOpen(false);
      onCreated?.(result.property);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create property");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button type="button" variant="outline">
            <Plus className="mr-2 h-4 w-4" />
            {triggerLabel}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Property</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="space-y-2">
            <Label>Company *</Label>
            {companyLocked && initialCompanyId ? (
              <Input value={company?.name ?? "Loading company..."} disabled />
            ) : (
              <CompanySelector
                value={formData.companyId || null}
                onChange={(companyId) => setFormData((prev) => ({ ...prev, companyId }))}
                required
              />
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="property-name">Property Name</Label>
            <Input
              id="property-name"
              value={formData.name}
              onChange={(event) => setFormData((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="Defaults to Company - Address if left blank"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="property-address">Address *</Label>
            <Input
              id="property-address"
              value={formData.address}
              onChange={(event) => setFormData((prev) => ({ ...prev, address: event.target.value }))}
              placeholder="123 Main St"
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="property-city">City</Label>
              <Input
                id="property-city"
                value={formData.city}
                onChange={(event) => setFormData((prev) => ({ ...prev, city: event.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="property-state">State</Label>
              <Input
                id="property-state"
                maxLength={2}
                value={formData.state}
                onChange={(event) =>
                  setFormData((prev) => ({ ...prev, state: event.target.value.toUpperCase() }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="property-zip">ZIP</Label>
              <Input
                id="property-zip"
                value={formData.zip}
                onChange={(event) => setFormData((prev) => ({ ...prev, zip: event.target.value }))}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="property-notes">Notes</Label>
            <Textarea
              id="property-notes"
              rows={3}
              value={formData.notes}
              onChange={(event) => setFormData((prev) => ({ ...prev, notes: event.target.value }))}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Create Property
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
