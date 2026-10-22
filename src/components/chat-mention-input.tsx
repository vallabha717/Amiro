"use client";
import React, {
  RefObject,
  useCallback,
  useMemo,
  useRef,
  useState,
  useEffect,
} from "react";

import { FileIcon, FolderIcon, SearchIcon } from "lucide-react";
import {
  findComposerFiles,
  type ComposerCommand,
  type ComposerEntry,
} from "@/lib/backend/composer-api";

import { ChatMention } from "app-types/chat";

import MentionInput from "./mention-input";
import { SkillPalette } from "./chat/skill-palette";
import { useTranslations } from "next-intl";
import { Popover, PopoverContent, PopoverTrigger } from "ui/popover";

import { cn, toAny } from "lib/utils";
import { Editor } from "@tiptap/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "ui/tooltip";
import equal from "lib/equal";
import { useIsMobile } from "@/hooks/use-mobile";

type MentionItemType = {
  id: string;
  type: string;
  label: string;
  onSelect: () => void;
  icon: React.ReactNode;
  suffix?: React.ReactNode;
};

interface ChatMentionInputProps {
  onChange: (text: string) => void;
  onChangeMention: (mentions: ChatMention[]) => void;
  onEnter?: () => void;
  placeholder?: string;
  input: string;
  disabledMention?: boolean;
  ref?: RefObject<Editor | null>;
  onFocus?: () => void;
  onBlur?: () => void;
  onSelectSkill?: (skill: { name: string; description?: string }) => void;
  onRunCommand?: (command: ComposerCommand) => void;
  projectDirectory?: string;
  threadId?: string;
}

export default function ChatMentionInput({
  onChange,
  onChangeMention,
  onEnter,
  placeholder,
  ref,
  input,
  disabledMention,
  onFocus,
  onBlur,
  onSelectSkill,
  onRunCommand,
  projectDirectory,
  threadId,
}: ChatMentionInputProps) {
  const latestMentions = useRef<string[]>([]);

  const handleChange = useCallback(
    ({
      text,
      mentions,
    }: { text: string; mentions: { label: string; id: string }[] }) => {
      onChange(text);
      const mentionsIds = mentions.map((mention) => mention.id);
      const parsedMentions = mentionsIds.map(
        (id) => JSON.parse(id) as ChatMention,
      );
      if (equal(latestMentions.current, mentionsIds)) return;
      latestMentions.current = mentionsIds;
      onChangeMention(parsedMentions);
    },
    [onChange, onChangeMention],
  );

  return (
    <MentionInput
      content={input}
      onEnter={onEnter}
      placeholder={placeholder}
      suggestionChar="@"
      disabledMention={disabledMention}
      onChange={handleChange}
      MentionItem={ChatMentionInputMentionItem}
      Suggestion={ChatMentionInputSuggestion}
      SkillSuggestion={SkillPalette}
      editorRef={ref}
      onFocus={onFocus}
      onBlur={onBlur}
      fullWidthSuggestion={true}
      enableSkillSuggestion={true}
      onSelectSkill={onSelectSkill}
      onRunCommand={onRunCommand}
      projectDirectory={projectDirectory}
      threadId={threadId}
    />
  );
}

