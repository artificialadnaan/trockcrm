import { Link } from "react-router-dom";

export function AdminOperationsWorkspace({
  items,
}: {
  items: Array<{ key: string; label: string; value: string; detail: string; href: string }>;
}) {
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div>
        <h2 className="text-sm font-bold uppercase tracking-wide text-gray-900">Operations workspace</h2>
        <p className="mt-1 text-sm text-gray-500">Prioritized action surfaces for queue triage, sync review, and admin oversight.</p>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {items.map((item) => (
          <Link key={item.key} to={item.href} className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-4 transition-colors hover:bg-white">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-gray-900">{item.label}</p>
              <span className="text-lg font-black text-gray-900">{item.value}</span>
            </div>
            <p className="mt-2 text-sm text-gray-500">{item.detail}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}
