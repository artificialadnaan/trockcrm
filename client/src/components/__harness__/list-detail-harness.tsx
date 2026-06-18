import { useState, type ReactNode } from "react";
import { ContactCard } from "@/pages/contacts/contact-list-page";
import type { Contact } from "@/hooks/use-contacts";
import { CompanyCard } from "@/pages/companies/company-list-page";
import type { Company } from "@/hooks/use-companies";
import { PropertyCard } from "@/pages/properties/property-list-page";
import type { PropertySurface } from "@/hooks/use-properties";
import {
  PipelineStageSummary,
  type PipelineStageSummaryColumn,
} from "@/components/deals/pipeline-stage-summary";
import { ScopeToggle } from "@/components/shared/scope-toggle";
import { listPaginationIconButtonClassName } from "@/components/shared/list-pagination";
import { FilterBar, type FilterDimension } from "@/components/filters/filter-bar";
import type { FilterBarValue } from "@/components/filters/filterbar-params";
import type { FilterSelectOption } from "@/components/filters/filter-select";
import { SearchInput } from "@/components/ui/search-input";
import { COMPANY_LIST_SORT_OPTIONS } from "@/components/companies/companies-filterbar-adapter";
import { cn } from "@/lib/utils";

// Dev-only preview for the Contacts/Companies/Properties list+detail mobile pass.
// Real presentational components, mock data, no backend / no auth. Served by vite
// dev at /harness-list-detail.html (NOT part of `vite build`, which only builds
// index.html). 390px viewport, for before/after screenshots. Grows per PR.

// Mock rows are cast pragmatically — the harness only needs the fields the cards
// read, and this file never ships to production.
function mockContact(overrides: Partial<Contact>): Contact {
  return {
    id: "c1",
    firstName: "Maria",
    lastName: "Caldwell",
    email: "maria@trock.test",
    phone: "2145550101",
    mobile: null,
    companyName: "T Rock Owner Group",
    ownerUserId: "u1",
    ownerUserName: "Alicia Adams",
    jobTitle: "Facilities Director",
    role: "facilities_director",
    isPrimary: true,
    city: "Dallas",
    state: "TX",
    linkedDealsCount: 2,
    lastTouchAt: "2026-04-11T09:00:00.000Z",
    ...overrides,
  } as unknown as Contact;
}

// Stand-in for the shared OwnerAssignmentControl (it is API-backed and out of scope
// for this responsiveness pass) — sized to its real ~44px footprint in the card.
function MockOwnerControl({ label = "Owner: Riley Rep" }: { label?: string }) {
  return (
    <div className="inline-flex h-11 items-center rounded-md border border-slate-200 px-3 text-xs font-semibold text-slate-600">
      {label}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xs font-black uppercase tracking-widest text-slate-500">{title}</h2>
      {children}
    </section>
  );
}

const harnessContacts: Contact[] = [
  mockContact({}),
  mockContact({
    id: "c2",
    firstName: "Priya",
    lastName: "Nguyen",
    jobTitle: "Procurement Lead",
    role: "procurement",
    isPrimary: false,
    companyName: "Northgate Facilities",
    city: "Fort Worth",
    email: "priya@trock.test",
    phone: "8175550144",
    linkedDealsCount: 0,
    lastTouchAt: "2025-12-02T09:00:00.000Z",
  }),
  mockContact({
    id: "c3",
    firstName: "No",
    lastName: "Owner",
    jobTitle: null,
    role: null,
    isPrimary: false,
    companyName: null,
    ownerUserId: null,
    ownerUserName: null,
    city: null,
    state: null,
    email: null,
    phone: null,
    mobile: null,
    linkedDealsCount: 0,
    lastTouchAt: null,
  }),
];

function mockCompany(overrides: Partial<Company>): Company {
  return {
    id: "co1",
    name: "T Rock Owner Group",
    city: "Dallas",
    state: "TX",
    domain: "owner.example.com",
    ownerUserId: "u1",
    ownerUserName: "Alicia Adams",
    propertiesCount: 3,
    contactsCount: 4,
    contactCount: 4,
    activeDealsCount: 2,
    dealCount: 2,
    pipelineValue: "750000",
    lastActivityAt: "2026-04-11T09:00:00.000Z",
    ...overrides,
  } as unknown as Company;
}

