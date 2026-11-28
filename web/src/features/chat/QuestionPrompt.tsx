import { useContext, useEffect, useEffectEvent, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock,
  LoaderCircle,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "cn";
import { api, queryClient } from "@/api/client";
import type { Answer, Request } from "@/api/types.gen";
import { MessageResponse } from "@/components/ai-elements/message-response";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { KeepConversationOpen } from "./ComposerContext";
import { useQuestionDraft } from "./questionDraft";
import {
  allowsCustomAnswer,
  buildQuestionAnswers,
  deriveQuestionProgress,
  formatQuestionCountdown,
  isQuestionRequired,
  remainingQuestionTimeoutSeconds,
} from "./questionState";

function isEditableElement(target: EventTarget | null): boolean {
  let node: Element | null = target instanceof Element ? target : null;
  while (node) {
    if (
      node instanceof HTMLInputElement ||
      node instanceof HTMLTextAreaElement ||
      node instanceof HTMLSelectElement
    ) {
      return true;
    }
    if (node instanceof HTMLElement && node.isContentEditable) {
      return true;
    }
    if (node.getAttribute("role") === "textbox") {
      return true;
    }
    const shadowActive = node.shadowRoot?.activeElement ?? null;
    if (shadowActive && shadowActive !== node) {
      node = shadowActive;
      continue;
    }
    break;
  }
  return false;
}

function isInsideBlockingOverlay(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      '[role="dialog"], [aria-modal="true"], [role="menu"], [role="combobox"], [data-slot="popover-content"], [data-slot="select-content"], [data-slot="dropdown-menu-content"]',
    ),
  );
}

function shouldHandleShortcutInPanel(
  panel: HTMLElement | null,
  target: EventTarget | null,
): boolean {
  if (!panel || panel.offsetParent === null) return false;
  const host = panel.closest(".topic-conversation, .chat-panel");
  if (target instanceof HTMLElement) {
    const targetHost = target.closest(".topic-conversation, .chat-panel");
    if (targetHost && host && targetHost !== host) {
      return false;
    }
  }
  const visiblePanels = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-question-panel="docked"][data-question-shortcuts="true"]',
    ),
  ).filter((el) => el.offsetParent !== null);
  if (visiblePanels.length <= 1) return true;
  if (target instanceof HTMLElement && host?.contains(target)) return true;
  return visiblePanels[visiblePanels.length - 1] === panel;
}

function OptionRadio({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
        checked
          ? "border-primary bg-primary"
          : "border-foreground/30 bg-background dark:border-foreground/35 dark:bg-input/30",
      )}
    >
      {checked && (
        <span className="size-1.5 rounded-full bg-primary-foreground" />
      )}
    </span>
  );
}

function OptionCheckbox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
        checked
          ? "border-primary bg-primary text-primary-foreground"
          : "border-foreground/30 bg-background dark:border-foreground/35 dark:bg-input/30",
      )}
    >
      {checked && <Check className="size-3" strokeWidth={2.5} />}
    </span>
  );
}

