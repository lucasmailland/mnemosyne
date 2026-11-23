import { WORDMARK_PATH, WORDMARK_VIEWBOX } from "./wordmark-glyphs";

/** MNΣMOSΥNΣ as outlines (tracking baked in). The brand name is not translated. */
export function Wordmark({ className, height = 16 }: { className?: string; height?: number }) {
  const [, , w, h] = WORDMARK_VIEWBOX.split(" ").map(Number);
  return (
    <svg
      role="img"
      aria-label="Mnemosyne"
      // React types omit `translate` on SVG, but browsers honor it.
      {...({ translate: "no" } as object)}
      fill="currentColor"
      viewBox={WORDMARK_VIEWBOX}
      height={height}
      width={(height * w) / h}
      className={className}
    >
      <path d={WORDMARK_PATH} />
    </svg>
  );
}
