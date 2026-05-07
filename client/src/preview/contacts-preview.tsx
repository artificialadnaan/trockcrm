import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  Filter,
  Plus,
  Download,
  ArrowUpDown,
  Search,
  Phone,
  Mail,
  Calendar,
  Star,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EYEBROW, MetricCard, ScopeToggle } from "./preview-shared";

const ROLE_OPTIONS = ["Decision Maker", "Influencer", "Gatekeeper", "Procurement", "Engineer", "Owner"] as const;
type Role = (typeof ROLE_OPTIONS)[number];

type ContactRow = {
  id: string;
  name: string;
  title: string;
  company: string;
  role: Role;
  primary: boolean;
  phone: string;
  email: string;
  lastTouch: string;
  staleDays: number;
  linkedDeals: number;
  ownerInitials: string;
  ownerName: string;
};

const contacts: ContactRow[] = [
  { id: "1", name: "Marcus Holloway", title: "Director of Facilities", company: "Dallas Independent SD", role: "Decision Maker", primary: true, phone: "(214) 555-0102", email: "mholloway@dallasisd.org", lastTouch: "today", staleDays: 0, linkedDeals: 2, ownerInitials: "BR", ownerName: "Brett Rios" },
  { id: "2", name: "Linda Park", title: "VP Operations", company: "Frisco Logistics Co.", role: "Decision Maker", primary: true, phone: "(972) 555-0188", email: "lpark@friscologistics.com", lastTouch: "yesterday", staleDays: 1, linkedDeals: 2, ownerInitials: "BR", ownerName: "Brett Rios" },
  { id: "3", name: "Eric Chen", title: "Project Engineer", company: "Frisco Logistics Co.", role: "Engineer", primary: false, phone: "(972) 555-0190", email: "echen@friscologistics.com", lastTouch: "2 days ago", staleDays: 2, linkedDeals: 1, ownerInitials: "BR", ownerName: "Brett Rios" },
  { id: "4", name: "Susan Albright", title: "Property Manager", company: "Plano Tower LP", role: "Decision Maker", primary: true, phone: "(469) 555-0144", email: "susan@planotowerlp.com", lastTouch: "yesterday", staleDays: 1, linkedDeals: 1, ownerInitials: "BR", ownerName: "Brett Rios" },
  { id: "5", name: "Roy Bautista", title: "Procurement Lead", company: "City of Arlington", role: "Procurement", primary: false, phone: "(817) 555-0166", email: "rbautista@arlingtontx.gov", lastTouch: "3 days ago", staleDays: 3, linkedDeals: 1, ownerInitials: "BR", ownerName: "Brett Rios" },
  { id: "6", name: "Dr. Janelle Reyes", title: "Director of Operations", company: "McKinney Health Group", role: "Decision Maker", primary: true, phone: "(972) 555-0211", email: "jreyes@mckinneyhealth.org", lastTouch: "1 month ago", staleDays: 32, linkedDeals: 0, ownerInitials: "BR", ownerName: "Brett Rios" },
  { id: "7", name: "Angela Cho", title: "Real Estate Manager", company: "Carrollton Properties", role: "Influencer", primary: false, phone: "(469) 555-0234", email: "acho@carrolltonprops.com", lastTouch: "yesterday", staleDays: 1, linkedDeals: 1, ownerInitials: "BR", ownerName: "Brett Rios" },
  { id: "8", name: "Tom Reilly", title: "Executive Assistant", company: "Allen ISD", role: "Gatekeeper", primary: false, phone: "(214) 555-0288", email: "treilly@allenisd.org", lastTouch: "1 week ago", staleDays: 7, linkedDeals: 1, ownerInitials: "BR", ownerName: "Brett Rios" },
  { id: "9", name: "Greg Holland", title: "Owner", company: "Westlake Holdings", role: "Owner", primary: true, phone: "(817) 555-0301", email: "greg@westlakeholdings.com", lastTouch: "today", staleDays: 0, linkedDeals: 1, ownerInitials: "BR", ownerName: "Brett Rios" },
  { id: "10", name: "Patricia Nunez", title: "Facilities Director", company: "Garland Industrial", role: "Decision Maker", primary: true, phone: "(972) 555-0322", email: "pnunez@garlandind.com", lastTouch: "today", staleDays: 0, linkedDeals: 1, ownerInitials: "BR", ownerName: "Brett Rios" },
  { id: "11", name: "Ben Waters", title: "Sr. Project Manager", company: "Allen ISD", role: "Engineer", primary: false, phone: "(214) 555-0345", email: "bwaters@allenisd.org", lastTouch: "2 weeks ago", staleDays: 14, linkedDeals: 1, ownerInitials: "BR", ownerName: "Brett Rios" },
  { id: "12", name: "Cathy Reynolds", title: "Owner", company: "Lewisville Realty", role: "Owner", primary: true, phone: "(469) 555-0367", email: "cathy@lewisvillerealty.com", lastTouch: "6 weeks ago", staleDays: 42, linkedDeals: 0, ownerInitials: "BR", ownerName: "Brett Rios" },
];

