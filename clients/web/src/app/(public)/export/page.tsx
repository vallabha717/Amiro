"use client";

import ExportError from "@/components/export/error";
import ChatPreview from "@/components/export/chat-preview";
import { fetcher } from "lib/utils";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import useSWR from "swr";

// Was export/[id] -- flattened to a ?id= query param, see (chat)/page.tsx's
// doc comment for why. Was a Server Component reading chatExportRepository
// directly, with no auth check at all (a genuinely public share-link
// page); now GET /api/export/{id}, registered with auth.OptionalSession on
// the sidecar for exactly that reason (see httpserver/router.go's comment
// on the export routes) -- works identically with or without a logged-in
// session.
function ExportPageContent() {
  const id = useSearchParams().get("id");
  const {
    data: thread,
    error,
    isLoading,
  } = useSWR(id ? `/api/export/${id}` : null, fetcher);

  if (isLoading) return null;

  if (error) {
    return (
      <ExportError
        message={
          error?.status === 404
            ? "This export does not exist"
            : "This export has expired"
        }
      />
    );
  }
  if (!thread) return null;
  if (thread.isExpired) {
    return <ExportError message="This export has expired" />;
  }

  return <ChatPreview thread={thread} comments={[]} />;
}

export default function ExportPage() {
  return (
    <Suspense fallback={null}>
      <ExportPageContent />
    </Suspense>
  );
}
