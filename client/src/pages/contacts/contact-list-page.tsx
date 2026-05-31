import { useMemo, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowUpRight, Briefcase, ChevronLeft, ChevronRight, Mail, Phone, Plus, Star, Users } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { listPaginationIconButtonClassName } from "@/components/shared/list-pagination";
import { MetricCard } from "@/components/shared/metric-card";
import { OwnerAssignmentControl } from "@/components/shared/owner-assignment-control";
import { OwnerLabel } from "@/components/shared/owner-label";
import { ScopeToggle } from "@/components/shared/scope-toggle";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SearchInput } from "@/components/ui/search-input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useOwnerAssignees } from "@/hooks/use-owner-assignees";
import { useTaskAssignees } from "@/hooks/use-task-assignees";
import { assignContactOwnerToMe, reassignContactOwner, useContacts, type Contact } from "@/hooks/use-contacts";
import { useContactFilters } from "@/hooks/use-contact-filters";
import { useKeepPreviousData } from "@/hooks/use-keep-previous-data";
import { useAuth } from "@/lib/auth";
import { contactLocation, formatPhone, fullName } from "@/lib/contact-utils";
import { cn } from "@/lib/utils";

const ROLE_LABELS: Record<string, string> = {
  owner_principal: "Owner / principal",
  project_manager: "Project manager",
  facilities_director: "Facilities director",
  maintenance: "Maintenance",
  procurement: "Procurement",
  insurance_adjuster: "Insurance adjuster",
  admin_ap: "Admin / AP",
  other: "Other",
};

const ROLE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "owner_principal", label: "Owner" },
  { value: "project_manager", label: "PM" },
  { value: "facilities_director", label: "Facilities" },
  { value: "procurement", label: "Procurement" },
] as const;

const OWNER_SCOPE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "mine", label: "Mine" },
] as const;

function initials(contact: Contact) {
  return [contact.firstName?.[0], contact.lastName?.[0]].filter(Boolean).join("").toUpperCase() || "?";
}

