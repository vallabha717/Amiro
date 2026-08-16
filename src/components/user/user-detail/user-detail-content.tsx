"use client";

import { useRef, useState, useEffect } from "react";
import useSWR, { mutate } from "swr";
import { fetcher } from "lib/utils";
import { apiJson, ApiError } from "@/lib/backend/client";
import { useFileUpload } from "@/hooks/use-presigned-upload";
import { passwordSchema } from "lib/validations/password";
import { Avatar, AvatarFallback, AvatarImage } from "ui/avatar";
import { Badge } from "ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "ui/card";
import { Label } from "ui/label";
import { Input } from "ui/input";
import { Button } from "ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "ui/tooltip";
import { Camera, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { UserDetailContentSkeleton } from "./user-detail-content-skeleton";
import { BasicUser } from "app-types/user";

// The single local account desktop builds auto-provision and auto-login
// as (internal/auth/service.go's DesktopDefaultUserEmail) -- kept in sync
// by hand since there is no shared module between the Go sidecar and this
// frontend. Its email is fixed: EnsureDesktopDefaultUser looks that user
// up by this exact address on every sidecar restart, so letting it be
// edited here would orphan the account (and everything it owns) the next
// time the app launches.
const DESKTOP_DEFAULT_EMAIL = "local@amiro.desktop";
const LEGACY_DESKTOP_DEFAULT_EMAIL = "local@betterchatbot.desktop";

const USER_DETAILS_KEY = "/api/user/details";
const AUTH_METHODS_KEY = "/api/user/auth-methods";
const USER_PASSWORD_KEY = "/api/user/password";

export function UserDetailContent({
  view = "user",
}: {
  userId?: string;
  view?: "admin" | "user";
}) {
  const { data: user, isLoading } = useSWR<BasicUser>(
    USER_DETAILS_KEY,
    fetcher,
  );

  if (isLoading || !user) {
    return <UserDetailContentSkeleton />;
  }

  return (
    <div className="flex flex-col gap-4 p-2 max-w-lg" data-testid="user-detail-content">
      <ProfileCard user={user} view={view} />
      {view === "user" && <PasswordCard />}
    </div>
  );
}

function ProfileCard({
  user,
  view,
}: {
  user: BasicUser;
  view: "admin" | "user";
}) {
  const t = useTranslations(
    view === "admin" ? "User.Profile.admin" : "User.Profile.user",
  );
  const tc = useTranslations("User.Profile.common");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { upload, isUploading } = useFileUpload();
  const [name, setName] = useState(user.name);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const isDesktopDefaultAccount =
    user.email === DESKTOP_DEFAULT_EMAIL ||
    user.email === LEGACY_DESKTOP_DEFAULT_EMAIL;
  const nameChanged = name.trim() !== user.name;
  const imageChanged = selectedFile !== null;
  const hasChanges = nameChanged || imageChanged;

  useEffect(() => {
    setName(user.name);
  }, [user.name]);

  useEffect(() => {
    return () => {
      if (previewImage) {
        URL.revokeObjectURL(previewImage);
      }
    };
  }, [previewImage]);

  const saveDetails = async (patch: Partial<Pick<BasicUser, "name" | "image">>) => {
    try {
      const updated = await apiJson<BasicUser>(USER_DETAILS_KEY, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      mutate(USER_DETAILS_KEY, updated, { revalidate: false });
      return updated;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : tc("failedToUpdateUserDetails"));
      return undefined;
    }
  };

  const handleSaveProfile = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error(tc("required"));
      return;
    }
    setIsSaving(true);

    let imageUrl: string | undefined = undefined;

    if (selectedFile) {
      const result = await upload(selectedFile);
      if (!result) {
        toast.error(tc("failedToUpdateProfilePhoto"));
        setIsSaving(false);
        return;
      }
      imageUrl = result.url;
    }

    const patch: Partial<Pick<BasicUser, "name" | "image">> = {};
    if (nameChanged) patch.name = trimmed;
    if (imageUrl) patch.image = imageUrl;

    const updated = await saveDetails(patch);
    setIsSaving(false);

    if (updated) {
      if (previewImage) {
        URL.revokeObjectURL(previewImage);
      }
      setSelectedFile(null);
      setPreviewImage(null);
      toast.success(t("updateSuccess"));
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (fileInputRef.current) fileInputRef.current.value = "";

    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (!allowed.includes(file.type)) {
      toast.error(tc("pleaseUploadValidImage"));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error(tc("imageSizeMustBeLessThan"));
      return;
    }

    if (previewImage) {
      URL.revokeObjectURL(previewImage);
    }

    setSelectedFile(file);
    const objectUrl = URL.createObjectURL(file);
    setPreviewImage(objectUrl);
  };

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          {tc("userDetailsCardTitle")}
          <Badge variant="outline" className="text-xs ml-auto">
            {tc("you")}
          </Badge>
        </CardTitle>
        <CardDescription>{t("userDetailsCardDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-center">
          <div className="relative inline-block">
            <Avatar className="size-20 rounded-full ring ring-border">
              <AvatarImage src={previewImage ?? user.image ?? undefined} />
              <AvatarFallback className="text-lg font-semibold">
                {user.name?.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            {(isUploading || isSaving) && selectedFile && (
              <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/60">
                <Loader2 className="size-6 animate-spin text-white" />
              </div>
            )}
            <Button
              type="button"
              size="icon"
              variant="secondary"
              className="absolute bottom-0 right-0 size-7 rounded-full shadow-lg"
              disabled={isUploading || isSaving}
              onClick={() => fileInputRef.current?.click()}
              data-testid="change-avatar-button"
              aria-label={tc("changeProfilePhoto")}
            >
              <Camera className="size-3.5" />
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/jpg,image/png,image/webp"
              className="hidden"
              onChange={handleFileSelect}
              disabled={isUploading || isSaving}
              data-testid="avatar-file-input"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="user-name">{tc("name")}</Label>
          <Input
            id="user-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isSaving || isUploading}
            data-testid="user-name-input"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="user-email">{tc("email")}</Label>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={isDesktopDefaultAccount ? "cursor-not-allowed" : ""}>
                <Input
                  id="user-email"
                  type="email"
                  value={user.email}
                  disabled
                  data-testid="user-email-input"
                />
              </span>
            </TooltipTrigger>
            {isDesktopDefaultAccount && (
              <TooltipContent>{t("emailFixedForDesktopAccount")}</TooltipContent>
            )}
          </Tooltip>
        </div>

        <Button
          className="w-full"
          disabled={isSaving || isUploading || !hasChanges}
          onClick={handleSaveProfile}
          data-testid="save-changes-button"
        >
          {isSaving || isUploading ? tc("saving") : t("saveChanges")}
        </Button>
      </CardContent>
    </Card>
  );
}

function PasswordCard() {
  const t = useTranslations("User.Profile.user");
  const tc = useTranslations("User.Profile.common");
  const { data: authMethods } = useSWR<{ hasPassword: boolean }>(
    AUTH_METHODS_KEY,
    fetcher,
  );
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const hasPassword = authMethods?.hasPassword ?? false;

  const reset = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  };

  const handleSubmit = async () => {
    const { success, error } = passwordSchema.safeParse(newPassword);
    if (!success) {
      toast.error(error.issues.map((i) => i.message).join("\n"));
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error(tc("confirmPassword"));
      return;
    }
    if (hasPassword && !currentPassword) {
      toast.error(tc("currentPassword"));
      return;
    }

    setIsSaving(true);
    try {
      await apiJson(USER_PASSWORD_KEY, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      toast.success(tc("passwordUpdatedSuccessfully"));
      reset();
      mutate(AUTH_METHODS_KEY);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : tc("failedToUpdatePassword"));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="text-lg font-semibold">
          {tc("passwordManagement")}
        </CardTitle>
        <CardDescription>
          {hasPassword ? t("changeUserPassword") : t("setPasswordDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {hasPassword && (
          <div className="space-y-2">
            <Label htmlFor="current-password">{tc("currentPassword")}</Label>
            <Input
              id="current-password"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              disabled={isSaving}
              data-testid="current-password-input"
            />
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="new-password">{t("newPasswordPlaceholder")}</Label>
          <Input
            id="new-password"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={isSaving}
            data-testid="new-password-input"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm-password">{tc("confirmPassword")}</Label>
          <Input
            id="confirm-password"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={isSaving}
            data-testid="confirm-password-input"
          />
        </div>
        <Button
          className="w-full"
          disabled={isSaving || !newPassword}
          onClick={handleSubmit}
          data-testid="update-password-button"
        >
          {isSaving ? tc("saving") : t("updatePasswordButton")}
        </Button>
      </CardContent>
    </Card>
  );
}
