import { createContext } from "react";
import type { JSONContent } from "@tiptap/core";
import type { MessageQuote, Reference, Run } from "@/api/types.gen";
import type { ReferenceScope } from "@/features/files/fileSource";

type OpenReference = (
  reference: Reference,
  scope: ReferenceScope,
) => Promise<void>;

export type ComposerInsertion = {
  id: string;
  composer: string;
} & (
  | { kind: "reference"; reference: Reference }
  | { kind: "files"; files: File[] }
  | { kind: "reply"; content: JSONContent[] }
  | { kind: "quote"; quote: MessageQuote; mode?: "main" | "topic" }
  | { kind: "edit"; run: Run }
);

export const ComposerContext = createContext<{
  addToChat?: (reference: Reference) => void;
  openReference?: OpenReference;
  openFileReference?: OpenReference;
  openRuntimeSettings: (providerId?: string) => void;
  quote: (composer: string, message: MessageQuote) => void;
  quoteTo: (chatId: string, message: MessageQuote) => void;
  edit: (composer: string, run: Run) => void;
  insertions: ReadonlyMap<string, ComposerInsertion>;
  inserted: (composer: string, id: string) => void;
} | null>(null);

export const ReferenceScopeContext = createContext<ReferenceScope>({});

export const KeepConversationOpen = createContext<(() => void) | undefined>(
  undefined,
);
