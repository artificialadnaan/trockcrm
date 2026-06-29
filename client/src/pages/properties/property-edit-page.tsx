import { useState, useEffect } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { usePropertyDetail, updateProperty } from "@/hooks/use-properties";

/** Parse an optional whole-number field: "" -> null, a non-negative integer -> number, anything else -> "invalid". */
function parseOptionalCount(value: string): number | null | "invalid" {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0) return "invalid";
  return n;
}

export function PropertyEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { property, loading, error } = usePropertyDetail(id);

  // Only the fields the API accepts (PATCH /api/properties/:id): address, city, state, zip,
  // buildYear, unitCount, notes. Name/company aren't editable here.
  const [formData, setFormData] = useState({
    address: "",
    city: "",
    state: "",
    zip: "",
    buildYear: "",
    unitCount: "",
    notes: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (property) {
      setFormData({
        address: property.address ?? "",
        city: property.city ?? "",
        state: property.state ?? "",
        zip: property.zip ?? "",
        buildYear: property.buildYear != null ? String(property.buildYear) : "",
        unitCount: property.unitCount != null ? String(property.unitCount) : "",
        notes: property.notes ?? "",
      });
    }
  }, [property]);

  const handleChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !property) return;

    const buildYear = parseOptionalCount(formData.buildYear);
    const unitCount = parseOptionalCount(formData.unitCount);
    if (buildYear === "invalid") {
      setSubmitError("Build year must be a whole number");
      return;
    }
    if (unitCount === "invalid") {
      setSubmitError("Unit count must be a whole number");
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    // Send only the fields the user actually changed. The server validates every key present in the
    // payload (buildPropertyUpdatePatch) — address/city/state/zip are required-when-present, buildYear
    // is bounded to 1800..now+2, unitCount must be > 0 — so re-sending an unchanged legacy value (a
    // blank required address part, a build year of 1500, a unit count of 0) would reject an otherwise
    // valid edit to a different field. Diffing also surfaces the real server error when a user clears
    // a required field, instead of silently keeping the old value.
    // Compare RAW form values (which mirror the loaded property) against the raw property values, so a
    // whitespace-padded or whitespace-only legacy field isn't mistaken for a change. Trim only when
    // assigning, so a genuine edit is still normalized before it's sent.
    const patch: Parameters<typeof updateProperty>[1] = {};
    if (formData.address !== (property.address ?? "")) patch.address = formData.address.trim() || null;
    if (formData.city !== (property.city ?? "")) patch.city = formData.city.trim() || null;
    if (formData.state !== (property.state ?? "")) patch.state = formData.state.trim() || null;
    if (formData.zip !== (property.zip ?? "")) patch.zip = formData.zip.trim() || null;
    if (buildYear !== property.buildYear) patch.buildYear = buildYear;
    if (unitCount !== property.unitCount) patch.unitCount = unitCount;
    if (formData.notes !== (property.notes ?? "")) patch.notes = formData.notes.trim() || null;

    try {
      await updateProperty(id, patch);
      // Preserve the query string (e.g. ?officeId=…) so a cross-office save returns to the detail
      // page in the same office context (api() resolves the office from the URL).
      navigate(`/properties/${id}${location.search}`);
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : "Failed to save property");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-3xl space-y-4">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="h-96 bg-muted animate-pulse rounded-lg" />
      </div>
    );
  }

  if (error || !property) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600">{error ?? "Property not found"}</p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => navigate(`/properties${location.search}`)}
        >
          Back to Properties
        </Button>
      </div>
    );
  }

  // Soft-deleted properties are read-only — editing one would silently revive stale data. getPropertyDetail
  // returns inactive rows, and the route is reachable by deep link, so guard here before the form.
  if (!property.isActive) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600">This property has been deleted and can&apos;t be edited.</p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => navigate(`/properties/${id}${location.search}`)}
        >
          Back to Property
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <h2 className="text-2xl font-bold">Edit Property</h2>
      <p className="text-muted-foreground mb-4">{property.name}</p>

      <form onSubmit={handleSubmit} className="space-y-6">
        {submitError && (
          <div className="p-4 bg-red-50 text-red-700 rounded-lg text-sm">{submitError}</div>
        )}

        {/* Address */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Address</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="address">Street Address</Label>
              <Input
                id="address"
                value={formData.address}
                onChange={(e) => handleChange("address", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="city">City</Label>
              <Input
                id="city"
                value={formData.city}
                onChange={(e) => handleChange("city", e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="state">State</Label>
                <Input
                  id="state"
                  maxLength={2}
                  value={formData.state}
                  onChange={(e) => handleChange("state", e.target.value.toUpperCase())}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="zip">ZIP</Label>
                <Input
                  id="zip"
                  value={formData.zip}
                  onChange={(e) => handleChange("zip", e.target.value)}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Building details */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Building Details</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="buildYear">Build Year</Label>
              <Input
                id="buildYear"
                inputMode="numeric"
                value={formData.buildYear}
                onChange={(e) => handleChange("buildYear", e.target.value)}
                placeholder="e.g. 2005"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="unitCount">Unit Count</Label>
              <Input
                id="unitCount"
                inputMode="numeric"
                value={formData.unitCount}
                onChange={(e) => handleChange("unitCount", e.target.value)}
                placeholder="e.g. 120"
              />
            </div>
          </CardContent>
        </Card>

        {/* Notes */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea
              id="notes"
              placeholder="Internal notes about this property..."
              value={formData.notes}
              onChange={(e) => handleChange("notes", e.target.value)}
              rows={4}
            />
          </CardContent>
        </Card>

        {/* Actions */}
        <div className="flex gap-3 justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => navigate(`/properties/${id}${location.search}`)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save Changes
          </Button>
        </div>
      </form>
    </div>
  );
}
