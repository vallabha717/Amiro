"use client";

import MCPEditor from "@/components/mcp-editor";
import { Alert } from "ui/alert";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import { fetcher } from "lib/utils";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import useSWR from "swr";

// Was mcp/modify/[id] -- flattened to a ?id= query param, see
// (chat)/page.tsx's doc comment for why.
function ModifyPageContent() {
  const id = useSearchParams().get("id");
  const t = useTranslations();
  const { data: mcpClient, isLoading } = useSWR(
    id ? `/api/mcp/servers/${id}` : null,
    fetcher,
  );

  return (
    <div className="container max-w-3xl mx-4 md:mx-auto py-8">
      <div className="flex flex-col gap-2">
        <Link
          href="/mcp"
          className="flex items-center gap-2 text-muted-foreground text-sm hover:text-foreground transition-colors mb-8"
        >
          <ArrowLeft className="size-3" />
          {t("Common.back")}
        </Link>
        <header>
          <h2 className="text-3xl font-semibold my-2">
            {t("MCP.mcpConfiguration")}
          </h2>
          <p className="text text-muted-foreground">
            {t("MCP.configureYourMcpServerConnectionSettings")}
          </p>
        </header>

        <main className="my-8">
          {mcpClient ? (
            <MCPEditor
              initialConfig={mcpClient.config}
              name={mcpClient.name}
              id={mcpClient.id}
            />
          ) : !isLoading ? (
            <Alert variant="destructive">MCP client not found</Alert>
          ) : null}
        </main>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ModifyPageContent />
    </Suspense>
  );
}
