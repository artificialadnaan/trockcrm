import { AlertTriangle, ArrowLeft, Flag, Loader2, Save } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { EntityPicker, PropertyCreateModal, type PickerOption } from "../components/entity-picker";
import { SkipModal } from "../components/skip-modal";
import { Badge, Button, FieldLabel, Panel, TextArea, TextInput } from "../components/ui";
import { useCleanupMutations, useRecord } from "../hooks/use-cleanup";
import type { MissingField, RecordType, RecordTypeSingular } from "../types/cleanup";
import { TYPE_TO_SINGULAR } from "../types/cleanup";

function validType(value: string | undefined): RecordType {
  if (value === "deals" || value === "leads" || value === "contacts" || value === "companies") return value;
  return "deals";
}

function editableFields(type: RecordTypeSingular, missing: MissingField[]) {
  const fields = new Set(missing.map((item) => item.field));
  if (type === "deal") {
    const expanded = new Set(fields);
    if (fields.has("amount")) {
      expanded.add("bid_estimate");
      expanded.add("awarded_amount");
    }
    return ["primary_contact_id", "company_id", "bid_estimate", "awarded_amount", "expected_close_date", "actual_close_date", "next_step"].filter((field) => expanded.has(field) || field === "next_step");
  }
  if (type === "lead") return ["company_id", "property_id", "primary_contact_id", "status", "pre_qual_value", "project_type", "bid_due_date"].filter((field) => fields.has(field) || field === "status");
  if (type === "contact") {
    const expanded = new Set(fields);
    if (fields.has("name")) {
      expanded.add("first_name");
      expanded.add("last_name");
    }
    if (fields.has("contact_method")) {
      expanded.add("email");
      expanded.add("phone");
      expanded.add("mobile");
    }
    return ["first_name", "last_name", "email", "phone", "mobile", "company_id"].filter((field) => expanded.has(field));
  }
  const expanded = new Set(fields);
  if (fields.has("account_signal")) {
    expanded.add("phone");
    expanded.add("address");
    expanded.add("website");
  }
  return ["name", "phone", "address", "website", "notes"].filter((field) => expanded.has(field) || field === "notes");
}