export function ChatMentionInputMentionItem({
  id,
  className,
}: {
  id: string;
  className?: string;
}) {
  const item = useMemo(() => JSON.parse(id) as ChatMention, [id]);
  const label = useMemo(() => {
    return (
      <div
        className={cn(
          "flex items-center text-sm px-2 py-0.5 rounded-sm font-semibold transition-colors",
          "text-primary font-bold bg-primary/5",
          className,
        )}
      >
        {toAny(item).label || item.name}
      </div>
    );
  }, [item]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>{label}</TooltipTrigger>
      <TooltipContent className="p-4 whitespace-pre-wrap max-w-xs">
        {item.description || "mention"}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The composer's `@` menu: files and folders in the chat's working folder,
 * searched as the user types (folders first at the same rank). Picking one
 * inserts `@path` (a folder gets a trailing `/`), the way jcode's TUI does.
 */
export function ChatMentionInputSuggestion({
  onInsertText,
  threadId,
  projectDirectory,
  onClose,
  top,
  left,
  className,
  open,
  onOpenChange,
  children,
  style,
}: {
  onClose: () => void;
  /** Kept for the MentionInput contract; `@` inserts plain paths instead. */
  onSelectMention?: (item: { label: string; id: string }) => void;
  onInsertText?: (text: string) => void;
  threadId?: string;
  projectDirectory?: string;
  top: number;
  left: number;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  const tc = useTranslations("Chat.Mentions");
  const [searchValue, setSearchValue] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [found, setFound] = useState<{ root: string; entries: ComposerEntry[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const itemRefs = useRef<{ [key: string]: HTMLButtonElement | null }>({});
  const isMobile = useIsMobile();

  // Debounced search; only the newest answer is applied.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      findComposerFiles({ q: searchValue, threadId, projectDirectory, limit: 30 })
        .then((result) => {
          if (cancelled) return;
          setFound({ root: result.root, entries: result.entries });
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchValue, threadId, projectDirectory]);

  const items = useMemo<MentionItemType[]>(
    () =>
      (found?.entries ?? []).map(({ path, kind }) => {
        const slash = path.lastIndexOf("/");
        const insert = kind === "folder" ? `@${path}/ ` : `@${path} `;
        return {
          id: `${kind}-${path}`,
          type: kind,
          label: path,
          onSelect: () => onInsertText?.(insert),
          icon:
            kind === "folder" ? (
              <FolderIcon className="size-3.5 shrink-0 text-primary/80" />
            ) : (
              <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
            ),
          suffix:
            slash > 0 ? (
              <span className="ml-auto truncate pl-2 text-xs text-muted-foreground">{path.slice(0, slash)}</span>
            ) : undefined,
        };
      }),
    [found, onInsertText],
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [items.length, searchValue]);

  useEffect(() => {
    const selected = items[selectedIndex];
    if (selected) itemRefs.current[selected.id]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedIndex, items]);

  const trigger = useMemo(
    () => children ?? <span className="fixed z-50" style={{ top, left }} />,
    [children, top, left],
  );
  const folderName = found?.root.split("/").filter(Boolean).pop() ?? "";

  return (
    <Popover
      open={open ?? true}
      onOpenChange={(f) => {
        !f && onClose();
        onOpenChange?.(f);
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        data-testid="chat-mention-suggestion"
        className={cn("p-0", className)}
        align="start"
        side="top"
        style={{
          ...style,
          width: style?.width || (isMobile ? "100%" : "auto"),
          minWidth: isMobile ? undefined : "520px",
          maxWidth: isMobile ? undefined : "800px",
        }}
      >
        <div className="flex flex-col">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <SearchIcon className="size-4 shrink-0 opacity-50" />
            <input
              className="flex h-8 w-full rounded-md bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              placeholder={tc("searchPlaceholder")}
              aria-label={tc("searchPlaceholder")}
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Backspace" && !e.currentTarget.value) onClose();
                if (e.key === "Escape") onClose();
                if (e.key === "Enter" && items[selectedIndex]) {
                  e.preventDefault();
                  items[selectedIndex].onSelect();
                }
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSelectedIndex((prev) => (prev < items.length - 1 ? prev + 1 : 0));
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSelectedIndex((prev) => (prev > 0 ? prev - 1 : Math.max(0, items.length - 1)));
                }
              }}
              autoFocus
            />
          </div>
          <div data-testid="chat-mention-list"
            className={cn("overflow-y-auto", isMobile ? "max-h-[50vh]" : "max-h-[340px]")}>
            {items.length === 0 ? (
              <div className="flex items-center justify-center p-8 text-center text-sm text-muted-foreground">
                {failed
                  ? tc("filesFailed")
                  : searchValue
                    ? tc("noMatch", { query: searchValue })
                    : found
                      ? tc("emptyFolder")
                      : tc("loading")}
              </div>
            ) : (
              <MentionGroup testId="chat-mention-group-files" title={tc("files", { folder: folderName })}>
                {items.map((item, index) => (
                  <MentionItem key={item.id} item={item} isSelected={index === selectedIndex}
                    ref={(el) => {
                      itemRefs.current[item.id] = el;
                    }} />
                ))}
              </MentionGroup>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function MentionGroup({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return (
    <div data-testid={testId} className="border-b p-2 last:border-b-0">
      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

const MentionItem = React.forwardRef<
  HTMLButtonElement,
  { item: MentionItemType; isSelected: boolean }
>(({ item, isSelected }, ref) => {
  return (
    <button
      ref={ref}
      data-testid={`chat-mention-${item.type}-${item.label}`}
      className={cn(
        "flex items-center gap-2 w-full rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground cursor-pointer",
        isSelected && "bg-accent text-accent-foreground",
      )}
      onClick={() => item.onSelect()}
    >
      {item.icon}
      <span className="min-w-0 truncate font-mono text-xs">
        {item.label.split("/").pop()}
        {item.type === "folder" ? "/" : ""}
      </span>
      {item.suffix}
    </button>
  );
});
MentionItem.displayName = "MentionItem";
