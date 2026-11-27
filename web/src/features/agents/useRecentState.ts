import { useCallback, useMemo, useRef, useState } from "react";
import { api } from "@/api/client";
import type { Conversation, SharedConversation } from "@/api/types.gen";
import { sharedConversationKey } from "@/features/chat/sharedConversations";
import { loadSessionCursors } from "./useConversationReadState";

type PinEntry = string | SharedConversation;
type RecentState = { pins: PinEntry[]; cleared: Record<string, number> };
const storageKey = "lever:recent-conversations";
const legacyClearedKey = "lever:dismissed-agent-activity";
export const pinId = (pin: PinEntry) =>
  typeof pin === "string" ? pin : sharedConversationKey(pin);

function readRecentState(): RecentState {
  const cleared = loadSessionCursors(legacyClearedKey);
  try {
    const saved = JSON.parse(
      localStorage.getItem(storageKey) ?? "null",
    ) as Partial<RecentState> | null;
    for (const [id, sequence] of Object.entries(saved?.cleared ?? {})) {
      if (Number.isSafeInteger(sequence) && sequence >= 0)
        cleared[id] = Math.max(cleared[id] ?? 0, sequence);
    }
    return { pins: saved?.pins ?? [], cleared };
  } catch {
    return { pins: [], cleared };
  }
}

export function useRecentState() {
  const [state, setState] = useState(readRecentState);
  const unsaved = useRef<RecentState>(undefined);
  const serverClearedRef = useRef<Record<string, number>>({});
  const pushedClearedRef = useRef<Record<string, number>>({});
  const updateState = useCallback(
    (change: (current: RecentState) => RecentState) => {
      // Read storage again to preserve clears and pins saved by another window.
      const current = unsaved.current ?? readRecentState();
      const next = change(current);
      if (next !== current) {
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
          localStorage.removeItem(legacyClearedKey);
          unsaved.current = undefined;
        } catch {
          // The current window can still organize the list.
          unsaved.current = next;
        }
      }
      setState(next);
    },
    [],
  );
  const pushClearedMarks = useCallback(
    (items: { sessionId: string; sequence: number }[]) => {
      if (!items.length) return;
      for (const item of items) {
        pushedClearedRef.current[item.sessionId] = item.sequence;
      }
      void api("/sessions/cleared", { items }).catch(() => undefined);
    },
    [],
  );
  const syncServerCleared = useCallback(
    (conversations: Conversation[] | undefined) => {
      if (!conversations) return;
      const toPush: { sessionId: string; sequence: number }[] = [];
      updateState((current) => {
        let cleared = current.cleared;
        for (const item of conversations) {
          const serverSeq = item.clearedSequence ?? 0;
          const prevServer = serverClearedRef.current[item.id] ?? 0;
          serverClearedRef.current[item.id] = serverSeq;
          const hasLocal = Object.hasOwn(cleared, item.id);
          const localSeq = hasLocal ? cleared[item.id] : -1;
          if (serverSeq > 0 && serverSeq > localSeq) {
            if (cleared === current.cleared) cleared = { ...current.cleared };
            cleared[item.id] = serverSeq;
            pushedClearedRef.current[item.id] = serverSeq;
          } else if (serverSeq === 0 && prevServer > 0 && hasLocal) {
            // Restored from another device (e.g. mobile drawer)
            if (cleared === current.cleared) cleared = { ...current.cleared };
            delete cleared[item.id];
            delete pushedClearedRef.current[item.id];
          } else if (hasLocal && serverSeq === 0) {
            const target = Math.max(localSeq, item.unreadSequence, 1);
            if ((pushedClearedRef.current[item.id] ?? -1) < target) {
              toPush.push({ sessionId: item.id, sequence: target });
            }
          }
        }
        return cleared === current.cleared ? current : { ...current, cleared };
      });
      if (toPush.length) pushClearedMarks(toPush);
    },
    [pushClearedMarks, updateState],
  );
  const pinnedIds = useMemo(() => new Set(state.pins.map(pinId)), [state.pins]);
  const setPinned = useCallback(
    (entry: PinEntry, pinned: boolean) => {
      const id = pinId(entry);
      updateState((current) => {
        if (current.pins.some((pin) => pinId(pin) === id) === pinned)
          return current;
        const pin =
          typeof entry === "string"
            ? entry
            : { ...entry, activity: undefined, preview: undefined };
        return {
          ...current,
          pins: pinned
            ? [pin, ...current.pins]
            : current.pins.filter((p) => pinId(p) !== id),
        };
      });
    },
    [updateState],
  );
  function clearConversations(
    items: Pick<Conversation, "id" | "unreadSequence">[],
  ) {
    const syncItems: { sessionId: string; sequence: number }[] = [];
    updateState((current) => {
      const cleared = { ...current.cleared };
      for (const { id, unreadSequence } of items) {
        const seq = Math.max(cleared[id] ?? 0, unreadSequence, 1);
        cleared[id] = seq;
        syncItems.push({ sessionId: id, sequence: seq });
      }
      return { ...current, cleared };
    });
    if (syncItems.length) pushClearedMarks(syncItems);
  }
  function restoreConversation(id: string) {
    updateState((current) => {
      if (!Object.hasOwn(current.cleared, id)) return current;
      const cleared = { ...current.cleared };
      delete cleared[id];
      return { ...current, cleared };
    });
    pushClearedMarks([{ sessionId: id, sequence: 0 }]);
  }
  return {
    ...state,
    pinnedIds,
    setPinned,
    clearConversations,
    restoreConversation,
    syncServerCleared,
  };
}
