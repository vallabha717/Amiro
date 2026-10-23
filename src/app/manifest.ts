import type { MetadataRoute } from "next";

// Lets a phone add Amiro to its home screen from the browser (after pairing
// at /pair). Static, so it is part of the exported `out/`.
export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Amiro",
    short_name: "Amiro",
    description: "Your own AI agent",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/web-app-manifest-192x192.png", sizes: "192x192", type: "image/png" },
      { src: "/web-app-manifest-512x512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
