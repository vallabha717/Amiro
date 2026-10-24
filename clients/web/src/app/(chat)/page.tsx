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

  // chat-bot.tsx's prepareSendMessagesRequest syncs the URL to
  // `?thread=<id>` as soon as the first message of a brand-new chat is
  // sent, purely via a raw history.replaceState (not a real navigation) --
  // just so the URL is shareable/reloadable. But Next's router patches
  // history globally, so that URL change still re-renders this component.
  // Without this check, that flips us into the SWR branch below, which
  // returns null while `isLoading` is true -- and since the thread's
  // messages aren't persisted server-side until its streamed response
  // fully finishes (route.go's Chat handler upserts them only at the very
  // end), that null unmounts the live ChatBot mid-response, discarding the
  // in-flight reply the user is watching (the backend still finishes and
  // persists it, which is why the thread's title updates regardless -- the
  // reply just silently vanishes from the UI until something else reloads
  // the thread). Recognizing "the URL now points at the very thread we
  // ourselves just created" and continuing to render that same `newId`
  // instance sidesteps the refetch entirely: its conversation is already
  // correct in memory, nothing needs to be loaded from the server.
  const isOwnNewThread = threadId === newId;

  const {
    data: thread,
    error,
    isLoading,
  } = useSWR(
    threadId && !isOwnNewThread ? `/api/thread/${threadId}` : null,
    fetcher,
  );

  useEffect(() => {
    if (error) router.replace("/");
  }, [error, router]);

  if (!threadId || isOwnNewThread) {
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
