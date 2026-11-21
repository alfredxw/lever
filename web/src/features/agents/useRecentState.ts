import { useCallback, useMemo, useRef, useState } from "react";
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
    updateState((current) => {
      const cleared = { ...current.cleared };
      for (const { id, unreadSequence } of items)
        cleared[id] = Math.max(cleared[id] ?? 0, unreadSequence);
      return { ...current, cleared };
    });
  }
  function restoreConversation(id: string) {
    updateState((current) => {
      if (!Object.hasOwn(current.cleared, id)) return current;
      const cleared = { ...current.cleared };
      delete cleared[id];
      return { ...current, cleared };
    });
  }
  return {
    ...state,
    pinnedIds,
    setPinned,
    clearConversations,
    restoreConversation,
  };
}
