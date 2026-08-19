"use client";

import {
  Check,
  ChevronDown,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  KeySquare,
  Loader2,
  Search,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import useSWR, { mutate } from "swr";

import {
  SEARCH_CATALOG_KEY,
  SEARCH_PROVIDERS_KEY,
  type SearchProviderConfig,
  type SearchProviderSpec,
  saveSearchProvider,
  selectSearchCatalog,
} from "@/lib/backend/search-provider-api";
import { Button } from "ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import { Input } from "ui/input";
import { Label } from "ui/label";
import { handleErrorWithToast } from "ui/shared-toast";

export interface SearchProviderEditorProps {
  initialConfig?: SearchProviderConfig;
  templateProvider?: string;
}

/**
 * Create or edit one search provider.
 *
 * Every supported provider authenticates with an API key and nothing else,
 * so this form has exactly two fields. That is a consequence of the adapters
 * rather than a simplification: the base-URL field this form used to grow
 * for SearxNG went away with SearxNG itself, which was removed because
 * scraping a public instance from a server IP returns a bot challenge rather
 * than results.
 *
 * The provider list is fetched, never hardcoded. A second copy in the
 * frontend is a copy that goes stale silently -- which is how the picker
 * kept offering two providers whose adapters had been deleted.
 */
export default function SearchProviderEditor({
  initialConfig,
  templateProvider,
}: SearchProviderEditorProps) {
  const router = useRouter();
  const isNew = !initialConfig?.id;

  const { data: catalog = [] } = useSWR<SearchProviderSpec[]>(
    SEARCH_CATALOG_KEY,
    selectSearchCatalog,
  );

  const [isSaving, setIsSaving] = useState(false);
  const [revealKey, setRevealKey] = useState(false);
  const [name, setName] = useState(initialConfig?.name ?? "");
  const [providerType, setProviderType] = useState(
    initialConfig?.provider ?? templateProvider ?? "brave",
  );
  // Always starts empty, even when editing. The server never sends the
  // stored key, so there is nothing to prefill -- and an empty submission is
  // exactly how the editor says "leave the saved key alone".
  const [apiKey, setApiKey] = useState("");

  const selected = catalog.find((p) => p.kind === providerType);

  const handleSave = async () => {
    if (!name.trim()) return toast.error("Configuration name is required");
    if (isNew && !apiKey.trim()) return toast.error("An API key is required");

    setIsSaving(true);
    try {
      await saveSearchProvider({
        id: initialConfig?.id,
        name: name.trim(),
        provider: providerType,
        apiKey: apiKey.trim(),
      });
      await mutate(SEARCH_PROVIDERS_KEY);
      toast.success("Search provider saved");
      router.push("/admin/search");
    } catch (e) {
      handleErrorWithToast(e as Error);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex flex-col space-y-8 animate-in fade-in duration-500">
      <div className="space-y-2">
        <Label htmlFor="name" className="text-sm font-semibold">
          Configuration Name
        </Label>
        <Input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. My Primary Search"
          className="max-w-md bg-background/50 shadow-sm"
          data-testid="search-provider-name-input"
        />
        <p className="text-xs text-muted-foreground">
          A human-readable name for this search configuration.
        </p>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-semibold">Search Provider Engine</Label>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="w-full max-w-md justify-between bg-background/50 cursor-pointer"
              disabled={!isNew}
              data-testid="search-provider-type-trigger"
            >
              <div className="flex items-center gap-2">
                <Search className="size-4 text-primary" />
                <span>{selected?.label ?? providerType}</span>
              </div>
              {isNew && (
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  Change
                  <ChevronDown className="size-3.5" />
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
          {isNew && (
            <DropdownMenuContent className="w-[360px]">
              {catalog.map((p) => (
                <DropdownMenuItem
                  key={p.kind}
                  onClick={() => setProviderType(p.kind)}
                  className="cursor-pointer items-start gap-2 py-2"
                >
                  <Search className="size-4 mt-0.5 text-primary shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{p.label}</p>
                    {/* The free tier, shown at the moment of choosing. It is
                        the deciding factor for most people and it should not
                        require opening four pricing pages to compare. */}
                    <p className="text-xs text-muted-foreground">
                      {p.freeTier}
                    </p>
                  </div>
                  {providerType === p.kind && (
                    <Check className="ml-auto mt-0.5 size-4 shrink-0" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          )}
        </DropdownMenu>

        {selected && (
          <div className="max-w-md space-y-1 pt-1">
            {/* Stated here rather than discovered when a tool call fails:
                choosing a links-only provider turns the web_content tool
                off, and that is a consequence of this dropdown. */}
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <FileText className="size-3.5 shrink-0" />
              {selected.extracts
                ? "Can extract full page content, so the agent can read pages it finds."
                : "Returns links and snippets only. The agent will fall back to fetching pages directly."}
            </p>
            <a
              href={selected.docs}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
            >
              Get an API key
              <ExternalLink className="size-3" />
            </a>
          </div>
        )}
      </div>

      <div className="space-y-2 max-w-md">
        <Label
          htmlFor="api-key"
          className="flex items-center gap-2 font-medium"
        >
          <KeySquare className="w-4 h-4 text-primary" /> API Key
        </Label>
        <div className="relative">
          <Input
            id="api-key"
            type={revealKey ? "text" : "password"}
            placeholder={
              isNew ? "Enter API key" : "Leave blank to keep the saved key"
            }
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="bg-background/50 shadow-sm pr-10"
            autoComplete="off"
            data-testid="search-provider-key-input"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 -translate-y-1/2 size-7 text-muted-foreground hover:text-foreground cursor-pointer"
            onClick={() => setRevealKey((v) => !v)}
            aria-label={revealKey ? "Hide API key" : "Show API key"}
          >
            {revealKey ? (
              <EyeOff className="size-4" />
            ) : (
              <Eye className="size-4" />
            )}
          </Button>
        </div>
        {!isNew && (
          <p className="text-xs text-muted-foreground">
            {/* Says why the field is empty. Without this it reads as the app
                having lost the key. */}
            Saved keys are never sent back to the browser. Leave this blank to
            keep the current one, or type a new key to replace it.
          </p>
        )}
      </div>

      <div className="flex justify-end gap-3 border-t pt-6">
        <Button
          variant="ghost"
          onClick={() => router.push("/admin/search")}
          className="font-semibold cursor-pointer"
        >
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          disabled={isSaving || !name.trim()}
          className="min-w-[120px] font-bold shadow-md cursor-pointer"
          data-testid="search-provider-save-button"
        >
          {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save Configuration
        </Button>
      </div>
    </div>
  );
}
