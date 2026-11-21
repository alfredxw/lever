import { useState } from "react";
import { Command } from "cmdk";
import { Check, ChevronDown, GitBranch, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { GitBranch as Branch } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
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

export function BranchPicker({
  label,
  value,
  branches,
  onChange,
}: {
  label: string;
  value: string;
  branches: Branch[];
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const selected = branches.find((branch) => branch.ref === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="diff-ref-trigger"
          aria-label={label}
          title={selected?.name}
          disabled={branches.length === 0}
        >
          <span className="truncate">
            {selected?.name ?? t("diff.selectBranch")}
          </span>
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="diff-menu diff-branch-menu"
        align="start"
        aria-label={label}
      >
        <Command label={label} defaultValue={value} loop>
          <InputGroup className="diff-branch-search">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <Command.Input asChild>
              <InputGroupInput
                aria-label={t("diff.searchBranches")}
                placeholder={t("diff.searchBranches")}
              />
            </Command.Input>
          </InputGroup>
          <Command.List>
            <Command.Empty>{t("diff.noMatchingBranches")}</Command.Empty>
            <Command.Group heading={t("diff.branches")}>
              {branches.map((branch) => (
                <Command.Item
                  key={branch.ref}
                  value={branch.ref}
                  keywords={[branch.name]}
                  data-checked={branch.ref === value}
                  onSelect={() => {
                    onChange(branch.ref);
                    setOpen(false);
                  }}
                >
                  <GitBranch />
                  <span className="truncate">{branch.name}</span>
                  {branch.ref === value && <Check className="ml-auto" />}
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
