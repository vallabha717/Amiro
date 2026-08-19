"use client";

import { Suspense, useState, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { TrendingUp, ShieldCheck, Users, Check, ChevronsUpDown } from "lucide-react";
import { fetcher } from "lib/utils";
import { getUserAvatar } from "lib/user/utils";
import { useSession } from "@/lib/backend/session-context";
import { Avatar, AvatarFallback, AvatarImage } from "ui/avatar";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "ui/command";
import { Skeleton } from "ui/skeleton";
import {
  UserStatisticsCard,
  type UserStatsData,
} from "@/components/user/user-detail/user-statistics-card";
import {
  DateRangePicker,
  type DateRangeValue,
  PRESET_OPTIONS,
} from "@/components/ui/date-range-picker";

type AdminUserDetail = {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  role: string;
  banned?: boolean | null;
  banReason?: string | null;
  createdAt: string;
  lastLogin?: string | null;
};

type UsageStatsResponse = {
  user: AdminUserDetail;
  stats: UserStatsData;
};

type UserListItem = {
  id: string;
  name: string;
  email: string;
  role: string;
};

function UsageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, isPending: isSessionLoading } = useSession();
  const tCommon = useTranslations("User.Profile.common");

  const queryUserId = searchParams.get("id");
  const currentUserId = session?.user?.id;
  const activeUserId = queryUserId || currentUserId;

  const [userSelectOpen, setUserSelectOpen] = useState(false);

  // Date Range state (Default: Last 30 Days)
  const [dateRange, setDateRange] = useState<DateRangeValue>(() => {
    const preset = PRESET_OPTIONS.find((p) => p.key === "30d") || PRESET_OPTIONS[3];
    const r = preset.getRange();
    return {
      from: r.from,
      to: r.to,
      presetKey: "30d",
    };
  });

  // Construct API endpoint with query parameters
  const statsUrl = useMemo(() => {
    if (!activeUserId) return null;
    const params = new URLSearchParams();

    if (dateRange.presetKey === "today") {
      params.set("days", "1");
    } else if (dateRange.presetKey === "7d") {
      params.set("days", "7");
    } else if (dateRange.presetKey === "30d") {
      params.set("days", "30");
    } else if (dateRange.presetKey === "90d") {
      params.set("days", "90");
    } else if (dateRange.from && dateRange.to) {
      params.set("from", dateRange.from.toISOString());
      params.set("to", dateRange.to.toISOString());
    }

    const qs = params.toString();
    return `/api/admin/users/${activeUserId}/stats${qs ? `?${qs}` : ""}`;
  }, [activeUserId, dateRange]);

  // Fetch all users to allow switching if desired
  const { data: usersData } = useSWR<{ users: UserListItem[] }>(
    "/api/admin/users?limit=100",
    fetcher,
  );
  const usersList = usersData?.users ?? [];

  // Fetch usage stats for the active user with selected date filter
  const {
    data: usageData,
    error: statsError,
    isLoading: isStatsLoading,
    isValidating: isStatsValidating,
    mutate: retryStats,
  } = useSWR<UsageStatsResponse>(statsUrl, fetcher, {
    keepPreviousData: true,
  });

  const isSelf = activeUserId === currentUserId;

  const user: AdminUserDetail | null =
    usageData?.user ??
    (isSelf && session?.user
      ? {
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
          image: null,
          role: session.user.role,
          banned: false,
          banReason: null,
          createdAt: new Date().toISOString(),
          lastLogin: null,
        }
      : null);

  const stats = usageData?.stats ?? {
    threadCount: 0,
    messageCount: 0,
    modelStats: [],
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    dailyUsage: [],
    period: "Last 30 Days",
  };

  if (isSessionLoading || (isStatsLoading && !usageData && !statsError)) {
    return (
      <div className="p-4 md:p-6 max-w-6xl mx-auto w-full space-y-6">
        <Skeleton className="h-10 w-1/3" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (statsError && !usageData) {
    return (
      <div className="p-4 md:p-6 max-w-6xl mx-auto w-full space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <TrendingUp className="size-6 text-primary" />
            Usage Analytics
          </h1>
        </div>
        <Card className="border-destructive/30 bg-destructive/5 p-6 text-center space-y-3">
          <p className="text-sm font-medium text-destructive">
            {statsError.message || "Failed to load usage statistics from backend."}
          </p>
          <button
            onClick={() => retryStats()}
            className="px-4 py-2 text-xs font-semibold rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Retry
          </button>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto w-full space-y-6" data-testid="admin-usage-page">
      {/* Page Header with Calendar Date Picker & User Switcher */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight flex items-center gap-2">
              <TrendingUp className="size-7 text-primary" />
              Usage & Cost Analytics
            </h1>
            {isStatsValidating && (
              <span className="inline-block size-2 rounded-full bg-primary animate-ping" />
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isSelf
              ? "Comprehensive breakdown of token volume, estimated expenditure, and provider activity"
              : `Viewing AI usage analytics for ${user?.name || "user"}`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 self-start md:self-auto">
          {/* Interactive Date Range & Calendar Picker */}
          <DateRangePicker
            value={dateRange}
            onChange={(newRange) => setDateRange(newRange)}
          />

          {/* User Switcher (For Admins with live typing search) */}
          {usersList.length > 1 && (
            <Popover open={userSelectOpen} onOpenChange={setUserSelectOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={userSelectOpen}
                  className="w-[190px] sm:w-[230px] h-9 justify-between bg-background text-xs font-normal"
                >
                  <div className="flex items-center gap-2 truncate">
                    <Users className="size-3.5 text-muted-foreground shrink-0" />
                    <span className="truncate">
                      {usersList.find((u) => u.id === activeUserId)?.name || "Select user..."}
                    </span>
                  </div>
                  <ChevronsUpDown className="size-3.5 opacity-50 shrink-0 ml-1" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[260px] p-0" align="end">
                <Command>
                  <CommandInput placeholder="Search users by name or email..." className="h-9 text-xs" />
                  <CommandList className="max-h-64">
                    <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">
                      No users found.
                    </CommandEmpty>
                    <CommandGroup heading="Users">
                      {usersList.map((u) => {
                        const isSelected = activeUserId === u.id;
                        return (
                          <CommandItem
                            key={u.id}
                            value={`${u.name} ${u.email}`}
                            onSelect={() => {
                              if (u.id === currentUserId) {
                                router.push("/admin/usage");
                              } else {
                                router.push(`/admin/usage?id=${u.id}`);
                              }
                              setUserSelectOpen(false);
                            }}
                            className="text-xs flex items-center justify-between py-2 cursor-pointer"
                          >
                            <div className="flex flex-col truncate pr-2">
                              <div className="flex items-center gap-1.5 truncate">
                                <span className="font-medium truncate">{u.name}</span>
                                {u.id === currentUserId && (
                                  <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5">
                                    You
                                  </Badge>
                                )}
                              </div>
                              <span className="text-[10px] text-muted-foreground truncate">{u.email}</span>
                            </div>
                            {isSelected && <Check className="size-3.5 text-primary shrink-0" />}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>

      {/* User Info Overview Banner */}
      {user && (
        <Card className="border shadow-xs bg-card/60">
          <CardHeader className="p-4 sm:p-5 pb-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <Avatar className="size-12 rounded-full border shadow-sm">
                  <AvatarImage src={getUserAvatar(user)} />
                  <AvatarFallback className="text-base font-semibold bg-primary/10 text-primary">
                    {user.name.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <CardTitle className="flex items-center gap-2 text-lg font-bold">
                    {user.name}
                    {isSelf && (
                      <Badge variant="outline" className="text-xs font-normal">
                        You
                      </Badge>
                    )}
                  </CardTitle>
                  <CardDescription className="text-xs">{user.email}</CardDescription>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Badge
                  variant={user.role === "admin" ? "default" : "secondary"}
                  className="text-xs flex items-center gap-1"
                >
                  {user.role === "admin" && <ShieldCheck className="size-3" />}
                  {user.role}
                </Badge>
                <Badge variant={user.banned ? "destructive" : "secondary"}>
                  {user.banned ? tCommon("banned") : tCommon("active")}
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-4 sm:p-5 pt-0">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-xs pt-3 border-t text-muted-foreground">
              <div>
                <span className="text-[10px] uppercase tracking-wider block font-medium">
                  {tCommon("joined")}
                </span>
                <span className="text-foreground font-medium">
                  {format(new Date(user.createdAt), "MMM d, yyyy")}
                </span>
              </div>
              {user.lastLogin && (
                <div>
                  <span className="text-[10px] uppercase tracking-wider block font-medium">
                    {tCommon("lastUpdated")}
                  </span>
                  <span className="text-foreground font-medium">
                    {format(new Date(user.lastLogin), "MMM d, yyyy")}
                  </span>
                </div>
              )}
              <div>
                <span className="text-[10px] uppercase tracking-wider block font-medium">
                  Filter Window
                </span>
                <span className="text-foreground font-medium">
                  {stats.period || "Last 30 Days"}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Main User Statistics Analytics Card */}
      {stats && <UserStatisticsCard stats={stats} view="admin" />}
    </div>
  );
}

export default function UsagePage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full m-6" />}>
      <UsageContent />
    </Suspense>
  );
}
