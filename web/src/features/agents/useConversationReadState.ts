import { useCallback, useEffect, useMemo, useState } from "react";
import type { Conversation } from "@/api/types.gen";

const storageKey = "lever:read-sessions";

export function loadSessionCursors(key: string): Record<string, number> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        ([, cursor]) => Number.isSafeInteger(cursor) && cursor >= 0,
      ),
    );
  } catch {
    return {};
  }
}

export function useConversationReadState(
  conversations: Conversation[] | undefined,
) {
  const [cursors, setCursors] = useState(() => loadSessionCursors(storageKey));
  const [legacy] = useState(() => loadSessionCursors("lever:read-chats"));
  useEffect(() => {
    if (!conversations) return;
    setCursors((current) => {
      const missing = conversations.filter(
        (item) =>
          current[item.id] === undefined && legacy[item.chatId] !== undefined,
      );
      return missing.length
        ? {
            ...Object.fromEntries(
              missing.map((item) => [item.id, legacy[item.chatId]]),
            ),
            ...current,
          }
        : current;
    });
  }, [conversations, legacy]);
  const [focused, setFocused] = useState(
    () => document.visibilityState === "visible" && document.hasFocus(),
  );
  useEffect(() => {
    const update = () =>
      setFocused(document.visibilityState === "visible" && document.hasFocus());
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(cursors));
    } catch {
      // Viewing a result still acknowledges it for this open window.
    }
  }, [cursors]);
  const markConversationsRead = useCallback(
    (items: Pick<Conversation, "id" | "unreadSequence">[]) => {
      setCursors((current) => {
        let next = current;
        for (const { id, unreadSequence } of items) {
          if (unreadSequence <= (next[id] ?? 0)) continue;
          if (next === current) next = { ...current };
          next[id] = unreadSequence;
        }
        return next;
      });
    },
    [],
  );
  const markRead = useCallback(
    (id: string, unreadSequence: number) =>
      markConversationsRead([{ id, unreadSequence }]),
    [markConversationsRead],
  );
  return {
    cursors: useMemo(
      () =>
        Object.fromEntries(
          (conversations ?? []).map((item) => [
            item.id,
            cursors[item.id] ?? legacy[item.chatId] ?? 0,
          ]),
        ),
      [conversations, cursors, legacy],
    ),
    focused,
    markRead,
    markConversationsRead,
  };
}
