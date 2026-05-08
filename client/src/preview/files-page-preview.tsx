import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Plus,
  Search,
  ChevronDown,
  ChevronRight,
  Camera,
  FileText,
  Layers,
  ArrowDownToLine,
  MoreHorizontal,
  Briefcase,
  Building2,
  Users,
  ClipboardList,
  MapPin,
  LayoutGrid,
  List,
  ArrowUpDown,
  Filter,
  Star,
  X,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EYEBROW, MetricCard, ScopeToggle } from "./preview-shared";

type LinkType = "deal" | "lead" | "contact" | "company" | "property";

type LinkedRecord = { type: LinkType; id: string; name: string };

type Kind = "photo" | "Contract" | "Proposal" | "Estimate" | "RFP" | "Drawing" | "Spec" | "Receipt" | "Other";

type FileRow = {
  id: string;
  name: string;
  kind: Kind;
  sizeKB: number;
  uploadedBy: string;
  uploadedByInitials: string;
  uploadedAt: string;
  uploadedTimestamp: number;
  linked?: LinkedRecord;
  starred?: boolean;
};

const fixture: FileRow[] = [
  // PHOTOS - mostly tied to site walks
  { id: "f1", name: "Ridge cap south", kind: "photo", sizeKB: 2_400, uploadedBy: "Brett Rios", uploadedByInitials: "BR", uploadedAt: "2 days ago", uploadedTimestamp: 172800, linked: { type: "property", id: "1", name: "Building A" } },
  { id: "f2", name: "Drain bay 4", kind: "photo", sizeKB: 1_900, uploadedBy: "Brett Rios", uploadedByInitials: "BR", uploadedAt: "2 days ago", uploadedTimestamp: 172800, linked: { type: "property", id: "1", name: "Building A" } },
  { id: "f3", name: "HVAC curb 7", kind: "photo", sizeKB: 2_100, uploadedBy: "Brett Rios", uploadedByInitials: "BR", uploadedAt: "2 days ago", uploadedTimestamp: 172800, linked: { type: "property", id: "1", name: "Building A" } },
  { id: "f4", name: "Parapet east", kind: "photo", sizeKB: 1_700, uploadedBy: "Brett Rios", uploadedByInitials: "BR", uploadedAt: "2 days ago", uploadedTimestamp: 172800, linked: { type: "property", id: "1", name: "Building A" } },
  { id: "f5", name: "Plano Tower roof south", kind: "photo", sizeKB: 2_300, uploadedBy: "Brett Rios", uploadedByInitials: "BR", uploadedAt: "1 week ago", uploadedTimestamp: 604800, linked: { type: "property", id: "3", name: "Plano Office Tower" } },
  { id: "f6", name: "Frisco DC aerial", kind: "photo", sizeKB: 3_400, uploadedBy: "Brett Rios", uploadedByInitials: "BR", uploadedAt: "3 days ago", uploadedTimestamp: 259200, linked: { type: "property", id: "2", name: "Frisco DC" } },
  { id: "f7", name: "Skylight cluster", kind: "photo", sizeKB: 1_800, uploadedBy: "Brett Rios", uploadedByInitials: "BR", uploadedAt: "2 days ago", uploadedTimestamp: 172800, linked: { type: "property", id: "1", name: "Building A" } },
  { id: "f8", name: "Stair access", kind: "photo", sizeKB: 1_600, uploadedBy: "Brett Rios", uploadedByInitials: "BR", uploadedAt: "2 days ago", uploadedTimestamp: 172800, linked: { type: "property", id: "1", name: "Building A" } },
  { id: "f9", name: "Westlake building 7 north", kind: "photo", sizeKB: 2_900, uploadedBy: "Brett Rios", uploadedByInitials: "BR", uploadedAt: "today", uploadedTimestamp: 7200, linked: { type: "lead", id: "1", name: "Westlake Industrial Park" } },
  { id: "f10", name: "Allen Sports complex aerial", kind: "photo", sizeKB: 3_100, uploadedBy: "Brett Rios", uploadedByInitials: "BR", uploadedAt: "1 month ago", uploadedTimestamp: 2_592_000, linked: { type: "deal", id: "9", name: "Allen Sports Complex" } },

  // DOCUMENTS
  { id: "f11", name: "Dallas ISD Bldg A — Estimate v2.pdf", kind: "Estimate", sizeKB: 1_240, uploadedBy: "Brett Rios", uploadedByInitials: "BR", uploadedAt: "yesterday", uploadedTimestamp: 86_400, linked: { type: "deal", id: "1", name: "Dallas ISD Roof Replacement" }, starred: true },
  { id: "f12", name: "Building A — RFP packet.pdf", kind: "RFP", sizeKB: 4_320, uploadedBy: "Marcus Holloway", uploadedByInitials: "MH", uploadedAt: "1 week ago", uploadedTimestamp: 604800, linked: { type: "deal", id: "1", name: "Dallas ISD Roof Replacement" } },
  { id: "f13", name: "MSA — Dallas ISD 2024.pdf", kind: "Contract", sizeKB: 2_140, uploadedBy: "Marcus Holloway", uploadedByInitials: "MH", uploadedAt: "1 month ago", uploadedTimestamp: 2_592_000, linked: { type: "company", id: "1", name: "Dallas ISD" }, starred: true },
  { id: "f14", name: "Frisco DC — pre-bid Q&A.pdf", kind: "Spec", sizeKB: 240, uploadedBy: "Linda Park", uploadedByInitials: "LP", uploadedAt: "1 week ago", uploadedTimestamp: 604800, linked: { type: "deal", id: "2", name: "Frisco Distribution Center" } },
  { id: "f15", name: "Frisco DC — site survey.dwg", kind: "Drawing", sizeKB: 8_440, uploadedBy: "Linda Park", uploadedByInitials: "LP", uploadedAt: "2 weeks ago", uploadedTimestamp: 1_209_600, linked: { type: "deal", id: "2", name: "Frisco Distribution Center" } },
  { id: "f16", name: "Plano Tower — addendum 1.pdf", kind: "Spec", sizeKB: 540, uploadedBy: "Susan Albright", uploadedByInitials: "SA", uploadedAt: "yesterday", uploadedTimestamp: 86_400, linked: { type: "deal", id: "3", name: "Plano Office Tower Re-Cover" } },
  { id: "f17", name: "Skyline closeout proposal.pdf", kind: "Proposal", sizeKB: 980, uploadedBy: "Brett Rios", uploadedByInitials: "BR", uploadedAt: "3 weeks ago", uploadedTimestamp: 1_814_400, linked: { type: "deal", id: "11", name: "Skyline Auditorium" } },
  { id: "f18", name: "TPO membrane spec sheet.pdf", kind: "Spec", sizeKB: 540, uploadedBy: "Brett Rios", uploadedByInitials: "BR", uploadedAt: "2 weeks ago", uploadedTimestamp: 1_209_600, linked: { type: "deal", id: "1", name: "Dallas ISD Roof Replacement" } },
  { id: "f19", name: "Building A floor plan.dwg", kind: "Drawing", sizeKB: 8_440, uploadedBy: "Marcus Holloway", uploadedByInitials: "MH", uploadedAt: "2 weeks ago", uploadedTimestamp: 1_209_600, linked: { type: "property", id: "1", name: "Building A" } },
  { id: "f20", name: "Arlington Civic — signed contract.pdf", kind: "Contract", sizeKB: 1_840, uploadedBy: "Roy Bautista", uploadedByInitials: "RB", uploadedAt: "3 days ago", uploadedTimestamp: 259200, linked: { type: "deal", id: "4", name: "Arlington Civic Center" }, starred: true },
  { id: "f21", name: "QuickBooks receipt May 2026.pdf", kind: "Receipt", sizeKB: 80, uploadedBy: "QuickBooks", uploadedByInitials: "QB", uploadedAt: "5 days ago", uploadedTimestamp: 432_000 },
  { id: "f22", name: "Carrollton Logistics RFP.pdf", kind: "RFP", sizeKB: 3_220, uploadedBy: "Angela Cho", uploadedByInitials: "AC", uploadedAt: "1 week ago", uploadedTimestamp: 604800, linked: { type: "deal", id: "8", name: "Carrollton Logistics Hub" } },
  { id: "f23", name: "Garland Warehouse — bid sheet.pdf", kind: "Estimate", sizeKB: 760, uploadedBy: "Brett Rios", uploadedByInitials: "BR", uploadedAt: "yesterday", uploadedTimestamp: 86_400, linked: { type: "deal", id: "9", name: "Garland Warehouse 14" } },
  { id: "f24", name: "McKinney Medical — initial scope.pdf", kind: "Spec", sizeKB: 1_120, uploadedBy: "Dr. Janelle Reyes", uploadedByInitials: "JR", uploadedAt: "1 month ago", uploadedTimestamp: 2_592_000, linked: { type: "lead", id: "1", name: "McKinney Medical Plaza" } },
];

