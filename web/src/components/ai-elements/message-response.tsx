import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Streamdown,
  defaultComponents,
  type Components,
  type StreamdownProps,
} from "streamdown";
import { cjk } from "@streamdown/cjk";
import { cn } from "cn";
import { CodeSnippet } from "./code-block";
import { MermaidBlock } from "./mermaid-block";
import { ResponseTable } from "./response-table";

export const MessageResponse = memo(function MessageResponse({
  text,
  running = false,
  components: overrides,
  remarkPlugins,
  rehypePlugins,
  BlockComponent,
  className,
  mode = "streaming",
}: {
  text: string;
  running?: boolean;
} & Pick<
  StreamdownProps,
  | "components"
  | "remarkPlugins"
  | "rehypePlugins"
  | "BlockComponent"
  | "className"
  | "mode"
>) {
  const { t } = useTranslation();
  const components = useMemo<Components>(
    () => ({
      // Streamdown marks fenced code separately from inline code.
      code: ({ children, className }) => {
        const code = String(children ?? "");
        const language = className?.replace(/^language-/, "") || "text";
        return language.toLowerCase() === "mermaid" ? (
          <MermaidBlock code={code} />
        ) : (
          <CodeSnippet code={code} language={language} />
        );
      },
      inlineCode: defaultComponents.code,
      table: ResponseTable,
      a: ({ href, children }) => (
        <a href={href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      ),
      img: ({ alt }) => (
        <span className="text-muted-foreground">
          {t("chat.image", { alt: alt || "" })}
        </span>
      ),
      ...overrides,
    }),
    [t, overrides],
  );
  return (
    <Streamdown
      plugins={{ cjk }}
      isAnimating={running}
      // Keep the render tree stable so completion preserves open table dialogs.
      mode={mode}
      parseIncompleteMarkdown={running}
      className={cn("min-w-0", className)}
      controls={{ code: false, table: false }}
      components={components}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      BlockComponent={BlockComponent}
    >
      {text}
    </Streamdown>
  );
});
