import { useTranslation } from "react-i18next";

export function WorkspaceDivider({
  ratio,
  onChange,
}: {
  ratio: number;
  onChange: (ratio: number) => void;
}) {
  const { t } = useTranslation();
  const resize = (value: number) =>
    onChange(Math.max(20, Math.min(80, Math.round(value))));
  return (
    <div
      className="workspace-divider"
      role="separator"
      tabIndex={0}
      aria-label={t("workspace.resizePanes")}
      aria-orientation="vertical"
      aria-valuemin={20}
      aria-valuemax={80}
      aria-valuenow={ratio}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const rect = event.currentTarget.parentElement!.getBoundingClientRect();
        resize(((event.clientX - rect.left) / rect.width) * 100);
      }}
      onPointerUp={(event) =>
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      onDoubleClick={() => onChange(50)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") resize(ratio - 5);
        else if (event.key === "ArrowRight") resize(ratio + 5);
        else if (event.key === "Home") resize(20);
        else if (event.key === "End") resize(80);
        else return;
        event.preventDefault();
      }}
    />
  );
}
