import { Puzzle } from "lucide-react";
import type { Plugin } from "../../api/plugins";

/** A manifest `icon` value is an image if it has an image extension or a path
 *  separator; otherwise it's treated as text (an emoji). */
const IMG_RE = /\.(png|svg|jpe?g|gif|webp|ico)$/i;

/**
 * Renders a plugin's icon: a shipped image (`"icon.png"` / `"assets/x.svg"`,
 * served via the plugin's /asset route), an emoji (`"🧩"`), or — when the
 * manifest declares none — a default puzzle glyph. `className` sizes the box
 * (image + fallback); `size` is the emoji font size in px.
 */
export function PluginIcon({
  plugin,
  className = "h-4 w-4",
  size = 16,
}: {
  plugin: Pick<Plugin, "id" | "icon">;
  className?: string;
  size?: number;
}) {
  const icon = plugin.icon;
  if (icon && (IMG_RE.test(icon) || icon.includes("/"))) {
    const src = `/api/v1/plugins/${plugin.id}/asset/${icon
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
    return <img src={src} alt="" className={`${className} object-contain`} />;
  }
  if (icon) {
    return (
      <span
        className={`${className} inline-flex items-center justify-center leading-none`}
        style={{ fontSize: size }}
      >
        {icon}
      </span>
    );
  }
  return <Puzzle className={className} />;
}
