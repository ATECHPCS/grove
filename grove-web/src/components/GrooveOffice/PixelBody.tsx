/**
 * Original (license-clean) pixel-art office worker torso. The shirt is tinted
 * to the agent's brand colour so each AI agent "wears" its own colours; collar
 * is a lighter shade of the same, hands are skin. Rendered as crisp 1×1 SVG
 * rects so it scales without blur.
 *
 *   S = shirt (brand)   C = collar (light brand)   A = sleeve (dark brand)
 *   H = hand/skin       . = transparent
 */
const SPRITE = [
  "..SSSS..",
  ".SCCCCS.",
  "ASSSSSSA",
  "ASSSSSSA",
  "ASSSSSSA",
  ".SSSSSS.",
  "H......H",
];

const COLS = 8;

export function PixelBody({ shirt }: { shirt: string }) {
  const collar = `color-mix(in srgb, ${shirt} 45%, #ffffff)`;
  const sleeve = `color-mix(in srgb, ${shirt} 72%, #000000)`;
  const skin = "#f1c8a0";

  const fillFor = (ch: string): string | null => {
    switch (ch) {
      case "S": return shirt;
      case "C": return collar;
      case "A": return sleeve;
      case "H": return skin;
      default: return null;
    }
  };

  return (
    <svg
      className="office-fellow__pixbody"
      width={COLS * 5}
      height={SPRITE.length * 5}
      viewBox={`0 0 ${COLS} ${SPRITE.length}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {SPRITE.flatMap((row, y) =>
        row.split("").map((ch, x) => {
          const fill = fillFor(ch);
          return fill ? (
            <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={fill} />
          ) : null;
        }),
      )}
    </svg>
  );
}
