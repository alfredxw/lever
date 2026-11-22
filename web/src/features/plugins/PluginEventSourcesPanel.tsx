import { ArrowUpRight, KeyRound, Type, Zap } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { Agent, Plugin } from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import {
  automationsQuery,
  nextLabel,
  planTargets,
} from "@/features/automations/automationsQuery";

export function PluginEventSourcesPanel({
  plugin,
  agents,
  onOpenAutomations,
}: {
  plugin: Plugin;
  agents: Agent[];
  onOpenAutomations?: (automationId?: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const automations = useQuery(automationsQuery);
  const eventSources = plugin.manifest.contributes.eventSources ?? [];
  const consumers = (automations.data ?? []).filter(
    (plan) => plan.trigger.source?.pluginId === plugin.id,
  );
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const now = Date.now();

  return (
    <div className="flex flex-col gap-4">
      <div className="plugins-info-banner">
        <div className="plugins-info-banner-copy">
          <Zap className="size-3.5 shrink-0 text-muted-foreground" />
          <span>{t("plugins.sharedEventSourcesHint")}</span>
        </div>
        {onOpenAutomations && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenAutomations()}
          >
            {t("plugins.openAutomations")}
            <ArrowUpRight data-icon="inline-end" />
          </Button>
        )}
      </div>

      {!plugin.enabled && (
        <p className="plugins-disabled-note" role="status">
          {t("plugins.disabledHint")}
        </p>
      )}

      {automations.error && (
        <ErrorNotice
          error={automations.error}
          retry={() => void automations.refetch()}
        />
      )}

      <section className="plugins-panel panel-surface">
        <div className="plugins-panel-head">
          <div className="flex items-center gap-2">
            <h3>{t("plugins.eventSource.consuming")}</h3>
            <span className="text-xs text-muted-foreground tabular-nums">
              {t("plugins.eventSource.count", { count: consumers.length })}
            </span>
          </div>
        </div>
        {consumers.length === 0 ? (
          <div className="px-4 py-5 text-xs text-muted-foreground">
            {t("plugins.eventSource.empty")}
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {consumers.map((plan) => {
              const target = planTargets(plan)[0];
              const agent = target ? agentsById.get(target.agentId) : undefined;
              const statusText = nextLabel(plan, t, i18n.language, now);
              const tone = !plan.enabled || plan.sourceDisabled
                ? "muted"
                : plan.sourceError
                  ? "error"
                  : plan.sourceReady
                    ? "positive"
                    : "attention";
              return (
                <div key={plan.id} className="plugins-panel-row">
                  <div className="flex min-w-0 flex-1 items-center gap-2.5">
                    <span
                      className="plugins-status-dot"
                      data-tone={tone}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-foreground">
                        <span className="truncate">
                          {plan.name || plan.id}
                        </span>
                        {agent && (
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
                            <AgentAvatar agent={agent} size="sm" />
                            <span className="max-w-32 truncate">
                              {agent.name}
                            </span>
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {statusText}
                      </p>
                    </div>
                  </div>
                  {onOpenAutomations && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => onOpenAutomations(plan.id)}
                    >
                      {t("plugins.openAutomations")}
                      <ArrowUpRight data-icon="inline-end" />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {eventSources.map((source) => (
        <section key={source.id} className="plugins-panel panel-surface">
          <div className="plugins-panel-head">
            <div className="flex flex-wrap items-center gap-2">
              <h3>{t("plugins.eventSource.schema")}</h3>
              <Badge variant="outline" className="font-mono text-[11px]">
                {source.id}
              </Badge>
              {source.driver && (
                <Badge variant="secondary" className="font-mono text-[11px]">
                  {source.driver}
                </Badge>
              )}
            </div>
            {source.command && (
              <code className="truncate text-[11px] text-muted-foreground">
                {source.command}
              </code>
            )}
          </div>
          <div className="divide-y divide-border/60">
            {source.fields.map((field) => (
              <div key={field.id} className="plugins-panel-row">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-foreground">
                    <span>{field.label}</span>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
                      {field.id}
                    </code>
                    {field.required && (
                      <Badge
                        variant="outline"
                        className="h-5 px-1.5 text-[10px]"
                      >
                        {t("plugins.eventSource.required")}
                      </Badge>
                    )}
                  </div>
                  {(field.placeholder || field.default) && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {field.default
                        ? `${field.default}`
                        : field.placeholder}
                    </p>
                  )}
                </div>
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/60 bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                  {field.kind === "secret" ? (
                    <KeyRound className="size-3" aria-hidden="true" />
                  ) : (
                    <Type className="size-3" aria-hidden="true" />
                  )}
                  {t(
                    field.kind === "secret"
                      ? "plugins.eventSource.secret"
                      : "plugins.eventSource.text",
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
