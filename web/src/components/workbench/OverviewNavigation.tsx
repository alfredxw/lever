import type { ReactNode } from "react";
import { LayoutGrid } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export function OverviewNavigation({
  label,
  overviewLabel,
  count,
  search,
  groupLabel,
  topItems,
  toolbar,
  footer,
  current,
  onOverview,
  children,
}: {
  label: string;
  overviewLabel?: string;
  count?: number;
  search?: ReactNode;
  groupLabel?: string;
  topItems?: ReactNode;
  toolbar?: ReactNode;
  footer?: ReactNode;
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
      {search}
      <div className="flex shrink-0 flex-col gap-0.5">
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
          <span className="min-w-0 flex-1 truncate text-start">
            {overviewLabel ?? t("common.overview")}
          </span>
          {count !== undefined && (
            <span
              className="text-[11px] text-muted-foreground tabular-nums"
              aria-hidden="true"
            >
              {count}
            </span>
          )}
        </Button>
        {topItems}
      </div>
      {children && (
        <>
          <Separator className="mt-2.5 mb-2 shrink-0" />
          {toolbar}
          {groupLabel && (
            <h2 className="shrink-0 px-2 pb-1 text-xs font-medium text-muted-foreground">
              {groupLabel}
            </h2>
          )}
          <div className="min-h-0 flex-1 space-y-0.5 overflow-auto">
            {children}
          </div>
        </>
      )}
      {footer && (
        <div className="mt-2 shrink-0 border-t border-border/60 pt-2">
          {footer}
        </div>
      )}
    </nav>
  );
}
