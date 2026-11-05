"use client";

import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenu,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuPortal,
  DropdownMenuSubContent,
  DropdownMenuCheckboxItem,
} from "ui/dropdown-menu";
import { AvatarFallback, AvatarImage, Avatar } from "ui/avatar";
import { SidebarMenuButton, SidebarMenuItem, SidebarMenu } from "ui/sidebar";
import {
  ChevronsUpDown,
  Command,
  LogOutIcon,
  Settings2,
  Palette,
  Languages,
  Sun,
  MoonStar,
  ChevronRight,
  ChevronDown,
  Settings,
  Shield,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { appStore } from "@/app/store";
import { COOKIE_KEY_LOCALE, SUPPORTED_LOCALES } from "lib/const";
import { VEGA_PALETTES } from "@/lib/vega-themes";
import { capitalizeFirstLetter, cn, fetcher } from "lib/utils";
import { authClient } from "auth/client";
import { useTranslations } from "next-intl";
import useSWR from "swr";
import { getLocaleAction } from "@/i18n/get-locale";
import { Suspense, useCallback, useState } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { GithubIcon } from "ui/github-icon";
import { useVegaPalette } from "@/hooks/use-vega-palette";
import { BasicUser } from "app-types/user";
import { getUserAvatar } from "lib/user/utils";
import { Skeleton } from "ui/skeleton";

export function AppSidebarUserInner(props: {
  user?: BasicUser;
}) {
  const { data: user } = useSWR<BasicUser>(`/api/user/details`, fetcher, {
    fallbackData: props.user,
    suspense: true,
    revalidateOnMount: false,
    revalidateOnFocus: false,
    shouldRetryOnError: false,
    refreshInterval: 1000 * 60 * 10,
  });
  const appStoreMutate = appStore((state) => state.mutate);
  const router = useRouter();
  const t = useTranslations("Layout");

  const logout = () => {
    authClient.signOut().finally(() => {
      window.location.href = "/sign-in";
    });
  };

  if (!user) return null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground bg-input/30 border"
              size={"lg"}
              data-testid="sidebar-user-button"
            >
              <Avatar className="rounded-full size-8 border">
                <AvatarImage
                  className="object-cover"
                  src={getUserAvatar(user)}
                  alt={user?.name || "User"}
                />
                <AvatarFallback>{user?.name?.slice(0, 1) || ""}</AvatarFallback>
              </Avatar>
              <span className="truncate" data-testid="sidebar-user-email">
                {user?.email}
              </span>
              <ChevronsUpDown className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            className="bg-background w-[--radix-dropdown-menu-trigger-width] min-w-60 rounded-lg"
            align="center"
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar className="h-8 w-8 rounded-full">
                  <AvatarImage
                    src={getUserAvatar(user)}
                    alt={user?.name || "User"}
                  />
                  <AvatarFallback className="rounded-lg">
                    {user?.name?.slice(0, 1) || ""}
                  </AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span
                    className="truncate font-medium"
                    data-testid="sidebar-user-name"
                  >
                    {user?.name}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {user?.email}
                  </span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />

            <DropdownMenuItem
              className="cursor-pointer"
              onClick={() => appStoreMutate({ openChatPreferences: true })}
            >
              <Settings2 className="size-4 text-foreground" />
              <span>{t("chatPreferences")}</span>
            </DropdownMenuItem>
            <SelectTheme />
            <SelectLanguage />
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="cursor-pointer"
              onClick={() => appStoreMutate({ openShortcutsPopup: true })}
            >
              <Command className="size-4 text-foreground" />
              <span>{t("keyboardShortcuts")}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                window.open(
                  "https://github.com/vallabha717/Amiro/issues/new/choose",
                  "_blank",
                  "noopener",
                );
              }}
            >
              <GithubIcon className="size-4 fill-foreground" />
              <span>{t("reportAnIssue")}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />

            <DropdownMenuItem
              onClick={() => appStoreMutate({ openUserSettings: true })}
              className="cursor-pointer"
              data-testid="user-settings-menu-item"
            >
              <Settings className="size-4 text-foreground" />
              <span>{t("userSettings")}</span>
            </DropdownMenuItem>
            {user.role === "admin" && (
              <DropdownMenuItem
                onClick={() => router.push("/admin/providers")}
                className="cursor-pointer"
                data-testid="user-menu-admin-link"
              >
                <Shield className="size-4 text-foreground" />
                <span>Admin Preferences</span>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={logout} className="cursor-pointer">
              <LogOutIcon className="size-4 text-foreground" />
              <span>{t("signOut")}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/**
 * On a phone there is no room beside the menu for a submenu: it opened off
 * the right edge and the palettes could not be tapped. There the section
 * opens inline instead, inside the (scrollable) menu itself.
 */
function InlineSection({
  icon,
  label,
  hint,
  testId,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  testId: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <DropdownMenuItem
        className="flex items-center"
        aria-expanded={open}
        data-testid={testId}
        onSelect={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
      >
        {icon}
        <span className="mr-auto">{label}</span>
        {hint && (
          <span className="text-muted-foreground text-xs min-w-0 truncate">
            {hint}
          </span>
        )}
        <ChevronDown
          className={cn("size-4 ml-2 transition-transform", open && "rotate-180")}
        />
      </DropdownMenuItem>
      {open && <div className="ml-4 border-l pl-1">{children}</div>}
    </>
  );
}

function ThemeModeToggle() {
  const t = useTranslations("Layout");
  const { theme = "light", resolvedTheme, setTheme } = useTheme();
  // Flip what is on screen: from "System" a light/dark toggle based on the
  // stored value went System → Light, which changed nothing on a light phone.
  const shown = resolvedTheme === "dark" ? "dark" : "light";
  return (
    <DropdownMenuLabel className="text-muted-foreground w-full flex items-center">
      <span className="text-muted-foreground text-xs mr-2 select-none">
        {capitalizeFirstLetter(theme)}
      </span>
      <div className="flex-1" />
      <button
        type="button"
        aria-label={t("switchLightDark")}
        data-testid="theme-mode-toggle"
        onClick={() => setTheme(shown === "light" ? "dark" : "light")}
        className="cursor-pointer border rounded-full flex items-center"
      >
        <div
          className={cn(
            shown === "dark" &&
              "bg-accent ring ring-muted-foreground/40 text-foreground",
            "p-1 rounded-full",
          )}
        >
          <MoonStar className="size-3" />
        </div>
        <div
          className={cn(
            shown === "light" &&
              "bg-accent ring ring-muted-foreground/40 text-foreground",
            "p-1 rounded-full",
          )}
        >
          <Sun className="size-3" />
        </div>
      </button>
    </DropdownMenuLabel>
  );
}

function PaletteItems() {
  // The VegaAI palettes (app.vegaai.dev), independent of the agent colour.
  const { palette, setPalette } = useVegaPalette();
  return (
    <>
      {VEGA_PALETTES.map((p) => (
        <DropdownMenuCheckboxItem
          key={p.id}
          checked={palette === p.id}
          onClick={(e) => {
            e.preventDefault();
            setPalette(p.id);
          }}
          onSelect={(e) => e.preventDefault()}
          className="text-sm"
          data-testid={`palette-${p.id}`}
        >
          <span className="flex-1">{p.label}</span>
          {/* Window fill · action accent · muted text, as in VegaAI. */}
          <span
            aria-hidden="true"
            className="palette-preview"
            data-palette={p.id}
          />
        </DropdownMenuCheckboxItem>
      ))}
    </>
  );
}

function SelectTheme() {
  const t = useTranslations("Layout");
  const isMobile = useIsMobile();
  const { theme = "light" } = useTheme();
  const { palette } = useVegaPalette();
  const paletteLabel =
    VEGA_PALETTES.find((p) => p.id === palette)?.label ?? "Graphite";
  const hint = `${capitalizeFirstLetter(theme)} ${paletteLabel}`;

  if (isMobile) {
    return (
      <InlineSection
        icon={<Palette className="mr-2 size-4" />}
        label={t("theme")}
        hint={hint}
        testId="theme-menu-toggle"
      >
        <ThemeModeToggle />
        <PaletteItems />
      </InlineSection>
    );
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        className="flex items-center"
        icon={
          <>
            <span className="text-muted-foreground text-xs min-w-0 truncate">
              {hint}
            </span>
            <ChevronRight className="size-4 ml-2" />
          </>
        }
      >
        <Palette className="mr-2 size-4" />
        <span className="mr-auto">{t("theme")}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent
          className="w-48 max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto!"
          collisionPadding={8}
        >
          <ThemeModeToggle />
          <PaletteItems />
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

function SelectLanguage() {
  const t = useTranslations("Layout");
  const isMobile = useIsMobile();
  const { data: currentLocale } = useSWR(COOKIE_KEY_LOCALE, getLocaleAction, {
    fallbackData: SUPPORTED_LOCALES[0].code,
    revalidateOnFocus: false,
  });
  const handleOnChange = useCallback((locale: string) => {
    document.cookie = `${COOKIE_KEY_LOCALE}=${locale}; path=/;`;
    window.location.reload();
  }, []);

  const items = SUPPORTED_LOCALES.map((locale) => (
    <DropdownMenuCheckboxItem
      key={locale.code}
      checked={locale.code === currentLocale}
      data-testid={`locale-${locale.code}`}
      onCheckedChange={() =>
        locale.code !== currentLocale && handleOnChange(locale.code)
      }
    >
      {locale.name}
    </DropdownMenuCheckboxItem>
  ));

  if (isMobile) {
    return (
      <InlineSection
        icon={<Languages className="mr-2 size-4" />}
        label={t("language")}
        testId="language-menu-toggle"
      >
        {items}
      </InlineSection>
    );
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Languages className="mr-2 size-4" />
        <span>{t("language")}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent
          className="w-48 max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto!"
          collisionPadding={8}
        >
          <DropdownMenuLabel className="text-muted-foreground">
            {t("language")}
          </DropdownMenuLabel>
          {items}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

export function AppSidebarUserSkeleton() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground bg-input/30 border"
          size={"lg"}
          data-testid="sidebar-user-button"
        >
          <Skeleton className="h-8 w-8 rounded-full" />
          <Skeleton className="h-4 w-24" />
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function AppSidebarUser({
  user,
}: {
  user?: BasicUser;
}) {
  return (
    <Suspense fallback={<AppSidebarUserSkeleton />}>
      <AppSidebarUserInner user={user} />
    </Suspense>
  );
}
