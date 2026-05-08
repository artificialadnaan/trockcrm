import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Handshake,
  ClipboardList,
  Building2,
  Kanban,
  Users,
  Mail,
  CheckSquare,
  FileImage,
  Camera,
  Image as ImageIcon,
  BarChart3,
  DollarSign,
  Briefcase,
  Shield,
  Search,
  Bell,
  type LucideIcon,
} from "lucide-react";
import { RepDashboardPreview } from "./preview/rep-dashboard-preview";
import { DealsPreview } from "./preview/deals-preview";
import { LeadsPreview } from "./preview/leads-preview";
import { CompaniesPreview } from "./preview/companies-preview";
import { ContactsPreview } from "./preview/contacts-preview";
import { PropertiesPreview } from "./preview/properties-preview";
import { CompanyDetailPreview } from "./preview/company-detail-preview";
import { ContactDetailPreview } from "./preview/contact-detail-preview";
import { PropertyDetailPreview } from "./preview/property-detail-preview";
import { DealDetailPreview } from "./preview/deal-detail-preview";
import { EmailPreview } from "./preview/email-preview";
import { TasksPreview } from "./preview/tasks-preview";
import { FilesPagePreview } from "./preview/files-page-preview";
import { ReportsPreview } from "./preview/reports-preview";
import { CommissionsPreview } from "./preview/commissions-preview";
import { DirectorDashboardPreview } from "./preview/director-dashboard-preview";
import "./globals.css";

type NavEntry = { icon: LucideIcon; label: string; to: string };

const NAV: NavEntry[] = [
  { icon: LayoutDashboard, label: "Dashboard", to: "/" },
  { icon: Handshake, label: "Deals", to: "/deals" },
  { icon: ClipboardList, label: "Leads", to: "/leads" },
  { icon: Building2, label: "Properties", to: "/properties" },
  { icon: Kanban, label: "Pipeline", to: "/pipeline" },
  { icon: Users, label: "Contacts", to: "/contacts" },
  { icon: Building2, label: "Companies", to: "/companies" },
  { icon: Mail, label: "Email", to: "/email" },
  { icon: CheckSquare, label: "Tasks", to: "/tasks" },
  { icon: FileImage, label: "Files", to: "/files" },
  { icon: Camera, label: "Capture", to: "/capture" },
  { icon: ImageIcon, label: "Feed", to: "/feed" },
  { icon: BarChart3, label: "Reports", to: "/reports" },
  { icon: DollarSign, label: "Commissions", to: "/commissions" },
  { icon: Briefcase, label: "Projects", to: "/projects" },
];

function FakeSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const activePath = location.pathname;
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white lg:flex">
      <div className="flex h-16 items-center gap-3 bg-[#0F172A] px-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-sm bg-brand-red text-sm font-black uppercase text-white">
          TR
        </div>
        <div className="leading-none">
          <p className="text-sm font-black uppercase tracking-wide text-white">T Rock</p>
          <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-300">CRM</p>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-3">
        {NAV.map((item) => {
          const Icon = item.icon;
          const isActive = activePath === item.to;
          return (
            <button
              key={item.label}
              type="button"
              onClick={() => navigate(item.to)}
              className={`mb-0.5 flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors ${
                isActive
                  ? "bg-brand-red/10 font-bold text-brand-red"
                  : "text-slate-700 hover:bg-slate-100"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
        <div className="my-3 px-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">Director</p>
        </div>
        <button
          type="button"
          onClick={() => navigate("/director")}
          className={`mb-0.5 flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors ${
            activePath === "/director"
              ? "bg-brand-red/10 font-bold text-brand-red"
              : "text-slate-700 hover:bg-slate-100"
          }`}
        >
          <Shield className="h-4 w-4 shrink-0" />
          <span className="truncate">Director</span>
        </button>
      </nav>
    </aside>
  );
}

function FakeTopbar() {
  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-slate-200 bg-white px-4 md:px-6">
      <div className="flex flex-1 items-center gap-3 rounded-md bg-slate-100 px-3 py-2 max-w-md">
        <Search className="h-4 w-4 text-slate-400" />
        <input
          type="text"
          placeholder="Search"
          className="flex-1 bg-transparent text-sm placeholder:text-slate-500 focus:outline-none"
        />
        <kbd className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
          ⌘K
        </kbd>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <button
          type="button"
          className="relative flex h-9 w-9 items-center justify-center rounded-full hover:bg-slate-100"
        >
          <Bell className="h-4 w-4 text-slate-600" />
          <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-brand-red" />
        </button>
        <button
          type="button"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-red text-sm font-black text-white"
        >
          BR
        </button>
      </div>
    </header>
  );
}

function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-slate-500">Preview not built</p>
        <h1 className="mt-2 text-3xl font-black uppercase tracking-tight text-slate-950">{title}</h1>
        <p className="mt-2 text-sm text-slate-600">This page hasn&apos;t been redesigned in the preview yet.</p>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MemoryRouter>
      <div className="flex min-h-screen bg-slate-50">
        <FakeSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <FakeTopbar />
          <main className="flex-1 overflow-auto p-6 md:p-8">
            <Routes>
              <Route path="/" element={<RepDashboardPreview />} />
              <Route path="/deals" element={<DealsPreview />} />
              <Route path="/deals/:id" element={<DealDetailPreview />} />
              <Route path="/leads" element={<LeadsPreview />} />
              <Route path="/companies" element={<CompaniesPreview />} />
              <Route path="/companies/:id" element={<CompanyDetailPreview />} />
              <Route path="/contacts" element={<ContactsPreview />} />
              <Route path="/contacts/:id" element={<ContactDetailPreview />} />
              <Route path="/properties" element={<PropertiesPreview />} />
              <Route path="/properties/:id" element={<PropertyDetailPreview />} />
              <Route path="/email" element={<EmailPreview />} />
              <Route path="/tasks" element={<TasksPreview />} />
              <Route path="/files" element={<FilesPagePreview />} />
              <Route path="/reports" element={<ReportsPreview />} />
              <Route path="/commissions" element={<CommissionsPreview />} />
              <Route path="/director" element={<DirectorDashboardPreview />} />
              <Route path="*" element={<PlaceholderPage title="Coming soon" />} />
            </Routes>
          </main>
        </div>
      </div>
    </MemoryRouter>
  </StrictMode>
);
