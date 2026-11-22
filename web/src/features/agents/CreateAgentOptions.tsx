import { useLayoutEffect, useRef, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

export function CreateAgentOptions({
  open,
  onOpenChange,
  skills,
  delegations,
}: {
  open?: boolean;
  onOpenChange: (open: boolean) => void;
  skills: ReactNode;
  delegations: ReactNode;
}) {
  const { t } = useTranslation();
  const section = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (open) section.current?.scrollIntoView({ block: "start" });
  }, [open]);

  const cards = [
    {
      label: "profile.skills",
      className: "agent-create-skills",
      fields: skills,
    },
    {
      label: "profile.delegations",
      className: "agent-create-delegations",
      fields: delegations,
    },
  ] as const;

  return (
    <Collapsible
      ref={section}
      open={!!open}
      onOpenChange={onOpenChange}
      className="agent-create-options"
    >
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="agent-more-options group"
        >
          <ChevronRight className="group-data-[state=open]:rotate-90" />
          {t("profile.moreOptions")}
        </Button>
      </CollapsibleTrigger>
      {open !== undefined && (
        <CollapsibleContent
          forceMount
          hidden={!open}
          className="agent-create-options-content"
          onInvalidCapture={() => {
            // Reveal the invalid field before the browser attempts to focus it.
            if (!open) flushSync(() => onOpenChange(true));
          }}
        >
          {cards.map(({ label, className, fields }) => (
            <Card
              key={label}
              size="sm"
              role="group"
              aria-label={t(label)}
              className="min-w-0 gap-2"
            >
              <CardHeader>
                <CardTitle>
                  <h3>{t(label)}</h3>
                </CardTitle>
              </CardHeader>
              <CardContent className={className}>{fields}</CardContent>
            </Card>
          ))}
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
