import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowUp, LoaderCircle } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, APIError, queryClient } from "@/api/client";
import type { SharedHistory } from "@/api/types.gen";
import { ErrorNotice, Loading } from "@/components/common";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
} from "@/components/ui/input-group";
import {
  MessageScrollerProvider,
  MessageTimeline,
  useMessageScroller,
} from "@/components/ui/message-scroller";
import { ComposerInput, type ComposerInputHandle } from "./ComposerInput";
import {
  ImagePreview,
  ImagePreviewProvider,
  useImagePreview,
} from "./ImagePreview";
import { hostFileSource } from "@/features/files/fileSource";
import { resolveChatFile } from "./chatFileLinks";
import type { ChatFileSelection, ChatFiles } from "./ChatResponse";
import { sharedExchanges, SharedTurn } from "./SharedTranscript";
import { useComposerDraft } from "./composerDraft";
import { isLeverReference, serializePrompt, textPrompt } from "./prompt";
import {
  sharedConversationKey,
  sharedConversationPath,
  sharedRuntimeName,
  type SharedConversationRef,
} from "./sharedConversations";

export function SharedChat({
  conversation,
  onOpenFile,
}: {
  conversation: SharedConversationRef;
  onOpenFile?: (file: ChatFileSelection) => void;
}) {
  return (
    <MessageScrollerProvider key={sharedConversationKey(conversation)}>
      <ImagePreviewProvider>
        <SharedChatContent
          conversation={conversation}
          onOpenFile={onOpenFile}
        />
      </ImagePreviewProvider>
    </MessageScrollerProvider>
  );
}

const pageSize = 100;
const historyLimit = 1200;
const turnKey = (turn: { id: string }) => turn.id;

function SharedChatContent({
  conversation,
  onOpenFile,
}: {
  conversation: SharedConversationRef;
  onOpenFile?: (file: ChatFileSelection) => void;
}) {
  const { t } = useTranslation();
  const preview = useImagePreview();
  const scroller = useMessageScroller();
  const [limit, setLimit] = useState(pageSize);
  const pageAnchors = useRef(new Set<string>());
  const path = sharedConversationPath(conversation);
  const key = sharedConversationKey(conversation);
  const runtime = sharedRuntimeName(conversation.runtime);
  const queryKey = ["shared-history", key];
  const history = useQuery({
    queryKey: [...queryKey, limit],
    queryFn: ({ signal }) =>
      api<SharedHistory>(`${path}?limit=${limit}`, undefined, "GET", signal),
    initialData: () =>
      queryClient.getQueryData<SharedHistory>([...queryKey, limit - pageSize]),
    staleTime: 0,
    refetchInterval: 2000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const [draft, setDraft] = useComposerDraft(key);
  const textbox = useRef<ComposerInputHandle>(null);
  const prompt = serializePrompt(draft.content);
  const input = prompt.text.trim();
  const hasLeverReferences = prompt.references.some(isLeverReference);
  const data = history.data;
  const activity =
    data?.conversation.activity ??
    (data?.busy ? { status: "running" } : undefined);
  const blocked =
    hasLeverReferences ||
    !data?.canSend ||
    (conversation.runtime === "codex" && !!activity);
  const cwd = data?.conversation.cwd;
  const files = useMemo<ChatFiles | undefined>(
    () =>
      onOpenFile
        ? {
            resolve: (href) => {
              const resolved = resolveChatFile(
                href,
                undefined,
                [],
                window.location.origin,
                cwd,
              );
              return resolved
                ? { ...resolved.file, source: hostFileSource }
                : null;
            },
            open: onOpenFile,
          }
        : undefined,
    [cwd, onOpenFile],
  );
  const turns = useMemo(
    () => sharedExchanges(data?.messages ?? [], pageAnchors.current, activity),
    [data?.messages, activity],
  );
  const send = useMutation({
    mutationFn: (text: string) => api(path, { text }),
    onSuccess: (_, text) => {
      if (preview.file) preview.close({ restoreFocus: false });
      setDraft((current) =>
        serializePrompt(current.content).text.trim() === text
          ? { ...current, content: textPrompt("") }
          : current,
      );
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({
        queryKey: ["shared-conversations"],
      });
      scroller.current?.scrollToEnd();
    },
    onError: () => void history.refetch(),
  });
  const submit = () => {
    if (input && !blocked && !send.isPending && !history.isError)
      send.mutate(input);
  };
  const sendError =
    send.error instanceof APIError
      ? ({
          409: t("shared.busy"),
          502: t("shared.unconfirmed"),
          503: t("shared.openOriginal"),
        }[send.error.status] ?? send.error.message)
      : send.error?.message;

  if (!data) {
    return history.error ? (
      <ErrorNotice error={history.error} retry={() => void history.refetch()} />
    ) : (
      <Loading />
    );
  }

  return (
    <div className="chat-panel">
      <MessageTimeline
        items={turns}
        itemKey={turnKey}
        busy={activity?.status === "running"}
        inert={!!preview.file}
        overlay={<ImagePreview />}
        onLoadEarlier={
          data.more &&
          limit < historyLimit &&
          !history.isFetching &&
          !history.error
            ? () => {
                const first = turns[0];
                if (first && !first.prompt) pageAnchors.current.add(first.id);
                setLimit(Math.min(limit + pageSize, historyLimit));
              }
            : undefined
        }
        notice={
          history.error && (
            <ErrorNotice
              error={history.error}
              retry={() => void history.refetch()}
            />
          )
        }
      >
        {(turn, index) => (
          <SharedTurn
            turn={turn}
            path={path}
            runtime={runtime}
            activity={index === turns.length - 1 ? activity : undefined}
            files={files}
          />
        )}
      </MessageTimeline>
      <div className="chat-composer-wrap">
        <InputGroup className="composer">
          {(hasLeverReferences || sendError) && (
            <InputGroupAddon align="block-start">
              <p role="alert" className="reference-error">
                {hasLeverReferences
                  ? t("composer.sharedReferences")
                  : sendError}
              </p>
            </InputGroupAddon>
          )}
          <ComposerInput
            chatId={key}
            provider={conversation.provider}
            scopeKey={key}
            fixedDestination
            suggestions={false}
            canStartComparison={false}
            value={draft.content}
            empty={!input}
            onChange={(content) =>
              setDraft((current) => ({ ...current, content }))
            }
            onCommand={() => {}}
            textbox={textbox}
            onSubmit={submit}
            label={t("chat.message")}
            placeholder={t("shared.reply", { runtime })}
            disabled={send.isPending}
          />
          <InputGroupAddon align="block-end" className="justify-between">
            <span
              role="status"
              className="min-w-0 truncate text-xs font-normal"
            >
              {!data.canSend ? t("shared.openOriginal") : ""}
            </span>
            <InputGroupButton
              variant="default"
              size="icon-sm"
              className="send-button rounded-full"
              aria-label={t("chat.send")}
              disabled={!input || blocked || send.isPending || history.isError}
              onClick={submit}
            >
              {send.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <ArrowUp />
              )}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </div>
    </div>
  );
}
