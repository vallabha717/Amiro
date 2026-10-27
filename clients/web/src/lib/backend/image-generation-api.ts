import { useEffect, useState } from "react";
import useSWR from "swr";
import { apiFetch, apiJson } from "./client";

/** One image provider Amiro can draw with. */
export type ImageProviderSpec = {
  kind: "9router" | "openai" | "gemini" | "openai-compatible";
  label: string;
  defaultModel: string;
  defaultApiBase?: string;
  needsApiBase?: boolean;
  docs: string;
};

export type ImageGenerationConfig = {
  provider: ImageProviderSpec["kind"];
  model: string;
  apiBase: string;
  keySet: boolean;
  keyHint?: string | null;
};

export type ImageGenerationSettings = {
  catalog: ImageProviderSpec[];
  config: ImageGenerationConfig | null;
};

export type GeneratedImageArtifact = {
  id: string;
  title: string;
  filename: string;
  mime: string;
  model: string;
  workspacePath: string;
};

export const IMAGE_GENERATION_KEY = "/api/image-generation";

export function useImageGenerationSettings() {
  return useSWR<ImageGenerationSettings>(IMAGE_GENERATION_KEY, () =>
    apiJson<ImageGenerationSettings>(IMAGE_GENERATION_KEY),
  );
}

/** Save the provider; leave `apiKey` empty to keep the saved key. */
export function saveImageGenerationSettings(body: {
  provider: string;
  model?: string;
  apiBase?: string;
  apiKey?: string;
}): Promise<ImageGenerationSettings> {
  return apiJson<ImageGenerationSettings>(IMAGE_GENERATION_KEY, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function clearImageGenerationSettings(): Promise<ImageGenerationSettings> {
  return apiJson<ImageGenerationSettings>(IMAGE_GENERATION_KEY, {
    method: "DELETE",
  });
}

/** Draw one picture with the configured provider; it is kept as an artifact. */
export function generateImage(prompt: string): Promise<GeneratedImageArtifact> {
  return apiJson<GeneratedImageArtifact>(`${IMAGE_GENERATION_KEY}/generate`, {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });
}

/**
 * An artifact image as an object URL. The download needs the sign-in header,
 * which a plain `<img src>` cannot send, so it is fetched and shown locally.
 */
export function useArtifactImage(id: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    void apiFetch(`/api/artifacts/${encodeURIComponent(id)}/download?inline=1`)
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (!blob || cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);
  return url;
}
