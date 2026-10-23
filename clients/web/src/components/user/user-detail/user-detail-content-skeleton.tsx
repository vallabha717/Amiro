import { Skeleton } from "ui/skeleton";

export function UserDetailContentSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-2">
      <div className="flex items-center gap-4">
        <Skeleton className="size-14 rounded-full" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-40" />
        </div>
      </div>
      <Skeleton className="h-3 w-full max-w-md" />
    </div>
  );
}
