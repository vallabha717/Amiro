export type SkillScope = "project" | "user";

export type SkillSource = ".agents" | ".amiro" | ".claude" | ".codex";

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
