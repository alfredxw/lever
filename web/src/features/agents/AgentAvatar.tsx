import { lazy, Suspense, useState, type CSSProperties } from "react";
import { StarterAvatarPreset, type Agent, type Avatar } from "@/api/types.gen";
import { initials } from "@/components/common";
import leverIcon from "../../../../cmd/lever-desktop/icon.png";
import { avatarColors } from "./avatarPalette";

const AvatarIcon = lazy(() =>
  import("./avatarIcons").then((module) => ({ default: module.AvatarIcon })),
);

const avatarImageIdPattern = /^[a-f0-9]{64}$/;

export function avatarImageSrc(avatar?: Avatar) {
  if (!avatar) return undefined;
  if (avatar.kind === "image" && avatarImageIdPattern.test(avatar.value))
    return `/api/avatars/${avatar.value}`;
  if (avatar.kind === "preset" && avatar.value === StarterAvatarPreset)
    return leverIcon;
  return undefined;
}

export function AgentAvatar({
  agent,
  size = "default",
}: {
  agent: Pick<Agent, "id" | "name" | "avatar">;
  size?: "default" | "sm" | "xs";
}) {
  const { avatar } = agent;
  const imageSrc = avatarImageSrc(avatar);
  const [failedSrc, setFailedSrc] = useState<string>();
  const showImage = !!imageSrc && failedSrc !== imageSrc;
  const isLeverLogo =
    showImage &&
    avatar?.kind === "preset" &&
    avatar.value === StarterAvatarPreset;
  const color = avatar?.color;
  const preset =
    !showImage && color && Object.hasOwn(avatarColors, color)
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
      data-kind={showImage ? avatar?.kind : imageSrc ? undefined : avatar?.kind}
      data-avatar-color={preset ? color : undefined}
      style={showImage ? undefined : (style as CSSProperties)}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          src={imageSrc}
          alt=""
          draggable={false}
          className={
            isLeverLogo
              ? "agent-avatar-image agent-avatar-logo"
              : "agent-avatar-image"
          }
          onError={() => setFailedSrc(imageSrc)}
        />
      ) : avatar?.kind === "lucide" ? (
        <Suspense fallback={fallback}>
          <AvatarIcon name={avatar.value} />
        </Suspense>
      ) : (
        (!imageSrc && avatar?.value) || fallback
      )}
    </span>
  );
}
