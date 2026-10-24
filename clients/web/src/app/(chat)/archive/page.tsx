"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo } from "react";
import useSWR from "swr";
import { fetcher } from "lib/utils";
import { useSession } from "@/lib/backend/session-context";
import Link from "next/link";
import { Card, CardContent, CardHeader } from "ui/card";
import { MessageCircleXIcon } from "lucide-react";
import { ArchiveActionsClient } from "@/app/(chat)/archive/archive-actions-client";
import { Separator } from "ui/separator";

import LightRays from "ui/light-rays";
import Particles from "ui/particles";

function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffInMs = now.getTime() - date.getTime();
  const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));

  if (diffInDays === 0) return "Today";
  if (diffInDays === 1) return "Yesterday";
  if (diffInDays < 7) return `${diffInDays} days ago`;
  if (diffInDays < 30) return `${Math.floor(diffInDays / 7)} weeks ago`;
  if (diffInDays < 365) return `${Math.floor(diffInDays / 30)} months ago`;
  return `${Math.floor(diffInDays / 365)} years ago`;
}

// Was archive/[id] -- flattened to a ?id= query param, see (chat)/page.tsx's
// doc comment for why. Was a Server Component reading
// archiveRepository/chatRepository directly and cross-referencing them
// in-process (getArchiveWithThreads); now two client-side reads -- GET
// /api/archive/{id} (ownership-checked on the sidecar, 404s a non-owner
// the same way requireOwnedArchive did) and GET /api/thread (the
// sidebar's own list, already fetched, joined here against the archive's
// item ids instead of a second server-side query).
function ArchivePageContent() {
  const id = useSearchParams().get("id");
  const router = useRouter();
  const { data: session } = useSession();
  const { data: archive, error } = useSWR(
    id ? `/api/archive/${id}` : null,
    fetcher,
  );
  const { data: threads } = useSWR(session ? "/api/thread" : null, fetcher);

  useEffect(() => {
    if (error) router.replace("/");
  }, [error, router]);

  const archiveThreads = useMemo(() => {
    if (!archive || !threads) return [];
    const itemIds = new Set(
      archive.items.map((item: { itemId: string }) => item.itemId),
    );
    return threads
      .filter((t: { id: string }) => itemIds.has(t.id))
      .sort(
        (a: { lastMessageAt: number }, b: { lastMessageAt: number }) =>
          (b.lastMessageAt || 0) - (a.lastMessageAt || 0),
      );
  }, [archive, threads]);

  if (!session || !archive) return null;

  return (
    <>
      <>
        <div className="absolute opacity-30 pointer-events-none top-0 left-0 w-full h-full z-10 fade-in animate-in duration-5000">
          <LightRays className="bg-transparent" />
        </div>
        <div className="absolute pointer-events-none top-0 left-0 w-full h-full z-10 fade-in animate-in duration-5000">
          <Particles
            className="bg-transparent"
            particleCount={400}
            particleBaseSize={10}
          />
        </div>
        <div className="absolute pointer-events-none top-0 left-0 w-full h-full z-10 fade-in animate-in duration-5000">
          <div className="w-full h-full bg-gradient-to-t from-background to-50% to-transparent z-20" />
        </div>
        <div className="absolute pointer-events-none top-0 left-0 w-full h-full z-10 fade-in animate-in duration-5000">
          <div className="w-full h-full bg-gradient-to-l from-background to-20% to-transparent z-20" />
        </div>
        <div className="absolute pointer-events-none top-0 left-0 w-full h-full z-10 fade-in animate-in duration-5000">
          <div className="w-full h-full bg-gradient-to-r from-background to-20% to-transparent z-20" />
        </div>
      </>
      <div className="container mx-auto p-6 max-w-4xl z-40" data-testid="archive-page">
        <div className="mb-8 z-50">
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-bold" data-testid="archive-title">{archive.name}</h1>
            <div className="flex-1" />
            <p className="text-xs text-muted-foreground mr-2">
              Created {formatTimeAgo(new Date(archive.createdAt))}
            </p>
            <div className="h-4">
              <Separator orientation="vertical" />
            </div>
            <ArchiveActionsClient
              archive={{
                id: archive.id,
                name: archive.name,
                description: archive.description,
                userId: session.user.id,
                createdAt: archive.createdAt,
                updatedAt: archive.updatedAt,
              }}
            />
          </div>
          {archive.description && (
            <p className="text-muted-foreground text-sm mt-4">
              {archive.description}
            </p>
          )}
        </div>

        <div className="space-y-3">
          {archiveThreads.length === 0 ? (
            <Card className="bg-transparent border-none" data-testid="archive-empty">
              <CardContent className="flex items-center justify-center py-12">
                <div className="text-center">
                  <MessageCircleXIcon className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                  <h3 className="text-lg font-medium mb-2">
                    No threads in this archive
                  </h3>
                  <p className="text-muted-foreground">
                    Add some chat threads to this archive to see them here.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            archiveThreads.map(
              (thread: {
                id: string;
                title: string;
                createdAt: string;
                lastMessageAt: number;
              }) => (
                <Link key={thread.id} href={`/?thread=${thread.id}`}>
                  <Card className="hover:bg-accent/30 transition-all duration-200 cursor-pointer">
                    <CardHeader className="py-4">
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <h3 className="font-medium text-base truncate mb-1">
                            {thread.title || "Untitled Chat"}
                          </h3>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {formatTimeAgo(
                            thread.lastMessageAt
                              ? new Date(thread.lastMessageAt)
                              : new Date(thread.createdAt),
                          )}
                        </span>
                      </div>
                    </CardHeader>
                  </Card>
                </Link>
              ),
            )
          )}
        </div>
      </div>
    </>
  );
}

export default function ArchivePage() {
  return (
    <Suspense fallback={null}>
      <ArchivePageContent />
    </Suspense>
  );
}
