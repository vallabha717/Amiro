import type { ReactNode } from "react";

interface UserDetailLayoutProps {
  children: ReactNode;
}

export default function UserDetailLayout({ children }: UserDetailLayoutProps) {
  return (
    <div className="relative bg-window w-full min-h-screen">{children}</div>
  );
}
