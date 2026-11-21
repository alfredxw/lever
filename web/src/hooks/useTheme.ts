import { useEffect, useState } from "react";

export type Theme = "system" | "light" | "dark";

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("lever:theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const dark = theme === "system" ? systemDark : theme === "dark";

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("lever:theme", theme);
  }, [theme, dark]);

  return { theme, setTheme, dark };
}
