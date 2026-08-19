import { useMemo, useState, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "ui/sidebar";
import { Tooltip } from "ui/tooltip";
import { SidebarMenuItem } from "ui/sidebar";
import { SidebarMenuButton } from "ui/sidebar";
import { Shield, TrendingUp, Search, Cpu, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { cn } from "lib/utils";

const AppSidebarAdmin = () => {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations("Admin");
  const [isExpanded, setIsExpanded] = useState(() => pathname.startsWith("/admin"));

  useEffect(() => {
    if (pathname.startsWith("/admin")) {
      setIsExpanded(true);
    }
  }, [pathname]);

  const adminNavItems = useMemo(
    () => [
      {
        id: "providers",
        title: t("Providers.title"),
        url: "/admin/providers",
        icon: Cpu,
        isActive: pathname.startsWith("/admin/providers"),
      },
      {
        id: "search",
        title: "Search Providers",
        url: "/admin/search",
        icon: Search,
        isActive: pathname.startsWith("/admin/search"),
      },
      {
        id: "usage",
        title: t("Usage.title"),
        url: "/admin/usage",
        icon: TrendingUp,
        isActive: pathname.startsWith("/admin/usage") || pathname.startsWith("/admin/users"),
      },
    ],
    [t, pathname],
  );

  return (
    <SidebarMenu className="group/admin">
      <Tooltip>
        <SidebarMenuItem>
          <SidebarMenuButton
            asChild
            isActive={pathname.startsWith("/admin")}
            className="font-semibold"
          >
            <Link href="/admin" data-testid="admin-sidebar-link">
              <Shield className="size-4 text-foreground" />
              <span>{t("title")}</span>
            </Link>
          </SidebarMenuButton>
          <SidebarMenuAction
            aria-label="Toggle Admin Submenu"
            data-testid="admin-sidebar-dropdown-button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsExpanded((prev) => !prev);
            }}
          >
            <ChevronRight
              className={cn(
                "size-4 transition-transform duration-200 text-muted-foreground",
                isExpanded && "rotate-90",
              )}
            />
          </SidebarMenuAction>
        </SidebarMenuItem>
      </Tooltip>
      {isExpanded && (
        <div className="animate-in fade-in-0 slide-in-from-top-1 duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]">
          <SidebarMenuSub className="mb-2">
            {adminNavItems.map((item) => (
              <SidebarMenuSubItem key={item.id}>
                <SidebarMenuSubButton
                  className="text-muted-foreground cursor-pointer flex items-center gap-2"
                  data-testid={`admin-sidebar-link-${item.id}`}
                  onClick={() => {
                    router.push(item.url);
                  }}
                  isActive={item.isActive}
                >
                  <item.icon className="size-3.5" />
                  <span>{item.title}</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </div>
      )}
    </SidebarMenu>
  );
};

export { AppSidebarAdmin };

