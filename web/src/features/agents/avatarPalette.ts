import {
  DefaultAvatarColor,
  DefaultAvatarEmoji,
  type Avatar,
} from "@/api/types.gen";

export const defaultAvatar = {
  kind: "emoji",
  value: DefaultAvatarEmoji,
  color: DefaultAvatarColor,
} satisfies Avatar;

function swatch(background: string | string[], color = "#19191c") {
  return Array.isArray(background)
    ? { backgroundImage: background.join(", ") }
    : { backgroundColor: background, color };
}

export const avatarPalette = {
  "gradient-prism": swatch([
    "radial-gradient(ellipse at 30% 20%, #9b7bed, transparent 65%)",
    "radial-gradient(ellipse at 95% 55%, #6fd9ae, transparent 65%)",
    "linear-gradient(25deg, #eb824e 12%, #f0a170 54%, #aa8de7)",
  ]),
  "gradient-coral": swatch([
    "radial-gradient(ellipse at 92% 30%, #ec70bd, transparent 65%)",
    "radial-gradient(ellipse at 68% 85%, #f18e77, transparent 68%)",
    "linear-gradient(105deg, #62dcb1 20%, #84d6aa 48%, #e393bd)",
  ]),
  "gradient-citrus": swatch([
    "radial-gradient(ellipse at 82% 10%, #bce978, transparent 69%)",
    "radial-gradient(ellipse at 55% 94%, #f5a56a, transparent 74%)",
    "linear-gradient(145deg, #f7df78, #ffd985)",
  ]),
  "gradient-coast": swatch([
    "radial-gradient(ellipse at 54% 20%, #f7d38a, transparent 67%)",
    "radial-gradient(ellipse at 94% 47%, #8ae5c3, transparent 65%)",
    "linear-gradient(15deg, #6a95f1 18%, #86b4ee 55%, #c4d5b2)",
  ]),
  "gradient-sunset": swatch([
    "radial-gradient(ellipse at 22% 18%, #ffd48b, transparent 66%)",
    "radial-gradient(ellipse at 94% 52%, #ea7eaf, transparent 65%)",
    "linear-gradient(25deg, #ef805f 14%, #f5a087 62%, #f3adbd)",
  ]),
  "gradient-jade": swatch([
    "radial-gradient(ellipse at 20% 13%, #c2ed8b, transparent 68%)",
    "radial-gradient(ellipse at 96% 45%, #72cbd3, transparent 68%)",
    "linear-gradient(35deg, #4bbfa4 16%, #80d8a4 63%, #b1e8a0)",
  ]),
  "gradient-glacier": swatch([
    "radial-gradient(ellipse at 18% 25%, #92e5ef, transparent 68%)",
    "radial-gradient(ellipse at 90% 24%, #a9a6f4, transparent 68%)",
    "linear-gradient(15deg, #6b98f0 16%, #8eb2f3 56%, #b3d2f7)",
  ]),
  "gradient-orchid": swatch([
    "radial-gradient(ellipse at 91% 27%, #f4a4cd, transparent 72%)",
    "radial-gradient(ellipse at 14% 30%, #b4a1f4, transparent 62%)",
    "linear-gradient(35deg, #a07ce9 12%, #c38ce7 55%, #e5a9da)",
  ]),
  "gradient-pearl": swatch([
    "radial-gradient(ellipse at 24% 16%, #f8e8d7, transparent 68%)",
    "radial-gradient(ellipse at 90% 62%, #b4cbd9, transparent 70%)",
    "linear-gradient(35deg, #a79eb7, #dfd6df 63%, #eef0e4)",
  ]),
  "gradient-rose": swatch([
    "radial-gradient(ellipse at 24% 16%, #ffcfce, transparent 68%)",
    "radial-gradient(ellipse at 94% 48%, #c879aa, transparent 68%)",
    "linear-gradient(25deg, #c46a79, #ed99a6 58%, #efb5ce)",
  ]),
  "gradient-ember": swatch([
    "radial-gradient(ellipse at 76% 14%, #ffd97f, transparent 65%)",
    "radial-gradient(ellipse at 12% 68%, #c76270, transparent 72%)",
    "linear-gradient(40deg, #ae5464, #ef9062 54%, #ffb469)",
  ]),
  "gradient-dune": swatch([
    "radial-gradient(ellipse at 22% 20%, #f7deb0, transparent 70%)",
    "radial-gradient(ellipse at 94% 36%, #d8b492, transparent 66%)",
    "linear-gradient(30deg, #ac896e, #d7b58a 56%, #eee0ba)",
  ]),
  "gradient-meadow": swatch([
    "radial-gradient(ellipse at 25% 14%, #e3ee98, transparent 68%)",
    "radial-gradient(ellipse at 92% 58%, #72b68a, transparent 65%)",
    "linear-gradient(25deg, #77a468, #b5cf80 57%, #dce5a0)",
  ]),
  "gradient-lagoon": swatch([
    "radial-gradient(ellipse at 30% 16%, #91e9dd, transparent 68%)",
    "radial-gradient(ellipse at 94% 48%, #61b9c9, transparent 70%)",
    "linear-gradient(35deg, #41849c 10%, #68b9b5 58%, #9edbcc)",
  ]),
  "gradient-twilight": swatch([
    "radial-gradient(ellipse at 20% 18%, #b2bdf9, transparent 65%)",
    "radial-gradient(ellipse at 94% 56%, #879fd6, transparent 69%)",
    "linear-gradient(30deg, #6065ab, #858ec9 58%, #adc4ed)",
  ]),
  "gradient-iris": swatch([
    "radial-gradient(ellipse at 20% 18%, #d7b1ef, transparent 66%)",
    "radial-gradient(ellipse at 94% 42%, #b780bf, transparent 68%)",
    "linear-gradient(35deg, #8262ad, #ab86d1 58%, #d7a8d6)",
  ]),
  white: swatch("#ffffff"),
  gray: swatch("#a3a3a3"),
  black: swatch("#000000", "#ffffff"),
  red: swatch("#ad3849", "#ffffff"),
  amber: swatch("#dca753"),
  green: swatch("#72ad87"),
  blue: swatch("#315fa0", "#ffffff"),
  violet: swatch("#b097df"),
};

// Keep previously saved colors renderable when they rotate out of the picker.
export const avatarColors = {
  ...avatarPalette,
  orange: swatch("#ed945d"),
  yellow: swatch("#f2d977"),
  lime: swatch("#afce78"),
  teal: swatch("#236961", "#ffffff"),
  cyan: swatch("#78c9d8"),
  indigo: swatch("#4e4e86", "#ffffff"),
  magenta: swatch("#973e79", "#ffffff"),
  pink: swatch("#eca2bb"),
};
