"use client";

import { useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Skeleton } from "ui/skeleton";

function UsersRedirectContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const qs = searchParams.toString();
    router.replace(qs ? `/admin/usage?${qs}` : "/admin/usage");
  }, [router, searchParams]);

  return <Skeleton className="h-96 w-full m-6" />;
}

export default function UsersRedirectPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full m-6" />}>
      <UsersRedirectContent />
    </Suspense>
  );
}
