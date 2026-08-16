"use client";

import { useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Skeleton } from "ui/skeleton";

function UserDetailRedirectContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const qs = searchParams.toString();
    router.replace(qs ? `/admin/usage/detail?${qs}` : "/admin/usage");
  }, [router, searchParams]);

  return <Skeleton className="h-96 w-full m-6" />;
}

export default function UserDetailRedirectPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full m-6" />}>
      <UserDetailRedirectContent />
    </Suspense>
  );
}
