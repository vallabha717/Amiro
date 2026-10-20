import { NextRequest, NextResponse } from "next/server";

/** The dev API proxy supports SSH and HTTPS port forwarding without weakening
 * the backend's origin checks. Only the frontend's own origin is translated. */
export function proxy(request: NextRequest) {
  if (process.env.NODE_ENV !== "development") return NextResponse.next();

  const headers = new Headers(request.headers);
  const origin = headers.get("origin");
  if (origin) {
    let authority: string;
    try {
      authority = new URL(origin).host;
    } catch {
      return NextResponse.json({ error: "invalid origin" }, { status: 403 });
    }
    const host = headers.get("host");
    const forwardedHost = headers.get("x-forwarded-host")?.split(",")[0].trim();
    if (authority !== host && authority !== forwardedHost) {
      return NextResponse.json(
        { error: "origin not allowed" },
        { status: 403 },
      );
    }
    // Next's rewrite proxy sends `X-Forwarded-Host: <this request's Host>`, and
    // the backend checks Origin against that forwarded host (plus
    // X-Forwarded-Proto, defaulting to http). Name exactly that origin.
    const proto =
      headers.get("x-forwarded-proto")?.split(",")[0].trim() || "http";
    headers.set("origin", `${proto}://${host}`);
  }
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/api/:path*", "/storage/:path*", "/health"],
};
