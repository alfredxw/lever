import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

export function TaskFilterOptions({
  options,
  selected,
  onChange,
  searchable = options.length > 8,
}: {
  options: { id: string; label: string; shortLabel?: string }[];
  selected: string[];
  onChange: (ids: string[]) => void;
  searchable?: boolean;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const term = search.trim().toLocaleLowerCase();
  const matches = options.filter(
    ({ label, shortLabel }) =>
      label.toLocaleLowerCase().includes(term) ||
      shortLabel?.toLocaleLowerCase().includes(term),
  );
  const searchLabel = t("tasks.searchFilterOptions");
  return (
    <>
      {searchable && (
        <Input
          type="search"
          aria-label={searchLabel}
          placeholder={searchLabel}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      )}
      <div className="min-h-0 overflow-y-auto">
        {matches.map(({ id, label }) => (
          <label key={id} className="task-board-filter-option">
            <Checkbox
              checked={selected.includes(id)}
              onCheckedChange={(checked) =>
                onChange(updateSelection(selected, id, checked))
              }
            />
            <span className="truncate" title={label}>
              {label}
            </span>
          </label>
        ))}
        {!matches.length && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            {t("tasks.noMatches")}
          </p>
        )}
      </div>
    </>
  );
}

function updateSelection(
  selected: string[],
  id: string,
  checked: boolean | "indeterminate",
) {
  return checked === true
    ? [...selected, id]
    : selected.filter((value) => value !== id);
}
