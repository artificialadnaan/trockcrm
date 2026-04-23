import { useNavigate } from "react-router-dom";
import { Plus, ChevronLeft, ChevronRight, Users } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { ContactCard } from "@/components/contacts/contact-card";
import { ContactFilters } from "@/components/contacts/contact-filters";
import { useContacts } from "@/hooks/use-contacts";
import { useContactFilters } from "@/hooks/use-contact-filters";

export function ContactListPage() {
  const navigate = useNavigate();
  const { filters, setFilters, resetFilters } = useContactFilters();
  const { contacts, pagination, loading, error } = useContacts(filters);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Contacts"
        meta={`${pagination.total} contact${pagination.total !== 1 ? "s" : ""}`}
        actions={{
          primary: (
            <Button onClick={() => navigate("/contacts/new")}>
              <Plus className="mr-2 h-4 w-4" />
              New Contact
            </Button>
          ),
        }}
      />

      {/* Filters */}
      <ContactFilters
        filters={filters}
        onFilterChange={setFilters}
        onReset={resetFilters}
      />

      {/* Error State */}
      {error && (
        <div className="p-4 bg-red-50 text-red-700 rounded-lg text-sm">
          {error}
        </div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-20 bg-muted animate-pulse rounded-lg" />
          ))}
        </div>
      )}

      {/* Contact List */}
      {!loading && contacts.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <Users className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="text-lg font-medium">No contacts found</p>
          <p className="text-sm">Try adjusting your filters or create a new contact.</p>
        </div>
      )}

      {!loading && contacts.length > 0 && (
        <div className="space-y-2">
          {contacts.map((contact) => (
            <ContactCard
              key={contact.id}
              contact={contact}
              onClick={() => navigate(`/contacts/${contact.id}`)}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-sm text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page <= 1}
              onClick={() => setFilters({ page: pagination.page - 1 })}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => setFilters({ page: pagination.page + 1 })}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
