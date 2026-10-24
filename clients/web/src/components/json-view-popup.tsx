"use client";
import { useCopy } from "@/hooks/use-copy";
import { cn, isString } from "lib/utils";
import { Check, Copy } from "lucide-react";
import { ReactNode } from "react";
import { Button } from "ui/button";
import { Dialog, DialogContent, DialogTrigger } from "ui/dialog";
import JsonView from "ui/json-view";
import { PopupShell } from "ui/popup-shell";

export function JsonViewPopup({
  data,
  open,
  onOpenChange,
  children,
}: {
  data?: any;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}) {
  const { copied, copy } = useCopy();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        {children || (
          <Button
            variant={"ghost"}
            size={"sm"}
            className="text-muted-foreground text-xs"
          >
            JSON
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="flex max-h-[85vh] min-w-[40vw] max-w-[70vw] flex-col overflow-hidden p-0">
        <PopupShell
          title="JSON"
          headerExtra={
            <Button
              variant="ghost"
              size="icon"
              className={cn("size-3! p-4! absolute top-4 right-12")}
              onClick={() => copy(isString(data) ? data : JSON.stringify(data))}
              aria-label="Copy JSON"
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          }
        >
          <JsonView data={data} />
        </PopupShell>
      </DialogContent>
    </Dialog>
  );
}
