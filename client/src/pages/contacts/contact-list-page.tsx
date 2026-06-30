import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowUpRight, Briefcase, ChevronLeft, ChevronRight, Mail, Phone, Plus, Star, Users, X } from "lucide-react";
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
import { SortableTableHead } from "@/components/shared/sortable-table-head";
import {
  nextSortState,
  sortHeaderProps,
  type ColumnType,
  type SortState,
} from "@/components/reports/sortable";
import { useOwnerAssignees } from "@/hooks/use-owner-assignees";
import { useTaskAssignees } from "@/hooks/use-task-assignees";
import { assignContactOwnerToMe, reassignContactOwner, useContacts, type Contact } from "@/hooks/use-contacts";
import { useContactFilters } from "@/hooks/use-contact-filters";
import { useKeepPreviousData } from "@/hooks/use-keep-previous-data";
import { useAuth } from "@/lib/auth";
import { contactLocation, formatPhone, fullName, getContactCompanyName } from "@/lib/contact-utils";
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

// Linked-deals filter: "All" contacts vs only those with an active linked deal. contact_deal_associations
// is empty in office_dallas today, so "Linked" correctly returns an empty set until associations exist.
const LINKED_DEALS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "linked", label: "Linked" },
] as const;

// Persistent highlight for the currently-drilled summary card (matches MetricCard's focus ring).
const ACTIVE_CARD_CLASS = "ring-2 ring-brand-red";

