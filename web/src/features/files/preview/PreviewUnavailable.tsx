import { createContext, useContext } from "react";
import { useTranslation } from "react-i18next";
import { Download, File } from "lucide-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/common";
import { PreviewLoadError } from "./fileKind";

export const PreviewDownload = createContext("");

export function PreviewUnavailable() {
  const { t } = useTranslation();
  const download = useContext(PreviewDownload);
  return (
    <Empty className="file-preview-unavailable">
      <EmptyHeader>
        <EmptyMedia className="text-muted-foreground">
          <File className="size-10" strokeWidth={1.5} />
        </EmptyMedia>
        <EmptyTitle>{t("files.unsupportedTitle")}</EmptyTitle>
        <EmptyDescription>{t("files.unsupportedDescription")}</EmptyDescription>
      </EmptyHeader>
      {download && (
        <Button asChild variant="outline" size="sm">
          <a href={download} download>
            <Download />
            {t("files.download")}
          </a>
        </Button>
      )}
    </Empty>
  );
}

export function PreviewFailure({ error }: { error: unknown }) {
  return error instanceof PreviewLoadError ? (
    <ErrorNotice error={error} />
  ) : (
    <PreviewUnavailable />
  );
}
