import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import "katex/dist/katex.min.css";
import {
  ThemeProvider,
  ThemeStyleProvider,
} from "@/components/layouts/theme-provider";
import { Toaster } from "ui/sonner";
import { LocaleProvider } from "@/components/layouts/locale-provider";
import { BackendSessionProvider } from "@/lib/backend/session-context";
import { VEGA_PALETTE_INIT_SCRIPT } from "@/lib/vega-themes";

const dmSans = localFont({
  src: "../fonts/DMSans-Regular.ttf",
  variable: "--font-dm-sans",
  display: "swap",
});

const dmMono = localFont({
  src: [
    {
      path: "../fonts/DMMono-Regular.ttf",
      weight: "400",
      style: "normal",
    },
    {
      path: "../fonts/DMMono-Medium.ttf",
      weight: "500",
      style: "normal",
    },
  ],
  variable: "--font-dm-mono",
  display: "swap",
});

const instrumentSerif = localFont({
  src: "../fonts/InstrumentSerif-Regular.ttf",
  variable: "--font-instrument-serif",
  weight: "400",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Amiro",
  description: "Amiro is a chatbot that uses the Tools to answer questions.",
  icons: {
    icon: "/Vrnda_logo.svg",
  },
};

// Phones: match the browser bar to the theme. Pinch zoom stays allowed.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // `data-theme="default"` selects VegaAI's Graphite palette (globals.css).
    // The font variables sit on <html> so the root font stack (Tailwind's
    // preflight reads `--font-sans` there) resolves to DM Sans everywhere.
    <html
      lang="en"
      data-theme="default"
      className={`${dmSans.variable} ${dmMono.variable} ${instrumentSerif.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Applies the saved VegaAI palette before first paint. */}
        <script
          dangerouslySetInnerHTML={{ __html: VEGA_PALETTE_INIT_SCRIPT }}
        />
      </head>
      <body
        className={`${dmSans.variable} ${dmMono.variable} ${instrumentSerif.variable} antialiased`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          themes={["light", "dark"]}
          storageKey="app-theme-v2"
          disableTransitionOnChange
        >
          <ThemeStyleProvider>
            <LocaleProvider>
              <BackendSessionProvider>
                <div id="root">
                  {children}
                  <Toaster richColors />
                </div>
              </BackendSessionProvider>
            </LocaleProvider>
          </ThemeStyleProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
