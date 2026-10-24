"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { apiJson } from "@/lib/backend/client";

interface UploadOptions {
  filename?: string;
  contentType?: string;
}

interface UploadResult {
  pathname: string;
  url: string;
  contentType?: string;
  size?: number;
}

/**
 * Was storage-driver-branching (Vercel Blob direct upload / S3 presign /
 * local-FS multipart fallback), picked via getStorageInfoAction (a "use
 * server" file checking env vars). The Go sidecar's Storage interface
 * (internal/storage) always supports a presign-then-PUT flow on both its
 * backends -- LocalStorage signs its own `/storage/{token}` URL,
 * S3Storage uses the AWS SDK's real presigner (backend-go/internal/api/
 * storage/upload.go's own doc comment: "both of this rewrite's backends
 * presign uploads natively") -- so there's no branch left to make: every
 * upload goes through POST /api/storage/upload-url -> PUT <presigned URL>.
 * Vercel Blob isn't a thing either backend target implements (it was a
 * Vercel-hosting-specific service, out of scope per the plan's storage
 * row), so that branch is dropped rather than ported.
 */
export function useFileUpload() {
  const [isUploading, setIsUploading] = useState(false);

  const upload = useCallback(
    async (
      file: File,
      uploadOptions: UploadOptions = {},
    ): Promise<UploadResult | undefined> => {
      if (!(file instanceof File)) {
        toast.error("Upload expects a File instance");
        return;
      }

      const filename = uploadOptions.filename ?? file.name;
      const contentType =
        uploadOptions.contentType || file.type || "application/octet-stream";

      setIsUploading(true);
      try {
        const uploadUrlData = await apiJson<{
          key: string;
          url: string;
          method?: string;
          headers?: Record<string, string>;
          sourceUrl?: string;
        }>("/api/storage/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename, contentType }),
        }).catch((e: unknown) => {
          toast.error(e instanceof Error ? e.message : "Failed to get upload URL");
          return undefined;
        });
        if (!uploadUrlData) return;

        // The presigned URL is a real absolute URL (either the sidecar's
        // own /storage/{token} or a real S3 URL), not a bare /api path --
        // plain fetch, not apiFetch (which would double-prefix it with
        // the sidecar base URL). It's also deliberately not sent through
        // the shared-secret header: /storage/{token} is registered exempt
        // from that check (see middleware.RequireToken's exemptPrefixes
        // doc comment) precisely because a real presigned URL is its own
        // credential.
        const uploadResponse = await fetch(uploadUrlData.url, {
          method: uploadUrlData.method || "PUT",
          headers: uploadUrlData.headers || { "Content-Type": contentType },
          body: file,
        });

        if (!uploadResponse.ok) {
          toast.error(`Upload failed: ${uploadResponse.status}`);
          return;
        }

        return {
          pathname: uploadUrlData.key,
          url: uploadUrlData.sourceUrl ?? uploadUrlData.url,
          contentType,
          size: file.size,
        };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Upload failed";
        toast.error(message);
        return;
      } finally {
        setIsUploading(false);
      }
    },
    [],
  );

  return {
    upload,
    isUploading,
  };
}

// Alias for backward compatibility
export const usePresignedUpload = useFileUpload;
