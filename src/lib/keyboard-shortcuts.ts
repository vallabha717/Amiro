"use client";

/**
 * Where an action exists in both, the default matches jcode (the runtime's
 * terminal UI): Alt+M side panel, Ctrl+Space voice, Alt+Y copy, Alt+I info
 * panel, Ctrl+[ / Ctrl+] previous / next prompt. Terminal-only jcode keys that
 * browsers reserve (Ctrl+Tab, Alt+Left/Right) are deliberately not mapped.
 */
export type Shortcut = {
  description?: string;
  shortcut: {
    key?: string;
    /** Physical key (KeyboardEvent.code), for Alt chords: on macOS Option
     * changes `event.key` (Option+M types "µ"). */
    code?: string;
    shift?: boolean;
    /** ⌘ on macOS, Ctrl elsewhere. */
    command?: boolean;
    /** The Control key itself, on every platform. */
    ctrl?: boolean;
    alt?: boolean;
    backspace?: boolean;
  };
};

const openNewChatShortcut: Shortcut = {
  description: "newChat",
  shortcut: {
    key: "O",
    shift: true,
    command: true,
  },
};

const toggleTemporaryChatShortcut: Shortcut = {
  description: "toggleTemporaryChat",
  shortcut: {
    key: "K",
    command: true,
  },
};

// jcode: voice_input = "ctrl+space"
const toggleVoiceChatShortcut: Shortcut = {
  description: "toggleVoiceChat",
  shortcut: {
    key: " ",
    code: "Space",
    ctrl: true,
  },
};

// jcode: side_panel_toggle = "alt+m"
const toggleSidebarShortcut: Shortcut = {
  description: "toggleSidebar",
  shortcut: {
    key: "M",
    code: "KeyM",
    alt: true,
  },
};

// jcode: info_widget_toggle = "alt+i"
const toggleSessionPanelShortcut: Shortcut = {
  description: "toggleSessionPanel",
  shortcut: {
    key: "I",
    code: "KeyI",
    alt: true,
  },
};

// jcode: scroll_prompt_up = "ctrl+[" / scroll_prompt_down = "ctrl+]"
const previousPromptShortcut: Shortcut = {
  description: "previousPrompt",
  shortcut: {
    key: "[",
    code: "BracketLeft",
    ctrl: true,
  },
};

const nextPromptShortcut: Shortcut = {
  description: "nextPrompt",
  shortcut: {
    key: "]",
    code: "BracketRight",
    ctrl: true,
  },
};

const toolModeShortcut: Shortcut = {
  description: "toolMode",
  shortcut: {
    key: "P",
    command: true,
  },
};

// jcode: copy_selection_toggle = "alt+y"
const lastMessageCopyShortcut: Shortcut = {
  description: "lastMessageCopy",
  shortcut: {
    key: "Y",
    code: "KeyY",
    alt: true,
  },
};

const openChatPreferencesShortcut: Shortcut = {
  description: "openChatPreferences",
  shortcut: {
    key: "L",
    command: true,
    shift: true,
  },
};

const deleteThreadShortcut: Shortcut = {
  description: "deleteThread",
  shortcut: {
    backspace: true,
    shift: true,
  },
};

const openShortcutsPopupShortcut: Shortcut = {
  description: "openShortcutsPopup",
  shortcut: {
    key: "/",
    command: true,
  },
};

const sendFollowUpNowShortcut: Shortcut = {
  description: "sendFollowUpNow",
  shortcut: {
    key: "Enter",
    command: true,
  },
};

export const Shortcuts = {
  openNewChat: openNewChatShortcut,
  openChatPreferences: openChatPreferencesShortcut,
  toggleTemporaryChat: toggleTemporaryChatShortcut,
  toggleVoiceChat: toggleVoiceChatShortcut,
  toggleSidebar: toggleSidebarShortcut,
  toggleSessionPanel: toggleSessionPanelShortcut,
  previousPrompt: previousPromptShortcut,
  nextPrompt: nextPromptShortcut,
  lastMessageCopy: lastMessageCopyShortcut,
  deleteThread: deleteThreadShortcut,
  toolMode: toolModeShortcut,
  openShortcutsPopup: openShortcutsPopupShortcut,
  sendFollowUpNow: sendFollowUpNowShortcut,
};

const isMac = () =>
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export const isShortcutEvent = (
  event: KeyboardEvent,
  { shortcut }: Shortcut,
) => {
  if (shortcut.command && !event.metaKey && !event.ctrlKey) return false;
  if (shortcut.ctrl && !event.ctrlKey) return false;
  // Alt must match exactly: plain chords must not fire while Alt is held, and
  // Alt chords must not fire without it.
  if (!!shortcut.alt !== event.altKey) return false;
  // A Ctrl/Alt chord must not also fire for ⌘ combinations.
  if ((shortcut.ctrl || shortcut.alt) && !shortcut.command && event.metaKey)
    return false;

  if (shortcut.shift && !event.shiftKey) return false;

  if (shortcut.code) {
    if (event.code !== shortcut.code) return false;
  } else if (
    shortcut.key &&
    shortcut.key?.toLowerCase() !== event.key?.toLowerCase()
  )
    return false;

  if (shortcut.backspace && event.key?.toLowerCase() !== "backspace")
    return false;

  return true;
};
export const getShortcutKeyList = ({ shortcut }: Shortcut): string[] => {
  const mac = isMac();
  const keys: string[] = [];
  if (shortcut.ctrl) {
    keys.push(mac ? "⌃" : "Ctrl");
  }
  if (shortcut.command) {
    keys.push(mac ? "⌘" : "Ctrl");
  }
  if (shortcut.alt) {
    keys.push(mac ? "⌥" : "Alt");
  }
  if (shortcut.shift) {
    keys.push("⇧");
  }
  if (shortcut.key) {
    keys.push(shortcut.key === " " ? "Space" : shortcut.key);
  }
  if (shortcut.backspace) {
    keys.push("⌫");
  }
  return keys;
};