const linkTypeMeta: Record<LinkType, { icon: typeof Briefcase; route: (id: string) => string; tone: string }> = {
  deal: { icon: Briefcase, route: (id) => `/deals/${id}`, tone: "bg-brand-red/10 text-brand-red ring-brand-red/20" },
  lead: { icon: ClipboardList, route: (id) => `/leads/${id}`, tone: "bg-blue-50 text-blue-700 ring-blue-200" },
  contact: { icon: Users, route: (id) => `/contacts/${id}`, tone: "bg-violet-50 text-violet-700 ring-violet-200" },
  company: { icon: Building2, route: (id) => `/companies/${id}`, tone: "bg-amber-50 text-amber-700 ring-amber-200" },
  property: { icon: MapPin, route: (id) => `/properties/${id}`, tone: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
};

const kindStyles: Record<Exclude<Kind, "photo">, string> = {
  Contract: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  Proposal: "bg-brand-red/10 text-brand-red ring-brand-red/20",
  Estimate: "bg-amber-50 text-amber-700 ring-amber-200",
  RFP: "bg-blue-50 text-blue-700 ring-blue-200",
  Drawing: "bg-violet-50 text-violet-700 ring-violet-200",
  Spec: "bg-slate-100 text-slate-700 ring-slate-200",
  Receipt: "bg-slate-100 text-slate-700 ring-slate-200",
  Other: "bg-slate-100 text-slate-700 ring-slate-200",
};

function formatSize(kb: number): string {
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${kb} KB`;
}

function LinkChip({ link, onClick }: { link: LinkedRecord; onClick: () => void }) {
  const meta = linkTypeMeta[link.type];
  const Icon = meta.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 transition-opacity hover:opacity-80 ${meta.tone}`}
    >
      <Icon className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate">{link.name}</span>
    </button>
  );
}

