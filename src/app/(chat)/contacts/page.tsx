"use client";

import { ContactsPage } from "@/components/contacts/contacts-page";
import { useSession } from "@/lib/backend/session-context";

export default function ContactsRoutePage() {
  const { data: session } = useSession();
  if (!session) return null;
  return <ContactsPage />;
}
