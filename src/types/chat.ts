import type { LanguageModelUsage, UIMessage } from "ai";
import { z } from "zod";
import { AllowedMCPServerZodSchema } from "./mcp";
import { UserPreferences } from "./user";

export type ChatMetadata = {
  usage?: LanguageModelUsage;
  chatModel?: ChatModel;
  toolChoice?: "auto" | "none" | "manual";
  toolCount?: number;
  /**
   * Milliseconds the turn spent working, summed across every round an
   * approval split it into and excluding the waits in between. Sent by the
   * server because a reopened thread has nothing to measure.
   */
  durationMs?: number;
};

export type ChatModel = {
  provider: string;
  model: string;
};

export const ChatAttachmentSchema = z.object({
  type: z.enum(["file", "source-url"]),
  url: z.string(),
  mediaType: z.string().optional(),
  filename: z.string().optional(),
});

export type ChatAttachment = z.infer<typeof ChatAttachmentSchema>;

export type ChatThread = {
  id: string;
  title: string;
  userId: string;
  createdAt: Date;
};

export type ChatMessage = {
  id: string;
  threadId: string;
  role: UIMessage["role"];
  parts: UIMessage["parts"];
  metadata?: ChatMetadata;
  createdAt: Date;
};

export const ChatMentionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mcpTool"),
    name: z.string(),
    description: z.string().optional(),
    serverName: z.string().optional(),
    serverId: z.string(),
  }),
  z.object({
    type: z.literal("defaultTool"),
    name: z.string(),
    label: z.string(),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("mcpServer"),
    name: z.string(),
    description: z.string().optional(),
    toolCount: z.number().optional(),
    serverId: z.string(),
  }),
  z.object({
    type: z.literal("workflow"),
    name: z.string(),
    description: z.string().nullish(),
    workflowId: z.string(),
    icon: z
      .object({
        type: z.literal("emoji"),
        value: z.string(),
        style: z.record(z.string(), z.string()).optional(),
      })
      .nullish(),
  }),
  z.object({
    type: z.literal("skill"),
    name: z.string(),
    description: z.string().optional(),
  }),
]);

export type ChatMention = z.infer<typeof ChatMentionSchema>;

export const chatApiSchemaRequestBodySchema = z.object({
  id: z.string(),
  message: z.any() as z.ZodType<UIMessage>,
  chatModel: z
    .object({
      provider: z.string(),
      model: z.string(),
    })
    .optional(),
  toolChoice: z.enum(["auto", "none", "manual"]),
  permissionMode: z
    .enum(["plan", "manual", "interactive", "edit", "auto"])
    .optional(),
  workspaceRoot: z.string().optional(),
  workingDir: z.string().optional(),
  projectDirectory: z.string().optional(),
  projectDir: z.string().optional(),
  mentions: z.array(ChatMentionSchema).optional(),
  imageTool: z.object({ model: z.string().optional() }).optional(),
  allowedMcpServers: z.record(z.string(), AllowedMCPServerZodSchema).optional(),
  allowedAppDefaultToolkit: z.array(z.string()).optional(),
  attachments: z.array(ChatAttachmentSchema).optional(),
});

export type ChatApiSchemaRequestBody = z.infer<
  typeof chatApiSchemaRequestBodySchema
>;

export type ChatRepository = {
  insertThread(thread: Omit<ChatThread, "createdAt">): Promise<ChatThread>;

  selectThread(id: string): Promise<ChatThread | null>;

  deleteChatMessage(id: string): Promise<void>;

  selectThreadDetails(id: string): Promise<
    | (ChatThread & {
        messages: ChatMessage[];
        userPreferences?: UserPreferences;
      })
    | null
  >;

  selectMessagesByThreadId(threadId: string): Promise<ChatMessage[]>;

  selectThreadsByUserId(userId: string): Promise<
    (ChatThread & {
      lastMessageAt: number;
    })[]
  >;

  updateThread(
    id: string,
    thread: Partial<Omit<ChatThread, "id" | "createdAt">>,
  ): Promise<ChatThread>;

  deleteThread(id: string): Promise<void>;

  upsertThread(
    thread: PartialBy<Omit<ChatThread, "createdAt">, "userId">,
  ): Promise<ChatThread>;

  insertMessage(message: Omit<ChatMessage, "createdAt">): Promise<ChatMessage>;
  upsertMessage(message: Omit<ChatMessage, "createdAt">): Promise<ChatMessage>;

  deleteMessagesByChatIdAfterTimestamp(messageId: string): Promise<void>;

  deleteAllThreads(userId: string): Promise<void>;

  deleteUnarchivedThreads(userId: string): Promise<void>;

  checkAccess(id: string, userId: string): Promise<boolean>;

  insertMessages(
    messages: PartialBy<ChatMessage, "createdAt">[],
  ): Promise<ChatMessage[]>;
};

/**
 * The answer to an approval prompt, sent back as a suspended tool call's
 * output. The backend recognizes the tag, runs (or refuses) the call for
 * real, and replaces this with the tool's actual result --
 * backend-go/internal/api/chat/approvals.go.
 *
 * `scope` distinguishes "yes, this once" from "yes, and stop asking". The
 * backend decides what "always" is scoped *to*: the exact command line for
 * a command-shaped call, otherwise the tool. It has to be that side's
 * choice, because it is the side that knows a tool's shape -- approving one
 * `go test` run must never widen into approving the shell.
 *
 * This does NOT go through lib/tag.ts's generic `tag()` helper -- that
 * helper's wire key is `__$ref__`, but the Go side of this contract
 * (approvals.go's `approvalAnswer.Tag`, `json:"__tag"`) and this file's own
 * `isApprovalAnswer` (tool-presenters/types.ts) both key off `__tag`. Using
 * `tag()` here silently produced `{__$ref__:"manual-tool-confirm",...}`,
 * which `parseApprovalAnswer` never recognizes -- an "Approve" click would
 * resubmit with the confirmation object itself read back as the tool's
 * result, not a real answer. `__tag` is used directly instead of fixing
 * `tag()`'s DEFAULT_KEY because that key is shared with
 * VercelAIWorkflowToolTag/VercelAIMcpToolTag, which have no such contract.
 */
export const ManualToolConfirmTag = {
  create: (data: { confirm: boolean; scope?: "once" | "always" }) => ({
    ...data,
    __tag: "manual-tool-confirm" as const,
  }),
};
