import { useMemo } from "react";
import { defaultRehypePlugins, type Components } from "streamdown";
import { MessageResponse } from "@/components/ai-elements/message-response";
import { fileURL } from "./fileDrafts";
import { resolveMarkdownPath, type FileSelection } from "./filePaths";
import { useFileSource } from "./fileSource";

// Keep raw HTML parsing and sanitization, but resolve local URLs ourselves.
// Streamdown's default hardening rewrites them relative to the website origin.
const rehypePlugins = [defaultRehypePlugins.raw, defaultRehypePlugins.sanitize];

export function MarkdownPreview({
  file: { root, path },
  text,
  onFile,
}: {
  file: FileSelection;
  text: string;
  onFile: (file: FileSelection) => void;
}) {
  const fileSource = useFileSource();
  const components = useMemo<Components>(() => {
    const imageURL = (src?: string) => {
      const local = resolveMarkdownPath(path, src);
      if (local) {
        const fragment = src?.match(/#.*$/)?.[0] ?? "";
        return `/api${fileURL({ source: fileSource, root, path: local })}&asset=true${fragment}`;
      }
      if (src?.startsWith("//")) return `https:${src}`;
      if (src && /^https?:\/\//i.test(src)) return src;
    };
    return {
      // Preserve HTML paragraph attributes, including image alignment.
      p: ({ node: _node, ...props }) => <p {...props} />,
      img: ({ src, alt, node: _node, ...props }) => {
        const source = imageURL(src);
        return source ? (
          <img
            {...props}
            src={source}
            alt={alt ?? ""}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="text-muted-foreground">{alt}</span>
        );
      },
      source: ({ srcSet, media }) => {
        // A single <picture> variant (such as a dark logo) is a normal image
        // reference. Other srcsets fall back to <img> rather than the app URL.
        const candidate = srcSet?.trim();
        const source =
          candidate && /^\S+$/.test(candidate) && imageURL(candidate);
        return source ? <source media={media} srcSet={source} /> : null;
      },
      a: ({ href, children, node: _node, ...props }) => {
        const local = resolveMarkdownPath(path, href);
        if (local) {
          return (
            <a
              {...props}
              href={href}
              onClick={(event) => {
                event.preventDefault();
                onFile({ root, path: local });
              }}
            >
              {children}
            </a>
          );
        }
        if (href?.startsWith("#")) {
          return (
            <a {...props} href={href}>
              {children}
            </a>
          );
        }
        return href && /^(?:https?:|mailto:|tel:|\/\/)/i.test(href) ? (
          <a {...props} href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        ) : (
          <span>{children}</span>
        );
      },
    };
  }, [fileSource, root, path, onFile]);

  return (
    <MessageResponse
      text={text}
      components={components}
      rehypePlugins={rehypePlugins}
    />
  );
}
