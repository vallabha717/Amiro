import { USER_ROLES } from "app-types/roles";
import { rewriteStorageUrl } from "@/lib/backend/config";

export const getUserAvatar = (user?: { image?: string | null } | null): string => {
  const disableDefaultAvatar = process.env.DISABLE_DEFAULT_AVATAR === "true";
  const image = user?.image ? (rewriteStorageUrl(user.image) || user.image) : undefined;
  return image || (disableDefaultAvatar ? "" : "/pf.png");
};

export const getIsUserAdmin = (user?: { role?: string | null }): boolean => {
  return user?.role?.split(",").includes(USER_ROLES.ADMIN) || false;
};
