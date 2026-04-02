import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DedupWarning } from "./dedup-warning";
import { createContact, updateContact } from "@/hooks/use-contacts";
import type { Contact } from "@/hooks/use-contacts";
import { CATEGORY_LABELS } from "@/lib/contact-utils";
import { Loader2 } from "lucide-react";

interface ContactFormProps {
  contact?: Contact;
  onSuccess?: (contact: Contact) => void;
}

export function ContactForm({ contact, onSuccess }: ContactFormProps) {
  const navigate = useNavigate();
  const isEdit = !!contact;

  const [formData, setFormData] = useState({
    firstName: contact?.firstName ?? "",
    lastName: contact?.lastName ?? "",
    email: contact?.email ?? "",
    phone: contact?.phone ?? "",
    mobile: contact?.mobile ?? "",
    companyName: contact?.companyName ?? "",
    jobTitle: contact?.jobTitle ?? "",
    category: contact?.category ?? "client",
    address: contact?.address ?? "",
    city: contact?.city ?? "",
    state: contact?.state ?? "",
    zip: contact?.zip ?? "",
    notes: contact?.notes ?? "",
  });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dedupSuggestions, setDedupSuggestions] = useState<Array<{
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    companyName: string | null;
    matchReason: string;
  }> | null>(null);

  const handleChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent, skipDedup = false) => {
    e.preventDefault();
    if (!formData.firstName.trim()) {
      setError("First name is required");
      return;
    }
    if (!formData.lastName.trim()) {
      setError("Last name is required");
      return;
    }

    setSubmitting(true);
    setError(null);
    setDedupSuggestions(null);

    try {
      if (isEdit) {
        const result = await updateContact(contact.id, formData);
        if (onSuccess) {
          onSuccess(result.contact);
        } else {
          navigate(`/contacts/${contact.id}`);
        }
      } else {
        const result = await createContact({
          ...formData,
          skipDedupCheck: skipDedup,
        });

        // Handle dedup warning
        if (result.dedupWarning && result.suggestions && result.suggestions.length > 0) {
          setDedupSuggestions(result.suggestions);
          setSubmitting(false);
          return;
        }

        if (result.contact) {
          if (onSuccess) {
            onSuccess(result.contact);
          } else {
            navigate(`/contacts/${result.contact.id}`);
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Failed to save contact");
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Show dedup warning if fuzzy matches were found
  if (dedupSuggestions) {
    return (
      <DedupWarning
        suggestions={dedupSuggestions}
        onUseExisting={(contactId) => navigate(`/contacts/${contactId}`)}
        onCreateAnyway={() => {
          setDedupSuggestions(null);
          // Re-submit with skipDedup flag
          const syntheticEvent = { preventDefault: () => {} } as React.FormEvent;
          handleSubmit(syntheticEvent, true);
        }}
        onCancel={() => setDedupSuggestions(null)}
      />
    );
  }

  return (
    <form onSubmit={(e) => handleSubmit(e, false)} className="space-y-6">
      {error && (
        <div className="p-4 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>
      )}

      {/* Name + Category */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Basic Information</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="firstName">First Name *</Label>
            <Input
              id="firstName"
              value={formData.firstName}
              onChange={(e) => handleChange("firstName", e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="lastName">Last Name *</Label>
            <Input
              id="lastName"
              value={formData.lastName}
              onChange={(e) => handleChange("lastName", e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="category">Category *</Label>
            <Select
              value={formData.category}
              onValueChange={(v) => { if (v != null) handleChange("category", v); }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                  <SelectItem key={key} value={key}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="companyName">Company</Label>
            <Input
              id="companyName"
              value={formData.companyName}
              onChange={(e) => handleChange("companyName", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="jobTitle">Job Title</Label>
            <Input
              id="jobTitle"
              value={formData.jobTitle}
              onChange={(e) => handleChange("jobTitle", e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Contact Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Contact Details</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={formData.email}
              onChange={(e) => handleChange("email", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone">Phone</Label>
            <Input
              id="phone"
              value={formData.phone}
              onChange={(e) => handleChange("phone", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mobile">Mobile</Label>
            <Input
              id="mobile"
              value={formData.mobile}
              onChange={(e) => handleChange("mobile", e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

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

      {/* Notes */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Notes</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            placeholder="Internal notes about this contact..."
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
          onClick={() => navigate(isEdit ? `/contacts/${contact.id}` : "/contacts")}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {isEdit ? "Save Changes" : "Create Contact"}
        </Button>
      </div>
    </form>
  );
}
