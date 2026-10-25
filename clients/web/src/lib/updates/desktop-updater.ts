/**
 * The desktop app's self-update, through the Tauri shell
 * (clients/desktop/src/lib.rs: `desktop_update_check`,
 * `desktop_update_install`, progress on `amiro://update-progress`).
 * Outside the desktop app every function reports "not available".
 */

export interface DesktopUpdateInfo {
  /** The installed desktop app's version. */
  current: string;
  available: boolean;
  version?: string;
  notes?: string | null;
  date?: string | null;
  /** False for installs that cannot replace themselves (a Linux .deb). */
  supported: boolean;
  reason?: "deb" | null;
}

export type DesktopUpdateProgress =
  | { phase: "downloading"; received: number; total: number | null }
  | { phase: "installing" }
  | { phase: "restarting" };

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type Listen = (
  event: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<() => void>;

interface TauriGlobal {
  invoke?: Invoke;
  core?: { invoke?: Invoke };
  event?: { listen?: Listen };
}

function tauri(): TauriGlobal | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    __TAURI__?: TauriGlobal;
    __AMIRO_DESKTOP__?: boolean;
  };
  if (!w.__AMIRO_DESKTOP__ || !w.__TAURI__) return null;
  return w.__TAURI__;
}

function invoker(): Invoke | null {
  const t = tauri();
  return t?.core?.invoke ?? t?.invoke ?? null;
}

/** Whether this page runs inside the Amiro desktop app. */
export function isDesktopApp(): boolean {
  return invoker() !== null;
}

/** Ask the release feed whether a newer desktop build exists. */
export async function checkDesktopUpdate(): Promise<DesktopUpdateInfo> {
  const invoke = invoker();
  if (!invoke) throw new Error("not running in the desktop app");
  return (await invoke("desktop_update_check")) as DesktopUpdateInfo;
}

/**
 * Download and install the update, then relaunch. `onProgress` receives
 * the download progress; the promise only settles if something fails
 * (on success the app restarts first).
 */
export async function installDesktopUpdate(
  onProgress?: (progress: DesktopUpdateProgress) => void,
): Promise<void> {
  const invoke = invoker();
  if (!invoke) throw new Error("not running in the desktop app");
  const listen = tauri()?.event?.listen;
  const unlisten = listen
    ? await listen("amiro://update-progress", (event) => {
        onProgress?.(event.payload as DesktopUpdateProgress);
      })
    : null;
  try {
    await invoke("desktop_update_install");
  } finally {
    unlisten?.();
  }
}

/** 0–100 for a download with a known size, otherwise null. */
export function progressPercent(progress: DesktopUpdateProgress | null): number | null {
  if (!progress || progress.phase !== "downloading" || !progress.total) return null;
  return Math.min(100, Math.round((progress.received / progress.total) * 100));
}
