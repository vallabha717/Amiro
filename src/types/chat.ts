import type { LanguageModelUsage, UIMessage } from "ai";
import { z } from "zod";
import { AllowedMCPServerZodSchema } from "./mcp";
import { UserPreferences } from "./user";
import { tag } from "lib/tag";

export type ChatMetadata = {
  usage?: LanguageModelUsage;
  chatModel?: ChatModel;
  toolChoice?: "auto" | "none" | "manual";
  toolCount?: number;
  agentId?: string;
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
    type: z.literal("agent"),
    name: z.string(),
    description: z.string().nullish(),
    agentId: z.string(),
    icon: z
      .object({
        type: z.literal("emoji"),
        value: z.string(),
        style: z.record(z.string(), z.string()).optional(),
      })
      .nullish(),
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
 */
export const ManualToolConfirmTag = tag<{
  confirm: boolean;
  scope?: "once" | "always";
}>("manual-tool-confirm");
