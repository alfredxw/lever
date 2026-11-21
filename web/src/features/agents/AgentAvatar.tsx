import { lazy, Suspense, type CSSProperties } from "react";
import type { Agent } from "@/api/types.gen";
import { initials } from "@/components/common";
import { avatarColors } from "./avatarPalette";

const AvatarIcon = lazy(() =>
  import("./avatarIcons").then((module) => ({ default: module.AvatarIcon })),
);

export function AgentAvatar({
  agent,
  size = "default",
}: {
  agent: Pick<Agent, "id" | "name" | "avatar">;
  size?: "default" | "sm";
}) {
  const { avatar } = agent;
  const color = avatar?.color;
  const preset =
    color && Object.hasOwn(avatarColors, color)
      ? avatarColors[color as keyof typeof avatarColors]
      : undefined;
  const style = preset ?? {
    "--avatar-hue":
      Array.from(agent.id).reduce(
        (hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0,
        0,
      ) % 360,
  };
  const fallback = initials(agent.name) || "AG";
  return (
    <span
      className="agent-avatar"
      data-size={size}
      data-kind={avatar?.kind}
      data-avatar-color={preset ? color : undefined}
      style={style as CSSProperties}
      aria-hidden="true"
    >
      {avatar?.kind === "lucide" ? (
        <Suspense fallback={fallback}>
          <AvatarIcon name={avatar.value} />
        </Suspense>
      ) : (
        avatar?.value || fallback
      )}
    </span>
  );
}
