import { Download, FileText, X } from "lucide-react";
import { useContext, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Attachment as FileAttachment } from "@/api/types.gen";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment";
import { useImagePreview, type PreviewImage } from "./ImagePreview";
import { HtmlPreviewContext, HtmlPreviewHost } from "./HtmlPreview";
import { InlineHtmlPreview, useInlineHtmlPreview } from "./InlineHtmlPreview";
import { rowMenuHandlers } from "@/components/ui/action-context-menu";
import { chatPreviewURL, type HtmlPreview } from "./chatFileLinks";
import { fileKind } from "@/features/files/preview/fileKind";

const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export function ImageAttachment({
  image,
  children,
}: {
  image: PreviewImage;
  children?: ReactNode;
}) {
  const preview = useImagePreview();
  return (
    <Attachment size="sm" className="attachment-chip attachment-image max-w-64">
      <AttachmentMedia variant="image">
        <img src={image.src} alt="" loading="lazy" decoding="async" />
      </AttachmentMedia>
      <AttachmentTrigger
        className="attachment-open"
        aria-label={image.name}
        aria-expanded={preview.file?.id === image.id}
        onClick={() => preview.open(image)}
      />
      {children}
    </Attachment>
  );
}

export function Attachments({
  files,
  onRemove,
  fileLinksOnly,
  defaultExpanded,
}: {
  files: FileAttachment[];
  onRemove?: (file: FileAttachment) => void;
  fileLinksOnly?: boolean;
  defaultExpanded?: boolean;
}) {
  const { t } = useTranslation();
  const host = useContext(HtmlPreviewContext);
  if (!files.length) return null;
  const group = (
    <AttachmentGroup className="attachment-strip max-w-full items-center">
      {files.map((file) => {
        const url = `/api/attachments/${encodeURIComponent(file.id)}`;
        const remove = onRemove && (
          <AttachmentActions>
            <AttachmentAction
              aria-label={t("attachments.remove", { name: file.name })}
              onClick={() => onRemove(file)}
            >
              <X />
            </AttachmentAction>
          </AttachmentActions>
        );
        return imageTypes.has(file.mediaType) ? (
          <ImageAttachment
            key={file.id}
            image={{ id: file.id, name: file.name, src: url }}
          >
            {remove}
          </ImageAttachment>
        ) : (
          <Attachment
            key={file.id}
            size="sm"
            className="attachment-chip max-w-64"
          >
            <AttachmentMedia variant="icon">
              <FileText />
            </AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle title={file.name}>{file.name}</AttachmentTitle>
              <AttachmentDescription>
                {file.size < 1024
                  ? `${file.size} B`
                  : file.size < 1024 * 1024
                    ? `${Math.ceil(file.size / 1024)} KB`
                    : `${(file.size / 1024 / 1024).toFixed(1)} MB`}
              </AttachmentDescription>
            </AttachmentContent>
            {fileKind(file.name) === "html" ? (
              <>
                <HtmlAttachmentTrigger
                  preview={attachmentPreview(file)}
                  title={
                    fileLinksOnly
                      ? t("composer.fileLinkOnly", { name: file.name })
                      : t("chat.htmlPreviewInline")
                  }
                />
                <AttachmentActions>
                  <AttachmentAction asChild>
                    <a
                      href={url}
                      download={file.name}
                      aria-label={t("files.download")}
                      title={t("files.download")}
                    >
                      <Download />
                    </a>
                  </AttachmentAction>
                </AttachmentActions>
              </>
            ) : (
              <AttachmentTrigger asChild>
                <a
                  className="attachment-open"
                  href={url}
                  download={file.name}
                  aria-label={file.name}
                  title={
                    fileLinksOnly
                      ? t("composer.fileLinkOnly", { name: file.name })
                      : file.name
                  }
                />
              </AttachmentTrigger>
            )}
            {remove}
          </Attachment>
        );
      })}
    </AttachmentGroup>
  );
  if (!files.some((file) => fileKind(file.name) === "html")) return group;
  const initial =
    defaultExpanded && files.length === 1
      ? attachmentPreview(files[0])
      : undefined;
  const content = (
    <InlineHtmlPreview key={initial?.src} defaultPreview={initial}>
      {group}
    </InlineHtmlPreview>
  );
  return host ? content : <HtmlPreviewHost>{content}</HtmlPreviewHost>;
}

function attachmentPreview(file: FileAttachment): HtmlPreview {
  return {
    src: chatPreviewURL(
      `/api/attachments/${encodeURIComponent(file.id)}/preview`,
      "html",
      file.name,
    ),
    title: file.name,
  };
}

function HtmlAttachmentTrigger({
  preview,
  title,
}: {
  preview: HtmlPreview;
  title: string;
}) {
  const actions = useContext(HtmlPreviewContext);
  const inline = useInlineHtmlPreview();
  const expanded = inline?.src === preview.src;
  return (
    <AttachmentTrigger
      className="attachment-open"
      aria-label={preview.title}
      title={title}
      aria-expanded={expanded}
      aria-controls={expanded ? inline?.id : undefined}
      onClick={({ currentTarget }) => inline?.toggle(preview, currentTarget)}
      {...rowMenuHandlers((anchor) =>
        actions?.menu(
          preview,
          anchor,
          inline && !expanded
            ? () => inline.toggle(preview, anchor.trigger)
            : undefined,
        ),
      )}
    />
  );
}
