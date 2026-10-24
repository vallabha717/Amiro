import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Loader2, Search, User } from "lucide-react";
import { getChannelLabel } from "@/components/channels/channel-presentation";
import type { ContactPayload } from "@/lib/backend/contacts-api";

export interface ContactsListProps {
  contacts: ContactPayload[];
  guardian: ContactPayload | null;
  regularContacts: ContactPayload[];
  selectedId: string | null;
  search: string;
  loading?: boolean;
  onSearchChange: (val: string) => void;
  onSelect: (id: string) => void;
  searchPlaceholder?: string;
  noMatchesText?: string;
  youText?: string;
  roleGuardianText?: string;
  noChannelsText?: string;
  verifiedText?: string;
}

/**
 * Left-rail contacts list modeled on Vellum's ContactsList.
 * Shows Guardian pinned at top, search box, and contact items with badges.
 */
export function ContactsList({
  contacts: _contacts,
  guardian,
  regularContacts,
  selectedId,
  search,
  loading = false,
  onSearchChange,
  onSelect,
  searchPlaceholder = "Search contacts...",
  noMatchesText = "No matching contacts",
  youText = "You",
  roleGuardianText = "Guardian",
  noChannelsText = "No accounts linked",
  verifiedText = "Verified",
}: ContactsListProps) {
  const filtered = search.trim()
    ? regularContacts.filter((c) =>
        c.displayName.toLowerCase().includes(search.trim().toLowerCase()) ||
        c.channels.some((ch) => ch.address.toLowerCase().includes(search.trim().toLowerCase())),
      )
    : regularContacts;

  return (
    <Card className="gap-2.5 py-3 shadow-xs">
      <CardHeader className="px-3 py-1">
        <div className="relative">
          <Search className="absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
          <Input
            placeholder={searchPlaceholder}
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-8 pl-7 text-xs"
            data-testid="contact-search-input"
          />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 px-2 py-0">
        {loading ? (
          <div className="flex items-center justify-center p-6 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : (
          <>
            {/* Guardian item */}
            {guardian && (
              <button
                type="button"
                onClick={() => onSelect(guardian.id)}
                data-testid={`contact-row-${guardian.id}`}
                className={`group flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left transition-colors ${
                  selectedId === guardian.id
                    ? "bg-accent text-accent-foreground font-medium"
                    : "hover:bg-accent/60 text-muted-foreground hover:text-foreground"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <User className="size-3.5" />
                  </div>
                  <div className="flex flex-col leading-tight">
                    <span className="text-xs font-semibold text-foreground">
                      {guardian.displayName} ({youText})
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {roleGuardianText}
                    </span>
                  </div>
                </div>
              </button>
            )}

            {guardian && regularContacts.length > 0 && (
              <div className="my-1 border-t border-border/60" />
            )}

            {/* Regular contacts list */}
            {filtered.length === 0 ? (
              <p className="p-3 text-center text-[11px] text-muted-foreground">
                {noMatchesText}
              </p>
            ) : (
              filtered.map((c) => {
                const isSelected = selectedId === c.id;
                const verified = c.channels.some(
                  (ch) => ch.status === "active" || ch.status === "verified",
                );

                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => onSelect(c.id)}
                    data-testid={`contact-row-${c.id}`}
                    className={`group flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left transition-colors ${
                      isSelected
                        ? "bg-accent text-accent-foreground font-medium"
                        : "hover:bg-accent/60 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground">
                        {c.displayName.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex min-w-0 flex-col leading-tight">
                        <span className="truncate text-xs font-medium text-foreground">
                          {c.displayName}
                        </span>
                        <span className="truncate text-[10px] text-muted-foreground">
                          {c.channels.length > 0
                            ? c.channels.map((ch) => getChannelLabel(ch.type)).join(", ")
                            : noChannelsText}
                        </span>
                      </div>
                    </div>
                    {verified ? (
                      <Badge
                        variant="outline"
                        className="border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary"
                      >
                        {verifiedText}
                      </Badge>
                    ) : null}
                  </button>
                );
              })
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
