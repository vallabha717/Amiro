import {
  toCredentialEnvVar,
  type CredentialMetadata,
} from "@/lib/backend/credentials-api";

/**
 * Non-route helpers for the admin credentials page. Kept out of the App Router
 * route module (`page.tsx`) because that file may only export Next-supported
 * route symbols (default, metadata, etc.).
 */

export function credentialEnvVar(credential: CredentialMetadata): string {
  return (
    credential.envVar || toCredentialEnvVar(credential.service, credential.field)
  );
}

export function filterCredentials(
  credentials: CredentialMetadata[],
  searchQuery: string,
): CredentialMetadata[] {
  const q = searchQuery.toLowerCase().trim();
  if (!q) return credentials;
  return credentials.filter((credential) => {
    const envVar = credentialEnvVar(credential);
    const haystack = [
      credential.service,
      credential.field,
      `${credential.service}/${credential.field}`,
      credential.label ?? "",
      credential.usageDescription ?? "",
      credential.hint ?? "",
      envVar,
      (credential.allowedDomains ?? []).join(" "),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}

export function validateCredentialDraft(draft: {
  service: string;
  field: string;
  value: string;
}): string | null {
  if (!draft.service.trim()) return "Service name is required";
  if (!draft.field.trim()) return "Field name is required";
  if (!draft.value.trim()) return "Secret value is required";
  return null;
}