type Tab = "all" | "photos" | "documents";
type View = "grid" | "list";
type SortBy = "recent" | "name" | "size";

export function FilesPagePreview() {
  const navigate = useNavigate();
  const [scope, setScope] = useState<"Mine" | "Team" | "All">("Mine");
  const [tab, setTab] = useState<Tab>("all");
  const [view, setView] = useState<View>("grid");
  const [sort, setSort] = useState<SortBy>("recent");
  const [search, setSearch] = useState("");
  const [linkedTypeFilter, setLinkedTypeFilter] = useState<LinkType | "any">("any");
  const [starredOnly, setStarredOnly] = useState(false);

  const filtered = useMemo(() => {
    return fixture
      .filter((f) => {
        if (tab === "photos" && f.kind !== "photo") return false;
        if (tab === "documents" && f.kind === "photo") return false;
        if (linkedTypeFilter !== "any" && f.linked?.type !== linkedTypeFilter) return false;
        if (starredOnly && !f.starred) return false;
        if (search.trim()) {
          const q = search.toLowerCase();
          if (
            !f.name.toLowerCase().includes(q) &&
            !(f.linked?.name.toLowerCase().includes(q) ?? false) &&
            !f.uploadedBy.toLowerCase().includes(q)
          )
            return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sort === "name") return a.name.localeCompare(b.name);
        if (sort === "size") return b.sizeKB - a.sizeKB;
        return a.uploadedTimestamp - b.uploadedTimestamp;
      });
  }, [tab, search, linkedTypeFilter, starredOnly, sort]);

  const photos = filtered.filter((f) => f.kind === "photo");
  const docs = filtered.filter((f) => f.kind !== "photo");
  const totalCounts = {
    all: fixture.length,
    photos: fixture.filter((f) => f.kind === "photo").length,
    documents: fixture.filter((f) => f.kind !== "photo").length,
  };
  const totalSizeKB = fixture.reduce((s, f) => s + f.sizeKB, 0);
  const recentUploads = fixture.filter((f) => f.uploadedTimestamp <= 259200).length;

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-4xl font-black uppercase tracking-tight text-slate-950 md:text-5xl">Files</h1>
          <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.24em] text-slate-500">
            {totalCounts.all} files · {totalCounts.photos} photos · {totalCounts.documents} documents
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ScopeToggle options={["Mine", "Team", "All"] as const} value={scope} onChange={setScope} />
          <Button size="lg">
            <Plus className="mr-1.5 h-4 w-4" />
            Upload
          </Button>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <MetricCard
          eyebrow="Storage used"
          value={formatSize(totalSizeKB)}
          badge={`${totalCounts.all} files`}
          badgeTone="green"
          caption="Across CRM"
          accent="red"
        />
        <MetricCard
          eyebrow="Photos"
          value={String(totalCounts.photos)}
          badge="from CompanyCam"
          badgeTone="blue"
          caption="Site walks · audits"
          accent="blue"
        />
        <MetricCard
          eyebrow="Recent uploads"
          value={String(recentUploads)}
          badge="last 3 days"
          drenched
          caption="Fresh on the books"
        />
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-1 rounded-md border border-slate-200 bg-white p-0.5">
            {(
              [
                { key: "all", label: "All", icon: Layers, count: totalCounts.all },
                { key: "photos", label: "Photos", icon: Camera, count: totalCounts.photos },
                { key: "documents", label: "Documents", icon: FileText, count: totalCounts.documents },
              ] as const
            ).map((t) => {
              const Icon = t.icon;
              const isActive = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => {
                    setTab(t.key);
                    setView(t.key === "documents" ? "list" : "grid");
                  }}
                  className={`flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-bold transition-colors ${
                    isActive ? "bg-slate-100 text-slate-950" : "text-slate-500 hover:text-slate-900"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t.label}
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-black tabular-nums ${
                      isActive ? "bg-brand-red/10 text-brand-red" : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {t.count}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 rounded-md bg-slate-100 px-3 py-2 lg:max-w-xs">
              <Search className="h-4 w-4 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search files"
                className="flex-1 bg-transparent text-sm placeholder:text-slate-500 focus:outline-none"
              />
            </div>
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <ArrowUpDown className="h-3.5 w-3.5" />
              Sort: {sort === "recent" ? "Recent" : sort === "name" ? "Name" : "Size"}
              <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
            </button>
            <div className="flex items-center gap-1 rounded-md border border-slate-200 bg-white p-0.5">
              <button
                type="button"
                onClick={() => setView("grid")}
                className={`flex h-7 w-7 items-center justify-center rounded-sm transition-colors ${
                  view === "grid" ? "bg-slate-100 text-slate-950" : "text-slate-500 hover:text-slate-900"
                }`}
                aria-label="Grid view"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setView("list")}
                className={`flex h-7 w-7 items-center justify-center rounded-sm transition-colors ${
                  view === "list" ? "bg-slate-100 text-slate-950" : "text-slate-500 hover:text-slate-900"
                }`}
                aria-label="List view"
              >
                <List className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-3">
          <p className={`${EYEBROW} self-center`}>Linked to:</p>
          {(["any", "deal", "lead", "contact", "company", "property"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setLinkedTypeFilter(t)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide transition-colors ${
                linkedTypeFilter === t ? "bg-brand-red text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {t === "any" ? "Any" : `${t.charAt(0).toUpperCase()}${t.slice(1)}`}
            </button>
          ))}
          <span aria-hidden className="mx-1 h-4 w-px bg-slate-200" />
          <button
            type="button"
            onClick={() => setStarredOnly((s) => !s)}
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide transition-colors ${
              starredOnly ? "bg-amber-100 text-amber-800 ring-1 ring-amber-200" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            <Star className={`h-3 w-3 ${starredOnly ? "fill-amber-400 stroke-amber-500" : ""}`} />
            Starred
          </button>
          {(linkedTypeFilter !== "any" || starredOnly || search) ? (
            <button
              type="button"
              onClick={() => {
                setLinkedTypeFilter("any");
                setStarredOnly(false);
                setSearch("");
              }}
              className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-slate-500 hover:text-slate-900"
            >
              <X className="h-3 w-3" />
              Clear filters
            </button>
          ) : null}
        </div>

        {filtered.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <Layers className="mx-auto h-8 w-8 text-slate-300" />
            <p className="mt-2 text-sm font-semibold text-slate-700">No files match these filters.</p>
            <Button variant="outline" size="sm" className="mt-3">
              <Plus className="mr-1 h-4 w-4" />
              Upload first file
            </Button>
          </div>
        ) : view === "grid" ? (
          <div className="space-y-6 p-5">
            {tab === "all" && photos.length > 0 ? (
              <section>
                <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500">
                  Photos · {photos.length}
                </p>
                <PhotoGrid items={photos} navigate={navigate} />
              </section>
            ) : tab === "photos" ? (
              <PhotoGrid items={photos} navigate={navigate} />
            ) : null}

            {tab === "all" && docs.length > 0 ? (
              <section>
                <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500">
                  Documents · {docs.length}
                </p>
                <DocumentGrid items={docs} navigate={navigate} />
              </section>
            ) : tab === "documents" ? (
              <DocumentGrid items={docs} navigate={navigate} />
            ) : null}
          </div>
        ) : (
          <FilesTable rows={filtered} navigate={navigate} />
        )}

        <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-xs text-slate-600">
          <p>
            <span className="font-bold tabular-nums text-slate-950">{filtered.length}</span> of{" "}
            <span className="tabular-nums">{fixture.length}</span> files
          </p>
          <p className="font-semibold tabular-nums">{formatSize(filtered.reduce((s, f) => s + f.sizeKB, 0))}</p>
        </div>
      </Card>
    </div>
  );
}

function PhotoGrid({ items, navigate }: { items: FileRow[]; navigate: (path: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {items.map((p) => (
        <div key={p.id} className="group overflow-hidden rounded-md border border-slate-200">
          <div className="relative aspect-[4/3] bg-gradient-to-br from-slate-200 to-slate-300">
            <div className="flex h-full w-full items-center justify-center">
              <Camera className="h-8 w-8 text-white/70" />
            </div>
            {p.starred ? (
              <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-amber-400 text-white shadow-sm">
                <Star className="h-3 w-3 fill-current" />
              </span>
            ) : null}
            <button
              type="button"
              className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-slate-700 opacity-0 shadow-sm transition-opacity hover:bg-white group-hover:opacity-100"
              aria-label="Download"
            >
              <ArrowDownToLine className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="space-y-1 border-t border-slate-100 bg-white px-3 py-2">
            <p className="truncate text-xs font-bold text-slate-950">{p.name}</p>
            <p className="text-[10px] text-slate-500">
              {p.uploadedByInitials} · {p.uploadedAt}
            </p>
            {p.linked ? (
              <LinkChip link={p.linked} onClick={() => navigate(linkTypeMeta[p.linked!.type].route(p.linked!.id))} />
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function DocumentGrid({ items, navigate }: { items: FileRow[]; navigate: (path: string) => void }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
      {items.map((d) => (
        <div
          key={d.id}
          className="group flex flex-col gap-2 overflow-hidden rounded-md border border-slate-200 bg-white p-4 transition-colors hover:border-slate-300"
        >
          <div className="flex items-start justify-between gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-slate-100">
              <FileText className="h-4 w-4 text-slate-600" />
            </span>
            <div className="flex items-center gap-1">
              {d.starred ? <Star className="h-4 w-4 fill-amber-400 stroke-amber-500" /> : null}
              <button
                type="button"
                className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 opacity-0 transition-opacity hover:bg-slate-100 hover:text-slate-900 group-hover:opacity-100"
                aria-label="Download"
              >
                <ArrowDownToLine className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 opacity-0 transition-opacity hover:bg-slate-100 hover:text-slate-900 group-hover:opacity-100"
                aria-label="More"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <p className="line-clamp-2 text-sm font-bold text-slate-950">{d.name}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {d.kind !== "photo" ? (
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${kindStyles[d.kind]}`}
              >
                {d.kind}
              </span>
            ) : null}
            {d.linked ? (
              <LinkChip link={d.linked} onClick={() => navigate(linkTypeMeta[d.linked!.type].route(d.linked!.id))} />
            ) : null}
          </div>
          <div className="mt-auto flex items-center justify-between border-t border-slate-100 pt-2 text-[10px] text-slate-500">
            <p>
              <span className="font-bold text-slate-700">{d.uploadedByInitials}</span> · {d.uploadedAt}
            </p>
            <p className="font-semibold tabular-nums">{formatSize(d.sizeKB)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function FilesTable({ rows, navigate }: { rows: FileRow[]; navigate: (path: string) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px]">
        <thead>
          <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
            <th className="px-5 py-3 text-left">File</th>
            <th className="px-5 py-3 text-left">Type</th>
            <th className="px-5 py-3 text-left">Linked to</th>
            <th className="px-5 py-3 text-right">Size</th>
            <th className="px-5 py-3 text-left">Uploaded</th>
            <th className="w-10 px-5 py-3" aria-hidden />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((d) => (
            <tr key={d.id} className="cursor-pointer transition-colors hover:bg-slate-50">
              <td className="px-5 py-3">
                <div className="flex items-center gap-3">
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${
                      d.kind === "photo"
                        ? "bg-slate-200"
                        : "bg-slate-100"
                    }`}
                  >
                    {d.kind === "photo" ? (
                      <Camera className="h-4 w-4 text-slate-500" />
                    ) : (
                      <FileText className="h-4 w-4 text-slate-600" />
                    )}
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-sm font-bold text-slate-950">{d.name}</p>
                      {d.starred ? <Star className="h-3 w-3 shrink-0 fill-amber-400 stroke-amber-500" /> : null}
                    </div>
                  </div>
                </div>
              </td>
              <td className="px-5 py-3">
                {d.kind === "photo" ? (
                  <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-700 ring-1 ring-slate-200">
                    Photo
                  </span>
                ) : (
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${kindStyles[d.kind]}`}
                  >
                    {d.kind}
                  </span>
                )}
              </td>
              <td className="px-5 py-3">
                {d.linked ? (
                  <LinkChip link={d.linked} onClick={() => navigate(linkTypeMeta[d.linked!.type].route(d.linked!.id))} />
                ) : (
                  <span className="text-xs text-slate-400">—</span>
                )}
              </td>
              <td className="px-5 py-3 text-right text-xs font-semibold tabular-nums text-slate-700">
                {formatSize(d.sizeKB)}
              </td>
              <td className="px-5 py-3 text-xs text-slate-500">
                <span className="font-bold text-slate-700">{d.uploadedByInitials}</span> · {d.uploadedAt}
              </td>
              <td className="px-5 py-3 text-right">
                <button
                  type="button"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-900"
                  aria-label="Download"
                >
                  <ArrowDownToLine className="h-3.5 w-3.5" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
