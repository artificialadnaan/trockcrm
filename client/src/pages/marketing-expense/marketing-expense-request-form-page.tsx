import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Megaphone, Paperclip, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { CurrencyInput } from "@/components/ui/currency-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { uploadFile } from "@/hooks/use-files";
import {
  createMarketingExpenseRequest,
  submitMarketingExpenseRequest,
  type MarketingExpenseRequestPayload,
} from "@/hooks/use-marketing-expense-requests";
import {
  MARKETING_EXPENSE_ATTACHMENT_KINDS,
  MARKETING_EXPENSE_ATTACHMENT_KIND_LABELS,
  MARKETING_EXPENSE_COST_LABELS,
  MARKETING_EXPENSE_PAYMENT_METHODS,
  MARKETING_EXPENSE_PAYMENT_METHOD_LABELS,
  formatMoney,
  parseMoneyInput,
  sumMoneyForDisplay,
  type MarketingExpenseAttachmentKind,
} from "@trock-crm/shared/types";

/**
 * The digitized Marketing & Advertising Expense Request form.
 *
 * HOUSE FORM IDIOM — one `useState` object, a `handleChange`, imperative validation in the submit handler.
 * There is no react-hook-form and no zod in this repo and this does not add either.
 *
 * THE SUBMIT IS THREE STEPS, IN THIS ORDER, and the order is the whole design:
 *   1. POST creates a `draft`. Nothing is emailed.
 *   2. Every chosen attachment uploads against the id that came back — `files` needs a real request id,
 *      because a file row that attaches to nothing is rejected by the DB and by files/service.ts alike.
 *   3. POST /:id/submit flips it to `pending` and enqueues the mail.
 * Emailing at step 1 would send the approver a request whose supporting documents do not exist yet.
 *
 * A FAILED SUBMIT KEEPS THE DRAFT. `draftIdRef` holds the id across attempts, so pressing the button again
 * retries step 3 rather than creating a second row — which matters, because the most likely failure is
 * "no approver is configured", a thing an admin fixes in a minute.
 */

/** "no selection" as a sentinel string. Base UI hands `onValueChange` a `string | null`, never `""`. */
const NO_PAYMENT_METHOD = "__none__";

const COST_FIELDS = [
  ["costAdvertising", "mer-cost-advertising"],
  ["costRegistration", "mer-cost-registration"],
  ["costTravel", "mer-cost-travel"],
  ["costLodging", "mer-cost-lodging"],
  ["costMeals", "mer-cost-meals"],
  ["costMaterials", "mer-cost-materials"],
  ["costOther1", "mer-cost-other-1"],
  ["costOther2", "mer-cost-other-2"],
] as const;

type CostField = (typeof COST_FIELDS)[number][0];

const EMPTY_FORM: MarketingExpenseRequestPayload = {
  requestedByName: "",
  department: "",
  neededBy: "",
  vendorEvent: "",
  locationDates: "",
  purpose: "",
  expectedReturn: "",
  costAdvertising: "",
  costRegistration: "",
  costTravel: "",
  costLodging: "",
  costMeals: "",
  costMaterials: "",
  costOther1: "",
  costOther1Label: "",
  costOther2: "",
  costOther2Label: "",
  budgetJobCode: "",
  travelRequired: false,
  attendees: "",
  businessMeetings: "",
  paymentMethod: null,
  attachmentKinds: [],
};

const PAYMENT_METHOD_ITEMS = [
  { value: NO_PAYMENT_METHOD, label: "Not specified" },
  ...MARKETING_EXPENSE_PAYMENT_METHODS.map((value) => ({
    value,
    label: MARKETING_EXPENSE_PAYMENT_METHOD_LABELS[value],
  })),
];

export function MarketingExpenseRequestFormPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState<MarketingExpenseRequestPayload>(EMPTY_FORM);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Survives a failed submit so the retry reuses the draft instead of minting a second request number.
  const draftIdRef = useRef<string | null>(null);
  // The attachments that have NOT yet landed. A file is removed only once its upload has succeeded, so a
  // retry resumes at the one that failed instead of skipping it.
  const outstandingFilesRef = useRef<File[]>([]);

  const handleChange = <K extends keyof MarketingExpenseRequestPayload>(
    field: K,
    value: MarketingExpenseRequestPayload[K],
  ) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  // Display only. The stored total is the SQL sum of the same eight columns, recomputed server-side
  // whatever this says.
  const total = useMemo(
    () => sumMoneyForDisplay(COST_FIELDS.map(([field]) => form[field])),
    [form],
  );

  function validate(): string | null {
    if (!form.requestedByName.trim()) return "Requested by (name) is required.";
    if (!form.vendorEvent.trim()) return "Vendor / event is required.";
    if (!form.purpose.trim()) return "What is the request for? is required.";
    if (!form.expectedReturn.trim()) return "What will TRC receive in return? is required.";

    for (const [field] of COST_FIELDS) {
      const parsed = parseMoneyInput(form[field]);
      if (!parsed.ok) {
        const label = MARKETING_EXPENSE_COST_LABELS[field as CostField];
        return parsed.reason === "negative"
          ? `${label} cannot be negative.`
          : `${label} must be a dollar amount (up to two decimal places).`;
      }
    }
    // A request for $0.00 is a form somebody abandoned halfway, not an expense.
    if (sumMoneyForDisplay(COST_FIELDS.map(([field]) => form[field])) === "0.00") {
      return "Enter at least one estimated cost — the total cannot be $0.00.";
    }
    return null;
  }

  async function handleSubmit() {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      if (!draftIdRef.current) {
        const draft = await createMarketingExpenseRequest(form);
        draftIdRef.current = draft.id;
        outstandingFilesRef.current = [...attachments];
      }

      // Runs on EVERY attempt, retries included, and drains a queue rather than iterating `attachments`.
      //
      // The version that looped inside the `if` above had a hole: a failed upload still left `draftIdRef`
      // populated, so the next press skipped this block entirely and submitted — silently omitting the file
      // that failed and every file after it. The submitter would see a success and believe their quote was
      // attached; the approver would get a request with nothing behind it. Shifting only on success means a
      // retry picks up exactly where it stopped, and submit is unreachable while anything is outstanding.
      while (outstandingFilesRef.current.length > 0) {
        const file = outstandingFilesRef.current[0]!;
        try {
          await uploadFile({ file, category: "proposal", marketingExpenseRequestId: draftIdRef.current });
        } catch (uploadError) {
          const reason = uploadError instanceof Error ? uploadError.message : "upload failed";
          throw new Error(
            `Could not upload "${file.name}": ${reason}. Your request has NOT been submitted — press Submit again to retry.`,
          );
        }
        outstandingFilesRef.current = outstandingFilesRef.current.slice(1);
      }

      const submitted = await submitMarketingExpenseRequest(draftIdRef.current);
      toast.success(`Request ${submitted.requestNumber} submitted for approval`);
      navigate("/marketing-expense-requests");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not submit the request.";
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  function toggleAttachmentKind(kind: MarketingExpenseAttachmentKind, checked: boolean) {
    handleChange(
      "attachmentKinds",
      checked
        ? [...form.attachmentKinds, kind]
        : form.attachmentKinds.filter((entry) => entry !== kind),
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-1">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-red/10 text-brand-red">
            <Megaphone className="h-5 w-5" />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight">Marketing &amp; Advertising Expense Request</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Submitted for approval before the spend. You will get an email confirming it, and another the
          moment there is a decision.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Request information</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="mer-requested-by">Requested by (name)</Label>
            <Input
              id="mer-requested-by"
              data-testid="mer-requested-by"
              value={form.requestedByName}
              onChange={(event) => handleChange("requestedByName", event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mer-department">Department</Label>
            <Input
              id="mer-department"
              data-testid="mer-department"
              value={form.department}
              onChange={(event) => handleChange("department", event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mer-needed-by">Needed by</Label>
            <Input
              id="mer-needed-by"
              data-testid="mer-needed-by"
              type="date"
              value={form.neededBy}
              onChange={(event) => handleChange("neededBy", event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mer-vendor-event">Vendor / event</Label>
            <Input
              id="mer-vendor-event"
              data-testid="mer-vendor-event"
              value={form.vendorEvent}
              onChange={(event) => handleChange("vendorEvent", event.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="mer-location-dates">Location &amp; dates</Label>
            <Input
              id="mer-location-dates"
              data-testid="mer-location-dates"
              placeholder="Dallas, TX — Oct 12–14"
              value={form.locationDates}
              onChange={(event) => handleChange("locationDates", event.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What is the request for?</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            id="mer-purpose"
            data-testid="mer-purpose"
            className="min-h-28"
            aria-label="What is the request for?"
            value={form.purpose}
            onChange={(event) => handleChange("purpose", event.target.value)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What will TRC receive in return?</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            id="mer-expected-return"
            data-testid="mer-expected-return"
            className="min-h-28"
            aria-label="What will TRC receive in return?"
            value={form.expectedReturn}
            onChange={(event) => handleChange("expectedReturn", event.target.value)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Estimated cost</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {COST_FIELDS.slice(0, 6).map(([field, testId]) => (
              <div key={field} className="space-y-1.5">
                <Label htmlFor={testId}>{MARKETING_EXPENSE_COST_LABELS[field]}</Label>
                <CurrencyInput
                  id={testId}
                  data-testid={testId}
                  value={form[field]}
                  onChange={(value) => handleChange(field, value)}
                />
              </div>
            ))}
          </div>

          {/* The two free-text "Other" rows: a label the requester writes, and its amount. */}
          {([
            ["costOther1", "costOther1Label", "mer-cost-other-1"],
            ["costOther2", "costOther2Label", "mer-cost-other-2"],
          ] as const).map(([amountField, labelField, testId]) => (
            <div key={amountField} className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`${testId}-label`}>Other (describe)</Label>
                <Input
                  id={`${testId}-label`}
                  data-testid={`${testId}-label`}
                  value={form[labelField]}
                  onChange={(event) => handleChange(labelField, event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={testId}>Other amount</Label>
                <CurrencyInput
                  id={testId}
                  data-testid={testId}
                  aria-label={form[labelField].trim() || "Other amount"}
                  value={form[amountField]}
                  onChange={(value) => handleChange(amountField, value)}
                />
              </div>
            </div>
          ))}

          <div className="space-y-1.5">
            <Label htmlFor="mer-budget-job-code">Budget / job code</Label>
            <Input
              id="mer-budget-job-code"
              data-testid="mer-budget-job-code"
              value={form.budgetJobCode}
              onChange={(event) => handleChange("budgetJobCode", event.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Travel &amp; attendance</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Checkbox
              id="mer-travel-required"
              checked={form.travelRequired}
              onCheckedChange={(checked) => handleChange("travelRequired", checked)}
            />
            Travel is required
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="mer-attendees">Who is attending?</Label>
            <Textarea
              id="mer-attendees"
              data-testid="mer-attendees"
              value={form.attendees}
              onChange={(event) => handleChange("attendees", event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mer-business-meetings">Business meetings planned</Label>
            <Textarea
              id="mer-business-meetings"
              data-testid="mer-business-meetings"
              value={form.businessMeetings}
              onChange={(event) => handleChange("businessMeetings", event.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payment &amp; supporting information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="mer-payment-method">How should this be paid?</Label>
            {/*
              `items` is REQUIRED on Base UI's Select, and <SelectValue> needs explicit children — without
              both, the trigger renders the raw column value ("invoice_ap") instead of the label. The
              correct call site is components/filters/filter-select.tsx.
            */}
            <Select
              items={PAYMENT_METHOD_ITEMS}
              value={form.paymentMethod ?? NO_PAYMENT_METHOD}
              onValueChange={(next: string | null) =>
                handleChange("paymentMethod", !next || next === NO_PAYMENT_METHOD ? null : next)
              }
            >
              <SelectTrigger id="mer-payment-method" data-testid="mer-payment-method">
                <SelectValue>
                  {PAYMENT_METHOD_ITEMS.find(
                    (item) => item.value === (form.paymentMethod ?? NO_PAYMENT_METHOD),
                  )?.label ?? "Not specified"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_METHOD_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">What are you attaching?</legend>
            {MARKETING_EXPENSE_ATTACHMENT_KINDS.map((kind) => (
              <label key={kind} className="flex items-center gap-2 text-sm">
                <Checkbox
                  id={`mer-attachment-kind-${kind}`}
                  checked={form.attachmentKinds.includes(kind)}
                  onCheckedChange={(checked) => toggleAttachmentKind(kind, checked)}
                />
                {MARKETING_EXPENSE_ATTACHMENT_KIND_LABELS[kind]}
              </label>
            ))}
          </fieldset>

          <div className="space-y-2">
            <Label htmlFor="mer-attachments">Supporting documents</Label>
            {/*
              A plain file input, not <FileUploadZone>: that component's onUploadComplete takes NO arguments
              and returns nothing, so it cannot tell this page which files landed — and it would upload at
              pick time, before the request id it needs exists. `uploadFile()` is called directly in the
              submit handler instead, the same way deal-scoping-workspace.tsx does it.
            */}
            <Input
              id="mer-attachments"
              data-testid="mer-attachments"
              type="file"
              multiple
              onChange={(event) => setAttachments(Array.from(event.target.files ?? []))}
            />
            {attachments.length > 0 && (
              <ul className="space-y-1">
                {attachments.map((file) => (
                  <li key={file.name} className="flex items-center gap-2 text-sm text-slate-600">
                    <Paperclip className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{file.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      // slate-500 (4.76:1), not slate-400 (~2.5:1) — see muted-text-contrast.test.ts.
                      className="rounded p-0.5 text-slate-500 hover:text-slate-700"
                      onClick={() =>
                        setAttachments((current) => current.filter((entry) => entry !== file))
                      }
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent role="alert" data-testid="mer-error" className="p-4 text-sm text-red-700">
            {error}
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Total requested{" "}
          <span data-testid="mer-total" className="text-lg font-semibold text-slate-900">
            {formatMoney(total)}
          </span>
        </p>
        <Button data-testid="mer-submit" disabled={submitting} onClick={() => void handleSubmit()}>
          {submitting ? "Submitting…" : "Submit for approval"}
        </Button>
      </div>
    </div>
  );
}
