"use client";

import { apiFetch, fetcher } from "@/lib/backend/client";
import useSWR from "swr";

export type FsRootsResponse = { roots: string[] };
export type FsBrowseEntry = {
  name: string;
  path: string;
  kind: "dir" | "file";
  isGitRepo: boolean;
};
export type FsBrowseResponse = {
  path: string;
  parent: string | null;
  roots: string[];
  entries: FsBrowseEntry[];
  truncated: boolean;
};
export type FsStatResponse = {
  path: string;
  name: string;
  kind: string;
  exists: boolean;
  usable: boolean;
  denied?: boolean;
  outsideRoots?: boolean;
};

export function useFsRoots(enabled = true) {
  return useSWR<FsRootsResponse>(enabled ? "/api/fs/roots" : null, fetcher, {
    revalidateOnFocus: false,
  });
}

export function useFsBrowse(path: string | null) {
  const key = path ? `/api/fs/browse?path=${encodeURIComponent(path)}` : null;
  return useSWR<FsBrowseResponse>(key, fetcher, {
    revalidateOnFocus: false,
  });
}

export async function fetchFsBrowse(path: string): Promise<FsBrowseResponse> {
  const res = await apiFetch(`/api/fs/browse?path=${encodeURIComponent(path)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err: any = new Error(body.error || `Browse failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function fetchFsStat(path: string): Promise<FsStatResponse> {
  const res = await apiFetch(`/api/fs/stat?path=${encodeURIComponent(path)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err: any = new Error(body.error || `Stat failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function fetchFsRoots(): Promise<FsRootsResponse> {
  const res = await apiFetch("/api/fs/roots");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err: any = new Error(body.error || `Roots failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}
