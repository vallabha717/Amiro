"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  useSidebar,
} from "ui/sidebar";
import { Tooltip } from "ui/tooltip";
import { Shield } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

const AppSidebarAdmin = () => {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations("Admin");
  const { setOpenMobile } = useSidebar();

  return (
    <SidebarMenu>
      <Tooltip>
        <SidebarMenuItem>
          <SidebarMenuButton
            asChild
            isActive={pathname.startsWith("/admin")}
            className="font-semibold"
          >
            <Link
              href="/admin/providers"
              data-testid="admin-sidebar-link"
              onClick={(e) => {
                e.preventDefault();
                setOpenMobile(false);
                router.push("/admin/providers");
              }}
            >
              <Shield className="size-4 text-foreground" />
              <span>{t("title")}</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </Tooltip>
    </SidebarMenu>
  );
};

export { AppSidebarAdmin };
