"use client";

import {
  ToolNodeData,
  UINode,
  WorkflowToolKey,
} from "lib/ai/workflow/workflow.interface";
import { InfoIcon, VariableIcon, WrenchIcon } from "lucide-react";
import { memo, useEffect, useMemo } from "react";

import { appStore } from "@/app/store";
import { useEdges, useNodes, useReactFlow } from "@xyflow/react";

import { useWorkflowStore } from "@/app/store/workflow.store";
import { SelectModel } from "@/components/select-model";
import {
  getToolPresenter,
  statusFromNodeHistory,
  toolGlance,
} from "@/components/tool-presenters";
import { useMcpList } from "@/hooks/queries/use-mcp-list";
import { isString, toAny } from "lib/utils";
import { useTranslations } from "next-intl";
import { MCPIcon } from "ui/mcp-icon";
import { Separator } from "ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "ui/tooltip";
import { OutputSchemaMentionInput } from "../output-schema-mention-input";
import { WorkflowToolSelect } from "../workflow-tool-select";

import { DefaultToolName } from "lib/ai/tools";
import {
  exaContentsSchema,
  exaContentsTool,
  exaSearchSchema,
  exaSearchTool,
} from "lib/ai/tools/web/web-search";

export const ToolNodeDataConfig = memo(function ({
  data,
}: {
  data: ToolNodeData;
}) {
  const t = useTranslations();
  const { updateNodeData } = useReactFlow();
  const nodes = useNodes() as UINode[];
  const edges = useEdges();
  const editable = useWorkflowStore((state) => {
    return (
      state.processIds.length === 0 &&
      state.hasEditAccess &&
      !state.workflow?.isPublished
    );
  });

  const { data: mcpList } = useMcpList();

  const toolList = useMemo<WorkflowToolKey[]>(() => {
    const mcpTools: WorkflowToolKey[] = (mcpList || []).flatMap((mcp) => {
      return mcp.toolInfo.map((tool) => {
        return {
          type: "mcp-tool",
          serverId: mcp.id,
          serverName: mcp.name,
          id: tool.name,
          description: tool.description,
          parameterSchema: tool.inputSchema,
        };
      });
    });
    const defaultTools: WorkflowToolKey[] = [
      {
        type: "app-tool",
        id: DefaultToolName.WebSearch,
        description: exaSearchTool.description!,
        parameterSchema: exaSearchSchema,
      },
      {
        type: "app-tool",
        id: DefaultToolName.WebContent,
        description: exaContentsTool.description!,
        parameterSchema: exaContentsSchema,
      },
    ];
    return [...mcpTools, ...defaultTools];
  }, [mcpList]);

  useEffect(() => {
    if (!data.model) {
      updateNodeData(data.id, {
        model: appStore.getState().chatModel!,
      });
    }
  }, []);

  return (
    <div className="flex flex-col gap-2 text-sm px-4">
      <p className="text-sm font-semibold">{t("Common.tool")}</p>
      <WorkflowToolSelect
        tools={toolList}
        onChange={(tool) => {
          updateNodeData(data.id, { tool });
        }}
        tool={data.tool}
      />
      <p className="text-sm font-semibold my-2">
        {t("Workflow.descriptionAndSchema")}
      </p>
      {data.tool?.description ||
      Object.keys(data.tool?.parameterSchema?.properties || {}).length > 0 ? (
        <div className="text-xs p-2 bg-background border rounded-md">
          <p>{data.tool?.description}</p>
          {Object.keys(data.tool?.parameterSchema?.properties || {}).length >
            0 && (
            <div className="flex items-center flex-wrap gap-1 mt-2">
              {Object.keys(data.tool?.parameterSchema?.properties || {}).map(
                (key) => {
                  const isRequired =
                    data.tool?.parameterSchema?.required?.includes(key);
                  return (
                    <div
                      key={key}
                      className="mb-0.5 flex items-center text-xs px-1.5 py-0.5 bg-secondary rounded-md"
                    >
                      <VariableIcon className="size-3.5 text-blue-500" />
                      {isRequired && (
                        <span className="text-destructive">*</span>
                      )}
                      <span className="font-semibold">{key}</span>

                      <span className="text-muted-foreground ml-2">
                        {isString(data.tool?.parameterSchema?.properties?.[key])
                          ? data.tool?.parameterSchema?.properties?.[key]
                          : toAny(data.tool?.parameterSchema?.properties?.[key])
                              ?.type || "unknown"}
                      </span>
                    </div>
                  );
                },
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground text-center py-2 border rounded-md">
          {t("Workflow.noDescriptionAndSchema")}
        </div>
      )}

      <Separator className="my-4" />
      <div className="flex items-center gap-2">
        <p className="text-sm font-semibold my-2">Message</p>
        <SelectModel
          currentModel={data.model}
          onSelect={(model) => {
            updateNodeData(data.id, {
              model,
            });
          }}
        />

        <Tooltip>
          <TooltipTrigger asChild>
            <div className="p-1 hover:bg-secondary rounded cursor-pointer">
              <InfoIcon className="size-3" />
            </div>
          </TooltipTrigger>
          <TooltipContent className="p-4 whitespace-pre-wrap">
            {t("Workflow.toolDescription")}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="w-full bg-secondary rounded-md p-2 min-h-20">
        <OutputSchemaMentionInput
          currentNodeId={data.id}
          nodes={nodes}
          edges={edges}
          content={data.message}
          editable={editable}
          onChange={(content) => {
            updateNodeData(data.id, {
              message: content,
            });
          }}
        />
      </div>
    </div>
  );
});
ToolNodeDataConfig.displayName = "ToolNodeDataConfig";

export const ToolNodeStack = memo(function ({ data }: { data: ToolNodeData }) {
  const t = useTranslations();
  const selectedToolLabel = useMemo(() => {
    if (!data.tool)
      return (
        <>
          <WrenchIcon className="size-3" />
          <span className="text-muted-foreground">
            {t("Common.selectTool")}
          </span>
        </>
      );
    if (data.tool.type == "mcp-tool") {
      return (
        <>
          <MCPIcon className="size-3" />
          <span className="font-bold">{data.tool.serverName}</span>
          <div className="bg-primary text-primary-foreground px-2 rounded-md truncate">
            {data.tool.id}
          </div>
        </>
      );
    }
    return (
      <>
        <WrenchIcon className="size-3" />
        <span className="font-semibold truncate">{data.tool.id}</span>
      </>
    );
  }, [data.tool]);
  // Once the node has actually run, the useful thing to show on its face is
  // what the tool *did* -- "src/lib/utils.ts . 120 lines" -- not which tool
  // it is. Before Phase 2 every tool node looked identical here regardless
  // of what it had done, which made a canvas of ten nodes unreadable.
  const glance = useMemo(() => {
    const toolId = data.tool?.id;
    if (!toolId || !getToolPresenter(toolId)) return null;
    const runtime = data as unknown as {
      status?: string;
      error?: unknown;
      result?: { input?: unknown; output?: unknown };
    };
    if (!runtime.status) return null;
    return toolGlance(toolId, {
      input: runtime.result?.input,
      output: runtime.result?.output,
      status: statusFromNodeHistory(runtime),
    });
  }, [data]);

  return (
    <div className="flex flex-col gap-1 px-4 mt-4">
      {!data.tool ? (
        <div className="text-xs text-muted-foreground text-center py-2 border rounded-md">
          {t("Common.noResults")}
        </div>
      ) : (
        <div className="border bg-input text-[10px] rounded px-2 py-1 flex items-center gap-1">
          {selectedToolLabel}
        </div>
      )}
      {glance ? (
        <div className="text-[10px] text-muted-foreground truncate px-0.5">
          {glance}
        </div>
      ) : null}
    </div>
  );
});
ToolNodeStack.displayName = "ToolNodeStack";