function ContactAvatar({ name }: { name: string }) {
  const initials = name
    .split(" ")
    .filter((w) => !w.endsWith("."))
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-red text-[11px] font-black uppercase text-white">
      {initials}
    </div>
  );
}

function RolePill({ role }: { role: Role }) {
  const tones: Record<Role, string> = {
    "Decision Maker": "bg-brand-red/10 text-brand-red ring-1 ring-brand-red/20",
    Influencer: "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
    Gatekeeper: "bg-slate-100 text-slate-700 ring-1 ring-slate-200",
    Procurement: "bg-violet-50 text-violet-700 ring-1 ring-violet-200",
    Engineer: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
    Owner: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${tones[role]}`}>
      {role}
    </span>
  );
}

export function ContactsPreview() {
  const navigate = useNavigate();
  const [scope, setScope] = useState<"Mine" | "Team" | "All">("Mine");
  const [selected, setSelected] = useState<Role[]>([]);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    return contacts.filter((c) => {
      if (selected.length > 0 && !selected.includes(c.role)) return false;
      if (scope === "Mine" && c.ownerInitials !== "BR") return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        if (!c.name.toLowerCase().includes(q) && !c.company.toLowerCase().includes(q) && !c.email.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [scope, selected, search]);

  const decisionMakers = filtered.filter((c) => c.role === "Decision Maker" || c.role === "Owner").length;
  const stale = filtered.filter((c) => c.staleDays >= 30).length;
  const totalLinked = filtered.reduce((s, c) => s + c.linkedDeals, 0);

  const toggle = (r: Role) => {
    setSelected((current) => (current.includes(r) ? current.filter((s) => s !== r) : [...current, r]));
  };

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-4xl font-black uppercase tracking-tight text-slate-950 md:text-5xl">Contacts</h1>
          <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.24em] text-slate-500">
            People directory · {filtered.length} of {contacts.length}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ScopeToggle options={["Mine", "Team", "All"] as const} value={scope} onChange={setScope} />
          <Button size="lg">
            <Plus className="mr-1.5 h-4 w-4" />
            New contact
          </Button>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <MetricCard
          eyebrow="Total contacts"
          value={String(filtered.length)}
          badge={`${totalLinked} linked deals`}
          badgeTone="green"
          caption="In your book"
          accent="red"
        />
        <MetricCard
          eyebrow="Decision makers"
          value={String(decisionMakers)}
          badge="primary contacts"
          badgeTone="blue"
          caption="Who signs"
          accent="blue"
        />
        <MetricCard
          eyebrow="Untouched 30d+"
          value={String(stale)}
          badge="needs follow-up"
          drenched
          caption={stale > 0 ? "going cold" : "all warm"}
        />
      </div>

      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-1 items-center gap-3">
            <div className="flex flex-1 items-center gap-2 rounded-md bg-slate-100 px-3 py-2 lg:max-w-sm">
              <Search className="h-4 w-4 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, company, or email"
                className="flex-1 bg-transparent text-sm placeholder:text-slate-500 focus:outline-none"
              />
            </div>
            <button
              type="button"
              className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Filter className="h-4 w-4" />
              Company
              <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
            </button>
          </div>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          >
            <Download className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap gap-2 border-b border-slate-100 px-5 py-3">
          <p className={`${EYEBROW} self-center`}>Role:</p>
          {ROLE_OPTIONS.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => toggle(r)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide transition-colors ${
                selected.includes(r) ? "bg-brand-red text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {r}
            </button>
          ))}
          {selected.length > 0 ? (
            <button
              type="button"
              onClick={() => setSelected([])}
              className="ml-auto text-[11px] font-bold uppercase tracking-wide text-slate-500 hover:text-slate-900"
            >
              Clear
            </button>
          ) : null}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px]">
            <thead>
              <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                <th className="px-5 py-3 text-left">
                  <button className="inline-flex items-center gap-1 hover:text-slate-900">
                    Contact
                    <ArrowUpDown className="h-3 w-3" />
                  </button>
                </th>
                <th className="px-5 py-3 text-left">Company</th>
                <th className="px-5 py-3 text-left">Role</th>
                <th className="px-5 py-3 text-left">Quick</th>
                <th className="px-5 py-3 text-right">Linked deals</th>
                <th className="px-5 py-3 text-left">Last touch</th>
                <th className="px-5 py-3 text-left">Owner</th>
                <th className="w-10 px-5 py-3" aria-hidden />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((c) => {
                const isStale = c.staleDays >= 30;
                return (
                  <tr
                    key={c.id}
                    onClick={() => navigate(`/contacts/${c.id}`)}
                    className="cursor-pointer transition-colors hover:bg-slate-50"
                  >
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-3">
                        <ContactAvatar name={c.name} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <p className="truncate font-bold text-slate-950">{c.name}</p>
                            {c.primary ? (
                              <Star className="h-3 w-3 fill-amber-400 stroke-amber-400" aria-label="Primary contact" />
                            ) : null}
                          </div>
                          <p className="mt-0.5 truncate text-xs text-slate-500">{c.title}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-4 text-sm font-semibold text-slate-700">{c.company}</td>
                    <td className="px-5 py-4">
                      <RolePill role={c.role} />
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={(e) => e.stopPropagation()}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                          aria-label="Call"
                          title={c.phone}
                        >
                          <Phone className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => e.stopPropagation()}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                          aria-label="Email"
                          title={c.email}
                        >
                          <Mail className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => e.stopPropagation()}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                          aria-label="Schedule"
                        >
                          <Calendar className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                    <td className="px-5 py-4 text-right">
                      {c.linkedDeals > 0 ? (
                        <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold tabular-nums text-emerald-700 ring-1 ring-emerald-200">
                          {c.linkedDeals}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-5 py-4">
                      <span className={`text-sm ${isStale ? "font-bold text-brand-red" : "text-slate-600"}`}>
                        {c.lastTouch}
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-2">
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-red text-[10px] font-black uppercase text-white">
                          {c.ownerInitials}
                        </span>
                        <span className="text-sm text-slate-700">{c.ownerName}</span>
                      </div>
                    </td>
                    <td className="px-5 py-4 text-right">
                      <ChevronRight className="ml-auto h-4 w-4 text-slate-400" />
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center text-sm text-slate-500">
                    No contacts match these filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-xs text-slate-600">
          <p>
            <span className="font-bold tabular-nums text-slate-950">{filtered.length}</span> of{" "}
            <span className="tabular-nums">{contacts.length}</span>
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              Prev
            </button>
            <button
              type="button"
              className="flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              Next
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
