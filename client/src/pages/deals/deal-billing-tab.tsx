import { useState } from "react";
import { api } from "@/lib/api";
import { type DealDetail } from "@/hooks/use-deals";

export function DealBillingTab({ deal, onDealUpdated }: { deal: DealDetail; onDealUpdated: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ id: string; firstName: string; lastName: string; email: string | null; companyName: string | null }>>([]);
  const [saving, setSaving] = useState(false);

  const runSearch = (q: string) => {
    setQuery(q);
    if (q.trim().length < 2) { setResults([]); return; }
    api<{ contacts: Array<{ id: string; firstName: string; lastName: string; email: string | null; companyName: string | null; category: string }> }>(
      `/contacts/search?q=${encodeURIComponent(q.trim())}&limit=10`
    ).then((res) => { setResults(res.contacts); });
  };

  const assign = (contactId: string) => {
    setSaving(true);
    api<{ deal: DealDetail }>(`/deals/${deal.id}`, {
      method: "PATCH",
      json: { billingContactId: contactId },
    }).then(
      () => {
        setResults([]);
        setQuery("");
        onDealUpdated();
        setSaving(false);
      },
      () => {
        setSaving(false);
      }
    );
  };

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-800">Billing contact</h3>
        {deal.billingContactId ? (
          <div className="mt-2 text-sm text-slate-700">
            <div className="font-semibold">{deal.billingContactName ?? "Unknown contact"}</div>
            {deal.billingContactCompany ? <div className="text-slate-500">{deal.billingContactCompany}</div> : null}
            {deal.billingContactTitle ? <div className="text-slate-500">{deal.billingContactTitle}</div> : null}
            {deal.billingContactEmail ? <div className="text-slate-500">{deal.billingContactEmail}</div> : null}
            {deal.billingContactPhone ? <div className="text-slate-500">{deal.billingContactPhone}</div> : null}
          </div>
        ) : (
          <p className="mt-2 text-sm text-amber-700">No billing contact assigned yet — required before this deal can be marked Won.</p>
        )}
        <div className="mt-3">
          <input
            type="search"
            placeholder="Search contacts…"
            value={query}
            disabled={saving}
            onChange={(e) => runSearch(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
          {results.length > 0 ? (
            <ul className="mt-1 divide-y divide-slate-100 rounded-md border border-slate-200">
              {results.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="w-full px-2 py-1.5 text-left text-sm hover:bg-slate-50"
                    onClick={() => assign(c.id)}
                  >
                    {c.firstName} {c.lastName}{c.companyName ? ` — ${c.companyName}` : ""}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>
    </div>
  );
}
