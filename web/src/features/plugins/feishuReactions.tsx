import { useEffect, useId, useState, type KeyboardEvent } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { SettingsRow } from "@/features/settings/SettingsControls";

export const FEISHU_REACTION_PATTERN = /^[A-Za-z0-9_+-]{1,64}$/;
export const CUSTOM_REACTION_OPTION = ":custom";

export const FEISHU_REACTION_ICONS = new Map<string, string>([
  ["OnIt", "🛠️"],
  ["Get", "📩"],
  ["OK", "👌"],
  ["THUMBSUP", "👍"],
  ["DONE", "✅"],
  ["OneSecond", "☝️"],
  ["THINKING", "🤔"],
  ["SALUTE", "🫡"],
  ["THANKS", "🙏"],
  ["HEART", "❤️"],
  ["APPLAUSE", "👏"],
  ["MUSCLE", "💪"],
  ["SMILE", "🙂"],
  ["LAUGH", "😄"],
  ["PARTY", "🎉"],
]);

export function feishuReactionOption(key: string, t: TFunction) {
  const icon = FEISHU_REACTION_ICONS.get(key);
  return {
    id: key,
    label: icon ? t(`personal.reaction.${key}`) : key,
    icon: icon && <span aria-hidden="true">{icon}</span>,
    keywords: icon ? [key, icon] : [key],
  };
}

export function FeishuReactionSetting({
  title,
  description,
  emptyLabel,
  value,
  disabled,
  onChange,
}: {
  title: string;
  description?: string;
  emptyLabel: string;
  value: string;
  disabled?: boolean;
  onChange: (next: string) => void;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const trimmed = value.trim();
  const isPresetOrEmpty = !trimmed || FEISHU_REACTION_ICONS.has(trimmed);
  const [customMode, setCustomMode] = useState(!isPresetOrEmpty);
  const [customDraft, setCustomDraft] = useState(trimmed);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    const nextTrimmed = value.trim();
    const nextPresetOrEmpty =
      !nextTrimmed || FEISHU_REACTION_ICONS.has(nextTrimmed);
    setCustomDraft(nextTrimmed);
    if (!nextPresetOrEmpty) {
      setCustomMode(true);
    } else if (nextTrimmed) {
      setCustomMode(false);
    }
  }, [value]);

  const draftTrimmed = customDraft.trim();
  const invalid =
    customMode &&
    (!draftTrimmed || !FEISHU_REACTION_PATTERN.test(draftTrimmed));
  const showError = invalid && (!!draftTrimmed || touched);

  const commitCustom = () => {
    setTouched(true);
    if (!draftTrimmed) {
      if (trimmed) onChange("");
      return;
    }
    if (!FEISHU_REACTION_PATTERN.test(draftTrimmed)) return;
    if (draftTrimmed !== trimmed) {
      onChange(draftTrimmed);
    }
  };

  const onCustomKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitCustom();
    }
  };

  return (
    <>
      <SettingsRow id={fieldId} title={title} description={description}>
        <SearchableSelect
          id={fieldId}
          label={title}
          placeholder={emptyLabel}
          searchLabel={t("personal.searchReactions")}
          emptyLabel={t("personal.noReactions")}
          className="w-44 max-w-full"
          disabled={disabled}
          value={customMode ? CUSTOM_REACTION_OPTION : trimmed}
          options={[
            { id: "", label: emptyLabel },
            ...Array.from(FEISHU_REACTION_ICONS.keys(), (id) =>
              feishuReactionOption(id, t),
            ),
            {
              id: CUSTOM_REACTION_OPTION,
              label: t("personal.customReaction"),
            },
          ]}
          onChange={(choice) => {
            if (choice === CUSTOM_REACTION_OPTION) {
              setCustomMode(true);
              setCustomDraft(FEISHU_REACTION_ICONS.has(trimmed) ? "" : trimmed);
              setTouched(false);
              return;
            }
            setCustomMode(false);
            setCustomDraft(choice);
            setTouched(false);
            if (choice !== trimmed) {
              onChange(choice);
            }
          }}
        />
      </SettingsRow>
      {customMode && (
        <SettingsRow
          id={`${fieldId}-custom`}
          title={t("personal.emoji")}
          description={t("personal.emojiHint")}
        >
          <div className="flex w-44 max-w-full flex-col gap-1">
            <Input
              id={`${fieldId}-custom`}
              className="font-mono text-xs"
              maxLength={64}
              placeholder="FINGERHEART"
              value={customDraft}
              disabled={disabled}
              aria-invalid={showError || undefined}
              aria-describedby={
                showError
                  ? `${fieldId}-custom-description ${fieldId}-custom-error`
                  : `${fieldId}-custom-description`
              }
              onChange={(event) => setCustomDraft(event.target.value)}
              onBlur={commitCustom}
              onKeyDown={onCustomKeyDown}
            />
            {showError && (
              <FieldError id={`${fieldId}-custom-error`} className="text-xs">
                {t("personal.invalidEmoji")}
              </FieldError>
            )}
          </div>
        </SettingsRow>
      )}
    </>
  );
}
