"use client";

import ChatBot from "@/components/chat-bot";
import { fetcher, generateUUID } from "lib/utils";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo } from "react";
import useSWR from "swr";

// Session gating now happens once at the (chat) layout level (RequireAuth)
// -- see (chat)/layout.tsx's doc comment -- so this page no longer needs
// its own getSession()/redirect() call.
//
// Was two separate routes (this file for a brand-new chat, chat/[thread]
// for an existing one) -- merged under a ?thread= query param since static
// export needs generateStaticParams' full id list at build time for a real
// route segment, which is impossible for runtime thread ids (see
// docs/desktop-phase8-handoff.md). Was selectThreadWithMessagesAction (a
// Server Action called directly from an RSC); now GET /api/thread/{id}
// (Phase 7's sidecar route), which 404s the same way the action returned
// null for a missing/foreign thread. useSearchParams() needs a Suspense
// boundary to statically prerender under output: "export".
function HomePageContent() {
  const searchParams = useSearchParams();
  const threadId = searchParams.get("thread");
  const router = useRouter();
  const newId = useMemo(() => generateUUID(), []);

  const {
    data: thread,
    error,
    isLoading,
  } = useSWR(threadId ? `/api/thread/${threadId}` : null, fetcher);

  useEffect(() => {
    if (error) router.replace("/");
  }, [error, router]);

  if (!threadId) {
    return <ChatBot initialMessages={[]} threadId={newId} key={newId} />;
  }

  if (isLoading || !thread) return null;

  return (
    <ChatBot
      key={threadId}
      threadId={threadId}
      initialMessages={thread.messages}
    />
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <HomePageContent />
    </Suspense>
  );
}
