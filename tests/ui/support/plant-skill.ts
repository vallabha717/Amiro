import * as fs from "node:fs";
import * as path from "node:path";

export interface PlantSkillOptions {
  name: string;
  description?: string;
  body?: string;
  scope?: "user" | "project";
  source?: ".agents" | ".amiro" | ".claude" | ".codex";
  disableModelInvocation?: boolean;
  extraFrontmatter?: Record<string, unknown>;
}

/**
 * Plants a skill file in the designated backend HOME or Workspace directory.
 * Must be called BEFORE the first /api/skills fetch is made for that backend.
 */
export function plantSkill(
  location: { home: string; workspace?: string },
  opts: PlantSkillOptions,
): string {
  const scope = opts.scope ?? "user";
  const source = opts.source ?? ".agents";
  const baseDir = scope === "project" ? location.workspace : location.home;

  if (!baseDir) {
    throw new Error(`Cannot plant ${scope}-scope skill: base directory is undefined`);
  }

  const skillDir = path.join(baseDir, source, "skills", opts.name);
  fs.mkdirSync(skillDir, { recursive: true });

  const frontmatterLines = [
    "---",
    `name: ${opts.name}`,
    `description: ${opts.description ?? `Test skill ${opts.name}`}`,
  ];

  if (opts.disableModelInvocation !== undefined) {
    frontmatterLines.push(`disable-model-invocation: ${opts.disableModelInvocation}`);
  }

  if (opts.extraFrontmatter) {
    for (const [key, value] of Object.entries(opts.extraFrontmatter)) {
      frontmatterLines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }

  frontmatterLines.push("---");
  const content = `${frontmatterLines.join("\n")}\n\n# ${opts.name}\n\n${opts.body ?? `Skill body for ${opts.name}`}\n`;

  const skillFilePath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillFilePath, content, "utf-8");
  return skillFilePath;
}
