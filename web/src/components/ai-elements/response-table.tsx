import type { ComponentProps } from "react";
import type { ExtraProps } from "streamdown";
import { useTranslation } from "react-i18next";
import { Maximize2 } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

// Keep Streamdown's cell rendering; use our dialog for focus trapping/restoration.
export function ResponseTable({
  children,
  className,
  node: _node,
  ...props
}: ComponentProps<"table"> & ExtraProps) {
  const { t } = useTranslation();
  const table = (
    <table
      {...props}
      data-streamdown="table"
      className={cn("response-table", className)}
    >
      {children}
    </table>
  );
  return (
    <Dialog>
      <div className="response-table-block group/response-table relative flex min-w-0 flex-col">
        <div className="absolute top-2 right-2 z-10 inline-flex rounded-md bg-background opacity-0 transition-opacity duration-150 motion-reduce:transition-none group-hover/response-table:opacity-100 group-has-[:focus-visible]/response-table:opacity-100 pointer-coarse:opacity-100 [@media(hover:none)]:opacity-100">
          <DialogTrigger asChild>
            <Button
              variant="outline"
              size="icon-xs"
              aria-label={t("chat.expandTable")}
              title={t("chat.expandTable")}
              className="text-muted-foreground hover:text-foreground focus-visible:text-foreground"
            >
              <Maximize2 />
            </Button>
          </DialogTrigger>
        </div>
        <div
          className="overflow-x-auto rounded-md border border-border outline-none focus-visible:border-foreground/30"
          role="region"
          aria-label={t("chat.tableContent")}
          tabIndex={0}
        >
          {table}
        </div>
      </div>
      <DialogContent
        className="flex h-[calc(100dvh-2rem)] flex-col pt-12 sm:max-w-[calc(100%-2rem)]"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">{t("chat.expandTable")}</DialogTitle>
        <div
          className="response-table-preview min-h-0 flex-1 overflow-auto rounded-md border border-border outline-none focus-visible:border-foreground/30"
          role="region"
          aria-label={t("chat.tableContent")}
          tabIndex={0}
        >
          {table}
        </div>
      </DialogContent>
    </Dialog>
  );
}