function labelFor(field: string) {
  return field.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function inputType(field: string) {
  if (field.includes("date")) return "date";
  if (field.includes("amount") || field.includes("estimate") || field === "pre_qual_value") return "number";
  return "text";
}

function valueFor(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return value.slice(0, 10);
  return String(value);
}

export function RecordEditPage() {
  const typeParam = validType(useParams().type);
  const type = TYPE_TO_SINGULAR[typeParam];
  const id = useParams().id ?? "";
  const { data: record, isLoading } = useRecord(type, id);
  const { patch, skip, flagDuplicate } = useCleanupMutations(type, id);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [skipOpen, setSkipOpen] = useState(false);
  const [propertyCreateOpen, setPropertyCreateOpen] = useState(false);
  const navigate = useNavigate();

  const fields = useMemo(() => (record ? editableFields(type, record.missingFields) : []), [record, type]);

  if (isLoading || !record) {
    return (
      <main className="grid min-h-[80vh] place-items-center">
        <Loader2 className="h-7 w-7 animate-spin text-red-700" />
      </main>
    );
  }

  const name = type === "contact" ? `${record.data.first_name ?? ""} ${record.data.last_name ?? ""}`.trim() || String(record.data.email ?? record.id) : String(record.data.name ?? record.id);
  const applyDraft = (cleanupStatus?: "completed") => {
    const body: Record<string, unknown> = {};
    for (const field of fields) {
      if (field in draft) body[field] = draft[field];
    }
    if (cleanupStatus) body.cleanup_status = cleanupStatus;
    patch.mutate(body, {
      onSuccess: () => {
        if (cleanupStatus) navigate(`/cleanup/${typeParam}`);
      },
    });
  };

  return (
    <main className="mx-auto max-w-7xl px-4 pb-28 pt-6 sm:px-6 lg:pb-8 lg:pt-8">
      <div className="border-b border-stone-300 pb-5">
        <Link to={`/cleanup/${typeParam}`} className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-red-800 hover:text-red-900">
          <ArrowLeft className="h-4 w-4" />
          Back to {typeParam}
        </Link>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-black text-stone-950">{name}</h1>
            <p className="mt-1 text-sm text-stone-600">
              {record.stage?.label ?? type} · Cleanup status {String(record.data.cleanup_status ?? "pending")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {record.missingFields.length === 0 ? <Badge tone="green">Ready to complete</Badge> : null}
            {record.missingFields.map((field) => (
              <Badge key={field.field + field.label} tone={field.severity === "required" ? "red" : "amber"}>
                {field.label}
              </Badge>
            ))}
          </div>
        </div>
      </div>

      <section className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
        <Panel className="p-5">
          <h2 className="text-xl font-black">Clean this record</h2>
          <p className="mt-1 text-sm text-stone-600">Update the fields Takashi needs reviewed. Save anytime, or mark complete when the record is ready.</p>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            {fields.length === 0 ? (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 sm:col-span-2">
                No required cleanup fields are missing. You can mark this record complete.
              </div>
            ) : (
              fields.map((field) => {
                const isTextArea = field === "notes" || field === "next_step";
                const currentValue = draft[field] ?? valueFor(record.data[field]);
                if (field === "primary_contact_id") {
                  return (
                    <EntityPicker
                      key={field}
                      label="Associated contact"
                      entity="contacts"
                      value={currentValue}
                      onChange={(value) => setDraft((current) => ({ ...current, [field]: value }))}
                    />
                  );
                }
                if (field === "company_id") {
                  return (
                    <EntityPicker
                      key={field}
                      label="Associated company"
                      entity="companies"
                      value={currentValue}
                      onChange={(value) => setDraft((current) => ({ ...current, [field]: value }))}
                    />
                  );
                }
                if (field === "property_id") {
                  return (
                    <EntityPicker
                      key={field}
                      label="Associated property"
                      entity="properties"
                      value={currentValue}
                      allowCreate={type === "lead"}
                      onCreate={() => setPropertyCreateOpen(true)}
                      onChange={(value) => setDraft((current) => ({ ...current, [field]: value }))}
                    />
                  );
                }
                return (
                  <div key={field} className={isTextArea ? "space-y-2 sm:col-span-2" : "space-y-2"}>
                    <FieldLabel>{labelFor(field)}</FieldLabel>
                    {isTextArea ? (
                      <TextArea value={currentValue} onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))} />
                    ) : (
                      <TextInput type={inputType(field)} value={currentValue} onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))} />
                    )}
                  </div>
                );
              })
            )}
          </div>
          {type === "lead" ? (
            <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <AlertTriangle className="mr-2 inline h-4 w-4" />
              Placeholder properties exist from import. Search for the target property, or create a new one when the imported placeholder is not useful.
            </div>
          ) : null}
          {type === "company" ? (
            <Button variant="secondary" className="mt-4" disabled={flagDuplicate.isPending} onClick={() => flagDuplicate.mutate()}>
              <Flag className="h-4 w-4" />
              Flag possible duplicate
            </Button>
          ) : null}
        </Panel>

        <Panel className="p-5">
          <h2 className="text-xl font-black">HubSpot source data</h2>
          <p className="mt-1 text-sm text-stone-600">Original import values for reference. Preserved fields are read-only.</p>
          <div className="mt-4 max-h-[620px] overflow-auto rounded-md border border-stone-300 bg-stone-950 p-4 text-xs text-stone-100">
            <dl className="space-y-3">
              {Object.entries(record.sourceHubSpotSnapshot).slice(0, 80).map(([key, value]) => (
                <div key={key}>
                  <dt className="font-bold text-stone-300">{key}</dt>
                  <dd className="mt-1 break-words text-stone-100">{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Panel>
      </section>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-stone-300 bg-stone-100/95 p-3 backdrop-blur lg:static lg:mt-6 lg:border-0 lg:bg-transparent lg:p-0">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 sm:flex-row lg:justify-end">
          <p className="text-xs leading-5 text-stone-600 sm:mr-auto sm:max-w-md">
            Skip only when the information is not available. Skipped records stay visible for leadership review.
          </p>
          <Button variant="secondary" className="w-full sm:w-auto" disabled={patch.isPending} onClick={() => applyDraft()}>
            <Save className="h-4 w-4" />
            Save draft
          </Button>
          <Button className="w-full sm:w-auto" disabled={patch.isPending} onClick={() => applyDraft("completed")}>
            Save and mark complete
          </Button>
          <Button variant="danger" className="w-full sm:w-auto" onClick={() => setSkipOpen(true)}>
            Skip for review
          </Button>
        </div>
      </div>

      <SkipModal
        open={skipOpen}
        pending={skip.isPending}
        onClose={() => setSkipOpen(false)}
        onConfirm={(skip_reason, skip_notes) =>
          skip.mutate(
            { skip_reason, skip_notes },
            {
              onSuccess: () => navigate(`/cleanup/${typeParam}`),
            },
          )
        }
      />
      <PropertyCreateModal
        open={propertyCreateOpen}
        companyId={draft.company_id ?? valueFor(record.data.company_id)}
        onClose={() => setPropertyCreateOpen(false)}
        onCreated={(option: PickerOption) => {
          setDraft((current) => ({ ...current, property_id: option.id }));
          setPropertyCreateOpen(false);
        }}
      />
    </main>
  );
}
