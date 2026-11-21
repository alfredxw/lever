// Keep the full library in one lazy chunk, shared by the picker and saved avatars.
import { icons, CircleHelp, type LucideProps } from "lucide-react";

export const avatarIconNames = Object.keys(icons);
export const popularAvatarIcons = [
  "Bot",
  "Code",
  "Terminal",
  "Folders",
  "Globe",
  "Server",
  "Database",
  "Sparkles",
  "Monitor",
  "Cloud",
  "Package",
  "BookOpen",
  "FlaskConical",
  "ShieldCheck",
  "Rocket",
  "Gamepad2",
  "Music",
  "Image",
  "GitBranch",
  "Workflow",
  "Wrench",
  "Layers",
  "Leaf",
  "Brain",
];
export function AvatarIcon({ name, ...props }: LucideProps & { name: string }) {
  const Icon = icons[name as keyof typeof icons] ?? CircleHelp;
  return <Icon {...props} />;
}
