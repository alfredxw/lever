import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api/client";
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
  const syncedRef = useRef<Record<string, number>>({});

  const pushReadMarks = useCallback(
    (items: { sessionId: string; sequence: number }[]) => {
      const pending: { sessionId: string; sequence: number }[] = [];
      for (const item of items) {
        if (item.sequence <= (syncedRef.current[item.sessionId] ?? 0)) continue;
        syncedRef.current[item.sessionId] = item.sequence;
        pending.push(item);
      }
      if (!pending.length) return;
      void api("/sessions/read", { items: pending }).catch(() => {
        for (const item of pending) {
          if (syncedRef.current[item.sessionId] === item.sequence) {
            delete syncedRef.current[item.sessionId];
          }
        }
      });
    },
    [],
  );

  useEffect(() => {
    if (!conversations) return;
    setCursors((current) => {
      let next = current;
      for (const item of conversations) {
        const merged = Math.max(
          current[item.id] ?? 0,
          current[item.id] === undefined ? (legacy[item.chatId] ?? 0) : 0,
          item.readSequence ?? 0,
        );
        if (merged > (next[item.id] ?? 0)) {
          if (next === current) next = { ...current };
          next[item.id] = merged;
        }
      }
      return next;
    });
    const toSync: { sessionId: string; sequence: number }[] = [];
    for (const item of conversations) {
      const serverSeq = item.readSequence ?? 0;
      if (serverSeq > (syncedRef.current[item.id] ?? 0)) {
        syncedRef.current[item.id] = serverSeq;
      }
      const localSeq = cursors[item.id] ?? legacy[item.chatId] ?? 0;
      const target = Math.min(localSeq, item.unreadSequence);
      if (target > serverSeq && target > (syncedRef.current[item.id] ?? 0)) {
        toSync.push({ sessionId: item.id, sequence: target });
      }
    }
    if (toSync.length) pushReadMarks(toSync);
  }, [conversations, cursors, legacy, pushReadMarks]);

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
    const reportPresence = (active: boolean, keepalive = false) => {
      void fetch("/api/desktop/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
        keepalive,
      }).catch(() => undefined);
    };
    const syncVisibility = () =>
      reportPresence(document.visibilityState === "visible");
    const onHide = () => reportPresence(false, true);
    syncVisibility();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        reportPresence(true);
      }
    }, 20_000);
    document.addEventListener("visibilitychange", syncVisibility);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", syncVisibility);
      window.removeEventListener("pagehide", onHide);
      onHide();
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
      const syncItems: { sessionId: string; sequence: number }[] = [];
      setCursors((current) => {
        let next = current;
        for (const { id, unreadSequence } of items) {
          if (unreadSequence > 0) {
            syncItems.push({ sessionId: id, sequence: unreadSequence });
          }
          if (unreadSequence <= (next[id] ?? 0)) continue;
          if (next === current) next = { ...current };
          next[id] = unreadSequence;
        }
        return next;
      });
      if (syncItems.length) pushReadMarks(syncItems);
    },
    [pushReadMarks],
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
            Math.max(
              item.readSequence ?? 0,
              cursors[item.id] ?? legacy[item.chatId] ?? 0,
            ),
          ]),
        ),
      [conversations, cursors, legacy],
    ),
    focused,
    markRead,
    markConversationsRead,
  };
}
