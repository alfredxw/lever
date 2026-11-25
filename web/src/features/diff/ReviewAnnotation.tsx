import { useEffect, useRef, useState } from "react";
import {
  Copy,
  MessageSquareText,
  Pencil,
  Send,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import {
  formatLineRange,
  type DraftAnchor,
  type ReviewComment,
  type ReviewSide,
} from "./reviewDraft";

export type ReviewAnnotationMetadata = {
  comments: ReviewComment[];
  draft?: DraftAnchor;
};

function sideText(side: ReviewSide, t: (key: string) => string) {
  return t(side === "deletions" ? "diff.oldSide" : "diff.newSide");
}

function stopDiffEvent(event: React.SyntheticEvent) {
  event.stopPropagation();
}

function ReviewCommentForm({
  anchorLabel,
  initialBody = "",
  submitLabel,
  onSubmit,
  onCancel,
}: {
  anchorLabel: string;
  initialBody?: string;
  submitLabel: string;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [body, setBody] = useState(initialBody);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const trimmed = body.trim();
  const save = () => {
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  return (
    <div className="diff-annotation-card diff-annotation-editor">
      <div className="diff-annotation-meta">
        <span className="diff-annotation-range">{anchorLabel}</span>
      </div>
      <Textarea
        ref={inputRef}
        className="diff-annotation-input"
        aria-label={t("diff.commentPlaceholder")}
        placeholder={t("diff.commentPlaceholder")}
        rows={2}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
            return;
          }
          if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            save();
          }
        }}
      />
      <div className="diff-annotation-actions">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!trimmed}
          onClick={save}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

export function ReviewAnnotationSlot({
  metadata,
  editingId,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
  onSaveDraft,
  onCancelDraft,
}: {
  metadata: ReviewAnnotationMetadata;
  editingId?: string;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  onSaveDraft: (draft: DraftAnchor, body: string) => void;
  onCancelDraft: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="diff-annotation-slot"
      onPointerDown={stopDiffEvent}
      onMouseDown={stopDiffEvent}
      onClick={stopDiffEvent}
      onKeyDown={stopDiffEvent}
    >
      {metadata.comments.map((comment) => {
        const rangeLabel = `${sideText(comment.side, t)} ${formatLineRange(comment.startLine, comment.endLine)}`;
        if (editingId === comment.id) {
          return (
            <ReviewCommentForm
              key={comment.id}
              anchorLabel={rangeLabel}
              initialBody={comment.body}
              submitLabel={t("common.save")}
              onSubmit={(body) => onSaveEdit(comment.id, body)}
              onCancel={onCancelEdit}
            />
          );
        }
        return (
          <div
            key={comment.id}
            className="diff-annotation-card"
            data-comment-id={comment.id}
          >
            <div className="diff-annotation-meta">
              <span className="diff-annotation-range">{rangeLabel}</span>
              <div className="diff-annotation-tools">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("diff.editComment")}
                  title={t("diff.editComment")}
                  onClick={() => onStartEdit(comment.id)}
                >
                  <Pencil />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("diff.deleteComment")}
                  title={t("diff.deleteComment")}
                  onClick={() => onDelete(comment.id)}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
            <p className="diff-annotation-body">{comment.body}</p>
          </div>
        );
      })}
      {metadata.draft && (
        <ReviewCommentForm
          key={`draft:${metadata.draft.path}:${metadata.draft.side}:${metadata.draft.startLine}:${metadata.draft.endLine}`}
          anchorLabel={`${sideText(metadata.draft.side, t)} ${formatLineRange(metadata.draft.startLine, metadata.draft.endLine)}`}
          submitLabel={t("diff.saveComment")}
          onSubmit={(body) => onSaveDraft(metadata.draft!, body)}
          onCancel={onCancelDraft}
        />
      )}
    </div>
  );
}

export function ReviewControls({
  comments,
  outdatedIds,
  submitting,
  canSubmit,
  onJump,
  onDelete,
  onClearAll,
  onCopy,
  onSubmit,
}: {
  comments: readonly ReviewComment[];
  outdatedIds: ReadonlySet<string>;
  submitting: boolean;
  canSubmit: boolean;
  onJump: (comment: ReviewComment) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
  onCopy: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  if (comments.length === 0) return null;

  const grouped = new Map<string, ReviewComment[]>();
  for (const comment of comments) {
    const list = grouped.get(comment.path);
    if (list) list.push(comment);
    else grouped.set(comment.path, [comment]);
  }

  return (
    <div className="diff-review-pill">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="diff-review-count"
            aria-label={t("diff.reviewComments", { count: comments.length })}
            title={t("diff.reviewComments", { count: comments.length })}
          >
            <MessageSquareText />
            <span className="tabular-nums">{comments.length}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={6}
          className="diff-review-popover"
          aria-label={t("diff.reviewComments", { count: comments.length })}
        >
          <div className="diff-review-popover-header">
            <span className="text-[13px] font-medium text-foreground">
              {t("diff.reviewComments", { count: comments.length })}
            </span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t("diff.copyReview")}
                title={t("diff.copyReview")}
                onClick={() => {
                  onCopy();
                  setOpen(false);
                }}
              >
                <Copy />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t("diff.clearComments")}
                title={t("diff.clearComments")}
                onClick={() => {
                  onClearAll();
                  setOpen(false);
                }}
              >
                <Trash2 />
              </Button>
            </div>
          </div>
          <div className="diff-review-list">
            {[...grouped].map(([path, items]) => (
              <div key={path} className="diff-review-group">
                <div className="diff-review-group-path truncate" title={path}>
                  {path}
                </div>
                {items.map((comment) => {
                  const outdated = outdatedIds.has(comment.id);
                  return (
                    <div key={comment.id} className="diff-review-item">
                      <button
                        type="button"
                        className="diff-review-item-trigger"
                        onClick={() => {
                          setOpen(false);
                          onJump(comment);
                        }}
                      >
                        <span className="diff-review-item-meta">
                          <span className="tabular-nums">
                            {sideText(comment.side, t)}{" "}
                            {formatLineRange(comment.startLine, comment.endLine)}
                          </span>
                          {outdated && (
                            <span className="diff-review-outdated">
                              {t("diff.commentOutdated")}
                            </span>
                          )}
                        </span>
                        <span className="diff-review-item-body">
                          {comment.body}
                        </span>
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="diff-review-item-delete"
                        aria-label={t("diff.deleteComment")}
                        title={t("diff.deleteComment")}
                        onClick={() => onDelete(comment.id)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      {canSubmit ? (
        <Button
          type="button"
          size="sm"
          className="diff-review-submit"
          disabled={submitting}
          onClick={onSubmit}
        >
          <Send />
          {t("diff.submitReview", { count: comments.length })}
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="diff-review-submit"
          onClick={onCopy}
        >
          <Copy />
          {t("diff.copyReview")}
        </Button>
      )}
    </div>
  );
}
