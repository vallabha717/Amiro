"use client";

import { useSidebar } from "ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "ui/tooltip";
import {
  AudioWaveformIcon,
  ChevronDown,
  MessageCircleDashed,
  PanelLeft,
  WorkflowIcon,
} from "lucide-react";
import { Button } from "ui/button";
import { Separator } from "ui/separator";

import { useEffect, useMemo, useRef } from "react";
import { ThreadDropdown } from "../thread-dropdown";
import { appStore } from "@/app/store";
import { usePathname, useSearchParams } from "next/navigation";
import { useShallow } from "zustand/shallow";
import { getShortcutKeyList, Shortcuts } from "lib/keyboard-shortcuts";
import { useTranslations } from "next-intl";
import { TextShimmer } from "ui/text-shimmer";
import { buildReturnUrl } from "lib/admin/navigation-utils";
import { BackButton } from "@/components/layouts/back-button";
import { WORKFLOW_VIEW_LAUNCH_DATE } from "app-types/chat-graph";

export function AppHeader() {
  const t = useTranslations();
  const [appStoreMutate, workflowView, threadList, currentThreadId] = appStore(
    useShallow((state) => [
      state.mutate,
      state.workflowView,
      state.threadList,
      state.currentThreadId,
    ]),
  );
  const { toggleSidebar, open, setOpen } = useSidebar();
  const currentPaths = usePathname();
  const searchParams = useSearchParams();
  const sidebarOpenBeforeWorkflowView = useRef<boolean | null>(null);

  const showActionButtons = useMemo(() => {
    if (currentPaths.startsWith("/admin")) {
      return false;
    }
    return true;
  }, [currentPaths]);

  const currentThread = useMemo(
    () => threadList.find((thread) => thread.id === currentThreadId),
    [threadList, currentThreadId],
  );

  const canToggleWorkflowView = useMemo(() => {
    if (!currentThread) return true;
    return (
      new Date(currentThread.createdAt).getTime() >=
      WORKFLOW_VIEW_LAUNCH_DATE.getTime()
    );
  }, [currentThread]);

  // Auto-collapses the nav sidebar the moment Workflow View becomes active
  // for an eligible thread (including by default, with no click needed), and
  // restores whatever the sidebar's prior state was once it's turned off.
  useEffect(() => {
    if (workflowView.isOpen && canToggleWorkflowView) {
      if (sidebarOpenBeforeWorkflowView.current === null) {
        sidebarOpenBeforeWorkflowView.current = open;
      }
      setOpen(false);
    } else if (sidebarOpenBeforeWorkflowView.current !== null) {
      setOpen(sidebarOpenBeforeWorkflowView.current);
      sidebarOpenBeforeWorkflowView.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowView.isOpen, canToggleWorkflowView]);

  const handleToggleWorkflowView = () => {
    appStoreMutate((state) => ({
      workflowView: {
        ...state.workflowView,
        isOpen: !state.workflowView.isOpen,
      },
    }));
  };

  const componentByPage = useMemo(() => {
    if (currentPaths === "/" && searchParams.get("thread")) {
      return <ThreadDropdownComponent />;
    }
    if (currentPaths === "/admin/usage/detail") {
      const searchPageParams = searchParams.get("searchPageParams");
      const returnUrl = buildReturnUrl("/admin/usage", searchPageParams || "");
      return (
        <BackButton
          data-testid="admin-usage-back-button"
          returnUrl={returnUrl}
          title={t("Admin.Usage.backToUsage")}
        />
      );
    }
    if (currentPaths === "/admin/users/detail") {
      const searchPageParams = searchParams.get("searchPageParams");
      const returnUrl = buildReturnUrl("/admin/usage", searchPageParams || "");
      return (
        <BackButton
          data-testid="admin-users-back-button"
          returnUrl={returnUrl}
          title={t("Admin.Usage.backToUsage")}
        />
      );
    }
  }, [currentPaths, searchParams]);

  return (
    <header className="sticky top-0 z-50 flex items-center px-3 py-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Toggle Sidebar"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              toggleSidebar();
            }}
            data-testid="sidebar-toggle"
            data-state={open ? "open" : "closed"}
          >
            <PanelLeft />
          </Button>
        </TooltipTrigger>
        <TooltipContent align="start" side="bottom">
          <div className="flex items-center gap-2">
            {t("KeyboardShortcuts.toggleSidebar")}
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              {getShortcutKeyList(Shortcuts.toggleSidebar).map((key) => (
                <span
                  key={key}
                  className="w-5 h-5 flex items-center justify-center bg-muted rounded "
                >
                  {key}
                </span>
              ))}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>

      {componentByPage}
      <div className="flex-1" />
      {showActionButtons && (
        <div className="flex items-center gap-2">
          {canToggleWorkflowView && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size={"icon"}
                  variant={workflowView.isOpen ? "secondary" : "ghost"}
                  className="bg-secondary/40"
                  aria-pressed={workflowView.isOpen}
                  onClick={handleToggleWorkflowView}
                >
                  <WorkflowIcon className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent align="end" side="bottom">
                {t("Chat.WorkflowView.toggle")}
              </TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size={"icon"}
                variant={"ghost"}
                className="bg-secondary/40"
                onClick={() => {
                  appStoreMutate((state) => ({
                    voiceChat: {
                      ...state.voiceChat,
                      isOpen: true,
                      agentId: undefined,
                    },
                  }));
                }}
              >
                <AudioWaveformIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent align="end" side="bottom">
              <div className="text-xs flex items-center gap-2">
                {t("KeyboardShortcuts.toggleVoiceChat")}
                <div className="text-xs text-muted-foreground flex items-center gap-1">
                  {getShortcutKeyList(Shortcuts.toggleVoiceChat).map((key) => (
                    <span
                      className="w-5 h-5 flex items-center justify-center bg-muted rounded "
                      key={key}
                    >
                      {key}
                    </span>
                  ))}
                </div>
              </div>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size={"icon"}
                variant={"secondary"}
                className="bg-secondary/40"
                onClick={() => {
                  appStoreMutate((state) => ({
                    temporaryChat: {
                      ...state.temporaryChat,
                      isOpen: !state.temporaryChat.isOpen,
                    },
                  }));
                }}
              >
                <MessageCircleDashed className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent align="end" side="bottom">
              <div className="text-xs flex items-center gap-2">
                {t("KeyboardShortcuts.toggleTemporaryChat")}
                <div className="text-xs text-muted-foreground flex items-center gap-1">
                  {getShortcutKeyList(Shortcuts.toggleTemporaryChat).map(
                    (key) => (
                      <span
                        className="w-5 h-5 flex items-center justify-center bg-muted rounded "
                        key={key}
                      >
                        {key}
                      </span>
                    ),
                  )}
                </div>
              </div>
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </header>
  );
}

function ThreadDropdownComponent() {
  const [threadList, currentThreadId, generatingTitleThreadIds] = appStore(
    useShallow((state) => [
      state.threadList,
      state.currentThreadId,
      state.generatingTitleThreadIds,
    ]),
  );
  const currentThread = useMemo(() => {
    return threadList.find((thread) => thread.id === currentThreadId);
  }, [threadList, currentThreadId]);

  useEffect(() => {
    if (currentThread?.id) {
      document.title = currentThread.title || "New Chat";
    }
  }, [currentThread?.id]);

  if (!currentThread) return null;

  return (
    <div className="items-center gap-1 hidden md:flex">
      <div className="w-1 h-4">
        <Separator orientation="vertical" />
      </div>

      <ThreadDropdown
        threadId={currentThread.id}
        beforeTitle={currentThread.title}
      >
        <div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                className="data-[state=open]:bg-input! hover:text-foreground cursor-pointer flex gap-1 items-center px-2 py-1 rounded-md hover:bg-accent"
              >
                {generatingTitleThreadIds.includes(currentThread.id) ? (
                  <TextShimmer className="truncate max-w-60 min-w-0 mr-1">
                    {currentThread.title || "New Chat"}
                  </TextShimmer>
                ) : (
                  <p className="truncate max-w-60 min-w-0 mr-1">
                    {currentThread.title || "New Chat"}
                  </p>
                )}

                <ChevronDown size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-[200px] p-4 break-all overflow-y-auto max-h-[200px]">
              {currentThread.title || "New Chat"}
            </TooltipContent>
          </Tooltip>
        </div>
      </ThreadDropdown>
    </div>
  );
}
