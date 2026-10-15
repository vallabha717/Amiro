import type { ReactNode } from "react";

export default function AgentLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className="h-full min-h-0 w-full"
      style={{
        fontFamily:
          "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
      }}
    >
      {children}
    </div>
  );
}