function formatLastTouch(value: string | null | undefined) {
  if (!value) return "Untouched";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function isUntouched(value: string | null | undefined) {
  if (!value) return true;
  return Date.now() - new Date(value).getTime() > 30 * 24 * 60 * 60 * 1000;
}

/**
 * Mobile (<md) card representation of a contact row. The desktop table stays the
 * source of truth at >=md; this is the stack-to-card fallback so phones get no
 * horizontal-scroll wall. Uses the stretched-link pattern (the name <Link> covers
 * the whole card via `after:absolute after:inset-0`) so the card is one tap target,
 * while the quick-action anchors and the owner control sit above it (`z-10`) and
 * stay independently tappable — no nested anchors, keyboard-navigable.
 */
export function ContactCard({
  contact,
  ownerSlot,
}: {
  contact: Contact;
  ownerSlot?: ReactNode;
}) {
  const untouched = isUntouched(contact.lastTouchAt);
  const phone = contact.phone ?? contact.mobile;
  return (
    <div className="relative rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-red text-xs font-black text-white">
          {initials(contact)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {contact.isPrimary ? <Star className="h-4 w-4 shrink-0 fill-amber-400 text-amber-500" aria-label="Primary contact" /> : null}
            <Link
              to={`/contacts/${contact.id}`}
              className="truncate text-sm font-black uppercase text-slate-950 after:absolute after:inset-0"
            >
              {fullName(contact)}
            </Link>
          </div>
          <p className="mt-1 truncate text-xs text-slate-500">
            {[contact.jobTitle, contactLocation(contact)].filter(Boolean).join(" • ") || "No title recorded"}
          </p>
          <p className="mt-1 truncate text-sm font-semibold text-slate-700">{contact.companyName ?? "Unassigned"}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-700">
              {contact.role ? ROLE_LABELS[contact.role] ?? contact.role : "Unclassified"}
            </span>
            <span className={cn("text-xs font-bold", untouched ? "text-brand-red" : "text-slate-600")}>
              {formatLastTouch(contact.lastTouchAt)}
            </span>
          </div>
          <OwnerLabel ownerId={contact.ownerUserId} ownerName={contact.ownerUserName} className="mt-2 max-w-full" />
        </div>
        <ArrowUpRight className="h-4 w-4 shrink-0 text-slate-400" />
      </div>
      <div className="relative z-10 mt-3 flex items-center gap-2">
        {phone ? (
          <a
            href={`tel:${phone}`}
            className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:border-red-200 hover:text-brand-red"
            aria-label={`Call ${fullName(contact)}${formatPhone(phone) ? ` at ${formatPhone(phone)}` : ""}`}
          >
            <Phone className="h-4 w-4" />
          </a>
        ) : null}
        {contact.email ? (
          <a
            href={`mailto:${contact.email}`}
            className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:border-red-200 hover:text-brand-red"
            aria-label={`Email ${fullName(contact)}`}
          >
            <Mail className="h-4 w-4" />
          </a>
        ) : null}
        {contact.linkedDealsCount ? (
          <span className="inline-flex h-11 items-center gap-1.5 rounded-md border border-slate-200 px-3 text-xs font-bold text-slate-500" title="Linked deals">
            <Briefcase className="h-4 w-4" />
            {contact.linkedDealsCount}
          </span>
        ) : null}
      </div>
      {ownerSlot ? <div className="relative z-10 mt-3">{ownerSlot}</div> : null}
    </div>
  );
}

export function ContactListPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { assignees, loading: assigneesLoading } = useTaskAssignees();
  const { assignees: ownerAssignees, loading: ownerAssigneesLoading } = useOwnerAssignees();
  const { filters, setFilters, resetFilters } = useContactFilters();
  const { contacts: rawContacts, pagination, loading, error, refetch } = useContacts(filters);
  // No-blank: keep the prior page of contacts visible during a search/filter/page refetch; gate
  // the skeleton to the FIRST load only and show an "Updating..." hint on a refresh.
  const { data: contacts, isInitialLoading, isRefreshing } = useKeepPreviousData(rawContacts, loading, error);

  const activeRole = (filters.role ?? "all") as (typeof ROLE_OPTIONS)[number]["value"];
  const activeOwnerScope = (filters.ownerScope ?? "all") as (typeof OWNER_SCOPE_OPTIONS)[number]["value"];
  const totals = useMemo(() => {
    const primary = contacts.filter((contact) => contact.isPrimary).length;
    const untouched = contacts.filter((contact) => isUntouched(contact.lastTouchAt)).length;
    const linkedDeals = contacts.reduce((sum, contact) => sum + (contact.linkedDealsCount ?? 0), 0);
    return { primary, untouched, linkedDeals };
  }, [contacts]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Contacts"
        description="Decision makers, field contacts, facilities owners, and AP contacts across active accounts."
        meta={`${pagination.total} contact${pagination.total === 1 ? "" : "s"}`}
        actions={{
          primary: (
            <Button onClick={() => navigate("/contacts/new")}>
              <Plus className="mr-2 h-4 w-4" />
              New Contact
            </Button>
          ),
        }}
      />

      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard eyebrow="Total contacts" value={String(pagination.total)} badge={`${contacts.length} shown`} caption="Directory" tone="green" accent="red" />
        <MetricCard eyebrow="Primary contacts" value={String(totals.primary)} badge={`${totals.linkedDeals} links`} caption="Deal coverage" tone="blue" accent="blue" />
        <MetricCard eyebrow="Untouched 30d+" value={String(totals.untouched)} badge="Review" caption="Needs touch" tone="red" accent="red" />
      </div>

      <Card className="border-slate-200 bg-white shadow-none">
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex flex-1 flex-col gap-3 lg:flex-row lg:items-center">
              <SearchInput
                value={filters.search ?? ""}
                onChange={(value) => setFilters({ search: value || undefined })}
                placeholder="Search contacts, companies, email..."
                aria-label="Search contacts"
                className="min-w-[240px] flex-1"
                inputClassName="h-9 border-slate-200"
              />
              <ScopeToggle
                options={ROLE_OPTIONS}
                value={activeRole}
                onChange={(value) => setFilters({ role: value === "all" ? undefined : value })}
                ariaLabel="Contact role filter"
                size="touch"
              />
              <ScopeToggle
                options={OWNER_SCOPE_OPTIONS}
                value={activeOwnerScope}
                onChange={(value) => setFilters({ ownerScope: value === "mine" ? "mine" : undefined })}
                ariaLabel="Ownership filter"
                size="touch"
              />
            </div>
            <div className="flex items-center gap-2">
              {isRefreshing ? (
                <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">Updating...</span>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                className="h-11 md:h-7"
                onClick={() => setFilters({ sortBy: "last_touch_at", sortDir: "desc" })}
              >
                Last touch
              </Button>
              <Button variant="ghost" size="sm" className="h-11 md:h-7" onClick={resetFilters}>
                Clear
              </Button>
            </div>
          </div>

          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{error}</div>
          ) : null}

          {isInitialLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="h-16 animate-pulse rounded-lg bg-slate-100" />
              ))}
            </div>
          ) : contacts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 px-6 py-14 text-center">
              <Users className="mx-auto h-10 w-10 text-slate-300" />
              <p className="mt-3 text-base font-black uppercase text-slate-950">No contacts match this view</p>
              <p className="mt-1 text-sm text-slate-500">Clear the search or switch the filters.</p>
            </div>
          ) : (
            <>
            {/* >=md keeps the full table; phones get the stacked card list (md:hidden) below. */}
            <div className="hidden md:block"><Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Contact</TableHead>
                  <TableHead className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Company</TableHead>
                  <TableHead className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Role</TableHead>
                  <TableHead className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Quick actions</TableHead>
                  <TableHead className="text-right text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Linked deals</TableHead>
                  <TableHead className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Last touch</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {contacts.map((contact) => {
                  const untouched = isUntouched(contact.lastTouchAt);
                  return (
                    <TableRow
                      key={contact.id}
                      className="cursor-pointer border-slate-100"
                      onClick={() => navigate(`/contacts/${contact.id}`)}
                    >
                      <TableCell className="min-w-[280px] py-3">
                        <div className="flex items-center gap-3">
                          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-red text-xs font-black text-white">
                            {initials(contact)}
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              {contact.isPrimary ? <Star className="h-4 w-4 fill-amber-400 text-amber-500" aria-label="Primary contact" /> : null}
                              <p className="truncate text-sm font-black uppercase text-slate-950">{fullName(contact)}</p>
                            </div>
                            <p className="mt-1 truncate text-xs text-slate-500">
                              {[contact.jobTitle, contactLocation(contact)].filter(Boolean).join(" • ") || "No title recorded"}
                            </p>
                            <OwnerLabel
                              ownerId={contact.ownerUserId}
                              ownerName={contact.ownerUserName}
                              className="mt-2 max-w-full"
                            />
                            <div className="mt-2">
                              <OwnerAssignmentControl
                                ownerUserId={contact.ownerUserId}
                                currentUser={user}
                                assignees={assignees}
                                ownerReassignAssignees={ownerAssignees}
                                assigneesLoading={assigneesLoading}
                                ownerReassignAssigneesLoading={ownerAssigneesLoading}
                                entityLabel="contact"
                                onAssignToMe={() => assignContactOwnerToMe(contact.id)}
                                onReassign={(ownerUserId) => reassignContactOwner(contact.id, ownerUserId)}
                                onAssigned={refetch}
                              />
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <p className="max-w-[220px] truncate text-sm font-semibold text-slate-700">{contact.companyName ?? "Unassigned"}</p>
                      </TableCell>
                      <TableCell>
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-700">
                          {contact.role ? ROLE_LABELS[contact.role] ?? contact.role : "Unclassified"}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {contact.phone || contact.mobile ? (
                            <a
                              href={`tel:${contact.phone ?? contact.mobile}`}
                              onClick={(event) => event.stopPropagation()}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:border-red-200 hover:text-brand-red"
                              aria-label={`Call ${fullName(contact)}${formatPhone(contact.phone ?? contact.mobile) ? ` at ${formatPhone(contact.phone ?? contact.mobile)}` : ""}`}
                            >
                              <Phone className="h-4 w-4" />
                            </a>
                          ) : null}
                          {contact.email ? (
                            <a
                              href={`mailto:${contact.email}`}
                              onClick={(event) => event.stopPropagation()}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:border-red-200 hover:text-brand-red"
                              aria-label={`Email ${fullName(contact)}`}
                            >
                              <Mail className="h-4 w-4" />
                            </a>
                          ) : null}
                          {contact.linkedDealsCount ? (
                            <span className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-500" title="Linked deals">
                              <Briefcase className="h-4 w-4" />
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-black tabular-nums">{contact.linkedDealsCount ?? 0}</TableCell>
                      <TableCell>
                        <span className={cn("text-xs font-bold", untouched ? "text-brand-red" : "text-slate-600")}>
                          {formatLastTouch(contact.lastTouchAt)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <ArrowUpRight className="h-4 w-4 text-slate-400" />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table></div>
            <div className="space-y-2 md:hidden" data-testid="contact-cards">
              {contacts.map((contact) => (
                <ContactCard
                  key={contact.id}
                  contact={contact}
                  ownerSlot={
                    <OwnerAssignmentControl
                      ownerUserId={contact.ownerUserId}
                      currentUser={user}
                      assignees={assignees}
                      ownerReassignAssignees={ownerAssignees}
                      assigneesLoading={assigneesLoading}
                      ownerReassignAssigneesLoading={ownerAssigneesLoading}
                      entityLabel="contact"
                      onAssignToMe={() => assignContactOwnerToMe(contact.id)}
                      onReassign={(ownerUserId) => reassignContactOwner(contact.id, ownerUserId)}
                      onAssigned={refetch}
                    />
                  }
                />
              ))}
            </div>
            </>
          )}
        </CardContent>
      </Card>

      {pagination.totalPages > 1 ? (
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-slate-500">
            Page {pagination.page} of {pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="icon"
              className={cn(listPaginationIconButtonClassName, "size-11 md:size-8")}
              disabled={pagination.page <= 1}
              onClick={() => setFilters({ page: pagination.page - 1 })}
              aria-label="Previous contacts page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className={cn(listPaginationIconButtonClassName, "size-11 md:size-8")}
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => setFilters({ page: pagination.page + 1 })}
              aria-label="Next contacts page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
