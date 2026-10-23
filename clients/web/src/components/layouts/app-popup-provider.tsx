"use client";

import { appStore } from "@/app/store";
import { isShortcutEvent, Shortcuts } from "lib/keyboard-shortcuts";
import dynamic from "next/dynamic";
import { useEffect } from "react";

const KeyboardShortcutsPopup = dynamic(
  () =>
    import("@/components/keyboard-shortcuts-popup").then(
      (mod) => mod.KeyboardShortcutsPopup,
    ),
  {
    ssr: false,
  },
);

const ChatPreferencesPopup = dynamic(
  () =>
    import("@/components/chat-preferences-popup").then(
      (mod) => mod.ChatPreferencesPopup,
    ),
  {
    ssr: false,
  },
);

const VoiceHotkeys = dynamic(
  () => import("@/components/voice-room/voice-room").then((mod) => mod.VoiceHotkeys),
  {
    ssr: false,
  },
);

const ChatBotTemporary = dynamic(
  () =>
    import("@/components/chat-bot-temporary").then(
      (mod) => mod.ChatBotTemporary,
    ),
  {
    ssr: false,
  },
);

const McpCustomizationPopup = dynamic(
  () =>
    import("@/components/mcp-customization-popup").then(
      (mod) => mod.McpCustomizationPopup,
    ),
  {
    ssr: false,
  },
);

const UserSettingsPopup = dynamic(
  () =>
    import("@/components/user/user-detail/user-settings-popup").then(
      (mod) => mod.UserSettingsPopup,
    ),
  {
    ssr: false,
  },
);

export function AppPopupProvider({
  userSettingsComponent,
}: {
  userSettingsComponent: React.ReactNode;
}) {
  // The shortcuts dialog is loaded lazily, so its hotkey lives here: it must
  // work as soon as the page is interactive, not once the chunk has arrived.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isShortcutEvent(e, Shortcuts.openShortcutsPopup)) return;
      e.preventDefault();
      e.stopPropagation();
      appStore.getState().mutate((prev) => ({
        openShortcutsPopup: !prev.openShortcutsPopup,
      }));
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <>
      <KeyboardShortcutsPopup />
      <ChatPreferencesPopup />
      <UserSettingsPopup userSettingsComponent={userSettingsComponent} />
      <VoiceHotkeys />
      <ChatBotTemporary />
      <McpCustomizationPopup />
    </>
  );
}
