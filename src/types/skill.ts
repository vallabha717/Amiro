import { z } from "zod";

export type SkillScope = "project" | "user";

export type SkillSource =
  | ".agents"
  | ".amiro"
  | ".claude"
  | ".codex";

export interface ShadowedSkill {
  name: string;
  scope: SkillScope;
  source: SkillSource;
  path: string;
  realPath?: string;
  reason: string;
}

export interface SkillDiagnostic {
  path: string;
  skill?: string;
  severity: "warning" | "error" | "info";
  message: string;
}

/**
 * SkillSummary is the Tier-1 catalog item returned by listSkills (GET /api/skills).
 * Deliberately omits body and resources to keep prompt and palette payloads lightweight.
 */
export interface SkillSummary {
  name: string;
  description: string;
  scope: SkillScope;
  source: SkillSource;
  path: string;
  realPath?: string;
  writable: boolean;
  deliverable?: boolean;
  invokable?: boolean;
  invokableReason?: string;
  disableModelInvocation?: boolean;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
  shadows?: ShadowedSkill[];
}

/**
 * Skill represents the full Tier-2/Tier-3 skill payload returned by getSkill (GET /api/skills/items/{name}).
 */
export interface Skill extends SkillSummary {
  resources?: string[];
  body: string;
}

export interface SkillsListResponse {
  items: SkillSummary[];
  diagnostics: SkillDiagnostic[];
  truncated: boolean;
}

/** WriteRequest is the create/update body (backend WriteRequest, route.go). */
export interface SkillWriteRequest {
  name: string;
  description: string;
  body: string;
  frontmatter?: Record<string, unknown>;
}

export interface SkillFieldError {
  field: string;
  message: string;
}

export interface SkillWriteResponse {
  skill: Skill;
  warnings?: SkillFieldError[];
}

export interface SkillValidationError {
  errors: SkillFieldError[];
  warnings?: SkillFieldError[];
}

/**
 * Mirrors internal/skills/validate.go's ValidateName so an invalid name is
 * a field error on submit rather than a round trip to the server -- and so
 * a Generate result the model got wrong never populates the form with a
 * name that could not have been saved anyway.
 */
export const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

export function validateSkillName(name: string): string | null {
  if (!name) return "nameRequired";
  if (name.length > SKILL_NAME_MAX_LENGTH) return "nameTooLong";
  if (!SKILL_NAME_REGEX.test(name)) return "nameInvalidFormat";
  return null;
}

export function validateSkillDescription(description: string): string | null {
  if (!description) return "descriptionRequired";
  if (description.length > SKILL_DESCRIPTION_MAX_LENGTH)
    return "descriptionTooLong";
  return null;
}

/** The streamed object shape from POST /api/skills/generate. */
export const SkillGenerateSchema = z.object({
  name: z.string().describe("Skill directory name"),
  description: z.string().describe("What the skill does and when to use it"),
  body: z.string().describe("The SKILL.md markdown body"),
});
