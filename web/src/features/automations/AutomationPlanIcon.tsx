import {
  Clock3,
  GitPullRequest,
  Layers,
  Lightbulb,
  Mail,
  Shield,
  SquareKanban,
  Webhook,
  Zap,
} from "lucide-react";
import type { Automation } from "@/api/types.gen";
import { deliveryModeOf, notifyPolicyOf } from "./automationsQuery";

export function AutomationPlanIcon({
  plan,
  className = "size-3.5 shrink-0 text-muted-foreground",
}: {
  plan: Pick<Automation, "trigger" | "deliveryMode" | "workItem" | "notifyPolicy" | "quiet">;
  className?: string;
}) {
  const source = plan.trigger.source;
  const delivery = deliveryModeOf(plan);
  const policy = notifyPolicyOf(plan);
  const Icon =
    plan.trigger.kind === "event"
      ? source?.pluginId === "lever.imap-mail"
        ? Mail
        : source
          ? Zap
          : Webhook
      : policy === "silent"
        ? Shield
        : delivery === "audit"
          ? Layers
          : delivery === "propose"
            ? Lightbulb
            : delivery === "curate"
              ? SquareKanban
              : delivery === "deliver"
                ? GitPullRequest
                : Clock3;
  return <Icon className={className} aria-hidden="true" />;
}
