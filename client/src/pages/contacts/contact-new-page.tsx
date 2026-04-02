import { ContactForm } from "@/components/contacts/contact-form";

export function ContactNewPage() {
  return (
    <div className="max-w-3xl">
      <h2 className="text-2xl font-bold mb-4">New Contact</h2>
      <ContactForm />
    </div>
  );
}
