"use client";

import {
  AGENTS_KEY,
  type AgentFile,
  type TeamAgent,
  agentKey,
  deleteAgent,
  sortAgentThreads,
  teamPath,
  updateAgent,
  useAgent,
  useAgentFiles,
  useAgentThreads,
} from "@/lib/backend/agents-api";
import { useSession } from "@/lib/backend/session-context";
import type { CharacterTraits } from "@/lib/agent/character-catalog";
import {
  ArrowLeftIcon,
  FileIcon,
  FolderIcon,
  HashIcon,
  MessageSquareIcon,
  PinIcon,
  PlusIcon,
  ShieldAlertIcon,
  Trash2Icon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { mutate } from "swr";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "ui/alert-dialog";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { Label } from "ui/label";
import { Skeleton } from "ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "ui/tabs";
import { Textarea } from "ui/textarea";
import { AgentAvatar } from "./agent-avatar";
import { AgentLookPicker, accentFor } from "./agent-look-picker";

/** Where a chat with this agent opens: the channel in Team, others in the agent chat page. */
export function agentThreadHref(agent: TeamAgent, threadId: string, channel: boolean) {
  if (channel) return teamPath(agent.id);
  if (agent.isMain) return `/?thread=${encodeURIComponent(threadId)}`;
  return `/team/chat?agent=${encodeURIComponent(agent.id)}&thread=${encodeURIComponent(threadId)}`;
}

function ChatsTab({ agent }: { agent: TeamAgent }) {
  const t = useTranslations("Team");
  const { data, isLoading } = useAgentThreads(agent.id);
  const threads = sortAgentThreads(data?.threads ?? []);
  const newChatHref = agent.isMain
    ? "/"
    : `/team/chat?agent=${encodeURIComponent(agent.id)}`;
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button asChild size="sm" variant="outline" data-testid="agent-new-chat">
          <Link href={newChatHref}>
            <PlusIcon className="size-4" />
            {t("newChat")}
          </Link>
        </Button>
      </div>
      <ul className="divide-y rounded-xl border" data-testid="agent-thread-list">
        {isLoading && (
          <li className="p-3">
            <Skeleton className="h-5 w-1/2" />
          </li>
        )}
        {threads.map((thread) => (
          <li key={thread.id}>
            <Link
              href={agentThreadHref(agent, thread.id, thread.channel)}
              className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-accent/60 focus-visible:bg-accent focus-visible:outline-none"
              data-testid={thread.channel ? "agent-channel-link" : "agent-thread-link"}
            >
              {thread.channel ? (
                <HashIcon className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">
                {thread.channel ? t("channel") : thread.title}
              </span>
              {thread.channel && (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <PinIcon className="size-3" />
                  {t("pinned")}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProfileTab({ agent, canEdit }: { agent: TeamAgent; canEdit: boolean }) {
  const t = useTranslations("Team");
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState(agent.role);
  const [instructions, setInstructions] = useState(agent.instructions);
  const [traits, setTraits] = useState<CharacterTraits>(agent.traits);
  const [busy, setBusy] = useState(false);

  if (agent.isMain) {
    return (
      <div className="rounded-xl border p-4 text-sm">
        <p className="text-muted-foreground">{t("mainProfileHint")}</p>
        <Button asChild className="mt-3" size="sm" data-testid="agent-open-personality">
          <Link href="/agent/personality">{t("openPersonality")}</Link>
        </Button>
      </div>
    );
  }

  const save = async () => {
    setBusy(true);
    try {
      const updated = await updateAgent(agent.id, { name, role, instructions, traits });
      await Promise.all([mutate(agentKey(agent.id), updated, false), mutate(AGENTS_KEY)]);
      toast.success(t("saved"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="agent-profile-name">{t("name")}</Label>
        <Input
          id="agent-profile-name"
          value={name}
          maxLength={32}
          disabled={!canEdit}
          onChange={(e) => setName(e.target.value)}
          data-testid="agent-profile-name"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="agent-profile-role">{t("role")}</Label>
        <Input
          id="agent-profile-role"
          value={role}
          maxLength={80}
          disabled={!canEdit}
          placeholder={t("rolePlaceholder")}
          onChange={(e) => setRole(e.target.value)}
          data-testid="agent-profile-role"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="agent-profile-instructions">{t("instructions")}</Label>
        <Textarea
          id="agent-profile-instructions"
          value={instructions}
          maxLength={4000}
          rows={6}
          disabled={!canEdit}
          placeholder={t("instructionsPlaceholder")}
          onChange={(e) => setInstructions(e.target.value)}
          data-testid="agent-profile-instructions"
        />
      </div>
      <AgentLookPicker traits={traits} onChange={setTraits} disabled={!canEdit} />
      {canEdit ? (
        <div className="flex justify-end">
          <Button
            onClick={save}
            disabled={busy || !name.trim()}
            data-testid="agent-profile-save"
          >
            {busy ? t("saving") : t("save")}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("ownerOnly")}</p>
      )}
    </div>
  );
}

function formatSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function WorkspaceTab({ agent }: { agent: TeamAgent }) {
  const t = useTranslations("Team");
  const { data, isLoading, error } = useAgentFiles(agent.id);
  const files: AgentFile[] = data?.files ?? [];
  return (
    <div className="space-y-3">
      <p className="break-all font-mono text-xs text-muted-foreground" data-testid="agent-workspace-dir">
        {agent.workspaceDir}
      </p>
      <div className="flex gap-2 rounded-xl border border-dashed p-3 text-xs text-muted-foreground">
        <ShieldAlertIcon className="size-4 shrink-0" />
        <span>{t("isolationNote")}</span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      )}
      <ul className="divide-y rounded-xl border text-sm" data-testid="agent-file-list">
        {isLoading && (
          <li className="p-3">
            <Skeleton className="h-5 w-1/3" />
          </li>
        )}
        {!isLoading && files.length === 0 && (
          <li className="p-3 text-muted-foreground">{t("noFiles")}</li>
        )}
        {files.map((file) => (
          <li key={file.path} className="flex items-center gap-2 px-3 py-2">
            {file.kind === "dir" ? (
              <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <FileIcon className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
            {file.kind === "file" && (
              <span className="text-xs text-muted-foreground">{formatSize(file.size)}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DeleteAgentButton({ agent }: { agent: TeamAgent }) {
  const t = useTranslations("Team");
  const router = useRouter();
  const remove = async () => {
    try {
      await deleteAgent(agent.id);
      await mutate(AGENTS_KEY);
      toast.success(t("deleted", { name: agent.name }));
      router.push("/team");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("deleteError"));
    }
  };
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-destructive" data-testid="agent-delete">
          <Trash2Icon className="size-4" />
          {t("delete")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("deleteTitle", { name: agent.name })}</AlertDialogTitle>
          <AlertDialogDescription>{t("deleteBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={remove} data-testid="agent-delete-confirm">
            {t("delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** One agent: its pinned channel and other chats, its profile, its folder. */
export function AgentPage({ agentId }: { agentId: string }) {
  const t = useTranslations("Team");
  const { data: session } = useSession();
  const isOwner = session?.user.role === "admin";
  const { data: agent, error } = useAgent(agentId);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">{t("notFound")}</h1>
        <Link href="/team" className="mt-3 inline-block text-sm underline">
          {t("backToTeam")}
        </Link>
      </div>
    );
  }
  if (!agent) return null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:py-8">
      <Link
        href={teamPath(agent.id)}
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
        {t("backToTeam")}
      </Link>
      <header className="mb-6 flex items-center gap-4">
        <AgentAvatar
          agent={{ ...agent, accentHex: agent.accentHex || accentFor(agent.traits.color) }}
          size={72}
          animated
        />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold" data-testid="agent-page-name">
            {agent.name}
          </h1>
          <p className="truncate text-sm text-muted-foreground">
            {agent.role || t("noRole")}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2 sm:flex-row sm:items-center">
          <Button asChild size="sm" data-testid="agent-open-channel">
            <Link href={teamPath(agent.id)}>
              <HashIcon className="size-4" />
              {t("openChannel")}
            </Link>
          </Button>
          {isOwner && !agent.isMain && <DeleteAgentButton agent={agent} />}
        </div>
      </header>
      <Tabs defaultValue="chats">
        <TabsList>
          <TabsTrigger value="chats" data-testid="agent-tab-chats">{t("tabChats")}</TabsTrigger>
          <TabsTrigger value="profile" data-testid="agent-tab-profile">{t("tabProfile")}</TabsTrigger>
          <TabsTrigger value="workspace" data-testid="agent-tab-workspace">{t("tabWorkspace")}</TabsTrigger>
        </TabsList>
        <TabsContent value="chats" className="mt-4">
          <ChatsTab agent={agent} />
        </TabsContent>
        <TabsContent value="profile" className="mt-4">
          {/* Keyed by the saved version so a revalidation never clobbers an
              unsaved edit, while a save elsewhere resets the form. */}
          <ProfileTab
            key={`${agent.id}:${agent.updatedAt ?? ""}`}
            agent={agent}
            canEdit={isOwner}
          />
        </TabsContent>
        <TabsContent value="workspace" className="mt-4">
          <WorkspaceTab agent={agent} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