export function QuestionPrompt({
  request,
  title = request.title,
  source,
  variant = "docked",
  queueCount = 1,
  visible = true,
  onSubmit,
}: {
  request: Request;
  title?: string;
  source?: string;
  variant?: "docked" | "card";
  queueCount?: number;
  visible?: boolean;
  onSubmit?: (value: Answer | "allow-run") => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const keepOpen = useContext(KeepConversationOpen);
  const reduceMotion = useReducedMotion();
  const panelRef = useRef<HTMLElement>(null);
  const autoAdvanceRef = useRef<number | null>(null);
  const timeoutPausedRef = useRef(false);
  const [collapsed, setCollapsed] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(() =>
    remainingQuestionTimeoutSeconds(request.expiresAt),
  );

  const { draft, toggleOption, setCustomAnswer, setQuestionIndex } =
    useQuestionDraft(request.id);

  const questions = request.questions;
  const progress = deriveQuestionProgress(
    questions,
    draft.answers,
    draft.questionIndex,
  );
  const activeQuestion = progress.activeQuestion;

  const answerMutation = useMutation({
    onMutate: () => keepOpen?.(),
    mutationFn: (value: Answer) =>
      onSubmit
        ? onSubmit(value)
        : api(`/requests/${request.id}/answer`, value),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      if (onSubmit) {
        void queryClient.invalidateQueries({ queryKey: ["delegations"] });
      }
    },
  });

  const cancelTimeoutMutation = useMutation({
    mutationFn: () => api(`/requests/${request.id}/cancel-timeout`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: () => {
      timeoutPausedRef.current = false;
      setRemainingSeconds(remainingQuestionTimeoutSeconds(request.expiresAt));
    },
  });

  const isPending = answerMutation.isPending;

  useEffect(() => {
    timeoutPausedRef.current = false;
  }, [request.id]);

  useEffect(() => {
    const sync = () => {
      setRemainingSeconds(remainingQuestionTimeoutSeconds(request.expiresAt));
    };
    sync();
    if (!request.expiresAt) return;
    const timer = window.setInterval(sync, 500);
    return () => window.clearInterval(timer);
  }, [request.expiresAt]);

  const pauseTimeout = () => {
    if (
      !request.expiresAt ||
      onSubmit ||
      timeoutPausedRef.current ||
      isPending ||
      cancelTimeoutMutation.isPending
    ) {
      return;
    }
    timeoutPausedRef.current = true;
    setRemainingSeconds(null);
    cancelTimeoutMutation.mutate();
  };

  const clearAutoAdvance = () => {
    if (autoAdvanceRef.current !== null) {
      window.clearTimeout(autoAdvanceRef.current);
      autoAdvanceRef.current = null;
    }
  };

  useEffect(() => {
    clearAutoAdvance();
    return clearAutoAdvance;
  }, [activeQuestion?.id, isPending, request.id]);

  const submitAnswers = () => {
    if (isPending) return;
    const answers = buildQuestionAnswers(questions, draft.answers);
    if (!answers) return;
    clearAutoAdvance();
    answerMutation.mutate({ allow: true, answers });
  };

  const dismissQuestion = () => {
    if (isPending) return;
    clearAutoAdvance();
    answerMutation.mutate({ allow: false, answers: {} });
  };

  const handleAdvanceOrSubmit = () => {
    if (isPending || !activeQuestion) return;
    clearAutoAdvance();
    if (!progress.isLastQuestion) {
      if (!progress.canAdvance) return;
      keepOpen?.();
      setQuestionIndex(progress.questionIndex + 1);
      return;
    }
    submitAnswers();
  };

  const handlePrevious = () => {
    if (isPending || progress.questionIndex <= 0) return;
    clearAutoAdvance();
    keepOpen?.();
    setQuestionIndex(progress.questionIndex - 1);
  };

  const handleSelectOption = (optionId: string) => {
    if (isPending || !activeQuestion) return;
    keepOpen?.();
    pauseTimeout();
    toggleOption(activeQuestion, optionId);
    if (!activeQuestion.multiple && !progress.isLastQuestion) {
      clearAutoAdvance();
      const nextIndex = progress.questionIndex + 1;
      if (reduceMotion) {
        setQuestionIndex(nextIndex);
      } else {
        autoAdvanceRef.current = window.setTimeout(() => {
          autoAdvanceRef.current = null;
          setQuestionIndex(nextIndex);
        }, 180);
      }
    }
  };

  const shortcutsEnabled =
    variant === "docked" &&
    visible &&
    !collapsed &&
    !isPending &&
    Boolean(activeQuestion && activeQuestion.options.length > 0);

  const onDigitShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (
      !activeQuestion ||
      event.defaultPrevented ||
      event.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return;
    }
    if (
      isEditableElement(event.target) ||
      isInsideBlockingOverlay(event.target) ||
      !shouldHandleShortcutInPanel(panelRef.current, event.target)
    ) {
      return;
    }
    const digit = Number.parseInt(event.key, 10);
    if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
    const option = activeQuestion.options[digit - 1];
    if (!option) return;
    event.preventDefault();
    handleSelectOption(option.id);
  });

  useEffect(() => {
    if (!shortcutsEnabled) return;
    document.addEventListener("keydown", onDigitShortcut);
    return () => document.removeEventListener("keydown", onDigitShortcut);
  }, [shortcutsEnabled]);

  if (!activeQuestion) return null;

  const customAllowed = allowsCustomAnswer(activeQuestion);
  const optional = !isQuestionRequired(activeQuestion);
  const headerLabel =
    activeQuestion.header?.trim() ||
    (questions.length > 1
      ? `${t("chat.questionHeader")} ${progress.questionIndex + 1}`
      : title?.trim() || t("chat.questionHeader"));
  const showCustomInput = customAllowed;
  const isFreeTextOnly = activeQuestion.options.length === 0;
  const customPlaceholder =
    activeQuestion.placeholder?.trim() ||
    (isFreeTextOnly
      ? t("chat.questionFreeTextPlaceholder")
      : t("chat.questionCustomPlaceholder"));

  return (
    <section
      ref={panelRef}
      data-question-panel={variant}
      data-question-shortcuts={shortcutsEnabled ? "true" : "false"}
      data-kind="question"
      role="group"
      aria-label={source ? `${headerLabel} · ${source}` : headerLabel}
      aria-busy={isPending}
      className={cn(
        "question-prompt overflow-hidden rounded-xl border border-border/80 bg-(--panel-background)",
        variant === "docked" && "mb-2.5",
      )}
    >
      {/* Header row */}
      <div className="flex min-h-9 items-center gap-1 px-2 py-1">
        {variant === "docked" ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors duration-150 outline-none hover:bg-control-hover focus-visible:bg-control-focus"
            aria-expanded={!collapsed}
            aria-label={
              collapsed ? t("chat.questionExpand") : t("chat.questionCollapse")
            }
            title={
              collapsed ? t("chat.questionExpand") : t("chat.questionCollapse")
            }
            onClick={() => setCollapsed((prev) => !prev)}
          >
            <span
              className="size-2 shrink-0 rounded-full bg-(--status-attention)"
              aria-hidden="true"
            />
            <span className="min-w-0 truncate text-[length:var(--text-control)] font-semibold text-foreground">
              {headerLabel}
            </span>
            {optional && (
              <span className="shrink-0 text-xs text-muted-foreground">
                ({t("chat.questionOptional")})
              </span>
            )}
            {source && (
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                · {source}
              </span>
            )}
            {collapsed && (
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                · {activeQuestion.text}
              </span>
            )}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1">
            <CircleHelp
              className="size-4 shrink-0 text-(--status-attention)"
              aria-hidden="true"
            />
            <span className="min-w-0 truncate text-[length:var(--text-control)] font-semibold text-foreground">
              {headerLabel}
            </span>
            {optional && (
              <span className="shrink-0 text-xs text-muted-foreground">
                ({t("chat.questionOptional")})
              </span>
            )}
            {source && (
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                · {source}
              </span>
            )}
          </div>
        )}

        <div className="flex shrink-0 items-center gap-0.5">
          {remainingSeconds !== null && (
            onSubmit ? (
              <span
                data-question-countdown=""
                title={t("chat.questionCountdownReadonlyTooltip")}
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-medium tabular-nums",
                  remainingSeconds <= 30
                    ? "text-(--status-attention)"
                    : "text-muted-foreground",
                )}
              >
                <Clock className="size-3 shrink-0" aria-hidden="true" />
                <span>{formatQuestionCountdown(remainingSeconds)}</span>
              </span>
            ) : (
              <button
                type="button"
                data-question-countdown=""
                disabled={isPending || cancelTimeoutMutation.isPending}
                aria-label={t("chat.questionCountdownPauseAria", {
                  time: formatQuestionCountdown(remainingSeconds),
                })}
                title={t("chat.questionCountdownTooltip")}
                onClick={pauseTimeout}
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-medium tabular-nums transition-colors duration-150 outline-none hover:bg-control-hover focus-visible:bg-control-focus disabled:pointer-events-none disabled:opacity-50",
                  remainingSeconds <= 30
                    ? "text-(--status-attention)"
                    : "text-muted-foreground",
                )}
              >
                <Clock className="size-3 shrink-0" aria-hidden="true" />
                <span>{formatQuestionCountdown(remainingSeconds)}</span>
              </button>
            )
          )}
          {queueCount > 1 && (
            <span className="px-1.5 text-xs text-muted-foreground tabular-nums">
              {t("chat.questionMorePending", { count: queueCount - 1 })}
            </span>
          )}
          {questions.length > 1 && (
            <span
              className="px-1.5 text-xs font-medium text-muted-foreground tabular-nums"
              data-question-step=""
            >
              {progress.questionIndex + 1}/{questions.length}
            </span>
          )}
          {variant === "docked" && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={
                collapsed
                  ? t("chat.questionExpand")
                  : t("chat.questionCollapse")
              }
              title={
                collapsed
                  ? t("chat.questionExpand")
                  : t("chat.questionCollapse")
              }
              onClick={() => setCollapsed((prev) => !prev)}
            >
              <ChevronDown
                className={cn(
                  "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
                  collapsed && "-rotate-90",
                )}
              />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={isPending}
            aria-label={t("chat.questionDismiss")}
            title={t("chat.questionDismiss")}
            onClick={dismissQuestion}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Collapsible body & footer */}
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.16, ease: "easeOut" }}
            className="overflow-hidden border-t border-border/60"
          >
            <div className="flex max-h-[min(22rem,42dvh)] flex-col gap-3 overflow-y-auto px-3.5 py-3">
              <div className="question-prompt-text text-sm leading-relaxed text-foreground">
                <MessageResponse
                  text={activeQuestion.text}
                  mode="static"
                  className="[&>p:first-child]:mt-0 [&>p:last-child]:mb-0"
                />
              </div>

              {activeQuestion.options.length > 0 && (
                <div
                  role={activeQuestion.multiple ? "group" : "radiogroup"}
                  aria-label={activeQuestion.text}
                  className="flex flex-col gap-1"
                >
                  {activeQuestion.options.map((option, index) => {
                    const isSelected = progress.selectedOptionIds.includes(
                      option.id,
                    );
                    return (
                      <div
                        key={`${activeQuestion.id}:${option.id}`}
                        className="flex flex-col"
                      >
                        <button
                          type="button"
                          role={activeQuestion.multiple ? "checkbox" : "radio"}
                          aria-checked={isSelected}
                          disabled={isPending}
                          onClick={() => handleSelectOption(option.id)}
                          className={cn(
                            "group flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 motion-reduce:transition-none outline-none disabled:pointer-events-none disabled:opacity-50",
                            isSelected
                              ? "bg-control-selected text-foreground focus-visible:bg-control-focus"
                              : "text-foreground/85 hover:bg-control-hover focus-visible:bg-control-focus",
                          )}
                        >
                          <span className="flex h-5 shrink-0 items-center">
                            {activeQuestion.multiple ? (
                              <OptionCheckbox checked={isSelected} />
                            ) : (
                              <OptionRadio checked={isSelected} />
                            )}
                          </span>
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="text-sm leading-5 font-medium wrap-break-word text-foreground">
                              {option.label}
                            </span>
                            {option.description &&
                              option.description !== option.label && (
                                <span className="text-xs leading-relaxed wrap-break-word text-muted-foreground">
                                  {option.description}
                                </span>
                              )}
                          </span>
                          {variant === "docked" && index < 9 && (
                            <span className="flex h-5 shrink-0 items-center">
                              <kbd
                                aria-hidden="true"
                                className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded border border-border/80 bg-background px-1 font-sans text-[10.5px] text-muted-foreground tabular-nums"
                              >
                                {index + 1}
                              </kbd>
                            </span>
                          )}
                        </button>
                        {option.preview && (
                          <div className="mt-1 mb-1.5 ml-9 mr-2 overflow-x-auto text-xs text-muted-foreground">
                            <MessageResponse
                              text={option.preview}
                              mode="static"
                              className="[&>p:first-child]:mt-0 [&>p:last-child]:mb-0"
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {showCustomInput && (
                <div className="flex flex-col gap-1">
                  {activeQuestion.secret ? (
                    <Input
                      type="password"
                      aria-label={t("chat.answerLabel", {
                        question: activeQuestion.text,
                      })}
                      placeholder={customPlaceholder}
                      disabled={isPending}
                      value={progress.customAnswer}
                      onCompositionStart={keepOpen}
                      onChange={(event) => {
                        keepOpen?.();
                        pauseTimeout();
                        setCustomAnswer(activeQuestion, event.target.value);
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" &&
                          !event.shiftKey &&
                          !event.nativeEvent.isComposing
                        ) {
                          event.preventDefault();
                          handleAdvanceOrSubmit();
                        }
                      }}
                    />
                  ) : (
                    <Textarea
                      aria-label={t("chat.answerLabel", {
                        question: activeQuestion.text,
                      })}
                      inputMode={
                        activeQuestion.inputType === "integer"
                          ? "numeric"
                          : activeQuestion.inputType === "number"
                            ? "decimal"
                            : undefined
                      }
                      placeholder={customPlaceholder}
                      rows={isFreeTextOnly ? 2 : 1}
                      disabled={isPending}
                      className={cn(
                        "resize-none bg-background/80 text-sm",
                        isFreeTextOnly ? "min-h-16" : "min-h-9",
                      )}
                      value={progress.customAnswer}
                      onCompositionStart={keepOpen}
                      onChange={(event) => {
                        keepOpen?.();
                        pauseTimeout();
                        setCustomAnswer(activeQuestion, event.target.value);
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" &&
                          !event.shiftKey &&
                          !event.nativeEvent.isComposing
                        ) {
                          event.preventDefault();
                          handleAdvanceOrSubmit();
                        }
                      }}
                    />
                  )}
                </div>
              )}

              {answerMutation.error && (
                <ErrorNotice error={answerMutation.error} />
              )}
            </div>

            {/* Footer actions */}
            <div className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-2">
              <div className="flex items-center gap-1">
                {questions.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isPending || progress.questionIndex === 0}
                    onClick={handlePrevious}
                  >
                    <ChevronLeft data-icon="inline-start" />
                    {t("chat.questionPrevious")}
                  </Button>
                )}
              </div>

              <div className="flex items-center gap-1.5">
                {!progress.isLastQuestion ? (
                  <Button
                    type="button"
                    size="sm"
                    variant={
                      optional && progress.resolvedAnswer === null
                        ? "outline"
                        : "default"
                    }
                    disabled={isPending || !progress.canAdvance}
                    onClick={handleAdvanceOrSubmit}
                  >
                    {optional && progress.resolvedAnswer === null
                      ? t("chat.questionSkip")
                      : t("chat.questionNext")}
                    <ChevronRight data-icon="inline-end" />
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    disabled={isPending || !progress.isComplete}
                    onClick={submitAnswers}
                  >
                    {isPending ? (
                      <LoaderCircle
                        className="animate-spin motion-reduce:animate-none"
                        data-icon="inline-start"
                      />
                    ) : (
                      <Check data-icon="inline-start" />
                    )}
                    {t("chat.answer")}
                  </Button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
