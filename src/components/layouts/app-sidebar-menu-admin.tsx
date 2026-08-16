import { useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  SidebarMenu,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "ui/sidebar";
import { Tooltip } from "ui/tooltip";
import { SidebarMenuItem } from "ui/sidebar";
import { SidebarMenuButton } from "ui/sidebar";
import { Shield, TrendingUp, Settings2 } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

const AppSidebarAdmin = () => {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations("Admin");
  const shouldExpandAdmin = useMemo(() => {
    return pathname.startsWith("/admin");
  }, [pathname]);
  const adminNavItems = useMemo(
    () => [
      {
        id: "providers",
        title: t("Providers.title"),
        url: "/admin/providers",
        icon: Settings2,
        isActive: pathname.startsWith("/admin/providers"),
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
          <Link href="/admin" data-testid="admin-sidebar-link">
            <SidebarMenuButton className="font-semibold">
              <Shield className="size-4 text-foreground" />
              {t("title")}
            </SidebarMenuButton>
          </Link>
        </SidebarMenuItem>
      </Tooltip>
      {shouldExpandAdmin && (
        <SidebarMenuSub className="mb-2">
          {adminNavItems.map((item) => (
            <SidebarMenuSubItem key={item.id}>
              <SidebarMenuSubButton
                className="text-muted-foreground"
                data-testid={`admin-sidebar-link-${item.id}`}
                onClick={() => {
                  router.push(item.url);
                }}
                isActive={item.isActive}
              >
                {item.title}
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenu>
  );
};

export { AppSidebarAdmin };
