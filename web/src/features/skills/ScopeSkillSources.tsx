import { ChevronDown, Folder, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { displayPath } from "@/lib/paths";
import type { useSkillSources } from "./skillsQuery";

export function ScopeSkillSources({
  sources,
  homeDir,
  fullWidth = false,
}: {
  sources: ReturnType<typeof useSkillSources>;
  homeDir: string;
  fullWidth?: boolean;
}) {
  const { t } = useTranslation();
  const groups = [
    {
      title: t("skills.userSources"),
      list: sources.data?.filter((item) => !item.scopeRootId),
    },
    {
      title: t("skills.scopeSources"),
      list: sources.data?.filter((item) => item.scopeRootId),
    },
  ];
  return (
    <Collapsible className={fullWidth ? undefined : "mt-3"}>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={
            fullWidth
              ? "group h-auto min-h-7 w-full justify-between px-0 py-1 text-left text-sm font-semibold whitespace-normal"
              : "group max-w-full"
          }
        >
          {!fullWidth && <Sparkles />}
          <span className={fullWidth ? undefined : "truncate"}>
            {t("skills.defaultSources")}
          </span>
          <ChevronDown className="group-data-[state=closed]:-rotate-90" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-3 px-2 pb-2 pt-1">
        {sources.error ? (
          <ErrorNotice
            error={sources.error}
            retry={() => void sources.refetch()}
          />
        ) : sources.isPending ? (
          <Loading />
        ) : (
          groups.map(({ title, list }) => (
            <section
              key={title}
              aria-label={title}
              className="grid gap-1 text-control"
            >
              <h3 className="font-medium">{title}</h3>
              {!list?.length ? (
                <p className="text-muted-foreground">{t("skills.noSources")}</p>
              ) : (
                <ul className="grid gap-1">
                  {list.map((source) => (
                    <li
                      key={source.path}
                      className="flex min-w-0 items-center gap-2 text-muted-foreground"
                    >
                      <Folder className="size-3.5 shrink-0" />
                      <span
                        className="min-w-0 flex-1 truncate"
                        title={source.path}
                      >
                        {displayPath(source.path, homeDir)}
                      </span>
                      <span
                        className="tabular-nums"
                        aria-label={t("skills.sourceCount", {
                          count: source.skills.length,
                        })}
                      >
                        {source.skills.length}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
