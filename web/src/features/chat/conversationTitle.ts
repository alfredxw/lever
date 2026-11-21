import type { TFunction } from "i18next";
import type { Chat } from "@/api/types.gen";

export function displayChatTitle(
  chat: Pick<Chat, "title" | "titleIsCustom">,
  t: TFunction,
) {
  return !chat.title || (chat.title === "New chat" && !chat.titleIsCustom)
    ? t("workspace.newChat")
    : chat.title;
}
