import type { NextConfig } from "next";

// package.json's "type": "module" means this file has no CommonJS
// __dirname -- import.meta.dirname is its ESM equivalent (Node 20.11+).
const PROJECT_ROOT = import.meta.dirname;

export default () => {
  const isDev = process.env.NODE_ENV === "development";
  const devBackend =
    process.env.AMIRO_DEV_BACKEND_URL || "http://127.0.0.1:8787";
  const nextConfig: NextConfig = {
    // A real `tauri build` needs static frontendDist files, not a running
    // Node server -- bundling Node would defeat the point of this rewrite
    // (a small Go-only executable, no Node runtime, see
    // docs/desktop-rewrite-go-rust-plan.md section 7). Phase 8's own
    // handoff doc found this out by actually trying it: Phase 7 was wrong
    // to call static export "an optimization, not a blocker". `next dev`
    // (devUrl in tauri.conf.json) doesn't need this, only `tauri build`
    // does.
    output: isDev ? undefined : "export",
    ...(isDev
      ? {
          async rewrites() {
            return {
              beforeFiles: [
                {
                  source: "/api/:path*",
                  destination: `${devBackend}/api/:path*`,
                },
                {
                  source: "/storage/:path*",
                  destination: `${devBackend}/storage/:path*`,
                },
                { source: "/health", destination: `${devBackend}/health` },
              ],
              afterFiles: [
                {
                  source: "/:agent/:path*",
                  destination: "/:path*",
                },
                {
                  source: "/:agent",
                  destination: "/",
                },
              ],
              fallback: [],
            };
          },
        }
      : {}),
    cleanDistDir: true,
    devIndicators: {
      position: "bottom-right",
    },
    // desktop/ is a sibling pnpm workspace to the repo root (its own
    // package.json + pnpm-lock.yaml), not a member of the root's workspace.
    // Without pinning this, Next's root-inference sees both lockfiles and
    // sometimes picks the repo root instead of desktop/ itself, which
    // resolves modules (e.g. instrumentation.ts) against the wrong src/
    // tree entirely -- confirmed live via a real "Cannot find module" dev
    // server crash caused by exactly this.
    turbopack: {
      root: PROJECT_ROOT,
    },
    env: {
      NO_HTTPS: process.env.NO_HTTPS,
      NEXT_PUBLIC_BACKEND_URL: isDev ? "" : process.env.NEXT_PUBLIC_BACKEND_URL,
    },
    // authInterrupts (forbidden()/unauthorized()) and serverActions are
    // both RSC-server features -- static export has no server, and Phase 7
    // already replaced every call site with client-side equivalents
    // (RequireAuth/RequireAdmin, lib/backend/*-api.ts fetches). taint stays
    // since it's a React/client feature, unrelated to the server runtime.
    experimental: {
      taint: true,
    },
  };
  return nextConfig;
};
