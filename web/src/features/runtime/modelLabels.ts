import type { TFunction } from "i18next";
import type { ModelInfo } from "@/api/types.gen";

export function modelSearchAliases(model: ModelInfo) {
  return model.resolvedModel ? [model.id, model.resolvedModel] : [model.id];
}

export function modelDescription(
  t: TFunction,
  model: ModelInfo,
  runtime: string,
) {
  if (model.requiresVersion) {
    return t("models.requiresVersion", {
      runtime,
      version: model.requiresVersion,
    });
  }
  return model.resolvedModel && model.resolvedModel !== model.id
    ? `${model.id} → ${model.resolvedModel}`
    : model.id;
}
