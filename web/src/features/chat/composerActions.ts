import type { TFunction } from "i18next";
import type { NativeCommand, Reference } from "@/api/types.gen";
import { searchComposerOptions } from "./composerSearch";

export type ComposerCommand = "chat" | "topic" | "model" | "compare" | "after";
export type ComposerPage = "actions" | "command" | "mention" | "goal";
export type ComposerBrowser = { page: ComposerPage; query: string };
export type ComposerOption = {
  id: string;
  name: string;
  description: string;
  reference?: Reference;
  command?: ComposerCommand;
  native?: boolean;
  action?: "attach" | "runApprovals" | "command" | "mention" | "goal";
};

const reserved = new Set([
  "chat",
  "topic",
  "model",
  "compare",
  "after",
  "clear",
  "effort",
  "fast",
  "permissions",
]);
const commonNative = new Set(["goal", "loop", "compact", "context"]);

export function runtimeOptions(commands: NativeCommand[]): ComposerOption[] {
  const seen = new Set(reserved);
  return commands
    .filter(({ name }) => {
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    })
    .sort(
      (a, b) =>
        Number(commonNative.has(b.name)) - Number(commonNative.has(a.name)),
    )
    .map(({ name, argumentHint, description }) => ({
      id: `native:${name}`,
      name: `/${name}`,
      description: [argumentHint, description].filter(Boolean).join(" · "),
      native: true,
    }));
}

export function actionOptions(
  t: TFunction,
  commands: ComposerOption[],
  native: ComposerOption[],
  skills: ComposerOption[],
  query: string,
  runApprovals?: boolean,
): ComposerOption[] {
  const candidates = [...commands, ...native];
  const featured = [
    "/compare",
    "/after",
    "/chat",
    "/topic",
    "/goal",
    "/model",
  ].flatMap((name) => candidates.find((option) => option.name === name) ?? []);
  const remaining = native.filter((option) => option.name !== "/goal");
  const options: ComposerOption[] = [
    {
      id: "attach",
      name: t("attachments.add"),
      description: "",
      action: "attach",
    },
  ];
  if (runApprovals !== undefined) {
    options.push({
      id: "runApprovals",
      name: t(
        runApprovals ? "permissions.resumeAsking" : "permissions.allowRun",
      ),
      description: runApprovals ? "" : t("permissions.allowRunHint"),
      action: "runApprovals",
    });
  }
  options.push(
    ...featured,
    ...(query ? remaining : remaining.slice(0, 3)),
    ...(query ? skills : []),
    {
      id: "commands",
      name: t("composer.browseCommands"),
      description: "/",
      action: "command",
    },
    {
      id: "references",
      name: t("composer.browseReferences"),
      description: "@",
      action: "mention",
    },
  );
  return searchComposerOptions(options, query);
}

export function goalOptions(
  t: TFunction,
  status: string,
  runtimeType?: string,
): ComposerOption[] {
  const controls = [
    { name: "/goal status", description: t("composer.goalShow") },
    ...(runtimeType === "codex" && status === "active"
      ? [{ name: "/goal pause", description: t("composer.goalPause") }]
      : []),
    ...(runtimeType === "codex" && status === "paused"
      ? [{ name: "/goal resume", description: t("composer.goalResume") }]
      : []),
    { name: "/goal", description: t("composer.goalSet") },
    { name: "/goal clear", description: t("composer.goalClear") },
  ];
  return controls.map((option) => ({
    ...option,
    id: option.name,
    native: true,
  }));
}
