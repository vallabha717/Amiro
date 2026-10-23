import type { ReactNode } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface DetailCardProps {
  id?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  accessory?: ReactNode;
  compactAccessory?: boolean;
  children?: ReactNode;
  showBorder?: boolean;
  className?: string;
}

/**
 * Reusable detail section card modeled on Vellum's DetailCard.
 * Combines consistent title, subtitle, accessory, and child sections.
 */
export function DetailCard({
  id,
  title,
  subtitle,
  accessory,
  compactAccessory = false,
  children,
  showBorder = true,
  className,
}: DetailCardProps) {
  const hasHeader = Boolean(title || subtitle || accessory);

  const headerContent = hasHeader ? (
    <div
      className={cn(
        "flex min-w-0 items-start justify-between gap-3",
        compactAccessory ? "flex-row items-center" : "flex-col sm:flex-row sm:items-start",
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        {title && (
          <h2 className="text-sm font-semibold tracking-tight text-foreground sm:text-base">
            {title}
          </h2>
        )}
        {subtitle && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {subtitle}
          </p>
        )}
      </div>
      {accessory && <div className="shrink-0">{accessory}</div>}
    </div>
  ) : null;

  if (!showBorder) {
    return (
      <section id={id} className={cn("space-y-4", className)}>
        {headerContent}
        {children != null && <div>{children}</div>}
      </section>
    );
  }

  return (
    <Card id={id} className={cn("gap-4 py-4 shadow-xs", className)}>
      {hasHeader && <CardHeader className="px-5 py-0">{headerContent}</CardHeader>}
      {children != null && (
        <CardContent className="px-5 py-0">
          {children}
        </CardContent>
      )}
    </Card>
  );
}
