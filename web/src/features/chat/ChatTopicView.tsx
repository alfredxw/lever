import { useEffect, useState, useRef } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronDown, Minimize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ImagePreview, useImagePreview } from "./ImagePreview";
import { chatTopicPagesQuery, conversationIntent, sessionQuery } from "./queries";
import { RunStatus } from "./RunStatus";
import {
  TopicConversation,
  topicTitle,
  type TopicConversationProps,
} from "./Topic";

function TopicPageEnd({ load }: { load: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const end = ref.current;
    if (!end) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) load();
      },
      { root: end.closest('[role="menu"]'), rootMargin: "0px 0px 32px" },
    );
    observer.observe(end);
    return () => observer.disconnect();
  }, [load]);
  return <div aria-hidden="true" className="h-px" ref={ref} />;
}

export function ChatTopicView({
  chatId,
  onSelect,
  onCollapseTopic,
  onReplyFocus,
  ...conversation
}: TopicConversationProps & {
  chatId: string;
  onSelect: (sessionId: string) => void;
  onCollapseTopic: () => void;
  onReplyFocus: () => void;
}) {
  const { t } = useTranslation();
  const { sessionId, enabled } = conversation;
  const [pickerOpen, setPickerOpen] = useState(false);
  const view = useQuery({
    ...sessionQuery(sessionId),
    enabled,
    subscribed: enabled,
  });
  const topics = useInfiniteQuery({
    ...chatTopicPagesQuery(chatId),
    enabled: enabled && pickerOpen,
    subscribed: enabled && pickerOpen,
  });
  const preview = useImagePreview();
  const title =
    (view.data && topicTitle(view.data.session, view.data.root)) ||
    t("chat.topic");
  return (
    <div className="chat-topic-body">
      <div
        className="chat-topic-detail"
        inert={!!preview.file}
        onFocusCapture={(event) => {
          if (!event.target.closest(".topic-collapse")) onReplyFocus();
        }}
      >
        <header className="chat-topic-header gap-1">
          <DropdownMenu open={pickerOpen} onOpenChange={setPickerOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="min-w-0 shrink"
                aria-label={t("chat.switchTopic")}
                aria-description={title}
                title={title}
              >
                <span className="truncate">{title}</span>
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              aria-label={t("chat.chatTopics")}
              className="max-h-[min(12rem,var(--radix-dropdown-menu-content-available-height))] max-w-72 overscroll-contain"
            >
              <DropdownMenuRadioGroup
                value={sessionId}
                onValueChange={onSelect}
              >
                {topics.data?.pages
                  .flatMap((page) => page.topics)
                  .map((item) => (
                    <DropdownMenuRadioItem
                      key={item.id}
                      value={item.id}
                      {...conversationIntent(chatId, item.id)}
                      textValue={item.title}
                      title={item.title || t("chat.topic")}
                    >
                      <span className="truncate">
                        {item.title || t("chat.topic")}
                      </span>
                      {item.status && item.status !== "completed" && (
                        <RunStatus status={item.status} iconOnly />
                      )}
                    </DropdownMenuRadioItem>
                  ))}
              </DropdownMenuRadioGroup>
              {topics.hasNextPage &&
                !topics.isFetching &&
                !topics.isFetchNextPageError && (
                  <TopicPageEnd load={topics.fetchNextPage} />
                )}
              {(topics.isPending || topics.isFetchingNextPage) && (
                <Loading className="py-2" />
              )}
              {topics.error && (
                <ErrorNotice
                  error={topics.error}
                  retry={() =>
                    void (topics.isFetchNextPageError
                      ? topics.fetchNextPage()
                      : topics.refetch())
                  }
                />
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="topic-collapse ml-auto text-muted-foreground"
            aria-label={t("chat.collapseTopic")}
            title={t("chat.collapseTopic")}
            onClick={onCollapseTopic}
          >
            <Minimize2 />
          </Button>
        </header>
        <TopicConversation
          key={sessionId}
          {...conversation}
          onOpenSiblingTopic={onSelect}
        />
      </div>
      <ImagePreview />
    </div>
  );
}
