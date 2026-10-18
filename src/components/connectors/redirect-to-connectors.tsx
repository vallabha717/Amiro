"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** MCP servers are connectors now: the old /mcp pages forward here. */
export function RedirectToConnectors() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/connectors");
  }, [router]);
  return null;
}
