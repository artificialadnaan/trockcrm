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

export function ListDetailHarness() {
  return (
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
    </div>
  );
}
