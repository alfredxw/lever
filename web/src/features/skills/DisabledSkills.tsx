import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Command } from "cmdk";
import { Ban, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { skillsQuery, type useSkillSources } from "./skillsQuery";
import "./skills.css";

export function DisabledSkills({
  names,
  attached,
  sources,
  supported,
  skillContext,
  onChange,
}: {
  names: string[];
  attached: string[];
  sources: ReturnType<typeof useSkillSources>;
  supported: boolean;
  skillContext?: boolean;
  onChange: (names: string[]) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const library = useQuery({
    ...skillsQuery,
    enabled: open && attached.length > 0,
  });
  const choices = new Map(
    (sources.data ?? [])
      .flatMap((source) => source.skills)
      .map((skill) => [skill.name.toLowerCase(), skill] as const),
  );
  for (const skill of library.data ?? []) {
    if (attached.includes(skill.path))
      choices.set(skill.name.toLowerCase(), skill);
  }
  for (const name of names) choices.delete(name.toLowerCase());
  const error = sources.error ?? (attached.length ? library.error : null);
  return (
    <Card className="profile-card">
      <CardHeader>
        <CardTitle>{t("skills.disabled")}</CardTitle>
        <CardAction>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!supported}
              >
                <Ban />
                {t("skills.disable")}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="skills-picker"
              aria-label={t("skills.disable")}
            >
              <Command label={t("skills.search")} loop>
                <InputGroup>
                  <InputGroupAddon>
                    <Search />
                  </InputGroupAddon>
                  <Command.Input asChild>
                    <InputGroupInput
                      aria-label={t("skills.search")}
                      placeholder={t("skills.search")}
                    />
                  </Command.Input>
                </InputGroup>
                {error ? (
                  <ErrorNotice
                    error={error}
                    retry={() =>
                      error === sources.error
                        ? void sources.refetch()
                        : void library.refetch()
                    }
                  />
                ) : sources.isPending ||
                  (attached.length > 0 && library.isPending) ? (
                  <Loading />
                ) : (
                  <Command.List>
                    <Command.Empty>{t("skills.noMatching")}</Command.Empty>
                    {Array.from(choices, ([name, skill]) => (
                      <Command.Item
                        key={name}
                        value={name}
                        keywords={[skill.description, skill.path]}
                        onSelect={() => {
                          onChange([...names, skill.name]);
                          setOpen(false);
                        }}
                      >
                        <span className="truncate">{skill.name}</span>
                      </Command.Item>
                    ))}
                  </Command.List>
                )}
              </Command>
            </PopoverContent>
          </Popover>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-2">
        {names.length ? (
          <ul className="grid gap-1">
            {names.map((name) => (
              <li key={name} className="flex items-center gap-2">
                <span
                  className="min-w-0 flex-1 truncate text-control"
                  title={name}
                >
                  {name}
                </span>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("skills.enable", { name })}
                  title={t("skills.enable", { name })}
                  onClick={() =>
                    onChange(names.filter((other) => other !== name))
                  }
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="profile-note">
          {t(
            !supported
              ? "skills.unsupported"
              : skillContext
                ? "skills.contextHint"
                : "skills.disabledHint",
          )}
        </p>
      </CardContent>
    </Card>
  );
}
