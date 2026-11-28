import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
export type TableSize = { rows: number; cols: number };
export function NoteTableSize({
  onChoose,
}: {
  onChoose: (size: TableSize) => void;
}) {
  const { t } = useTranslation();
  const [size, setSize] = useState({ rows: 3, cols: 3 });
  return (
    <div className="note-table-size" aria-label={t("tasks.table.size")}>
      <output>
        {size.rows} × {size.cols}
      </output>
      <div className="note-table-size-grid">
        {Array.from({ length: 36 }, (_, i) => {
          const rows = Math.floor(i / 6) + 1,
            cols = (i % 6) + 1;
          return (
            <Button
              key={i}
              size="icon-xs"
              variant="ghost"
              data-highlighted={
                (rows <= size.rows && cols <= size.cols) || undefined
              }
              aria-label={t("tasks.table.dimensions", { rows, cols })}
              autoFocus={rows === 3 && cols === 3}
              onFocus={() => setSize({ rows, cols })}
              onMouseEnter={() => setSize({ rows, cols })}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onChoose({ rows, cols })}
              onKeyDown={(e) => {
                const by: Record<string, number> = {
                  ArrowRight: 1,
                  ArrowLeft: -1,
                  ArrowUp: -6,
                  ArrowDown: 6,
                };
                if (e.key in by) {
                  e.preventDefault();
                  e.stopPropagation();
                  const index = Math.min(35, Math.max(0, i + by[e.key]));
                  (
                    e.currentTarget.parentElement?.children[
                      index
                    ] as HTMLButtonElement
                  )?.focus();
                }
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
