/** The release this UI was built for (next.config.ts, root package.json). */
export const UI_VERSION: string = process.env.NEXT_PUBLIC_AMIRO_VERSION ?? "";
/** The commit this UI was built from (next.config.ts); "" outside a checkout. */
export const UI_COMMIT: string = process.env.NEXT_PUBLIC_AMIRO_COMMIT ?? "";

/** A running build: its release version and, from a checkout, its commit. */
export interface Build {
  version: string | null;
  commit?: string | null;
}

function core(version: string): string {
  return version.trim().replace(/^v/i, "");
}

/** "v1.27.0" → "v1.27.0", "1.27.0" → "v1.27.0", "" → "". */
export function displayVersion(version: string | null | undefined): string {
  const v = core(version ?? "");
  return v ? `v${v}` : "";
}

/** The same version, written with or without the leading "v". */
export function sameVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b) && core(a ?? "") === core(b ?? "");
}

/** The same commit, full or abbreviated. */
export function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/** "v1.27.0", or "v1.27.0 (9ecb917)" when the commit is known. */
export function displayBuild(build: Build | null | undefined): string {
  const version = displayVersion(build?.version);
  return build?.commit ? `${version} (${build.commit.slice(0, 7)})` : version;
}

/**
 * Whether the server now runs a different build than the one this page was
 * loaded from, so a reload brings the matching UI: another release, or (a
 * server that follows a branch) another commit of the same release. Unknown
 * versions (dev builds, an older server without a version) never count.
 */
export function isStaleUi(
  server: Build | null | undefined,
  ui: Build = { version: UI_VERSION, commit: UI_COMMIT },
): boolean {
  if (!server?.version || !ui.version) return false;
  if (!sameVersion(server.version, ui.version)) return true;
  return Boolean(server.commit && ui.commit) && !sameCommit(server.commit, ui.commit);
}
