import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Command } from "cmdk";
import { FileText, FolderOpen, Plus, Search, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { Skill } from "@/api/types.gen";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
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
import { directoryName, displayPath } from "@/lib/paths";
import { SkillDialog } from "./SkillDialog";
import { skillGroup, skillsQuery } from "./skillsQuery";
import "./skills.css";

export function ProfileSkills({
  paths,
  homeDir,
  onChange,
}: {
  paths: string[];
  homeDir: string;
  onChange: (paths: string[]) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [addingDirectory, setAddingDirectory] = useState(false);
  const library = useQuery({
    ...skillsQuery,
    enabled: open || paths.length > 0,
  });
  const attached = new Set(paths.map(directoryName));
  const choices =
    library.data?.filter(
      (skill) => skill.available && !attached.has(directoryName(skill.path)),
    ) ?? [];
  const add = (skill: Skill) => {
    if (attached.has(directoryName(skill.path))) {
      toast.info(
        t("skills.alreadyAttached", { name: directoryName(skill.path) }),
      );
      return;
    }
    onChange([...paths, skill.path]);
    setOpen(false);
  };
  return (
    <Card className="profile-card">
      <CardHeader>
        <CardTitle>{t("skills.additional")}</CardTitle>
        <CardAction>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button type="button" variant="ghost" size="sm">
                <Plus data-icon="inline-start" />
                {t("profile.addSkill")}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="skills-picker"
              aria-label={t("profile.addSkill")}
              onCloseAutoFocus={(event) =>
                addingDirectory && event.preventDefault()
              }
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
                {library.isPending ? (
                  <Loading />
                ) : library.error ? (
                  <ErrorNotice
                    error={library.error}
                    retry={() => void library.refetch()}
                  />
                ) : (
                  <Command.List>
                    <Command.Empty>{t("skills.noMatching")}</Command.Empty>
                    {choices.map((skill) => (
                      <Command.Item
                        key={skill.id}
                        value={skill.id}
                        keywords={[skill.name, skill.description, skill.path]}
                        title={displayPath(skill.path, homeDir)}
                        onSelect={() => add(skill)}
                      >
                        <FileText className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">
                          {skill.name}
                        </span>
                        <small className="shrink-0 text-muted-foreground">
                          {t(skillGroup(skill))}
                        </small>
                      </Command.Item>
                    ))}
                  </Command.List>
                )}
              </Command>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-1 w-full justify-start"
                onClick={() => {
                  setOpen(false);
                  setAddingDirectory(true);
                }}
              >
                <FolderOpen />
                {t("skills.addDirectory")}
              </Button>
            </PopoverContent>
          </Popover>
        </CardAction>
      </CardHeader>
      <CardContent>
        {paths.length === 0 ? (
          <Empty className="profile-empty">
            <EmptyDescription>{t("profile.skillHint")}</EmptyDescription>
          </Empty>
        ) : (
          <ul className="grid gap-1.5">
            {paths.map((path, index) => {
              const skill = library.data?.find((item) => item.path === path);
              return (
                <li key={path} className="flex min-w-0 items-center gap-2">
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                  <span
                    className="flex-1 truncate text-control"
                    title={displayPath(path, homeDir)}
                  >
                    {skill?.name ?? directoryName(path)}
                  </span>
                  {skill && !skill.available && (
                    <small className="text-muted-foreground">
                      {t("skills.unavailable")}
                    </small>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("profile.removeSkill")}
                    onClick={() =>
                      onChange(paths.filter((_, i) => i !== index))
                    }
                  >
                    <Trash2 />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
      {addingDirectory && (
        <SkillDialog
          mode="directory"
          homeDir={homeDir}
          onClose={() => setAddingDirectory(false)}
          onSaved={(skill) => {
            add(skill);
            setAddingDirectory(false);
          }}
        />
      )}
    </Card>
  );
}
