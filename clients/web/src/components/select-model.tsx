"use client";

import { appStore } from "@/app/store";
import { useChatModels } from "@/hooks/queries/use-chat-models";
import { ChatModel } from "app-types/chat";
import { cn } from "lib/utils";
import { BlendIcon, CheckIcon, ChevronDown } from "lucide-react";
import { Fragment, memo, PropsWithChildren, useEffect, useState } from "react";
import { Button } from "ui/button";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "ui/command";
import { ModelProviderIcon } from "ui/model-provider-icon";
import { Popover, PopoverContent, PopoverTrigger } from "ui/popover";

interface SelectModelProps {
  onSelect: (model: ChatModel) => void;
  align?: "start" | "end";
  currentModel?: ChatModel;
  showProvider?: boolean;
}

function SafeModelProviderIcon({
  provider,
  className,
}: {
  provider?: string | null;
  className?: string;
}) {
  try {
    const p = String(provider || "").trim().toLowerCase();
    return <ModelProviderIcon provider={p} className={className} />;
  } catch {
    return <BlendIcon className={className} />;
  }
}

export const SelectModel = (props: PropsWithChildren<SelectModelProps>) => {
  const [open, setOpen] = useState(false);
  const { data: providers } = useChatModels();
  const [model, setModel] = useState(props.currentModel);

  useEffect(() => {
    const modelToUse = props.currentModel ?? appStore.getState().chatModel;

    if (modelToUse) {
      setModel(modelToUse);
    }
  }, [props.currentModel]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {props.children || (
          <Button
            variant={"secondary"}
            size={"sm"}
            className="data-[state=open]:bg-input! hover:bg-input! h-8 max-w-[200px]"
            data-testid="model-selector-button"
          >
            <div className="mr-auto flex items-center gap-1 min-w-0">
              {(props.showProvider ?? true) && (
                <SafeModelProviderIcon
                  provider={
                    providers?.find((p) => p.provider === model?.provider)?.providerType ||
                    model?.provider ||
                    ""
                  }
                  className="size-2.5 mr-1 shrink-0"
                />
              )}
              <p data-testid="selected-model-name" className="truncate text-xs font-medium">
                {model?.model || "model"}
              </p>
            </div>
            <ChevronDown className="size-3 shrink-0 ml-1 opacity-50" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        className="p-0 w-[300px] sm:w-[320px]"
        align={props.align || "end"}
        data-testid="model-selector-popover"
      >
        <Command
          className="rounded-lg relative shadow-md h-80"
          onClick={(e) => e.stopPropagation()}
        >
          <CommandInput
            placeholder="search model..."
            data-testid="model-search-input"
          />
          <CommandList className="p-2 max-h-72 overflow-y-auto">
            <CommandEmpty>No results found.</CommandEmpty>
            {providers?.map((provider, i) => (
              <Fragment key={provider.provider}>
                <CommandGroup
                  heading={
                    <ProviderHeader
                      providerName={provider.providerName || provider.provider}
                      providerKey={provider.providerType || provider.provider}
                      hasAPIKey={provider.hasAPIKey}
                    />
                  }
                  className={cn(
                    "pb-3 group",
                    !provider.hasAPIKey && "opacity-50",
                  )}
                  onWheel={(e) => {
                    e.stopPropagation();
                  }}
                  data-testid={`model-provider-${provider.provider}`}
                >
                  {provider.models.map((item) => (
                    <CommandItem
                      key={`${provider.provider}:${item.name}`}
                      disabled={!provider.hasAPIKey}
                      className="cursor-pointer"
                      onSelect={() => {
                        setModel({
                          provider: provider.provider,
                          model: item.name,
                        });
                        props.onSelect({
                          provider: provider.provider,
                          model: item.name,
                        });
                        setOpen(false);
                      }}
                      value={`${provider.providerName || provider.provider} ${provider.provider} ${item.name}`}
                      data-testid={`model-option-${provider.provider}-${item.name}`}
                    >
                      {model?.provider === provider.provider &&
                      model?.model === item.name ? (
                        <CheckIcon
                          className="size-3 shrink-0"
                          data-testid="selected-model-check"
                        />
                      ) : (
                        <div className="ml-3 shrink-0" />
                      )}
                      <span className="pr-2 truncate">{item.name}</span>
                      {item.isToolCallUnsupported && (
                        <div className="ml-auto flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                          No tools
                        </div>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
                {i < providers.length - 1 && <CommandSeparator />}
              </Fragment>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

const ProviderHeader = memo(function ProviderHeader({
  providerName,
  providerKey,
  hasAPIKey,
}: { providerName: string; providerKey: string; hasAPIKey: boolean }) {
  return (
    <div className="text-sm text-muted-foreground flex items-center gap-1.5 group-hover:text-foreground transition-colors duration-300">
      <SafeModelProviderIcon
        provider={providerKey}
        className="size-3 text-foreground shrink-0"
      />
      <span className="truncate">{providerName}</span>
      {!hasAPIKey && (
        <span className="text-xs ml-auto text-muted-foreground shrink-0">
          No API Key
        </span>
      )}
    </div>
  );
});