const CONTACT_CARD_LABELS: Record<string, string> = {
  primary: "Primary contacts",
  untouched: "Untouched 30d+",
};

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
          <p className="mt-1 truncate text-sm font-semibold text-slate-700">{getContactCompanyName(contact, "Unassigned")}</p>
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
      {/* Row is NOT raised; only the real call/email anchors get `relative z-10` so they
          sit above the stretched name link. The non-interactive linked-deals chip stays
          below the link, so tapping it (or any gap) navigates to the contact. */}
      <div className="mt-3 flex items-center gap-2">
        {phone ? (
          <a
            href={`tel:${phone}`}
            className="relative z-10 inline-flex h-11 w-11 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:border-red-200 hover:text-brand-red"
            aria-label={`Call ${fullName(contact)}${formatPhone(phone) ? ` at ${formatPhone(phone)}` : ""}`}
          >
            <Phone className="h-4 w-4" />
          </a>
        ) : null}
        {contact.email ? (
          <a
            href={`mailto:${contact.email}`}
            className="relative z-10 inline-flex h-11 w-11 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:border-red-200 hover:text-brand-red"
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

// Shared header typography for the contacts table.
const HEAD_CLASS = "text-[11px] font-black uppercase tracking-[0.16em] text-slate-500";

// Sortable columns map to the contacts list API's sortBy values (server-side sort over the FULL filtered
// set, not the visible page). Role / Quick actions have no server sort field today and stay non-sortable.
// The default server sort is updated_at (not a visible column), so no header is active until the user
// clicks one.
const CONTACT_SORT_TYPES: Record<string, ColumnType> = {
  name: "text",
  company_name: "text",
  last_touch_at: "date",
  linked_deals_count: "number",
};

export function ContactListPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { assignees, loading: assigneesLoading } = useTaskAssignees();
  const { assignees: ownerAssignees, loading: ownerAssigneesLoading } = useOwnerAssignees();
  const { filters, setFilters, resetFilters } = useContactFilters();
  // Summary-card drill state lives in the URL (?card=) so it is shareable + back-button-safe, while the
  // persistent prefs (search/role/owner/sort) stay in localStorage. The card filter is merged into the
  // server query (which also carries sortBy/sortDir from `filters`), so card-drill and column sort compose.
  const [searchParams, setSearchParams] = useSearchParams();
  const activeCard = searchParams.get("card");
  const { contacts: rawContacts, pagination, loading, error, refetch } = useContacts({
    ...filters,
    isPrimary: activeCard === "primary" ? true : undefined,
    untouched: activeCard === "untouched" ? true : undefined,
  });

  // Reset to page 1 whenever the card drill CHANGES (not on mount), so drilling from a high page never
  // lands on an out-of-range, empty page of the smaller filtered set.
  const prevCardRef = useRef(activeCard);
  useEffect(() => {
    if (prevCardRef.current !== activeCard) {
      prevCardRef.current = activeCard;
      setFilters({ page: 1 });
    }
  }, [activeCard, setFilters]);

  const buildCardTo = (card: "primary" | "untouched" | null) => {
    const next = new URLSearchParams(searchParams);
    if (card) next.set("card", card);
    else next.delete("card");
    const qs = next.toString();
    return `/contacts${qs ? `?${qs}` : ""}`;
  };
  const clearCard = () => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("card");
      return next;
    });
  };

  // The persisted filter (sortBy/sortDir) is the single source of truth; the headers reuse the shared sort
  // RULE (nextSortState / sortHeaderProps) over it, and a sort change goes back through setFilters → API +
  // page reset + persistence. No second sort store, so nothing can drift.
  const sortState: SortState | null =
    filters.sortBy && filters.sortBy in CONTACT_SORT_TYPES
      ? { key: filters.sortBy, dir: filters.sortDir ?? "desc" }
      : null;
  const handleSort = (key: string) => {
    const next = nextSortState(sortState, key, CONTACT_SORT_TYPES[key]);
    setFilters({ sortBy: next.key, sortDir: next.dir });
  };
  // No-blank: keep the prior page of contacts visible during a search/filter/page refetch; gate
  // the skeleton to the FIRST load only and show an "Updating..." hint on a refresh.
  const { data: contacts, isInitialLoading, isRefreshing } = useKeepPreviousData(rawContacts, loading, error);

  const activeRole = (filters.role ?? "all") as (typeof ROLE_OPTIONS)[number]["value"];
  const activeOwnerScope = (filters.ownerScope ?? "all") as (typeof OWNER_SCOPE_OPTIONS)[number]["value"];
  const activeLinkedDeals = (filters.hasLinkedDeals ? "linked" : "all") as (typeof LINKED_DEALS_OPTIONS)[number]["value"];
  const totals = useMemo(() => {
    // Primary + Untouched are now SERVER aggregates over the full filtered set (not the visible page),
    // so the cards reconcile with the lists they drill to. linkedDeals stays a page-scoped badge hint.
    const linkedDeals = contacts.reduce((sum, contact) => sum + (contact.linkedDealsCount ?? 0), 0);
    return {
      primary: pagination.primaryCount ?? 0,
      untouched: pagination.untouchedCount ?? 0,
      linkedDeals,
    };
  }, [pagination.primaryCount, pagination.untouchedCount, contacts]);

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
        <MetricCard
          eyebrow="Total contacts"
          value={String(pagination.baseTotal ?? pagination.total)}
          badge={`${contacts.length} shown`}
          caption="Directory"
          tone="green"
          accent="red"
          to={buildCardTo(null)}
          ariaLabel="Show all contacts in this view"
          className={!activeCard ? ACTIVE_CARD_CLASS : undefined}
        />
        <MetricCard
          eyebrow="Primary contacts"
          value={String(totals.primary)}
          badge={`${totals.linkedDeals} links`}
          caption="Deal coverage"
          tone="blue"
          accent="blue"
          to={buildCardTo("primary")}
          ariaLabel="Filter to primary contacts"
          className={activeCard === "primary" ? ACTIVE_CARD_CLASS : undefined}
        />
        <MetricCard
          eyebrow="Untouched 30d+"
          value={String(totals.untouched)}
          badge="Review"
          caption="Needs touch"
          tone="red"
          accent="red"
          to={buildCardTo("untouched")}
          ariaLabel="Filter to contacts untouched 30+ days"
          className={activeCard === "untouched" ? ACTIVE_CARD_CLASS : undefined}
        />
      </div>

      {activeCard ? (
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-2 rounded-full bg-brand-red/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-brand-red ring-1 ring-brand-red/20">
            Filtered: {CONTACT_CARD_LABELS[activeCard] ?? activeCard}
            <button
              type="button"
              onClick={clearCard}
              aria-label="Clear card filter"
              className="-mr-1 inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-brand-red/20"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        </div>
      ) : null}

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
              <ScopeToggle
                options={LINKED_DEALS_OPTIONS}
                value={activeLinkedDeals}
                onChange={(value) => setFilters({ hasLinkedDeals: value === "linked" ? true : undefined })}
                ariaLabel="Linked deals filter"
                size="touch"
              />
            </div>
            <div className="flex items-center gap-2">
              {isRefreshing ? (
                <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">Updating...</span>
              ) : null}
              {/* The one-shot "Last touch" sort button is replaced by the sortable "Last touch" column header
                  (desktop table). The mobile card list keeps the default order. */}
              <Button variant="ghost" size="sm" className="min-h-[44px] md:min-h-0" onClick={() => { resetFilters(); clearCard(); }}>
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
                  <SortableTableHead
                    label="Contact"
                    buttonClassName={HEAD_CLASS}
                    {...sortHeaderProps(sortState, "name")}
                    onSort={() => handleSort("name")}
                  />
                  <SortableTableHead
                    label="Company"
                    buttonClassName={HEAD_CLASS}
                    {...sortHeaderProps(sortState, "company_name")}
                    onSort={() => handleSort("company_name")}
                  />
                  <TableHead className={HEAD_CLASS}>Role</TableHead>
                  <TableHead className={HEAD_CLASS}>Quick actions</TableHead>
                  <SortableTableHead
                    label="Linked deals"
                    numeric
                    className="text-right"
                    buttonClassName={HEAD_CLASS}
                    {...sortHeaderProps(sortState, "linked_deals_count")}
                    onSort={() => handleSort("linked_deals_count")}
                  />
                  <SortableTableHead
                    label="Last touch"
                    buttonClassName={HEAD_CLASS}
                    {...sortHeaderProps(sortState, "last_touch_at")}
                    onSort={() => handleSort("last_touch_at")}
                  />
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
                        <p className="max-w-[220px] truncate text-sm font-semibold text-slate-700">{getContactCompanyName(contact, "Unassigned")}</p>
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
