import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { isMyGo, locale } from "mygo-runtime";
import { Appearance } from "@/api/desktop.gen";
import { enUS } from "./en-US";
import { zhCN } from "./zh-CN";

export const languages = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en-US", label: "English" },
] as const;

const saved = localStorage.getItem("lever:language");
const preferred = isMyGo() ? locale() : navigator.language;
const language = languages.some((entry) => entry.value === saved)
  ? saved!
  : preferred.startsWith("zh")
    ? "zh-CN"
    : "en-US";

void i18n.use(initReactI18next).init({
  resources: { "en-US": { translation: enUS }, "zh-CN": { translation: zhCN } },
  lng: language,
  fallbackLng: "en-US",
  supportedLngs: languages.map((entry) => entry.value),
  keySeparator: false,
  initAsync: false,
  interpolation: { escapeValue: false },
});
document.documentElement.lang = language;
i18n.on("languageChanged", (value) => {
  document.documentElement.lang = value;
  localStorage.setItem("lever:language", value);
});

export async function changeLanguage(value: string) {
  if (isMyGo()) await Appearance.setLanguage(value);
  await i18n.changeLanguage(value);
}

if (isMyGo()) {
  // A browser preference may predate the native shell's language setting.
  void Appearance.setLanguage(language).catch((error) =>
    console.error("Desktop language sync failed", error),
  );
}

export default i18n;
