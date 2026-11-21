import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@/components/ui/code-block";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";

// Shared by fenced replies, tool output, and approval details.
export function CodeSnippet({
  code,
  language = "text",
  title,
  failed = false,
}: {
  code: string;
  language?: string;
  title?: string;
  failed?: boolean;
}) {
  const { t } = useTranslation();
  const lines = useHighlightedCode(code, language);
  return (
    <CodeBlock size="sm" variant={failed ? "destructive" : "default"}>
      <CodeBlockHeader>
        <CodeBlockTitle>{title ?? language}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton
            value={code}
            copyLabel={t("chat.copyCode")}
            copiedLabel={t("chat.copied")}
            onCopyError={() => toast.error(t("chat.copyFailed"))}
          />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent lineNumbers className="max-h-80">
        {lines.map((line, index) => (
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}
