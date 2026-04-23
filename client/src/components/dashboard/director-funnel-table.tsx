import type { DirectorRepFunnelRow } from "@/hooks/use-director-dashboard";

export function DirectorFunnelTable({ rows }: { rows: DirectorRepFunnelRow[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-100">
            <th className="px-5 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-gray-500">
              Representative
            </th>
            <th className="px-4 py-3 text-right text-[10px] font-bold uppercase tracking-widest text-gray-500">
              Leads
            </th>
            <th className="px-4 py-3 text-right text-[10px] font-bold uppercase tracking-widest text-gray-500">
              Qualified Leads
            </th>
            <th className="px-4 py-3 text-right text-[10px] font-bold uppercase tracking-widest text-gray-500">
              Opportunities
            </th>
            <th className="px-4 py-3 text-right text-[10px] font-bold uppercase tracking-widest text-gray-500">
              Due Diligence
            </th>
            <th className="px-5 py-3 text-right text-[10px] font-bold uppercase tracking-widest text-gray-500">
              Bid Board Pipeline
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.repId} className="border-t border-gray-100">
              <td className="px-5 py-3 font-semibold text-gray-900">{row.repName}</td>
              <td className="px-4 py-3 text-right">{row.leads}</td>
              <td className="px-4 py-3 text-right">{row.qualifiedLeads}</td>
              <td className="px-4 py-3 text-right">{row.opportunities}</td>
              <td className="px-4 py-3 text-right">{row.dueDiligence}</td>
              <td className="px-5 py-3 text-right">{row.estimating}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
