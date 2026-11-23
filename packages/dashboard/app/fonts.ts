import { GFS_Didot, Inter, JetBrains_Mono } from "next/font/google";

/**
 * Brand typefaces (mnemosyne-branding/README.md §Typography): GFS Didot for the wordmark,
 * headings and large numerals (Latin and Greek, for Σ and Υ), Inter for reading and UI text,
 * JetBrains Mono for code, ids, times and metrics. `next/font/google` self-hosts them at build
 * time, so nothing is requested from Google at run time. Shared by the root layout and by
 * global-error, which draws its own <html>.
 */
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});
const didot = GFS_Didot({
  weight: "400",
  subsets: ["latin", "greek"],
  variable: "--font-didot",
  display: "swap",
});

export const fontVariables = `${inter.variable} ${jetbrainsMono.variable} ${didot.variable}`;
