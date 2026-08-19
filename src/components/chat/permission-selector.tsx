"use client";

import { appStore } from "@/app/store";
import { useShallow } from "zustand/shallow";
import { useTranslations } from "next-intl";
import {
  Check,
  ChevronDown,
  Eye,
  FileEdit,
  Hand,
  Zap,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "ui/tooltip";
import { cn } from "lib/utils";
import { useMemo, useState } from "react";

export type PermissionModeOption = "auto" | "edit" | "manual" | "plan";

export function PermissionSelector({
  disabled,
  className,
}: {
  disabled?: boolean;
  className?: string;
}) {
  const t = useTranslations("Chat.Tool");
  const [permissionMode, appStoreMutate] = appStore(
    useShallow((state) => [state.permissionMode, state.mutate]),
  );
  const [open, setOpen] = useState(false);

  // Normalize mode
  const normalizedMode: PermissionModeOption = useMemo(() => {
    if (permissionMode === "auto") return "auto";
    if (permissionMode === "edit") return "edit";
    if (permissionMode === "plan") return "plan";
    return "manual";
  }, [permissionMode]);

  const modeConfigs = useMemo(
    () => [
      {
        mode: "auto" as const,
        label: t("autoPermissionMode") || "Auto",
        description:
          t("autoPermissionModeDescription") ||
          "Runs everything automatically without asking.",
        icon: Zap,
        iconColor: "text-amber-500 dark:text-amber-400",
        badgeBg: "bg-amber-500/10 dark:bg-amber-500/20 text-amber-600 dark:text-amber-300",
      },
      {
        mode: "edit" as const,
        label: t("editPermissionMode") || "Edit Automatically",
        description:
          t("editPermissionModeDescription") ||
          "Auto-edits & creates files; asks before terminal commands.",
        icon: FileEdit,
        iconColor: "text-blue-500 dark:text-blue-400",
        badgeBg: "bg-blue-500/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-300",
      },
      {
        mode: "manual" as const,
        label: t("manualPermissionMode") || "Manual",
        description:
          t("manualPermissionModeDescription") ||
          "Reads run freely; asks before file writes and commands.",
        icon: Hand,
        // Manual is the neutral default state, and emerald is already spoken
        // for by the project selector — keep it token-neutral in both the
        // trigger and the menu so the two never disagree.
        iconColor: "text-muted-foreground",
        badgeBg: "bg-muted-foreground/15 dark:bg-muted-foreground/20 text-muted-foreground",
      },
      {
        mode: "plan" as const,
        label: t("planMode") || "Plan",
        description:
          t("planModeDescription") ||
          "Read-only exploration. No file changes or commands.",
        icon: Eye,
        iconColor: "text-purple-500 dark:text-purple-400",
        badgeBg: "bg-purple-500/10 dark:bg-purple-500/20 text-purple-600 dark:text-purple-300",
      },
    ],
    [t],
  );

  const currentConfig = useMemo(
    () => modeConfigs.find((c) => c.mode === normalizedMode) || modeConfigs[2],
    [modeConfigs, normalizedMode],
  );

  const CurrentIcon = currentConfig.icon;

  const triggerColorClasses = useMemo(() => {
    switch (normalizedMode) {
      case "auto":
        return "text-amber-600 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 dark:bg-amber-500/15 dark:hover:bg-amber-500/25";
      case "edit":
        return "text-blue-600 dark:text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 dark:bg-blue-500/15 dark:hover:bg-blue-500/25";
      case "plan":
        return "text-purple-600 dark:text-purple-400 bg-purple-500/10 hover:bg-purple-500/20 dark:bg-purple-500/15 dark:hover:bg-purple-500/25";
      case "manual":
      default:
        return "text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-muted/80 dark:bg-white/5 dark:hover:bg-white/10";
    }
  }, [normalizedMode]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild disabled={disabled}>
            <button
              type="button"
              className={cn(
                "group inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-transparent",
                triggerColorClasses,
                open && "ring-1 ring-border/80 dark:ring-white/20",
                "active:scale-[0.97] transition-[color,background-color,transform] duration-120 ease-out outline-none select-none cursor-pointer",
                className,
              )}
            >
              <CurrentIcon className={cn("size-3.5 shrink-0", currentConfig.iconColor)} />
              <span>{currentConfig.label}</span>
              <ChevronDown className="size-3 shrink-0 opacity-60 transition-transform duration-150 group-data-[state=open]:rotate-180" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          <span>{currentConfig.description}</span>
        </TooltipContent>
      </Tooltip>

      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        className="w-72 p-1.5 rounded-xl bg-popover/85 supports-[backdrop-filter]:bg-popover/75 backdrop-blur-xl backdrop-saturate-150 reduce-transparency:bg-popover reduce-transparency:backdrop-blur-none border-border/70 shadow-xl shadow-black/5 dark:shadow-black/40"
      >
        <DropdownMenuLabel className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("permissionMode") || "Permission Mode"}
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="my-1 bg-border/60 dark:bg-white/10" />

        <DropdownMenuGroup className="space-y-0.5">
          {modeConfigs.map(({ mode, label, description, icon: Icon, iconColor, badgeBg }) => {
            const isSelected = normalizedMode === mode;
            return (
              <DropdownMenuItem
                key={mode}
                onClick={() =>
                  appStoreMutate({
                    permissionMode: mode,
                    // Remember what Plan is being entered *from*, so approving
                    // a plan can hand that mode back rather than pick one.
                    // Someone who works in Manual and drops into Plan to think
                    // should come back to Manual, not be silently promoted.
                    ...(mode === "plan" && permissionMode !== "plan"
                      ? { modeBeforePlan: permissionMode }
                      : {}),
                  })
                }
                className={cn(
                  "flex items-start gap-2.5 p-2 rounded-lg cursor-pointer transition-colors duration-100",
                  isSelected
                    ? "bg-accent/80 text-accent-foreground font-medium"
                    : "hover:bg-muted/60 dark:hover:bg-white/5",
                )}
              >
                <div
                  className={cn(
                    "p-1 rounded-md shrink-0 mt-0.5 flex items-center justify-center",
                    badgeBg,
                  )}
                >
                  <Icon className={cn("size-3.5", iconColor)} />
                </div>
                <div className="flex flex-col flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="text-xs font-medium leading-none text-foreground">
                      {label}
                    </span>
                    {isSelected && (
                      <Check className="size-3.5 text-primary shrink-0" />
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground line-clamp-2 mt-1 leading-snug font-normal">
                    {description}
                  </p>
                </div>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
