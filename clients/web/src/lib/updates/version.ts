/** The release this UI was built for (next.config.ts, root package.json). */
export const UI_VERSION: string = process.env.NEXT_PUBLIC_AMIRO_VERSION ?? "";

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

/**
 * Whether the server now runs a different release than the one this page
 * was loaded from, so a reload brings the matching UI. Unknown versions
 * (dev builds, an older server without a version) never count as stale.
 */
export function isStaleUi(serverVersion: string | null | undefined, uiVersion = UI_VERSION): boolean {
  if (!serverVersion || !uiVersion) return false;
  return !sameVersion(serverVersion, uiVersion);
}
