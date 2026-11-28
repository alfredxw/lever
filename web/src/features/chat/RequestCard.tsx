import { useContext } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Check, CircleHelp, LoaderCircle, ShieldCheck, X } from "lucide-react";
import { api, queryClient } from "@/api/client";
import type { Answer, Request } from "@/api/types.gen";
import { CodeSnippet } from "@/components/ai-elements/code-block";
import { KeepConversationOpen } from "./ComposerContext";
import { QuestionPrompt } from "./QuestionPrompt";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemHeader,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";

export function RequestCard({
  request,
  title = request.title,
  source,
  onSubmit,
}: {
  request: Request;
  title?: string;
  source?: string;
  onSubmit?: (value: Answer | "allow-run") => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const keepOpen = useContext(KeepConversationOpen);
  const answer = useMutation({
    onMutate: () => keepOpen?.(),
    mutationFn: (value: Answer | "allow-run") =>
      onSubmit
        ? onSubmit(value)
        : value === "allow-run"
          ? api(`/runs/${request.runId}/approvals`, { allow: true })
          : api(`/requests/${request.id}/answer`, value),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      if (onSubmit) {
        void queryClient.invalidateQueries({ queryKey: ["delegations"] });
      }
    },
  });

  if (request.kind === "question" && request.questions.length > 0) {
    return (
      <QuestionPrompt
        request={request}
        title={title}
        source={source}
        variant="card"
        onSubmit={onSubmit}
      />
    );
  }

  const approval = request.kind === "approval";
  return (
    <Item
      variant="outline"
      className="request-card bg-(--panel-background)"
      data-kind={request.kind}
      role="group"
      aria-label={source ? `${title} · ${source}` : title}
      aria-busy={answer.isPending}
    >
      <ItemHeader>
        <ItemMedia variant="icon">
          {approval ? <ShieldCheck /> : <CircleHelp />}
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle>{title}</ItemTitle>
          <ItemDescription>
            {source && <span className="block font-medium">{source}</span>}
            {t(
              approval
                ? "chat.approvalDescription"
                : "chat.questionDescription",
            )}
          </ItemDescription>
        </ItemContent>
      </ItemHeader>
      <ItemContent className="min-w-0 basis-full">
        {request.delegationAgentId ? (
          <p className="text-sm whitespace-pre-wrap wrap-break-word">
            {request.detail}
          </p>
        ) : (
          request.detail && (
            <CodeSnippet
              code={request.detail}
              title={t("chat.requestDetails")}
            />
          )
        )}
        {answer.error && <ErrorNotice error={answer.error} />}
      </ItemContent>
      <ItemFooter className="justify-end">
        <ItemActions className="flex-wrap justify-end">
          {request.options?.map((option) => (
            <Button
              key={option.id}
              variant={option.allow ? "default" : "outline"}
              size="sm"
              disabled={answer.isPending}
              onClick={() =>
                answer.mutate({
                  allow: option.allow,
                  optionId: option.id,
                  answers: {},
                })
              }
            >
              {option.name}
            </Button>
          ))}
          {!request.options?.some((option) => !option.allow) && (
            <Button
              variant="outline"
              size="sm"
              disabled={answer.isPending}
              onClick={() => answer.mutate({ allow: false, answers: {} })}
            >
              <X data-icon="inline-start" />
              {t("chat.deny")}
            </Button>
          )}
          {approval && request.allowOnce && (
            <Button
              variant="outline"
              size="sm"
              disabled={answer.isPending}
              title={t("permissions.allowRunHint")}
              onClick={() => answer.mutate("allow-run")}
            >
              {t("permissions.allowRun")}
            </Button>
          )}
          {!request.options?.length && (
            <Button
              size="sm"
              disabled={answer.isPending}
              onClick={() => answer.mutate({ allow: true, answers: {} })}
            >
              {answer.isPending ? (
                <LoaderCircle
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              ) : (
                <Check data-icon="inline-start" />
              )}
              {t(approval ? "chat.allow" : "chat.answer")}
            </Button>
          )}
        </ItemActions>
      </ItemFooter>
    </Item>
  );
}
