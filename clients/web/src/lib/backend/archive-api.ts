"use client";

// Replaces src/app/api/archive/actions.ts's exports with fetches against
// the Go sidecar (internal/api/archive, ownership-checked server-side the
// same way -- see that package's requireOwnedArchive helper).
// getItemArchivesAction is not ported: it has no client call site (dead
// code even before Phase 7, confirmed by grep).
import { apiJson } from "./client";

export async function createArchive(data: {
  name: string;
  description?: string;
}) {
  return apiJson("/api/archive", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateArchive(
  id: string,
  data: { name?: string; description?: string },
) {
  return apiJson(`/api/archive/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteArchive(id: string) {
  await apiJson(`/api/archive/${id}`, { method: "DELETE" });
}

export async function addItemToArchive(archiveId: string, itemId: string) {
  return apiJson(`/api/archive/${archiveId}/items`, {
    method: "POST",
    body: JSON.stringify({ itemId }),
  });
}

export async function removeItemFromArchive(archiveId: string, itemId: string) {
  await apiJson(`/api/archive/${archiveId}/items/${itemId}`, {
    method: "DELETE",
  });
}
