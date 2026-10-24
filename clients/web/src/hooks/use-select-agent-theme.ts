"use client";

import { useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { toast } from "sonner";
import {
  AGENT_IDENTITY_KEY,
  updateAgentIdentity,
  useAgentIdentity,
} from "./queries/use-agent-identity";
import { useThemeStyle } from "./use-theme-style";
import { SIDEBAR_THEME_TO_COLOR } from "@/lib/agent/character-catalog";

/** Commit identity before applying a sidebar choice, never optimistically fight hydration. */
export function useSelectAgentTheme() {
  const { data: identity } = useAgentIdentity();
  const { mutate } = useSWRConfig();
  const { themeStyle, setThemeStyle } = useThemeStyle();
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);

  const selectTheme = async (theme: string) => {
    const color = SIDEBAR_THEME_TO_COLOR[theme];
    if (!identity || !color || pending.current) return;
    pending.current = true;
    setSaving(true);
    try {
      const saved = await updateAgentIdentity({
        traits: { ...identity.traits, color },
      });
      // Publish the PUT response and cancel older SWR reads before revalidation.
      await mutate(AGENT_IDENTITY_KEY, saved, { revalidate: false });
      setThemeStyle(theme);
      // A failed refresh must not turn a successful save into a failed choice.
      void mutate(AGENT_IDENTITY_KEY).catch(() => {});
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not save agent color.",
      );
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  return { themeStyle, selectTheme, disabled: !identity || saving };
}
