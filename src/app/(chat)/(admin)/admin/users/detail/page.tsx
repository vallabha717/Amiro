"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR, { mutate } from "swr";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { format } from "date-fns";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { fetcher } from "lib/utils";
import { apiJson, ApiError } from "@/lib/backend/client";
import { useSession } from "@/lib/backend/session-context";
import { Avatar, AvatarFallback, AvatarImage } from "ui/avatar";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { Label } from "ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "ui/alert-dialog";
import { Skeleton } from "ui/skeleton";

// Was admin/users/[id] -- flattened to /admin/users/detail?id= (see
// (chat)/agent/page.tsx's doc comment for why: static export can't build
// a runtime id into the route). Was a Server Component reading
// pgAdminRepository directly + Server Actions (updateUserRolesAction,
// updateUserBanStatusAction, deleteUserAction); now client-side calls
// against internal/api/admin -- the admin subsystem that didn't exist on
// the Go side at all until now.
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

const USERS_KEY = (id: string) => `/api/admin/users/${id}`;

function UserDetailContent() {
  const id = useSearchParams().get("id") ?? "";
  const router = useRouter();
  const t = useTranslations("Admin.Users");
  const tRoles = useTranslations("Admin.UserRoles");
  const tDelete = useTranslations("Admin.UserDelete");
  const tCommon = useTranslations("User.Profile.common");
  const tGlobal = useTranslations("Common");
  const { data: session } = useSession();

  const { data: user, isLoading } = useSWR<AdminUserDetail>(
    id ? USERS_KEY(id) : null,
    fetcher,
  );

  const [banReason, setBanReason] = useState("");
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const isSelf = session?.user.id === id;

  const handleRoleChange = async (role: string) => {
    setIsSaving(true);
    try {
      await apiJson(`/api/admin/users/${id}/role`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      toast.success(
        tRoles("roleUpdatedSuccessfullyTo", { role }),
      );
      mutate(USERS_KEY(id));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : tRoles("failedToUpdateRole"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleBanToggle = async (banned: boolean) => {
    setIsSaving(true);
    try {
      await apiJson(`/api/admin/users/${id}/ban`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ banned, banReason: banned ? banReason || undefined : undefined }),
      });
      toast.success(
        banned ? tCommon("userBannedSuccessfully") : tCommon("userUnbannedSuccessfully"),
      );
      setBanReason("");
      mutate(USERS_KEY(id));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : tCommon("failedToUpdateUserStatus"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    setIsSaving(true);
    try {
      await apiJson(`/api/admin/users/${id}`, { method: "DELETE" });
      toast.success(tDelete("userDeletedSuccessfully"));
      router.push("/admin/users");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : tDelete("failedToDeleteUser"));
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="p-6 max-w-2xl mx-auto w-full space-y-4">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        {t("noUsersFound")}
      </div>
    );
  }

  return (
    <div
      className="p-6 max-w-2xl mx-auto w-full space-y-6"
      data-testid="admin-user-detail"
    >
      <Link
        href="/admin/users"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {t("backToUsers")}
      </Link>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-4">
            <Avatar className="size-14 rounded-full">
              <AvatarImage src={user.image ?? undefined} />
              <AvatarFallback className="text-lg">
                {user.name.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div>
              <CardTitle className="flex items-center gap-2">
                {user.name}
                {isSelf && (
                  <Badge variant="outline" className="text-xs">
                    {t("youBadge")}
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>{user.email}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-muted-foreground">{t("joined")}</div>
              <div>{format(new Date(user.createdAt), "MMM d, yyyy")}</div>
            </div>
            <div>
              <div className="text-muted-foreground">{t("status")}</div>
              <Badge variant={user.banned ? "destructive" : "secondary"}>
                {user.banned ? tCommon("banned") : tCommon("active")}
              </Badge>
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t("role")}</Label>
            <Select
              value={user.role}
              disabled={isSelf || isSaving}
              onValueChange={handleRoleChange}
            >
              <SelectTrigger data-testid="user-role-select" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">User</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
            {isSelf && (
              <p className="text-xs text-muted-foreground">
                {tRoles("cannotUpdateOwnRole")}
              </p>
            )}
          </div>

          <div className="space-y-2 pt-2 border-t">
            {!user.banned ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="destructive"
                    disabled={isSelf || isSaving}
                    data-testid="ban-user-button"
                  >
                    {tCommon("banned")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{tCommon("banned")}</AlertDialogTitle>
                    <AlertDialogDescription asChild>
                      <div className="space-y-3">
                        <p>{tCommon("cannotBanUnbanYourself")}</p>
                        <Input
                          placeholder="Ban reason (optional)"
                          value={banReason}
                          onChange={(e) => setBanReason(e.target.value)}
                          data-testid="ban-reason-input"
                        />
                      </div>
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{tGlobal("cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive hover:bg-destructive/90"
                      onClick={() => handleBanToggle(true)}
                      data-testid="confirm-ban-button"
                    >
                      {tCommon("banned")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : (
              <Button
                variant="outline"
                disabled={isSelf || isSaving}
                onClick={() => handleBanToggle(false)}
                data-testid="unban-user-button"
              >
                {tCommon("active")}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-destructive">{tDelete("title")}</CardTitle>
          <CardDescription>
            {tDelete("description", { name: user.name })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AlertDialog onOpenChange={() => setDeleteConfirmName("")}>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                disabled={isSelf || isSaving}
                data-testid="delete-user-button"
              >
                {tDelete("title")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{tDelete("title")}</AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="space-y-3">
                    <p>{tDelete("description", { name: user.name })}</p>
                    <ul className="list-disc list-inside text-sm">
                      <li>{tDelete("deleteAllUserData")}</li>
                      <li>{tDelete("removeAllFiles")}</li>
                      <li>{tDelete("revokeAllAccess")}</li>
                      <li>{tDelete("cannotBeUndone")}</li>
                    </ul>
                    <Label>{tDelete("typeToConfirm", { name: user.name })}</Label>
                    <Input
                      value={deleteConfirmName}
                      onChange={(e) => setDeleteConfirmName(e.target.value)}
                      data-testid="delete-confirm-input"
                    />
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{tGlobal("cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive hover:bg-destructive/90"
                  disabled={deleteConfirmName !== user.name}
                  onClick={handleDelete}
                  data-testid="confirm-delete-button"
                >
                  {tDelete("title")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>
    </div>
  );
}

export default function UserDetailPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full m-6" />}>
      <UserDetailContent />
    </Suspense>
  );
}
