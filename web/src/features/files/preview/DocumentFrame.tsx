import { useMemo } from "react";
import DOMPurify from "dompurify";

// Content is untrusted even when it comes from a local workspace or a parser.
// Opaque-origin sandbox + CSP prevents scripts, forms, navigation and requests.
export function DocumentFrame({
  html,
  title,
}: {
  html: string;
  title: string;
}) {
  const srcDoc = useMemo(() => {
    const clean = DOMPurify.sanitize(html, {
      WHOLE_DOCUMENT: true,
      ADD_TAGS: ["style"],
      FORBID_TAGS: [
        "script",
        "iframe",
        "object",
        "embed",
        "form",
        "input",
        "button",
        "link",
        "meta",
        "base",
      ],
      FORBID_ATTR: ["srcset", "action", "formaction", "href", "target"],
    });
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"><style>html{color-scheme:light;background:white;color:#222}body{font:16px/1.6 system-ui;margin:24px;overflow-wrap:anywhere}img,svg{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #ddd;padding:6px 10px}pre{white-space:pre-wrap}</style></head><body>${clean}</body></html>`;
  }, [html]);
  return (
    <iframe
      className="file-document-frame"
      title={title}
      sandbox=""
      srcDoc={srcDoc}
      referrerPolicy="no-referrer"
    />
  );
}
