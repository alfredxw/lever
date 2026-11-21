import type { ReactNode } from "react";
import { LayoutGrid } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export function OverviewNavigation({
  label,
  groupLabel,
  toolbar,
  current,
  onOverview,
  children,
}: {
  label: string;
  groupLabel?: string;
  toolbar?: ReactNode;
  current: boolean;
  onOverview: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <nav
      className="flex min-h-0 flex-1 flex-col px-(--sidebar-gutter) pt-1 pb-2.5"
      aria-label={label}
    >
      <Button
        variant="ghost"
        className="sidebar-nav-item"
        aria-current={current ? "page" : undefined}
        onClick={onOverview}
      >
        <LayoutGrid
          data-icon="inline-start"
          className="text-muted-foreground"
        />
        {t("common.overview")}
      </Button>
      {children && (
        <>
          <Separator className="mt-2.5 mb-2" />
          {toolbar}
          {groupLabel && (
            <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">
              {groupLabel}
            </h2>
          )}
          <div className="min-h-0 space-y-0.5 overflow-auto">{children}</div>
        </>
      )}
    </nav>
  );
}
