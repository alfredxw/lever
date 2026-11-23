import type { TFunction } from "i18next";
import type { ChannelOrigin, Chat } from "@/api/types.gen";

export function formatChannelOrigin(
  origin: ChannelOrigin | undefined,
  t: TFunction,
) {
  if (!origin) return "";
  const source = origin.chatName
    ? origin.kind === "dm"
      ? `${t("personal.sourceDm")} · ${origin.chatName}`
      : origin.chatName
    : origin.chatId
      ? `${t(origin.kind === "dm" ? "personal.sourceDm" : "personal.sourceGroup")} · ${origin.chatId}`
      : "";
  return [source, origin.command].filter(Boolean).join(" · ");
}

export function displayChatTitle(
  chat: Pick<Chat, "title" | "titleIsCustom" | "source">,
  t: TFunction,
) {
  if (
    chat.source === "works" &&
    !chat.titleIsCustom &&
    (!chat.title || chat.title === "Works")
  )
    return t("tasks.worksChat");
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
