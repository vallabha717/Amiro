import type { Metadata } from "next";
import { Geist, Geist_Mono, Fraunces } from "next/font/google";
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

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Amiro",
  description: "Amiro is a chatbot that uses the Tools to answer questions.",
  icons: {
    icon: "/Vrnda_logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // `data-theme="default"` selects VegaAI's Graphite palette (globals.css).
    // The font variables sit on <html> so the root font stack (Tailwind's
    // preflight reads `--font-sans` there) resolves to Fraunces everywhere.
    <html
      lang="en"
      data-theme="default"
      className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Applies the saved VegaAI palette before first paint. */}
        <script
          dangerouslySetInnerHTML={{ __html: VEGA_PALETTE_INIT_SCRIPT }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} antialiased`}
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
