import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Mnemosyne — Memory Graph Viewer",
  description:
    "A constellation of memories. Render @mnemo-ai/core graph data with react-force-graph (2D/3D).",
};

const shell: React.CSSProperties = {
  margin: 0,
  minHeight: "100vh",
  color: "#e6ebff",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif",
  // Deep navy / space background with a top-left radial glow + aurora accent.
  background:
    "radial-gradient(1200px 800px at 12% -8%, rgba(138,152,255,0.18), transparent 55%)," +
    "radial-gradient(900px 700px at 88% 0%, rgba(34,211,238,0.10), transparent 50%)," +
    "linear-gradient(160deg, #03060c 0%, #070b16 35%, #101a32 75%, #1c2a4a 100%)",
};

/**
 * Next.js 15.5+ generates a strict `LayoutProps` validator in
 * `.next/types/app/layout.ts` that requires the prop shape to be
 * assignable to its generated interface. The older
 * `{ children: ReactNode }` annotation fails that check on fresh
 * CI runs (no incremental `.next` cache). Wrapping in `Readonly`
 * matches the validator's expected shape — the same pattern Next's
 * own templates use after 15.5.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en">
      <body style={shell}>{children}</body>
    </html>
  );
}
