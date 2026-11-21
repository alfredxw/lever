import type { TFunction } from "i18next";
import type { Catalog, Selection } from "@/api/types.gen";

export function hasDifferentModelSettings(a: Selection, b: Selection) {
  return a.model !== b.model || a.effort !== b.effort || a.fast !== b.fast;
}

function selectionModelName(
  t: TFunction,
  catalog: Catalog | null | undefined,
  selection: Selection,
) {
  const model =
    catalog?.provider === selection.provider
      ? catalog.models.find(({ id }) => id === selection.model)
      : undefined;
  return model?.name || selection.model || t("models.default");
}

export function steerModelHint(
  t: TFunction,
  catalog: Catalog | null | undefined,
  active: Selection,
  next: Selection,
) {
  if (!hasDifferentModelSettings(active, next)) return;
  const current = selectionModelName(t, catalog, active);
  return active.model === next.model
    ? t("queue.steerUsesActiveModel", { current })
    : t("queue.steerModelChangesNextTurn", {
        current,
        next: selectionModelName(t, catalog, next),
      });
}
