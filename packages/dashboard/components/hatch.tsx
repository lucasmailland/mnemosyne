/**
 * The engraver's 45° hatch, as an SVG pattern: share one per <svg> and fill with url(#id).
 * `color` inks the lines (the accent by default); `gap` and `width` set the period and the line
 * width in px. The CSS twin for HTML marks is the `.hatch` class in globals.css.
 */
export function HatchPattern({
  id,
  color = "var(--color-accent)",
  gap = 4,
  width = 2,
}: {
  id: string;
  color?: string;
  gap?: number;
  width?: number;
}) {
  return (
    <pattern
      id={id}
      width={gap}
      height={gap}
      patternUnits="userSpaceOnUse"
      patternTransform="rotate(45)"
    >
      <line x1="0" y1="0" x2="0" y2={gap} stroke={color} strokeWidth={width} />
    </pattern>
  );
}
