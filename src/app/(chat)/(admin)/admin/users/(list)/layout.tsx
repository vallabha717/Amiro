"use client";

import type { ReactNode } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "ui/card";
import { useTranslations } from "next-intl";

interface UsersLayoutProps {
  children: ReactNode;
}

export default function UsersLayout({ children }: UsersLayoutProps) {
  const t = useTranslations("Admin.Users");

  return (
    <div className="relative bg-background w-full flex flex-col min-h-screen">
      <div className="flex-1 overflow-y-auto p-6 w-full">
        <div className="space-y-4 w-full max-w-none">
          <Card className="w-full border-none bg-transparent">
            <CardHeader>
              <CardTitle className="text-2xl">{t("allUsers")}</CardTitle>
              <CardDescription>{t("viewAndManageUsers")}</CardDescription>
            </CardHeader>
            <CardContent className="p-2 md:p-6 w-full">{children}</CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
