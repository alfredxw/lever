import { useContext } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Check, CircleHelp, LoaderCircle, ShieldCheck, X } from "lucide-react";
import { api, queryClient } from "@/api/client";
import type { Answer, Request } from "@/api/types.gen";
import { CodeSnippet } from "@/components/ai-elements/code-block";
import { KeepConversationOpen } from "./ComposerContext";
import { useQuestionDraft } from "./questionDraft";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
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
}: {
  request: Request;
  title?: string;
  source?: string;
}) {
  const { t } = useTranslation();
  const keepOpen = useContext(KeepConversationOpen);
  const [draft, setAnswer] = useQuestionDraft(request.id);
  const answers = Object.fromEntries(
    request.questions.map((q) => {
      const value = draft[q.id];
      return [
        q.id,
        typeof value === "string"
          ? [value.trim()].filter(Boolean)
          : (value ?? []),
      ];
    }),
  );
  const answer = useMutation({
    onMutate: () => keepOpen?.(),
    mutationFn: (value: Answer | "allow-run") =>
      value === "allow-run"
        ? api(`/runs/${request.runId}/approvals`, { allow: true })
        : api(`/requests/${request.id}/answer`, value),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });
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
        ) : approval ? (
          request.detail && (
            <CodeSnippet
              code={request.detail}
              title={t("chat.requestDetails")}
            />
          )
        ) : (
          <FieldGroup>
            {request.questions.map((q) => {
              const value = draft[q.id];
              const choices = Array.isArray(value) ? value : [];
              return (
                <FieldSet key={q.id} disabled={answer.isPending}>
                  <FieldLegend variant="label">{q.text}</FieldLegend>
                  <FieldGroup className="gap-2">
                    {q.options.map((option) => {
                      const id = `${request.id}-${q.id}-${option.id}`;
                      return (
                        <FieldLabel key={option.id} htmlFor={id}>
                          <Field orientation="horizontal">
                            <Checkbox
                              id={id}
                              checked={choices.includes(option.id)}
                              onCheckedChange={(checked) => {
                                keepOpen?.();
                                setAnswer(
                                  q.id,
                                  checked
                                    ? [
                                        ...(q.multiple ? choices : []),
                                        option.id,
                                      ]
                                    : choices.filter((id) => id !== option.id),
                                );
                              }}
                            />
                            <div className="flex flex-col gap-1">
                              <span>{option.label}</span>
                              {option.description && (
                                <FieldDescription>
                                  {option.description}
                                </FieldDescription>
                              )}
                            </div>
                          </Field>
                        </FieldLabel>
                      );
                    })}
                    <Field>
                      <Textarea
                        aria-label={t("chat.answerLabel", { question: q.text })}
                        placeholder={t("chat.answerPlaceholder")}
                        rows={2}
                        value={typeof value === "string" ? value : ""}
                        onCompositionStart={keepOpen}
                        onChange={(event) => {
                          keepOpen?.();
                          setAnswer(q.id, event.target.value);
                        }}
                      />
                    </Field>
                  </FieldGroup>
                </FieldSet>
              );
            })}
          </FieldGroup>
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
              disabled={
                answer.isPending ||
                (!approval &&
                  request.questions.some((q) => !answers[q.id]?.length))
              }
              onClick={() => answer.mutate({ allow: true, answers })}
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
