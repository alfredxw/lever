import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function ErrorNotice({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="error-notice">
      <AlertCircle size={16} className="shrink-0" />
      <span>{error instanceof Error ? error.message : String(error)}</span>
      {retry && (
        <Button type="button" variant="outline" size="sm" onClick={retry}>
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}
export function Loading({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn("loading min-w-0 px-4 py-5", className)} role="status">
      <span className="sr-only">{t("common.loading")}</span>
      <div aria-hidden="true">
        {children ?? (
          <div className="flex max-w-lg flex-col gap-2.5">
            <Skeleton className="mb-1 h-4 w-2/5" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        )}
      </div>
    </div>
  );
}
export function initials(name: string) {
  return Array.from(name.trim()).slice(0, 2).join("").toUpperCase();
}