const harnessCompanies: Company[] = [
  mockCompany({}),
  mockCompany({
    id: "co2",
    name: "Northgate Facilities",
    city: "Fort Worth",
    domain: null,
    propertiesCount: 1,
    contactsCount: 2,
    contactCount: 2,
    activeDealsCount: 0,
    dealCount: 1,
    pipelineValue: "0",
    lastActivityAt: "2025-12-02T09:00:00.000Z",
  }),
  mockCompany({
    id: "co3",
    name: "Unowned Account",
    city: null,
    state: null,
    domain: null,
    ownerUserId: null,
    ownerUserName: null,
    propertiesCount: 0,
    contactsCount: 0,
    contactCount: 0,
    activeDealsCount: 0,
    dealCount: 0,
    pipelineValue: "0",
    lastActivityAt: null,
  }),
];

function mockProperty(overrides: Partial<PropertySurface>): PropertySurface {
  return {
    id: "p1",
    name: "Dallas HQ",
    address: "123 Main St",
    city: "Dallas",
    state: "TX",
    zip: "75201",
    companyName: "Alpha Roofing",
    type: "industrial",
    roofArea: 125000,
    linkedValue: "300000",
    activePipelineValue: "300000",
    engagementStatus: "won",
    photosCount: 2,
    leadCount: 2,
    dealCount: 3,
    lastActivityAt: "2026-04-11T09:00:00.000Z",
    ...overrides,
  } as unknown as PropertySurface;
}

const harnessProperties: PropertySurface[] = [
  mockProperty({}),
  mockProperty({
    id: "p2",
    name: "Northgate Retail Center",
    address: "55 Loop Rd",
    city: "Fort Worth",
    companyName: "Northgate Facilities",
    type: "retail",
    roofArea: 48000,
    linkedValue: "0",
    activePipelineValue: "0",
    engagementStatus: "active_lead",
    photosCount: 0,
    lastActivityAt: "2025-12-02T09:00:00.000Z",
  }),
  mockProperty({
    id: "p3",
    name: "",
    address: "900 Industrial Blvd",
    city: "Arlington",
    companyName: null,
    type: null,
    roofArea: null,
    unitCount: null,
    linkedValue: "0",
    activePipelineValue: "0",
    engagementStatus: "no_engagement",
    photosCount: 0,
    lastActivityAt: null,
  }),
];

const harnessPipelineColumns: PipelineStageSummaryColumn[] = [
  { stage: { id: "s-opp", name: "Opportunity" }, count: 6, totalValue: 2_100_000 },
  { stage: { id: "s-est", name: "Estimating" }, count: 4, totalValue: 1_200_000 },
  { stage: { id: "s-contract", name: "Contract" }, count: 2, totalValue: 880_000 },
  { stage: { id: "s-won", name: "Won" }, count: 9, totalValue: 4_000_000 },
  { stage: { id: "s-lost", name: "Lost" }, count: 3, totalValue: 540_000 },
];

// Interactive stand-in for the page wiring: tapping a chip toggles the highlighted stage, the way
// the page toggles the FilterBar's `stageIds` URL param.
function PipelineSummaryDemo() {
  const [activeStageId, setActiveStageId] = useState<string | null>("s-est");
  return (
    <PipelineStageSummary
      columns={harnessPipelineColumns}
      activeStageId={activeStageId}
      onSelectStage={(id) => setActiveStageId((current) => (current === id ? null : id))}
    />
  );
}

// Static stand-in for the Show-DD switch (RED's #554, page-inline) — visual only.
function ShowDdStub() {
  return (
    <div className="flex items-center gap-2 rounded-sm border border-gray-200 px-3 py-1.5">
      <span className="select-none text-xs text-gray-600">Show DD stages</span>
      <span className="relative inline-flex h-4 w-7 items-center rounded-full bg-gray-300">
        <span className="inline-block h-3 w-3 translate-x-0.5 rounded-full bg-white" />
      </span>
    </div>
  );
}

