"use client";

import { UploadedFile, appStore } from "@/app/store";
import { useThreadFileUploader } from "@/hooks/use-thread-file-uploader";
import { apiFetch } from "@/lib/backend/client";
import { cn } from "@/lib/utils";
import { UIMessage, UseChatHelpers } from "@ai-sdk/react";
import { Editor } from "@tiptap/react";
import { ChatMention, ChatModel } from "app-types/chat";
import { DefaultToolName } from "lib/ai/tools";
import equal from "lib/equal";
import {
  AudioWaveformIcon,
  ChevronDown,
  Clock,
  CornerRightUp,
  ImagesIcon,
  Loader2,
  Mic,
  MicOff,
  PaperclipIcon,
  PlusIcon,
  Sparkles,
  Square,
  XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "ui/button";
import { ClaudeIcon } from "ui/claude-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import { GeminiIcon } from "ui/gemini-icon";
import { GrokIcon } from "ui/grok-icon";
import { MCPIcon } from "ui/mcp-icon";
import { OpenAIIcon } from "ui/openai-icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "ui/tooltip";
import { useShallow } from "zustand/shallow";
import { ProjectSelector } from "./chat/project-selector";
import { DefaultToolIcon } from "./default-tool-icon";
import { SelectModel } from "./select-model";

import { useChatModels } from "@/hooks/queries/use-chat-models";
import { unlockAudio } from "@/lib/ai/speech/read-aloud-store";
import { AttachmentTile, pastedFiles } from "./attachment-tile";
import {
  getCachedVoiceSettings,
  transcribeSpeech,
} from "@/lib/backend/voice-api";
import { FileUIPart, TextUIPart } from "ai";
import { toast } from "sonner";
import {
  buildAttachmentParts,
  type ComposerAttachmentPart,
  countParkedFiles,
  createPendingFollowUp,
  hasUploadInProgress,
  isIngestable,
  isLoginCommand,
  type PendingFollowUp,
  previewQueuedText,
} from "@/lib/chat/followup-queue";
import { useVoiceStore } from "@/lib/voice/voice-store";
import {
  ComposerSecretNoticeBar,
  StoreCredentialModal,
  useComposerSecretGuard,
} from "./credentials/composer-secret-guard";

interface PromptInputProps {
  placeholder?: string;
  setInput: (value: string) => void;
  input: string;
  onStop: () => void;
  sendMessage: UseChatHelpers<UIMessage>["sendMessage"];
  toolDisabled?: boolean;
  isLoading?: boolean;
  model?: ChatModel;
  setModel?: (model: ChatModel) => void;
  voiceDisabled?: boolean;
  threadId?: string;
  disabledMention?: boolean;
  onFocus?: () => void;
  /** Follow-up parked while the agent responds; rendered as a chip. */
  pendingFollowUp?: PendingFollowUp | null;
  /** Park the current draft instead of sending it right away. */
  onQueueFollowUp?: (followUp: PendingFollowUp) => void;
  /** Cancel the parked follow-up and hand its text back to the composer. */
  onCancelFollowUp?: () => void;
  /**
   * Interrupt the live turn (stop it) and send the current draft at once.
   * Wired to Cmd/Ctrl+Enter while streaming.
   */
  onInterruptAndSend?: (followUp: PendingFollowUp) => void;
}

const ChatMentionInput = dynamic(() => import("./chat-mention-input"), {
  ssr: false,
  loading() {
    return <div className="h-[2rem] w-full animate-pulse"></div>;
  },
});

export default function PromptInput({
  placeholder,
  sendMessage,
  model,
  setModel,
  input,
  onFocus,
  setInput,
  onStop,
  isLoading,
  voiceDisabled,
  threadId,
  disabledMention,
  pendingFollowUp,
  onQueueFollowUp,
  onCancelFollowUp,
  onInterruptAndSend,
}: PromptInputProps) {
  const t = useTranslations("Chat");
  const liveVoiceActive = useVoiceStore((s) => s.active);
  const liveVoiceMinimized = useVoiceStore((s) => s.minimized);

  const [isUploadDropdownOpen, setIsUploadDropdownOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerBoxRef = useRef<HTMLDivElement>(null);
  const { uploadFiles } = useThreadFileUploader(threadId);
  const { data: providers } = useChatModels();

  const [dictationState, setDictationState] = useState<
    "idle" | "recording" | "transcribing"
  >("idle");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const speechRecognitionRef = useRef<any>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;

  useEffect(() => {
    return () => {
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state === "recording"
      ) {
        mediaRecorderRef.current.stop();
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      if (speechRecognitionRef.current) {
        try {
          speechRecognitionRef.current.stop();
        } catch {
          // ignore
        }
      }
    };
  }, []);


  const handleToggleDictation = useCallback(async () => {
    if (dictationState === "recording") {
      if (speechRecognitionRef.current) {
        try {
          speechRecognitionRef.current.stop();
        } catch {
          // ignore
        }
      }
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state === "recording"
      ) {
        mediaRecorderRef.current.stop();
      }
      return;
    }

    if (dictationState === "transcribing") {
      return;
    }

    unlockAudio();
    const settings = getCachedVoiceSettings();
    const sttProvider = settings.sttProvider || "browser-native";
    const sttLanguage = settings.sttLanguage || "en";

    if (
      sttProvider === "browser-native" &&
      typeof window !== "undefined" &&
      ("webkitSpeechRecognition" in window || "SpeechRecognition" in window)
    ) {
      const SpeechRecognitionClass =
        (window as any).SpeechRecognition ||
        (window as any).webkitSpeechRecognition;
      try {
        const recognition = new SpeechRecognitionClass();
        recognition.continuous = true;
        recognition.interimResults = false;
        if (sttLanguage && sttLanguage !== "multi") {
          recognition.lang = sttLanguage;
        }

        recognition.onresult = (event: any) => {
          let transcript = "";
          for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
              transcript += event.results[i][0].transcript;
            }
          }
          if (transcript.trim()) {
            const prev = inputRef.current;
            setInput(prev ? `${prev} ${transcript.trim()}` : transcript.trim());
          }
        };

        recognition.onerror = () => {
          setDictationState("idle");
          speechRecognitionRef.current = null;
        };

        recognition.onend = () => {
          setDictationState("idle");
          speechRecognitionRef.current = null;
        };

        recognition.start();
        speechRecognitionRef.current = recognition;
        setDictationState("recording");
        return;
      } catch {
        // Fallback to MediaRecorder below
      }
    }

    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      toast.error("Audio recording is not supported in this browser");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      audioChunksRef.current = [];

      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }

        const audioBlob = new Blob(audioChunksRef.current, {
          type: mediaRecorder.mimeType || "audio/webm",
        });

        if (audioBlob.size === 0) {
          setDictationState("idle");
          return;
        }

        setDictationState("transcribing");

        try {
          const reader = new FileReader();
          const base64Promise = new Promise<string>((resolve, reject) => {
            reader.onloadend = () => {
              const res = reader.result as string;
              resolve(res.split(",")[1] || "");
            };
            reader.onerror = reject;
          });
          reader.readAsDataURL(audioBlob);
          const base64Audio = await base64Promise;

          const providerState = settings.sttProviders[sttProvider];
          const result = await transcribeSpeech({
            audio: base64Audio,
            mimeType: audioBlob.type,
            provider: sttProvider,
            model: providerState?.model,
            language: sttLanguage,
            baseUrl: providerState?.baseUrl,
          });

          if (result && result.text) {
            const prev = inputRef.current;
            setInput(
              prev ? `${prev} ${result.text.trim()}` : result.text.trim(),
            );
          }
        } catch (err: any) {
          toast.error(err?.message || "Transcription failed");
        } finally {
          setDictationState("idle");
        }
      };

      mediaRecorder.start();
      setDictationState("recording");
    } catch {
      toast.error("Microphone access was denied or is unavailable");
      setDictationState("idle");
    }
  }, [dictationState, setInput]);

  const [
    globalModel,
    threadMentions,
    threadFiles,
    threadImageToolModel,
    projectDirectory,
    appStoreMutate,
  ] = appStore(
    useShallow((state) => [
      state.chatModel,
      state.threadMentions,
      state.threadFiles,
      state.threadImageToolModel,
      state.projectDirectory,
      state.mutate,
    ]),
  );

  const modelInfo = useMemo(() => {
    const provider = providers?.find(
      (provider) => provider.provider === globalModel?.provider,
    );
    const model = provider?.models.find(
      (model) => model.name === globalModel?.model,
    );
    return model;
  }, [providers, globalModel]);

  const supportedFileMimeTypes = modelInfo?.supportedFileMimeTypes;
  const canUploadImages =
    supportedFileMimeTypes?.some((mime) => mime.startsWith("image/")) ?? true;

  const mentions = useMemo<ChatMention[]>(() => {
    if (!threadId) return [];
    return threadMentions[threadId!] ?? [];
  }, [threadMentions, threadId]);

  const uploadedFiles = useMemo<UploadedFile[]>(() => {
    if (!threadId) return [];
    return threadFiles[threadId] ?? [];
  }, [threadFiles, threadId]);

  const imageToolModel = useMemo(() => {
    if (!threadId) return undefined;
    return threadImageToolModel[threadId];
  }, [threadImageToolModel, threadId]);

  const chatModel = useMemo(() => {
    return model ?? globalModel;
  }, [model, globalModel]);

  const editorRef = useRef<Editor | null>(null);

  const setChatModel = useCallback(
    (model: ChatModel) => {
      if (setModel) {
        setModel(model);
      } else {
        appStoreMutate({ chatModel: model });
      }
    },
    [setModel, appStoreMutate],
  );

  const deleteMention = useCallback(
    (mention: ChatMention) => {
      if (!threadId) return;
      appStoreMutate((prev) => {
        const newMentions = mentions.filter((m) => !equal(m, mention));
        return {
          threadMentions: {
            ...prev.threadMentions,
            [threadId!]: newMentions,
          },
        };
      });
    },
    [mentions, threadId],
  );

  const deleteFile = useCallback(
    (fileId: string) => {
      if (!threadId) return;

      // Find file and abort if uploading
      const file = uploadedFiles.find((f) => f.id === fileId);
      if (file?.isUploading && file.abortController) {
        file.abortController.abort();
      }

      // Cleanup preview URL if exists
      if (file?.previewUrl) {
        URL.revokeObjectURL(file.previewUrl);
      }

      appStoreMutate((prev) => {
        const newFiles = uploadedFiles.filter((f) => f.id !== fileId);
        return {
          threadFiles: {
            ...prev.threadFiles,
            [threadId]: newFiles,
          },
        };
      });
    },
    [uploadedFiles, threadId, appStoreMutate],
  );

  const summarizeFile = useCallback(
    async (fileId: string) => {
      const file = uploadedFiles.find((f) => f.id === fileId);
      const url = file?.url || file?.dataUrl;
      if (!url) {
        toast.error("No file URL available");
        return;
      }
      try {
        const res = await apiFetch("/api/storage/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          toast.error(e.error || "Failed to ingest file");
          return;
        }
        const data = await res.json();
        // Append preview text to input for the user to send
        setInput(`${input ? input + "\n\n" : ""}${data.text}`);
      } catch (_err) {
        toast.error("Failed to ingest file");
      }
    },
    [uploadedFiles, input],
  );

  // uploadFiles handled by hook

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const list = e.target.files;
      if (!list) return;
      await uploadFiles(Array.from(list));
      // Reset input
      if (fileInputRef.current) fileInputRef.current.value = "";
      setIsUploadDropdownOpen(false);
    },
    [uploadFiles],
  );

  // Pasted files go to the attachment tray on top of the input, never
  // inline into the editor. A native capture listener runs before the
  // editor's own paste handling, so preventing here reliably blocks the
  // inline insert. Plain text pastes are left alone.
  useEffect(() => {
    const box = composerBoxRef.current;
    if (!box) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = pastedFiles(e.clipboardData);
      if (files.length === 0 || !threadId) return;
      e.preventDefault();
      e.stopPropagation();
      void uploadFiles(files);
    };
    box.addEventListener("paste", onPaste, { capture: true });
    return () => box.removeEventListener("paste", onPaste, { capture: true });
  }, [uploadFiles, threadId]);

  const handleGenerateImage = useCallback(
    (provider?: "google" | "openai") => {
      if (!provider) {
        appStoreMutate({
          threadImageToolModel: {},
        });
      }
      if (!threadId) return;

      setIsUploadDropdownOpen(false);

      appStoreMutate((prev) => ({
        threadImageToolModel: {
          ...prev.threadImageToolModel,
          [threadId]: provider,
        },
      }));

      // Focus on the input
      editorRef.current?.commands.focus();
    },
    [threadId, editorRef],
  );

  const addMention = useCallback(
    (mention: ChatMention) => {
      if (!threadId) return;
      appStoreMutate((prev) => {
        if (mentions.some((m) => equal(m, mention))) return prev;

        return {
          threadMentions: {
            ...prev.threadMentions,
            [threadId!]: [...mentions, mention],
          },
        };
      });
    },
    [mentions, threadId],
  );

  const onSelectSkill = useCallback(
    (skill: { name: string; description?: string }) => {
      addMention({
        type: "skill",
        name: skill.name,
        description: skill.description,
      });
    },
    [addMention],
  );

  const onChangeMention = useCallback(
    (mentions: ChatMention[]) => {
      mentions.forEach(addMention);
    },
    [addMention],
  );

  const secretGuard = useComposerSecretGuard({ input, setInput });

  /**
   * Snapshot the current draft into attachment parts plus the file ids they
   * came from, so the queued message carries its files even if the user
   * keeps attaching afterwards, and the flush only clears those it parked.
   */
  const captureDraft = useCallback(
    (userMessage: string) => {
      const attachmentParts = buildAttachmentParts(
        uploadedFiles,
        supportedFileMimeTypes,
      );
      const textPart = { type: "text", text: userMessage } as const;
      return {
        attachmentParts,
        fileIds: uploadedFiles
          .filter((file) => file.url || file.dataUrl)
          .map((file) => file.id),
        parts:
          attachmentParts.length > 0
            ? [...attachmentParts, textPart]
            : [textPart],
      };
    },
    [uploadedFiles, supportedFileMimeTypes],
  );

  const clearParkedFiles = useCallback(
    (fileIds: string[]) => {
      if (fileIds.length === 0 || !threadId) return;
      const parked = new Set(fileIds);
      appStoreMutate((prev) => {
        const current = prev.threadFiles[threadId!] ?? [];
        if (!current.some((file) => parked.has(file.id))) return prev;
        return {
          threadFiles: {
            ...prev.threadFiles,
            [threadId!]: current.filter((file) => !parked.has(file.id)),
          },
        };
      });
    },
    [threadId, appStoreMutate],
  );

  const sendNow = useCallback(
    (draft: { parts: ComposerAttachmentPart[] }) => {
      sendMessage({
        role: "user",
        parts: draft.parts as Array<FileUIPart | TextUIPart | any>,
      });
    },
    [sendMessage],
  );

  const submit = (options?: { interrupt?: boolean }) => {
    if (hasUploadInProgress(uploadedFiles)) {
      toast.error("Please wait for files to finish uploading before sending.");
      return;
    }
    const userMessage = input?.trim() || "";
    if (userMessage.length === 0) return;

    // The secret guard decides before anything is parked or sent.
    if (!secretGuard.checkBeforeSend(userMessage)) {
      return;
    }

    // `/login` opens the local provider panel and never becomes a message,
    // even when typed mid-turn.
    if (isLoginCommand(userMessage)) {
      setInput("");
      sendMessage({
        role: "user",
        parts: [{ type: "text", text: userMessage }],
      });
      return;
    }

    if (isLoading) {
      // While the agent responds, Enter parks the draft as the next turn
      // and Cmd/Ctrl+Enter interrupts the live turn to send it at once.
      // Single slot: a newer follow-up replaces the older one.
      const draft = captureDraft(userMessage);
      const pending = createPendingFollowUp(
        options?.interrupt ? "interrupt" : "queued",
        userMessage,
        draft.attachmentParts,
        draft.fileIds,
        [...uploadedFiles],
      );
      setInput("");
      clearParkedFiles(draft.fileIds);
      if (options?.interrupt) {
        onInterruptAndSend?.(pending);
      } else {
        onQueueFollowUp?.(pending);
        toast.success(t("followUpQueued"));
      }
      return;
    }

    const draft = captureDraft(userMessage);
    setInput("");
    sendNow(draft);
    appStoreMutate((prev) => ({
      threadFiles: {
        ...prev.threadFiles,
        [threadId!]: [],
      },
    }));
  };

  const handleComposerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Cmd/Ctrl+Enter interrupts the live turn and sends the follow-up
      // immediately, Jcode-style. Plain Enter just queues it.
      if (
        isLoading &&
        (e.metaKey || e.ctrlKey) &&
        e.key === "Enter" &&
        !e.shiftKey
      ) {
        e.preventDefault();
        e.stopPropagation();
        submit({ interrupt: true });
      }
    },
    // submit is intentionally recreated per render so it sees fresh input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isLoading, input, uploadedFiles],
  );

  // Handle ESC key to clear mentions
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        threadId &&
        (mentions.length > 0 || imageToolModel)
      ) {
        e.preventDefault();
        e.stopPropagation();
        appStoreMutate(() => ({
          threadMentions: {},
          threadImageToolModel: {},
        }));
        editorRef.current?.commands.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mentions.length, threadId, appStoreMutate, imageToolModel]);

  // Drag overlay handled globally in ChatBot

  const queuedFileCount = pendingFollowUp
    ? countParkedFiles(pendingFollowUp.fileIds, uploadedFiles)
    : 0;

  return (
    <div
      className="max-w-3xl mx-auto fade-in animate-in"
      onKeyDownCapture={handleComposerKeyDown}
    >
      <div className="z-10 mx-auto w-full max-w-3xl relative">
        <fieldset className="flex w-full min-w-0 max-w-full flex-col px-4">
          <ComposerSecretNoticeBar
            matches={secretGuard.matches}
            composerInput={input}
            sendBlocked={secretGuard.sendBlocked}
            dismissed={secretGuard.dismissed}
            onDismiss={secretGuard.dismiss}
            onStoreSecurely={() => secretGuard.setDialogOpen(true)}
          />
          <StoreCredentialModal
            open={secretGuard.dialogOpen}
            onOpenChange={secretGuard.setDialogOpen}
            secret={secretGuard.matches[0] ?? null}
            composerInput={input}
            setInput={setInput}
          />

          <div
            ref={composerBoxRef}
            className="shadow-lg overflow-hidden rounded-4xl backdrop-blur-sm transition-all duration-200 bg-muted/60 relative flex w-full flex-col cursor-text z-10 items-stretch focus-within:bg-muted hover:bg-muted focus-within:ring-muted hover:ring-muted"
          >
            {pendingFollowUp ? (
              <div
                data-testid="queued-followup-chip"
                className="mx-2 mt-2 flex items-center gap-2 rounded-2xl border border-primary/30 bg-primary/10 px-3 py-2 text-left"
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <Clock className="size-3.5" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-xs font-semibold text-primary">
                    {pendingFollowUp.kind === "interrupt"
                      ? t("followUpInterrupting")
                      : t("followUpQueuedLabel")}
                  </span>
                  <span className="truncate text-sm text-foreground">
                    {previewQueuedText(pendingFollowUp.text)}
                    {queuedFileCount > 0
                      ? t("followUpQueuedFiles", {
                          count: queuedFileCount,
                        })
                      : null}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  data-testid="queued-followup-cancel"
                  className="size-6 shrink-0 rounded-full"
                  aria-label={t("followUpCancel")}
                  title={t("followUpCancel")}
                  onClick={() => onCancelFollowUp?.()}
                >
                  <XIcon className="size-3.5" />
                </Button>
              </div>
            ) : null}
            {mentions.length > 0 && (
              <div className="bg-input rounded-b-sm rounded-t-3xl p-3 flex flex-col gap-4 mx-2 my-2">
                {mentions.map((mention, i) => {
                  if (mention.type === "skill") {
                    return (
                      <div
                        key={`skill-${mention.name}-${i}`}
                        data-testid={`skill-chip-${mention.name}`}
                        className="flex items-center gap-2"
                      >
                        <div className="size-6 flex items-center justify-center ring ring-border rounded-full flex-shrink-0 p-0.5 bg-primary/10 text-primary">
                          <Sparkles className="size-3.5" />
                        </div>
                        <div className="flex flex-col flex-1 min-w-0">
                          <span className="text-sm font-semibold truncate">
                            {mention.name}
                          </span>
                          {mention.description ? (
                            <span className="text-muted-foreground text-xs truncate">
                              {mention.description}
                            </span>
                          ) : null}
                        </div>
                        <Button
                          variant={"ghost"}
                          size={"icon"}
                          disabled={!threadId}
                          data-testid={`skill-chip-remove-${mention.name}`}
                          className="rounded-full hover:bg-input! flex-shrink-0"
                          onClick={() => {
                            deleteMention(mention);
                          }}
                        >
                          <XIcon />
                        </Button>
                      </div>
                    );
                  }
                  return (
                    <div key={i} className="flex items-center gap-2">
                      <Button className="size-6 flex items-center justify-center ring ring-border rounded-full flex-shrink-0 p-0.5">
                        {mention.type == "mcpServer" ? (
                          <MCPIcon className="size-3.5" />
                        ) : (
                          <DefaultToolIcon
                            name={mention.name as DefaultToolName}
                            className="size-3.5"
                          />
                        )}
                      </Button>

                      <div className="flex flex-col flex-1 min-w-0">
                        <span className="text-sm font-semibold truncate">
                          {mention.name}
                        </span>
                        {mention.description ? (
                          <span className="text-muted-foreground text-xs truncate">
                            {mention.description}
                          </span>
                        ) : null}
                      </div>
                      <Button
                        variant={"ghost"}
                        size={"icon"}
                        disabled={!threadId}
                        className="rounded-full hover:bg-input! flex-shrink-0"
                        onClick={() => {
                          deleteMention(mention);
                        }}
                      >
                        <XIcon />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex flex-col gap-3.5 px-5 pt-2 pb-3">
              {/* Attachment tray - on top of the input */}
              {uploadedFiles.length > 0 && (
                <div
                  role="list"
                  aria-label="Attached files"
                  className="flex flex-wrap items-end gap-2 pt-1"
                >
                  {uploadedFiles.map((file) => (
                    <div key={file.id} role="listitem">
                      <AttachmentTile
                        file={file}
                        onRemove={deleteFile}
                        onSummarize={summarizeFile}
                        canSummarize={isIngestable(file.mimeType)}
                      />
                    </div>
                  ))}
                </div>
              )}
              <div className="relative min-h-[2rem]">
                <ChatMentionInput
                  input={input}
                  onChange={setInput}
                  onChangeMention={onChangeMention}
                  onEnter={submit}
                  placeholder={placeholder ?? t("placeholder")}
                  ref={editorRef}
                  disabledMention={disabledMention}
                  onFocus={onFocus}
                  onSelectSkill={onSelectSkill}
                  projectDirectory={projectDirectory}
                />
              </div>
              <div className="flex w-full items-center z-30">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,.pdf,.txt,.md,.csv,.json,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.rar,.7z,.tar,.gz,.mp3,.wav,.m4a,.ogg,.mp4,.webm,.mov"
                  multiple
                  className="hidden"
                  onChange={handleFileSelect}
                  disabled={!threadId}
                />

                <DropdownMenu
                  open={isUploadDropdownOpen}
                  onOpenChange={setIsUploadDropdownOpen}
                >
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant={"ghost"}
                      size={"sm"}
                      className="rounded-full hover:bg-input! p-2! data-[state=open]:bg-input!"
                      disabled={!threadId}
                      aria-label={t("uploadImage")}
                    >
                      <PlusIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" side="top">
                    <DropdownMenuItem
                      className="cursor-pointer"
                      disabled={
                        modelInfo?.isImageInputUnsupported || !canUploadImages
                      }
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <PaperclipIcon className="mr-2 size-4" />
                      {t("uploadImage")}
                    </DropdownMenuItem>

                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className="cursor-pointer">
                        <ImagesIcon className="mr-4 size-4 text-muted-foreground" />
                        <span className="mr-4">{t("generateImage")}</span>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuPortal>
                        <DropdownMenuSubContent>
                          <DropdownMenuItem
                            disabled={modelInfo?.isToolCallUnsupported}
                            onClick={() => handleGenerateImage("google")}
                            className="cursor-pointer"
                          >
                            <GeminiIcon className="mr-2 size-4" />
                            Gemini (Nano Banana)
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={modelInfo?.isToolCallUnsupported}
                            onClick={() => handleGenerateImage("openai")}
                            className="cursor-pointer"
                          >
                            <OpenAIIcon className="mr-2 size-4" />
                            OpenAI
                          </DropdownMenuItem>
                        </DropdownMenuSubContent>
                      </DropdownMenuPortal>
                    </DropdownMenuSub>
                  </DropdownMenuContent>
                </DropdownMenu>

                <div className="flex-1" />

                <SelectModel onSelect={setChatModel} currentModel={chatModel}>
                  <Button
                    variant={"ghost"}
                    size={"sm"}
                    className="rounded-full group data-[state=open]:bg-input! hover:bg-input! mr-1"
                    data-testid="model-selector-button"
                  >
                    {chatModel?.model ? (
                      <>
                        {chatModel.provider === "openai" ? (
                          <OpenAIIcon className="size-3 opacity-0 group-data-[state=open]:opacity-100 group-hover:opacity-100" />
                        ) : chatModel.provider === "xai" ? (
                          <GrokIcon className="size-3 opacity-0 group-data-[state=open]:opacity-100 group-hover:opacity-100" />
                        ) : chatModel.provider === "anthropic" ? (
                          <ClaudeIcon className="size-3 opacity-0 group-data-[state=open]:opacity-100 group-hover:opacity-100" />
                        ) : chatModel.provider === "google" ? (
                          <GeminiIcon className="size-3 opacity-0 group-data-[state=open]:opacity-100 group-hover:opacity-100" />
                        ) : null}
                        <span
                          className="text-foreground group-data-[state=open]:text-foreground"
                          data-testid="selected-model-name"
                        >
                          {chatModel.model}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">model</span>
                    )}

                    <ChevronDown className="size-3" />
                  </Button>
                </SelectModel>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      data-testid="composer-mic-button"
                      aria-label={
                        dictationState === "recording"
                          ? t("stopDictation")
                          : dictationState === "transcribing"
                            ? t("transcribingDictation")
                            : t("dictate")
                      }
                      variant="ghost"
                      size="sm"
                      onClick={handleToggleDictation}
                      className={cn(
                        "rounded-full p-2 mr-1 transition-colors",
                        dictationState === "recording" &&
                          "bg-destructive/15 text-destructive hover:bg-destructive/25 animate-pulse",
                      )}
                    >
                      {dictationState === "transcribing" ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : dictationState === "recording" ? (
                        <MicOff className="size-4 text-destructive" />
                      ) : (
                        <Mic className="size-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {dictationState === "recording"
                      ? t("stopDictation")
                      : dictationState === "transcribing"
                        ? t("transcribingDictation")
                        : t("dictate")}
                  </TooltipContent>
                </Tooltip>
                {!isLoading && !input.length && !voiceDisabled ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size={"sm"}
                        data-testid="composer-voice-mode-button"
                        aria-label={t("VoiceChat.title")}
                        onClick={() => {
                          const voice = useVoiceStore.getState();
                          if (liveVoiceActive) {
                            voice.setMinimized(!liveVoiceMinimized);
                          } else {
                            void voice.start(threadId ?? null);
                          }
                        }}
                        className={cn(
                          "rounded-full p-2!",
                          liveVoiceActive && "bg-primary text-primary-foreground",
                        )}
                      >
                        <AudioWaveformIcon size={16} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("VoiceChat.title")}</TooltipContent>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div
                        data-testid="chat-send-button"
                        onClick={() => {
                          if (isLoading) {
                            onStop();
                          } else {
                            submit();
                          }
                        }}
                        title={
                          isLoading ? t("followUpStopHint") : t("sendHint")
                        }
                        className="fade-in animate-in cursor-pointer text-muted-foreground rounded-full p-2 bg-secondary hover:bg-accent-foreground hover:text-accent transition-all duration-200"
                      >
                        {isLoading ? (
                          <Square
                            size={16}
                            className="fill-muted-foreground text-muted-foreground"
                          />
                        ) : (
                          <CornerRightUp size={16} />
                        )}
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
{isLoading ? t("followUpStopHint") : t("sendHint")}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>

            </div>

            {/* Sub-bar below composer with Project */}
            <div className="flex items-center justify-between px-3.5 py-1.5 border-t border-border/40 dark:border-white/[0.06] bg-background/40 dark:bg-white/[0.03] rounded-b-4xl transition-colors">
              <div className="flex items-center gap-1.5">
                <ProjectSelector />
              </div>
            </div>
          </div>
        </fieldset>
      </div>
    </div>
  );
}
