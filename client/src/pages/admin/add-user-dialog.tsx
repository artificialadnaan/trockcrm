import { useState } from "react";
import { CRM_ASSIGNABLE_ROLES, type CrmAssignableRole } from "@trock-crm/shared/types";

export interface AddUserOffice { id: string; name: string }

// Presentational, statically renderable (no hooks needed for the field markup the test checks).
export function AddUserDialogBody({
  offices,
  value,
  onChange,
}: {
  offices: AddUserOffice[];
  value?: { email: string; displayName: string; role: CrmAssignableRole; officeId: string; sendInvite: boolean };
  onChange?: (patch: Partial<NonNullable<typeof value>>) => void;
}) {
  const v = value ?? { email: "", displayName: "", role: "rep" as CrmAssignableRole, officeId: offices[0]?.id ?? "", sendInvite: true };
  return (
    <div className="space-y-3">
      <label className="block text-sm">Email
        <input type="email" value={v.email} onChange={(e) => onChange?.({ email: e.target.value })} className="mt-1 w-full rounded border px-2 py-1" />
      </label>
      <label className="block text-sm">Name
        <input value={v.displayName} onChange={(e) => onChange?.({ displayName: e.target.value })} className="mt-1 w-full rounded border px-2 py-1" />
      </label>
      <label className="block text-sm">Role
        <select value={v.role} onChange={(e) => onChange?.({ role: e.target.value as CrmAssignableRole })} className="mt-1 w-full rounded border px-2 py-1">
          {CRM_ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </label>
      <label className="block text-sm">Office
        <select value={v.officeId} onChange={(e) => onChange?.({ officeId: e.target.value })} className="mt-1 w-full rounded border px-2 py-1">
          {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={v.sendInvite} onChange={(e) => onChange?.({ sendInvite: e.target.checked })} />
        Send invite email now
      </label>
    </div>
  );
}

export function AddUserDialog({
  offices,
  onCreate,
  onClose,
}: {
  offices: AddUserOffice[];
  onCreate: (input: { email: string; displayName: string; role: CrmAssignableRole; officeId: string; sendInvite: boolean }) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState({ email: "", displayName: "", role: "rep" as CrmAssignableRole, officeId: offices[0]?.id ?? "", sendInvite: true });
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-4">
      <AddUserDialogBody offices={offices} value={value} onChange={(p) => setValue((cur) => ({ ...cur, ...p }))} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-sm">Cancel</button>
        <button
          type="button"
          disabled={busy || !value.email.trim() || !value.displayName.trim() || !value.officeId}
          onClick={async () => {
            setBusy(true);
            try {
              await onCreate(value);
              onClose(); // only on success — onCreate rejects on API failure (already surfaced there)
            } catch {
              // error surfaced by onCreate's toast; keep the dialog open with the entered values
            } finally {
              setBusy(false);
            }
          }}
          className="rounded bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          Create user
        </button>
      </div>
    </div>
  );
}
