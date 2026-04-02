import { useParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ContactForm } from "@/components/contacts/contact-form";
import { useContactDetail } from "@/hooks/use-contacts";

export function ContactEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { contact, loading, error } = useContactDetail(id);

  if (loading) {
    return (
      <div className="max-w-3xl space-y-4">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="h-96 bg-muted animate-pulse rounded-lg" />
      </div>
    );
  }

  if (error || !contact) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600">{error ?? "Contact not found"}</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/contacts")}>
          Back to Contacts
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <h2 className="text-2xl font-bold mb-4">Edit Contact</h2>
      <ContactForm contact={contact} />
    </div>
  );
}
