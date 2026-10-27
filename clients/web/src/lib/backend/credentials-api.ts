"use client";

import { apiJson } from "./client";

export const CREDENTIALS_CACHE_KEY = "amiro.credentials.cache";

export interface CredentialMetadata {
  id: string; // "<service>/<field>"
  service: string;
  field: string;
  label?: string | null;
  hint: string; // "••••1234"
  envVar?: string; // "AMIRO_CRED_<SERVICE>_<FIELD>"
  usageDescription?: string | null;
  allowedTools?: string[];
  allowedDomains?: string[];
  updatedAt: string;
}

export interface SaveCredentialInput {
  service: string;
  field: string;
  value: string;
  label?: string;
  usageDescription?: string;
  allowedTools?: string[];
  allowedDomains?: string[];
}

export interface ValidateCredentialResult {
  valid: boolean;
}

export interface DeleteCredentialResult {
  success: boolean;
}

/**
 * Returns the environment variable name under which the credential is
 * made available to runtime processes (e.g. bash, MCP tools).
 */
export function toCredentialEnvVar(service: string, field: string): string {
  const normService = service.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  const normField = field.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return `AMIRO_CRED_${normService}_${normField}`;
}

function getCachedCredentials(): CredentialMetadata[] | null {
  if (typeof window === "undefined" || !window.localStorage) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(CREDENTIALS_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CredentialMetadata[];
  } catch {
    return null;
  }
}

function setCachedCredentials(items: CredentialMetadata[]): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(CREDENTIALS_CACHE_KEY, JSON.stringify(items));
  } catch {
    // Ignore storage quota / security errors
  }
}

/**
 * List credential metadata. Returns the list from the backend, falls back
 * to localStorage if the backend is offline or returns an error / 404.
 */
export async function listCredentials(): Promise<CredentialMetadata[]> {
  try {
    const res = await apiJson<{ items: CredentialMetadata[] }>(
      "/api/credentials",
      { method: "GET" },
    );
    const items = (res?.items || []).map((item) => ({
      ...item,
      envVar: item.envVar || toCredentialEnvVar(item.service, item.field),
    }));
    setCachedCredentials(items);
    return items;
  } catch (err) {
    const cached = getCachedCredentials();
    if (cached !== null) {
      return cached;
    }
    throw err;
  }
}

/**
 * Encrypt and store a credential. Updates the local cache on success.
 */
export async function saveCredential(
  input: SaveCredentialInput,
): Promise<CredentialMetadata> {
  const res = await apiJson<CredentialMetadata>("/api/credentials", {
    method: "PUT",
    body: JSON.stringify(input),
  });

  const updated: CredentialMetadata = {
    ...res,
    envVar: res.envVar || toCredentialEnvVar(res.service, res.field),
    usageDescription:
      res.usageDescription !== undefined
        ? res.usageDescription
        : input.usageDescription,
    allowedTools:
      res.allowedTools !== undefined ? res.allowedTools : input.allowedTools,
    allowedDomains:
      res.allowedDomains !== undefined
        ? res.allowedDomains
        : input.allowedDomains,
  };

  const cached = getCachedCredentials() || [];
  const idx = cached.findIndex(
    (c) => c.service === updated.service && c.field === updated.field,
  );
  if (idx >= 0) {
    cached[idx] = updated;
  } else {
    cached.unshift(updated);
  }
  setCachedCredentials(cached);

  return updated;
}

/**
 * Delete a credential by service and field.
 */
export async function deleteCredential(
  service: string,
  field: string,
): Promise<DeleteCredentialResult> {
  const res = await apiJson<DeleteCredentialResult>(
    `/api/credentials/${encodeURIComponent(service)}/${encodeURIComponent(field)}`,
    { method: "DELETE" },
  );

  const cached = getCachedCredentials();
  if (cached) {
    const filtered = cached.filter(
      (c) => !(c.service === service && c.field === field),
    );
    setCachedCredentials(filtered);
  }

  return res ?? { success: true };
}

/**
 * Validate a stored credential against its upstream provider (e.g. Composio).
 */
export async function validateCredential(
  service: string,
  field: string,
): Promise<ValidateCredentialResult> {
  return apiJson<ValidateCredentialResult>("/api/credentials/validate", {
    method: "POST",
    body: JSON.stringify({ service, field }),
  });
}

/**
 * Fetch one decrypted value so an admin can view it. Called only when the user
 * clicks a blurred value; the result is never cached or written to storage.
 */
export async function revealCredential(
  service: string,
  field: string,
): Promise<string> {
  const res = await apiJson<{ value: string }>(
    `/api/credentials/${encodeURIComponent(service)}/${encodeURIComponent(field)}/reveal`,
    { method: "GET" },
  );
  return res.value;
}
