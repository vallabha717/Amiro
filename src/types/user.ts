import { z } from "zod";
import { passwordSchema } from "lib/validations/password";

export type UserPreferences = {
  displayName?: string;
  profession?: string; // User's job or profession
  responseStyleExample?: string; // Example of preferred response style
  botName?: string; // Name of the bot
};

// Ports internal/api/auth's userResponse (backend-go/internal/api/auth/handlers.go)
// -- the Go sidecar's actual user shape (Phase 7), not the old
// better-auth/Drizzle UserEntity this type used to extend. Every field
// better-auth's user table had that internal/auth (Phase 2) doesn't --
// emailVerified, image, banned/banReason/banExpires, createdAt/updatedAt
// -- is optional here rather than required, since nothing on the Go side
// populates them; consumers that display them (the admin users table)
// are a documented gap, not silently broken (see
// docs/desktop-rewrite-progress.md's Phase 7 entry).
export interface User {
  id: string;
  name: string;
  email: string;
  role?: string | null;
  preferences?: UserPreferences | null;
  emailVerified?: boolean;
  image?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  lastLogin?: Date | null;
  banned?: boolean | null;
  banReason?: string | null;
  banExpires?: Date | null;
}

export type BasicUser = User;

export interface BasicUserWithLastLogin extends BasicUser {
  lastLogin: Date | null;
}

export const UserZodSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: passwordSchema,
});

export const UserPreferencesZodSchema = z.object({
  displayName: z.string().optional(),
  profession: z.string().optional(),
  responseStyleExample: z.string().optional(),
  botName: z.string().optional(),
});
