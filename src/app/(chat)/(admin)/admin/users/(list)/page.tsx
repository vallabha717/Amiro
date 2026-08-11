"use client";

import { Suspense, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "ui/table";
import { Badge } from "ui/badge";
import { Input } from "ui/input";
import { buttonVariants } from "ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "ui/avatar";
import { Search, ChevronRight, X } from "lucide-react";
import { SortableHeader } from "ui/sortable-header";
import { TablePagination } from "ui/table-pagination";
import { Skeleton } from "ui/skeleton";
import { fetcher, cn } from "lib/utils";
import { useDebounce } from "@/hooks/use-debounce";
import { useSession } from "@/lib/backend/session-context";

const DEFAULT_SORT_BY = "createdAt";
const DEFAULT_SORT_DIRECTION = "desc";
const LIMIT = 10;

// Was a Server Component (getAdminUsers + <UsersTable/>) driven by search
// params on the server; now a client component driving the same params
// (page/sortBy/sortDirection/query) through useSearchParams/useRouter --
// same URL-as-state model desktop's (chat)/agent page.tsx already uses --
// and fetching GET /api/admin/users (internal/api/admin, new: this backend
// had no admin subsystem at all until now).
type AdminUser = {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  role: string;
  banned?: boolean | null;
  createdAt: string;
};

function buildQueryUrl(params: {
  page: number;
  sortBy: string;
  sortDirection: "asc" | "desc";
  query?: string;
}) {
  const offset = (params.page - 1) * LIMIT;
  const search = new URLSearchParams();
  search.set("limit", String(LIMIT));
  search.set("offset", String(offset));
  search.set("sortBy", params.sortBy);
  search.set("sortDirection", params.sortDirection);
  if (params.query) search.set("q", params.query);
  return `/api/admin/users?${search.toString()}`;
}

function UsersListContent() {
  const t = useTranslations("Admin.Users");
  const tCommon = useTranslations("User.Profile.common");
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);
  const sortBy = searchParams.get("sortBy") ?? DEFAULT_SORT_BY;
  const sortDirection =
    (searchParams.get("sortDirection") as "asc" | "desc") ??
    DEFAULT_SORT_DIRECTION;
  const query = searchParams.get("query") ?? "";

  const buildUrl = useCallback(
    (params: {
      page?: number;
      sortBy?: string;
      sortDirection?: "asc" | "desc";
      query?: string;
    }) => {
      const search = new URLSearchParams();
      const finalPage = params.page ?? page;
      const finalSortBy = params.sortBy ?? sortBy;
      const finalSortDirection = params.sortDirection ?? sortDirection;
      const finalQuery = params.query ?? query;
      if (finalPage && finalPage !== 1) search.set("page", String(finalPage));
      if (finalSortBy && finalSortBy !== DEFAULT_SORT_BY)
        search.set("sortBy", finalSortBy);
      if (
        finalSortDirection &&
        finalSortDirection !== DEFAULT_SORT_DIRECTION
      )
        search.set("sortDirection", finalSortDirection);
      if (finalQuery) search.set("query", finalQuery);
      const qs = search.toString();
      return qs ? `/admin/users?${qs}` : "/admin/users";
    },
    [page, sortBy, sortDirection, query],
  );

  const handleSort = useCallback(
    (field: string) => {
      const newDirection =
        sortBy === field && sortDirection === "asc" ? "desc" : "asc";
      router.push(buildUrl({ sortBy: field, sortDirection: newDirection, page: 1 }));
    },
    [sortBy, sortDirection, router, buildUrl],
  );

  const submitSearch = useCallback(() => {
    formRef.current?.requestSubmit();
  }, []);
  const debouncedSubmit = useDebounce(submitSearch, 300);

  const { data, isLoading } = useSWR<{ users: AdminUser[]; total: number }>(
    buildQueryUrl({ page, sortBy, sortDirection, query }),
    fetcher,
  );

  const users = data?.users ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / LIMIT);
  const currentUserId = session?.user.id;

  return (
    <div className="space-y-4 w-full p-6" data-testid="admin-users-page">
      <div>
        <h1 className="text-2xl font-semibold">{t("allUsers")}</h1>
        <p className="text-muted-foreground text-sm">
          {t("viewAndManageUsers")}
        </p>
      </div>

      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-sm">
          <form
            ref={formRef}
            onSubmit={(e) => {
              e.preventDefault();
              router.push(
                buildUrl({ query: inputRef.current?.value ?? "", page: 1 }),
              );
            }}
          >
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              key={query || "empty"}
              placeholder={t("searchPlaceholder")}
              className="pl-9"
              defaultValue={query}
              onChange={debouncedSubmit}
              data-testid="users-search-input"
            />
          </form>
        </div>
        {(query ||
          sortBy !== DEFAULT_SORT_BY ||
          sortDirection !== DEFAULT_SORT_DIRECTION) && (
          <button
            type="button"
            onClick={() => router.push("/admin/users")}
            className={cn("shrink-0", buttonVariants({ variant: "outline" }))}
          >
            <X className="h-4 w-4 mr-1" />
            {t("clear")}
          </button>
        )}
        <div
          className="text-sm text-muted-foreground"
          data-testid="users-total-count"
        >
          {t("totalCount", { count: total })}
        </div>
      </div>

      <div className="rounded-lg border bg-card w-full overflow-x-auto">
        <Table data-testid="users-table" className="w-full">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <SortableHeader
                field="name"
                currentSortBy={sortBy}
                currentSortDirection={sortDirection}
                onSort={handleSort}
                data-testid="sort-header-name"
              >
                <span className="px-2">{t("user")}</span>
              </SortableHeader>
              <SortableHeader
                field="role"
                currentSortBy={sortBy}
                currentSortDirection={sortDirection}
                onSort={handleSort}
                data-testid="sort-header-role"
              >
                {t("role")}
              </SortableHeader>
              <TableHead className="font-semibold" data-testid="header-status">
                {t("status")}
              </TableHead>
              <SortableHeader
                field="createdAt"
                currentSortBy={sortBy}
                currentSortDirection={sortDirection}
                onSort={handleSort}
                data-testid="sort-header-createdAt"
              >
                {t("joined")}
              </SortableHeader>
              <TableHead className="w-[50px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5}>
                  <Skeleton className="h-8 w-full" />
                </TableCell>
              </TableRow>
            ) : users.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center py-8 text-muted-foreground"
                >
                  {t("noUsersFound")}
                </TableCell>
              </TableRow>
            ) : (
              users.map((u) => (
                <TableRow
                  key={u.id}
                  className="cursor-pointer hover:bg-muted/50 transition-colors"
                  onClick={() =>
                    router.push(`/admin/users/detail?id=${u.id}`)
                  }
                  data-testid={`user-row-${u.id}`}
                >
                  <TableCell>
                    <div className="flex items-center gap-3 px-2">
                      <Avatar className="size-8 rounded-full">
                        <AvatarImage src={u.image ?? undefined} />
                        <AvatarFallback className="text-sm">
                          {u.name.slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <div className="font-medium flex items-center gap-2">
                          {u.name}
                          {u.id === currentUserId && (
                            <Badge
                              variant="outline"
                              className="text-xs"
                              data-testid="current-user-badge"
                            >
                              {t("youBadge")}
                            </Badge>
                          )}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {u.email}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="text-xs">
                      {u.role}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={u.banned ? "destructive" : "secondary"}>
                      {u.banned ? tCommon("banned") : tCommon("active")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {format(new Date(u.createdAt), "MMM d, yyyy")}
                  </TableCell>
                  <TableCell>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <TablePagination
        currentPage={page}
        totalPages={totalPages}
        buildUrl={(p) => buildUrl({ page: p.page })}
      />
    </div>
  );
}

export default function UserListPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full m-6" />}>
      <UsersListContent />
    </Suspense>
  );
}
