"use client";

import { getShortcutKeyList, Shortcuts } from "lib/keyboard-shortcuts";

import { Dialog, DialogContent } from "ui/dialog";
import { PopupShell } from "ui/popup-shell";
import { useTranslations } from "next-intl";
import { useShallow } from "zustand/shallow";
import { appStore } from "@/app/store";

export function KeyboardShortcutsPopup({}) {
  const [openShortcutsPopup, appStoreMutate] = appStore(
    useShallow((state) => [state.openShortcutsPopup, state.mutate]),
  );
  const t = useTranslations("KeyboardShortcuts");

  return (
    <Dialog
      open={openShortcutsPopup}
      onOpenChange={() =>
        appStoreMutate({ openShortcutsPopup: !openShortcutsPopup })
      }
    >
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden p-0 md:max-w-3xl">
        <PopupShell title={t("title")} bodyClassName="px-6">
          <div className="grid grid-cols-2 gap-5">
          {Object.entries(Shortcuts).map(([key, shortcut]) => (
            <div
              key={key}
              className="flex items-center gap-2 w-full text-sm px-2"
            >
              <p>{t(shortcut.description ?? "")}</p>
              <div className="flex-1" />
              {getShortcutKeyList(shortcut).map((key) => {
                return (
                  <div
                    key={key}
                    className="p-1.5 text-xs border min-w-8 min-h-8 flex items-center justify-center rounded-md bg-muted"
                  >
                    <span>{key}</span>
                  </div>
                );
              })}
            </div>
          ))}
          </div>
        </PopupShell>
      </DialogContent>
    </Dialog>
  );
}
