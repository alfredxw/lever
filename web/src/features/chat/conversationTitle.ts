import type { TFunction } from "i18next";
import type { Chat } from "@/api/types.gen";

export function displayChatTitle(
  chat: Pick<Chat, "title" | "titleIsCustom" | "source">,
  t: TFunction,
) {
  if (
    chat.source === "workItem" &&
    !chat.titleIsCustom &&
    (!chat.title || chat.title === "Work items")
  )
    return t("tasks.workItemsChat");
  return !chat.title || (chat.title === "New chat" && !chat.titleIsCustom)
    ? t("workspace.newChat")
    : chat.title;
}
