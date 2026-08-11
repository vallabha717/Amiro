"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { Button } from "ui/button";

// getAuthConfig() dropped -- sign-up is always enabled (see sign-in/page.tsx).
export default function SignUpLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations();

  return (
    <div className="animate-in fade-in duration-1000 w-full h-full flex flex-col p-4 md:p-8 justify-center relative">
      <div className="w-full flex justify-end absolute top-0 right-0">
        <Link href="/sign-in">
          <Button variant="ghost">{t("Auth.SignUp.signIn")}</Button>
        </Link>
      </div>
      <div className="flex flex-col gap-4 w-full md:max-w-md mx-auto">
        {children}
      </div>
    </div>
  );
}