// Page-chrome preview (PR2): header/footer are page-inline, so this mirrors their exact responsive
// classNames (real ScopeToggle, real pager classes). At the harness's 390px width the `md:` classes
// are inactive, so it renders the mobile branch. `before` uses the old no-wrap/compact classes.
function PipelineChromeDemo({ before = false }: { before?: boolean }) {
  const [scope, setScope] = useState<string>("mine");
  const scopeOptions = [
    { value: "mine", label: "Mine" },
    { value: "all", label: "All" },
  ];
  return (
    <div className="space-y-3">
      <header
        className={
          before
            ? "flex items-center justify-between gap-4 rounded-lg border border-gray-200 bg-white px-6 py-5"
            : "flex flex-col gap-3 rounded-lg border border-gray-200 bg-white px-4 py-4 md:flex-row md:items-center md:justify-between md:gap-4 md:px-6 md:py-5"
        }
      >
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-gray-900">Deal Pipeline</h1>
          <p className="mt-0.5 text-xs text-gray-500">128 deals · $14.2M total</p>
        </div>
        <div className={before ? "flex items-center gap-4" : "flex flex-wrap items-center gap-4"}>
          <ScopeToggle
            options={scopeOptions}
            value={scope}
            onChange={(v) => setScope(v as string)}
            ariaLabel="Pipeline scope"
            size={before ? "sm" : "touch"}
          />
          <ShowDdStub />
        </div>
      </header>

      <footer className={before ? "rounded-lg border border-gray-200 bg-white px-6 py-3" : "rounded-lg border border-gray-200 bg-white px-4 py-3 md:px-6"}>
        <dl className={before ? "flex items-center gap-8" : "flex flex-wrap items-center gap-x-8 gap-y-2"}>
          {[
            { label: "Active", value: "128" },
            { label: "Avg velocity", value: "34", suffix: "days" },
            { label: "Success", value: "67%" },
          ].map((stat) => (
            <div key={stat.label} className="flex items-baseline gap-2">
              <dt className="text-xs uppercase tracking-wide text-gray-500">{stat.label}</dt>
              <dd className="text-base font-semibold tabular-nums text-gray-900">
                {stat.value}
                {stat.suffix ? <span className="ml-1 text-xs font-normal text-gray-500">{stat.suffix}</span> : null}
              </dd>
            </div>
          ))}
        </dl>
      </footer>

      <div className="flex items-center justify-end gap-2 rounded-lg border border-gray-200 bg-white px-4 py-3">
        <span className="mr-auto text-xs text-slate-500">Deal-list pager</span>
        {["‹", "›"].map((glyph, i) => (
          <button
            key={i}
            type="button"
            className={cn(
              before
                ? "inline-flex h-9 w-9 items-center justify-center rounded-full border transition-colors"
                : "inline-flex h-11 w-11 items-center justify-center rounded-full border transition-colors md:h-9 md:w-9",
              listPaginationIconButtonClassName
            )}
          >
            <span aria-hidden="true">{glyph}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// Owner options the real mount feeds from useOwnerAssignees -> the bar's `reps`.
const harnessOwnerReps: FilterSelectOption[] = [
  { value: "u1", label: "Alicia Adams" },
  { value: "u2", label: "Riley Rep" },
  { value: "u3", label: "Dana Director" },
];
const HARNESS_OWNER_SCOPE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "mine", label: "Mine" },
] as const;
const HARNESS_COMPANY_DIMENSIONS: FilterDimension[] = ["rep", "date", "sort"];

/**
 * Structural mock of the Companies list chrome with the Wave 2 FilterBar mounted (the REAL <FilterBar>,
 * mock data, no API/auth). Mirrors company-list-page.tsx: the page keeps its own debounced search + the
 * mine/all scope control; the bar adds Owner (repLabel) + Date (recency) + Sort. Status was dropped and
 * the old Industry button row removed (product). The deal-specific date note is suppressed
 * (stageEntryDateEnabled), matching the mount. (Date label is "Date" until RED adds a `dateLabel` prop.)
 */
function CompaniesFilterBarDemo() {
  const [value, setValue] = useState<FilterBarValue>({});
  const ownerScope = value.scope === "mine" ? "mine" : "all";
  return (
    <div className="space-y-3 rounded-xl border border-emerald-200 bg-white p-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center">
          <SearchInput
            value={value.search ?? ""}
            onChange={() => {}}
            placeholder="Search accounts, cities, domains..."
            aria-label="Search accounts"
            className="min-w-[240px] flex-1"
            inputClassName="h-9 border-slate-200"
          />
          <ScopeToggle
            options={HARNESS_OWNER_SCOPE_OPTIONS}
            value={ownerScope}
            onChange={(next) => setValue((prev) => ({ ...prev, scope: next === "mine" ? "mine" : undefined }))}
            ariaLabel="Ownership filter"
            size="touch"
          />
        </div>
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">128 results</p>
      </div>
      <FilterBar
        dimensions={HARNESS_COMPANY_DIMENSIONS}
        options={{
          reps: harnessOwnerReps,
          sortOptions: COMPANY_LIST_SORT_OPTIONS,
          allowUnassigned: true,
          repLabel: "Owner",
        }}
        value={value}
        onChange={(patch) => setValue((prev) => ({ ...prev, ...patch }))}
        onReset={() => setValue({})}
        stageEntryDateEnabled
      />
      <div className="space-y-2">
        {harnessCompanies.slice(0, 2).map((company) => (
          <CompanyCard key={company.id} company={company} ownerSlot={<MockOwnerControl />} />
        ))}
      </div>
    </div>
  );
}

export function ListDetailHarness() {
  return (
    <>
    <div className="mx-auto max-w-md space-y-8 bg-[#F5F4F2] p-4 pb-12">
      <header>
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">List + detail mobile pass</p>
        <h1 className="mt-1 text-2xl font-black uppercase leading-none text-slate-950">Phone preview · 390px</h1>
      </header>

      <Section title="Contacts list — table stacks to cards (<md)">
        <div>
          <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-red-600">Before</p>
          <div className="rounded-xl border border-dashed border-red-200 bg-white p-2">
            <p className="mb-2 text-xs text-slate-500">7-column table → horizontal scroll wall at 390px (drag sideways):</p>
            <div className="overflow-x-auto">
              <div className="flex w-[760px] items-center gap-6 whitespace-nowrap border-b border-slate-200 pb-2 text-[11px] font-black uppercase tracking-[0.16em] text-slate-400">
                <span>Contact</span>
                <span>Company</span>
                <span>Role</span>
                <span>Quick actions</span>
                <span>Linked deals</span>
                <span>Last touch</span>
                <span>›</span>
              </div>
            </div>
          </div>
        </div>
        <div>
          <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-emerald-600">After</p>
          <div className="space-y-2 rounded-xl border border-emerald-200 bg-white p-2">
            {harnessContacts.map((contact) => (
              <ContactCard key={contact.id} contact={contact} ownerSlot={<MockOwnerControl />} />
            ))}
          </div>
        </div>
      </Section>

      <Section title="Companies list — table stacks to cards (<md)">
        <div>
          <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-red-600">Before</p>
          <div className="rounded-xl border border-dashed border-red-200 bg-white p-2">
            <p className="mb-2 text-xs text-slate-500">8-column table → horizontal scroll wall at 390px (drag sideways):</p>
            <div className="overflow-x-auto">
              <div className="flex w-[820px] items-center gap-6 whitespace-nowrap border-b border-slate-200 pb-2 text-[11px] font-black uppercase tracking-[0.16em] text-slate-400">
                <span>Company</span>
                <span>Owner</span>
                <span>Properties</span>
                <span>Contacts</span>
                <span>Active deals</span>
                <span>Pipeline</span>
                <span>Last activity</span>
                <span>›</span>
              </div>
            </div>
          </div>
        </div>
        <div>
          <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-emerald-600">After</p>
          <div className="space-y-2 rounded-xl border border-emerald-200 bg-white p-2">
            {harnessCompanies.map((company) => (
              <CompanyCard key={company.id} company={company} ownerSlot={<MockOwnerControl />} />
            ))}
          </div>
        </div>
      </Section>

      <Section title="Properties list — table stacks to cards (<md)">
        <div>
          <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-red-600">Before</p>
          <div className="rounded-xl border border-dashed border-red-200 bg-white p-2">
            <p className="mb-2 text-xs text-slate-500">8-column table → horizontal scroll wall at 390px (drag sideways):</p>
            <div className="overflow-x-auto">
              <div className="flex w-[820px] items-center gap-6 whitespace-nowrap border-b border-slate-200 pb-2 text-[11px] font-black uppercase tracking-[0.16em] text-slate-400">
                <span>Property</span>
                <span>Type</span>
                <span>Owner company</span>
                <span>Sq ft</span>
                <span>Engagement</span>
                <span>Linked value</span>
                <span>Last touch</span>
                <span>›</span>
              </div>
            </div>
          </div>
        </div>
        <div>
          <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-emerald-600">After</p>
          <div className="space-y-2 rounded-xl border border-emerald-200 bg-white p-2">
            {harnessProperties.map((property) => (
              <PropertyCard key={property.id} property={property} />
            ))}
          </div>
        </div>
      </Section>

      <Section title="Pipeline board — collapses to a per-stage summary (<md)">
        <div>
          <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-red-600">Before</p>
          <div className="rounded-xl border border-dashed border-red-200 bg-white p-2">
            <p className="mb-2 text-xs text-slate-500">
              5 fixed <code>w-80</code> columns in an overflow-x flex row → horizontal scroll wall + drag-across-stages
              is unusable at 390px (drag sideways):
            </p>
            <div className="overflow-x-auto">
              <div className="flex w-[1080px] gap-3">
                {harnessPipelineColumns.map((column) => (
                  <div key={column.stage.id} className="h-28 w-80 flex-shrink-0 rounded-md border border-slate-200 bg-slate-50/70 p-3">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{column.stage.name}</p>
                    <p className="mt-2 text-xl font-semibold tabular-nums text-slate-700">{column.count}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div>
          <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-emerald-600">After</p>
          <div className="rounded-xl border border-emerald-200 bg-white p-2">
            <p className="mb-2 text-xs text-slate-500">
              Tappable per-stage chips (name · count · value) → filter the list below; the responsive deal list leads.
            </p>
            <PipelineSummaryDemo />
          </div>
        </div>
      </Section>

      <Section title="Pipeline page chrome — header stacks, footer wraps, touch targets (<md)">
        <div>
          <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-red-600">Before</p>
          <div className="rounded-xl border border-dashed border-red-200 bg-white p-2">
            <p className="mb-2 text-xs text-slate-500">
              Single-row header (no wrap, <code>px-6</code>) squeezes the controls; footer stats overflow; pager chevrons are 36px.
            </p>
            <PipelineChromeDemo before />
          </div>
        </div>
        <div>
          <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-emerald-600">After</p>
          <div className="rounded-xl border border-emerald-200 bg-white p-2">
            <p className="mb-2 text-xs text-slate-500">
              Title stacks above touch-sized controls (ScopeToggle 44px), footer stats wrap, pager chevrons are 44px. ≥md reverts.
            </p>
            <PipelineChromeDemo />
          </div>
        </div>
      </Section>
    </div>

    {/* Wider container so the desktop layout is faithful at a ≥md viewport (the mobile sections above
        stay capped at max-w-md). At 390px this still renders the mobile wrap. */}
    <div className="mx-auto max-w-5xl space-y-3 bg-[#F5F4F2] px-4 pb-16" data-testid="companies-filterbar-demo">
      <Section title="Companies list — Wave 2 FilterBar (Owner · Date · Sort)">
        <p className="text-xs text-slate-500">
          The shared <code>&lt;FilterBar&gt;</code> mounted on the companies list: Owner (relabeled from
          Rep, filters owner-by-id) · Date (recency — last contacted) · Sort. Search and the mine/all
          owner scope stay page controls (search is the existing debounced, local, no-URL input). The old
          Industry button row is removed and verification Status was dropped (product). Resize to ≥768px
          for the desktop row. (Date label reads "Date" until RED adds a per-surface <code>dateLabel</code>.)
        </p>
        <CompaniesFilterBarDemo />
      </Section>
    </div>
    </>
  );
}
