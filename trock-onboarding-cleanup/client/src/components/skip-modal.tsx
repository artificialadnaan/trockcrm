import { useState } from "react";
import type { SkipReason } from "../types/cleanup";
import { Button, FieldLabel, Select, TextArea } from "./ui";

const reasons: Array<{ value: SkipReason; label: string }> = [
  { value: "contact_left_company", label: "Contact left company" },
  { value: "deal_stalled", label: "Deal stalled" },
  { value: "customer_unreachable", label: "Customer unreachable" },
  { value: "record_is_duplicate", label: "Record is duplicate" },
  { value: "record_is_junk", label: "Record is junk" },
  { value: "historical_no_enrichment_needed", label: "Historical, no enrichment needed" },
  { value: "missing_information_not_available", label: "Missing information not available" },
  { value: "other", label: "Other" },
];

export function SkipModal({
  open,
  onClose,
  onConfirm,
  pending,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: SkipReason, notes?: string) => void;
  pending?: boolean;
}) {
  const [reason, setReason] = useState<SkipReason>("missing_information_not_available");
  const [notes, setNotes] = useState("");
  if (!open) return null;
  const needsNotes = reason === "other";
  const disabled = pending || (needsNotes && !notes.trim());
  return (
    <div className="fixed inset-0 z-50 grid place-items-end bg-stone-950/50 p-0 sm:place-items-center sm:p-6">
      <div className="w-full max-w-lg rounded-t-lg border border-stone-300 bg-stone-50 p-5 shadow-2xl sm:rounded-lg">
        <h2 className="text-xl font-bold text-stone-950">Skip this record</h2>
        <p className="mt-1 text-sm text-stone-600">Skipped records count toward onboarding and stay flagged for leadership review.</p>
        <div className="mt-5 space-y-4">
          <div className="space-y-2">
            <FieldLabel>Reason</FieldLabel>
            <Select value={reason} onChange={(event) => setReason(event.target.value as SkipReason)}>
              {reasons.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <FieldLabel>{needsNotes ? "Notes required" : "Notes"}</FieldLabel>
            <TextArea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Add context for Takashi or admin review." />
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => onConfirm(reason, notes.trim() || undefined)} disabled={disabled}>
            Confirm skip
          </Button>
        </div>
      </div>
    </div>
  );
}
