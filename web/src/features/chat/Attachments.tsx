import { FileText, X } from "lucide-react";
import type { ReactNode } from "react";
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
}: {
  files: FileAttachment[];
  onRemove?: (file: FileAttachment) => void;
}) {
  const { t } = useTranslation();
  if (!files.length) return null;
  return (
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
            <AttachmentTrigger asChild>
              <a
                className="attachment-open"
                href={url}
                download={file.name}
                aria-label={file.name}
                title={file.name}
              />
            </AttachmentTrigger>
            {remove}
          </Attachment>
        );
      })}
    </AttachmentGroup>
  );
}
