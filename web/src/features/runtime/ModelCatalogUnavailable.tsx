import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

export function ModelCatalogUnavailable({
  retry,
  disabled,
}: {
  retry: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span role="status">{t("models.runtimeNotFound")}</span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="text-foreground"
        disabled={disabled}
        onClick={retry}
      >
        {t("common.retry")}
      </Button>
    </div>
  );
}
