import { createContext, useContext } from "react";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Citation } from "@/api/types.gen";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { citationDomain } from "./chatCitations";

export const ChatCitationsContext = createContext<Citation[]>([]);

export function InlineCitation({ index }: { index: number }) {
  const { t } = useTranslation();
  const citations = useContext(ChatCitationsContext);
  const citation = citations[index];
  const sources = citation?.sources;
  if (!sources?.length) return null;

  if (sources.length === 1) {
    const source = sources[0];
    const domain = citationDomain(source.url);
    const label = source.title || domain;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            className="chat-citation"
            href={source.url}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={label}
          >
            {domain}
          </a>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6} className="max-w-xs">
          <span className="block font-medium leading-snug">{label}</span>
          {source.title && source.title !== domain && (
            <span className="mt-0.5 block opacity-75">{domain}</span>
          )}
        </TooltipContent>
      </Tooltip>
    );
  }

  const firstDomain = citationDomain(sources[0].url);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="chat-citation"
          aria-label={t("chat.citationSources", { count: sources.length })}
        >
          {firstDomain} +{sources.length - 1}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-80 max-w-[calc(100vw-2rem)] p-1.5"
      >
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {sources.map((source) => {
            const domain = citationDomain(source.url);
            return (
              <li key={source.url}>
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="chat-citation-item flex flex-col gap-0.5 rounded-md px-2.5 py-2 no-underline transition-colors hover:bg-control-hover focus-visible:bg-control-focus focus-visible:outline-none"
                >
                  <span className="line-clamp-2 text-[13px] font-medium leading-snug text-foreground">
                    {source.title || domain}
                  </span>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <span className="truncate">{domain}</span>
                    <ExternalLink className="size-3 shrink-0" />
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
